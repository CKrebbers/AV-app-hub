#!/usr/bin/env node
// @ts-check
// varve-hub — opdrachten:
//   doctor [--json]          overzicht: MIDI, controllers, poorten, apps
//   proef [naam]             begeleide hardwareproef (standaard f0-hardware), opgenomen in proef/
//   testpatroon              regenboog op de APC + live wat binnenkomt (Ctrl-C stopt)
//   opname [naam]            speelsessie opnemen in proef/ (Ctrl-C stopt)
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import readline from 'node:readline';
import { laadConfig, laadLpd8Profiel, HUB_MAP, LPD8_PROFIEL_PAD } from './config.js';
import { laadRtMidi } from './ports/rtmidi.js';
import { maakApparaten } from './apparaten.js';
import { echteKlok } from './core/klok.js';
import { Logboek } from './core/logboek.js';
import { doctor } from './doctor.js';
import { voerUit, terminalIO } from './proef/runner.js';
import { PROTOCOLLEN } from './proef/index.js';
import * as A from './devices/apc40mk2.js';

const [opdracht = 'help', ...args] = process.argv.slice(2);
const config = laadConfig();

const stempel = () => new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');

async function midiOfStop() {
  const { systeem, reden } = await laadRtMidi();
  if (!systeem) { console.error(`Geen MIDI beschikbaar: ${reden}\nDraai "varve-hub doctor" voor details.`); process.exit(2); }
  return systeem;
}

