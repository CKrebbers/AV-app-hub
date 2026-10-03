#!/usr/bin/env node
// @ts-check
// varve-hub — opdrachten:
//   start [set] [--poort N] [--host H] [--zonder-midi] [--geen-drivers] [--zonder-chrome] [--uitvoer]
//                            de hub: controllers, kern, cockpit op http://localhost:7700, drivers;
//                            met een set (sets/<set>.json) ook alle apps van die avond (docs/SETS.md)
//   doctor [--json]          overzicht: MIDI, controllers, poorten, apps
//   proef [naam]             begeleide hardwareproef (standaard f0-hardware), opgenomen in proef/
//   testpatroon              regenboog op de APC + live wat binnenkomt (Ctrl-C stopt)
//   opname [naam]            speelsessie opnemen in proef/ (Ctrl-C stopt)
import { createWriteStream, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
import { startHub } from './hub.js';
import { NepSysteem } from './ports/nep.js';
import { laadSet, laadPaden, lijstSets, startSet, kernToegang, cockpitToegang, startProces, openInChrome, poortOpen, PADEN_PAD, toonPad } from './sets/index.js';

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

/**
 * Netjes afsluiten bij Ctrl-C (SIGINT), kill (SIGTERM) en bij het sluiten van het Terminal-venster (SIGHUP):
 * LEDs uit, poorten dicht, logboek dicht, gestarte apps dicht.
 * @param {() => Promise<void>|void} opruimen
 */
function bijStoppen(opruimen) {
  let bezig = false;
  const stop = async () => {
    if (bezig) return;
    bezig = true;
    try { await opruimen(); } catch (e) { console.error(e); process.exit(1); }
    process.exit(0);
  };
  for (const sein of /** @type {const} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) process.on(sein, stop);
}

/**
 * Zonder echte MIDI: geen controllers (alleen de virtuele in de cockpit) en ook geen virtuele poorten.
 * Een nep-poort "VARVE-HUB TD" zou alleen in het geheugen bestaan; zonder `virtueel` slaat
 * startDrivers de MIDI-drivers over en zegt dat (TD en Logic krijgen geen poort).
 * @returns {import('./ports/poort.js').Systeem}
 */
function zonderMidi() {
  const nep = new NepSysteem();
  return { soort: 'geen', lijst: () => nep.lijst(), open: (naam) => nep.open(naam) };
}

/** @param {string} naam */
const optie = (naam) => { const i = args.indexOf(naam); return i >= 0 ? args[i + 1] : undefined; };

/**
 * Start de apps van een set naast een hub (in dit proces of een die al draaide). Ctrl-C ruimt op wat de
 * starter zelf startte, daarna `naStop` (de hub stoppen, of de cockpitverbinding sluiten).
 * @param {import('./sets/set.js').SetDef} set @param {import('./sets/toegang.js').KernToegang} hub
 * @param {number} hubPoort @param {() => Promise<void>|void} naStop
 */
function draaiSet(set, hub, hubPoort, naStop) {
  const log = (/** @type {string} */ r) => console.log(r);
  const openUrl = args.includes('--zonder-chrome') ? null : openInChrome();
  // Een venster dat dichtgaat geeft EPIPE/EIO op stdout: dat mag het opruimen niet afbreken.
  for (const s of [process.stdout, process.stderr]) s.on('error', () => {});
  let paden = {};
  if (!existsSync(PADEN_PAD)) console.log(`${toonPad(PADEN_PAD)} ontbreekt — doe eenmalig: cp sets/paden.voorbeeld.json sets/paden.json en zet je mappen erin (docs/SETS.md)`);
  try { paden = laadPaden(); } catch (e) { console.error(/** @type {Error} */ (e).message); }
  const s = startSet({ set, config, paden, hub, hubPoort, klok: echteKlok, startProces, openUrl, poortOpen, log, toonUitvoer: args.includes('--uitvoer') });
  // Vangnet: valt dit proces weg zonder dat stop() kon lopen (een fout, process.exit elders), dan krijgen de
  // eigen apps toch SIGTERM — anders blijven ze als wees draaien en houden ze hun poort bezet.
  process.on('exit', () => s.stopNu());
  bijStoppen(async () => { console.log('\nStoppen…'); await s.stop(); await naStop(); });
  s.klaar
    .then((u) => { if (u.some((x) => !x.klaar)) console.log('De hub blijft draaien; start wat mist met de hand of los het op en draai de set opnieuw. Ctrl-C stopt alles wat de set startte.'); })
    .catch((e) => console.error(`De starter liep vast: ${/** @type {Error} */ (e)?.message ?? e} — de hub draait door; Ctrl-C stopt alles wat de set startte.`));
}

/** De setnaam: het eerste argument dat geen optie (of de waarde van een optie) is. */
function setNaam() {
  const metWaarde = new Set(['--poort', '--host']);
  for (let i = 0; i < args.length; i++) {
    if (metWaarde.has(args[i])) { i++; continue; }
    if (!args[i].startsWith('--')) return args[i];
  }
  return undefined;
}

const opdrachten = {
  async start() {
    const naam = setNaam();
    let set = null;
    if (naam) {
      try { set = laadSet(naam, { config }); } catch (e) { console.error(/** @type {Error} */ (e).message); process.exit(1); }
    }
    let systeem;
    if (args.includes('--zonder-midi')) systeem = zonderMidi();
    else {
      const r = await laadRtMidi();
      if (r.systeem) systeem = r.systeem;
      else { console.log(`Geen MIDI (${r.reden}) — de hub draait zonder controllers; gebruik de virtuele in de cockpit.`); systeem = zonderMidi(); }
    }
    const log = (/** @type {unknown[]} */ ...x) => console.log(...x);
    const poort = optie('--poort') ? Number(optie('--poort')) : config.poorten.http;
    let hub;
    try {
      hub = await startHub({
        config, systeem, poort, host: optie('--host'),
        drivers: !args.includes('--geen-drivers'), lpd8Profiel: laadLpd8Profiel(), log,
      });
    } catch (e) {
      const code = /** @type {any} */ (e)?.code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw e;
      if (set && code === 'EADDRINUSE') {
        // Er draait al een hub: niet opnieuw starten, alleen verbinden (als cockpit) en de set erbij zetten.
        try {
          const toegang = await cockpitToegang(`ws://localhost:${poort}/cockpit`, { log: (r) => console.log(r) });
          console.log(`Er draait al een hub op poort ${poort} — de set "${set.naam}" verbindt daarmee.`);
          draaiSet(set, toegang, poort, () => toegang.sluit());
          return;
        } catch (f) {
          console.error(`poort ${poort} is bezet, maar daar antwoordt geen hub (${/** @type {Error} */ (f).message}).`);
        }
      }
      console.error(code === 'EADDRINUSE'
        ? `poort ${poort} is bezet — draait de hub al (in een ander venster)? Stop die, of start met --poort N (apps dan met ?hub=ws://localhost:N, nep-apps met --url).`
        : `poort ${poort} mag niet gebruikt worden (${code}) — kies een andere met --poort N.`);
      process.exit(3);
    }
    for (const [dev, s] of [['APC40', hub.apparaten.apc], ['LPD8', hub.apparaten.lpd8]]) {
      /** @type {any} */ (s).bij('verbonden', (/** @type {string} */ n) => console.log(`${dev} verbonden: ${n}`));
      /** @type {any} */ (s).bij('weg', () => console.log(`${dev} weg`));
    }
    hub.kern.bij('naarApp', () => {});
    console.log(`varve-hub draait. Cockpit: ${hub.adres}   Apps: ${hub.adres.replace('http', 'ws')}/app   Ctrl-C stopt.`);
    if (set) { const h = hub; draaiSet(set, kernToegang(h.kern), Number(new URL(h.adres).port), () => h.stop()); }
    else bijStoppen(() => hub.stop());
  },

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
  start [set]       de hub: cockpit op http://localhost:7700 (--poort, --host, --zonder-midi, --geen-drivers);
                    met een set ook de apps van die avond (${lijstSets().join(', ') || 'geen sets'}; --zonder-chrome, --uitvoer)
  doctor [--json]   overzicht: MIDI, controllers, poorten, apps
  proef [naam]      begeleide hardwareproef (${Object.keys(PROTOCOLLEN).join(', ')})
  testpatroon       regenboog op de APC + live wat binnenkomt
  opname [naam]     speelsessie opnemen in proef/`);
  },
};

const fn = /** @type {Record<string, () => Promise<void>|void>} */ (opdrachten)[opdracht];
if (!fn) { opdrachten.help(); process.exit(1); }
await fn();