/** Logboek naar een bestand in proef/. @param {string} soort @param {string} naam */
function nieuwLogboek(soort, naam) {
  const map = join(HUB_MAP, config.proefmap);
  mkdirSync(map, { recursive: true });
  const pad = join(map, `${stempel()}-${naam}.jsonl`);
  const stroom = createWriteStream(pad);
  const logboek = new Logboek({
    klok: echteKlok, schrijf: (r) => stroom.write(r + '\n'),
    kop: { soort, naam, begon: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}` },
  });
  return { pad, logboek, sluit: () => new Promise((r) => stroom.end(r)) };
}

/** Netjes afsluiten bij Ctrl-C: LEDs uit, poorten dicht, logboek dicht. @param {() => Promise<void>|void} opruimen */
function bijStoppen(opruimen) {
  let bezig = false;
  const stop = async () => { if (bezig) return; bezig = true; await opruimen(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

const opdrachten = {
  async doctor() {
    const { tekst, data } = await doctor({ config, laadMidi: laadRtMidi });
    console.log(args.includes('--json') ? JSON.stringify(data, null, 2) : tekst);
  },

  async proef() {
    const naam = args[0] ?? 'f0-hardware';
    const protocol = PROTOCOLLEN[naam];
    if (!protocol) { console.error(`Onbekende proef "${naam}". Beschikbaar: ${Object.keys(PROTOCOLLEN).join(', ')}`); process.exit(1); }
    const systeem = await midiOfStop();
    const { pad, logboek, sluit } = nieuwLogboek('proef', naam);
    const apparaten = maakApparaten({ systeem, klok: echteKlok, config, logboek, lpd8Profiel: laadLpd8Profiel() });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const opruimen = async () => { await apparaten.stop(); rl.close(); await sluit(); console.log(`\nLogboek: ${pad}`); };
    bijStoppen(opruimen);
    apparaten.start();
    const bevindingen = await voerUit(protocol, { apparaten, io: terminalIO(rl), klok: echteKlok, logboek });
    const prof = /** @type {any} */ (bevindingen['lpd8-profiel'])?.profiel;
    if (prof && !prof.pads.some((/** @type {any} */ p) => p.n < 0)) {
      writeFileSync(LPD8_PROFIEL_PAD, JSON.stringify(prof, null, 2) + '\n');
      console.log(`LPD8-profiel bewaard in ${LPD8_PROFIEL_PAD}`);
    }
    console.log('\nSamenvatting:\n' + JSON.stringify(bevindingen, null, 2));
    await opruimen();
    console.log('\nPush dit bestand zodat Claude het kan verwerken:\n' +
      `  git add proef/ lpd8-profiel.json 2>/dev/null; git commit -m "proef ${naam}" && git push`);
    process.exit(0);
  },

  async testpatroon() {
    const systeem = await midiOfStop();
    const apparaten = maakApparaten({ systeem, klok: echteKlok, config, lpd8Profiel: laadLpd8Profiel() });
    const kleuren = [5, 9, 13, 21, 37, 45, 49, 53];
    const teken = () => {
      for (const c of A.CONTROLS) {
        if (c.led === 'rgb') apparaten.apc.zet(c.id, { kleur: kleuren[c.n % 8] });
        else if (c.led === 'aan' || c.led === 'clipstop') apparaten.apc.zet(c.id, { aan: true });
        else if (c.led === 'ab') apparaten.apc.zet(c.id, { stand: 2 });
        else if (c.led === 'ring') apparaten.apc.zet(c.id, { waarde: 0.5 });
      }
      apparaten.apc.teken();
    };
    apparaten.apc.bij('verbonden', (/** @type {string} */ n) => { console.log(`APC verbonden: ${n}`); teken(); });
    apparaten.apc.bij('weg', () => console.log('APC weg'));
    apparaten.lpd8.bij('verbonden', (/** @type {string} */ n) => console.log(`LPD8 verbonden: ${n}`));
    apparaten.lpd8.bij('model', (/** @type {string} */ m) => console.log(`LPD8-model: ${m}`));
    const toon = (/** @type {any} */ g) => { if (g.kind !== 'onbekend') console.log(`${g.dev.padEnd(5)} ${String(g.el).padEnd(10)} ${g.kind.padEnd(6)} ${g.raw ?? g.delta ?? ''}`); else console.log(`${g.dev.padEnd(5)} ?          ${JSON.stringify(g.bytes ?? '')}`); };
    apparaten.apc.bij('gebeurtenis', (/** @type {any} */ g) => {
      toon(g);
      if (/^(dk|tk)\d$/.test(g.el)) { apparaten.apc.zet(g.el, { waarde: g.v }); apparaten.apc.teken(); }
    });
    apparaten.lpd8.bij('gebeurtenis', toon);
    bijStoppen(() => apparaten.stop());
    apparaten.start();
    console.log('Testpatroon actief. Druk, draai en schuif; Ctrl-C stopt (LEDs gaan uit).');
  },

  async opname() {
    const naam = `opname-${args[0] ?? 'sessie'}`;
    const systeem = await midiOfStop();
    const { pad, logboek, sluit } = nieuwLogboek('opname', naam);
    const apparaten = maakApparaten({ systeem, klok: echteKlok, config, logboek, lpd8Profiel: laadLpd8Profiel() });
    let n = 0;
    for (const s of [apparaten.apc, apparaten.lpd8]) s.bij('gebeurtenis', () => { n++; if (n % 50 === 0) process.stdout.write(`\r${n} gebeurtenissen`); });
    bijStoppen(async () => { await apparaten.stop(); await sluit(); console.log(`\nOpname: ${pad}`); });
    apparaten.start();
    console.log(`Opname loopt naar ${pad}. Ctrl-C stopt.`);
  },

  help() {
    console.log(`varve-hub — opdrachten:
  doctor [--json]   overzicht: MIDI, controllers, poorten, apps
  proef [naam]      begeleide hardwareproef (${Object.keys(PROTOCOLLEN).join(', ')})
  testpatroon       regenboog op de APC + live wat binnenkomt
  opname [naam]     speelsessie opnemen in proef/`);
  },
};

const fn = /** @type {Record<string, () => Promise<void>|void>} */ (opdrachten)[opdracht];
if (!fn) { opdrachten.help(); process.exit(1); }
await fn();
