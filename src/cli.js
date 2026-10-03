#!/usr/bin/env node
// @ts-check
// varve-hub — opdrachten:
//   start [--poort N] [--host H] [--lan] [--zonder-midi] [--geen-drivers]
//                            de hub: controllers, kern, cockpit op http://localhost:7700, drivers
//                            --lan: ook op het netwerk (0.0.0.0), met token en mDNS (docs/NETWERK.md)
//   installeer [--weg] [--lokaal] [--node PAD]  altijd aan: launchd (macOS) / systemd --user (Linux)
//   token [--nieuw] [--poort N]  het token en de cockpit-adressen voor een tablet
//   doctor [--json]          overzicht: MIDI, controllers, poorten, apps
//   proef [naam]             begeleide hardwareproef (standaard f0-hardware), opgenomen in proef/
//   testpatroon              regenboog op de APC + live wat binnenkomt (Ctrl-C stopt)
//   opname [naam]            speelsessie opnemen in proef/ (Ctrl-C stopt)
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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
import { leesOfMaakToken, isLoopbackHost, lanNamen, mdnsNaam, lanOrigins, lanAdressen, cockpitAdressen, kondigAan, installeer, dienstVoor } from './lan.js';

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

/** Hoe je de hub stopt die als dienst draait (voor de melding 'poort bezet'), of null op een ander platform. */
function stopDienstRegel() {
  try { return dienstVoor({ hubMap: HUB_MAP }).ontlaad; } catch { return null; }
}

/**
 * Stoppen met een vaste fout (poort bezet, geen token). Onder launchd (KeepAlive) eerst een minuut wachten: anders
 * start launchd ons elke paar seconden opnieuw en loopt het logboek vol. systemd stopt zelf (RestartPreventExitStatus).
 * @param {number} code
 */
async function stopMetVasteFout(code) {
  if (process.env.VARVE_HUB_DIENST === 'launchd') {
    console.error('(launchd start de hub opnieuw; eerst 60 s wachten)');
    await new Promise((r) => setTimeout(r, 60000));
  }
  process.exit(code);
}

const opdrachten = {
  async start() {
    let systeem;
    if (args.includes('--zonder-midi')) systeem = zonderMidi();
    else {
      const r = await laadRtMidi();
      if (r.systeem) systeem = r.systeem;
      else { console.log(`Geen MIDI (${r.reden}) — de hub draait zonder controllers; gebruik de virtuele in de cockpit.`); systeem = zonderMidi(); }
    }
    const log = (/** @type {unknown[]} */ ...x) => console.log(...x);
    const poort = optie('--poort') ? Number(optie('--poort')) : config.poorten.http;
    // Op het netwerk = altijd met token: --lan, maar ook een --host of server.host die niet alleen loopback is.
    const host = optie('--host') ?? (args.includes('--lan') ? '0.0.0.0' : config.server?.host ?? '127.0.0.1');
    const lan = !isLoopbackHost(host);
    let hubConfig = config, token = null, namen = /** @type {string[]} */ ([]);
    if (lan) {
      const t = leesOfMaakToken();
      token = t.token;
      if (t.nieuw) console.log(`Nieuw token aangemaakt in ${t.pad} (alleen leesbaar voor jou).`);
      if (t.hersteld) console.log(`Rechten van ${t.pad} waren te ruim; hersteld naar 0600.`);
      namen = lanNamen({ extra: config.server?.lan_namen ?? [] });
      hubConfig = { ...config, server: { ...config.server, origins: [...(config.server?.origins ?? []), ...lanOrigins(namen, poort)] } };
    }
    let hub;
    try {
      hub = await startHub({
        config: hubConfig, systeem, poort, host, token,
        drivers: !args.includes('--geen-drivers'), lpd8Profiel: laadLpd8Profiel(), log,
      });
    } catch (e) {
      const code = /** @type {any} */ (e)?.code;
      if (code === 'GEEN_TOKEN') {
        // Vangnet in de server zelf: zonder token wordt er niet eens op het netwerk geluisterd.
        console.error(`${/** @type {Error} */ (e).message}. Start met --lan (dan maakt de hub een token).`);
        return stopMetVasteFout(4);
      }
      if (code !== 'EADDRINUSE' && code !== 'EACCES') throw e;
      const dienst = stopDienstRegel();
      console.error(code === 'EADDRINUSE'
        ? `poort ${poort} is bezet — draait de hub al (in een ander venster)? Stop die, of start met --poort N (apps dan met ?hub=ws://localhost:N, nep-apps met --url).` +
          (dienst ? `\nOf draait hij als dienst (node src/cli.js installeer)? Stop die met: ${dienst}` : '')
        : `poort ${poort} mag niet gebruikt worden (${code}) — kies een andere met --poort N.`);
      return stopMetVasteFout(3);
    }
    for (const [dev, s] of [['APC40', hub.apparaten.apc], ['LPD8', hub.apparaten.lpd8]]) {
      /** @type {any} */ (s).bij('verbonden', (/** @type {string} */ n) => console.log(`${dev} verbonden: ${n}`));
      /** @type {any} */ (s).bij('weg', () => console.log(`${dev} weg`));
    }
    hub.kern.bij('naarApp', () => {});
    const lokaal = `http://localhost:${hub.server.poort}`;
    console.log(`varve-hub draait. Cockpit: ${lan ? lokaal : hub.adres}   Apps: ${(lan ? lokaal : hub.adres).replace('http', 'ws')}/app   Ctrl-C stopt.`);
    /** @type {{ stop: () => void } | null} */
    let mdns = null;
    if (lan && token) {
      const adressen = cockpitAdressen({ namen, adressen: lanAdressen(), poort: hub.server.poort, token });
      // Het token alleen op een terminal tonen, niet in een logbestand (launchd/systemd).
      if (process.stdout.isTTY) console.log(`Op het netwerk (met token):\n${adressen.map((a) => `  ${a}`).join('\n')}`);
      else console.log(`Op het netwerk op poort ${hub.server.poort}; cockpit-adressen met token: node src/cli.js token --poort ${hub.server.poort} (in ${HUB_MAP})`);
      mdns = kondigAan({ poort: hub.server.poort, log });
    }
    bijStoppen(async () => { mdns?.stop(); await hub.stop(); });
  },

  installeer() {
    try {
      // --node: het pad zoals de shell het vindt (deploy/installeer.sh geeft `command -v node` mee).
      const node = optie('--node');
      const r = installeer({ hubMap: HUB_MAP, weg: args.includes('--weg'), lan: !args.includes('--lokaal'), ...(node && isAbsolute(node) ? { node } : {}) });
      console.log(r.regels.join('\n'));
    } catch (e) {
      console.error(/** @type {Error} */ (e).message);
      process.exit(1);
    }
  },

  token() {
    const t = leesOfMaakToken({ opnieuw: args.includes('--nieuw') });
    if (t.nieuw) console.log(`Nieuw token in ${t.pad}${args.includes('--nieuw') ? ' (herstart de hub; oude tablets moeten het nieuwe adres openen)' : ''}.`);
    const poort = optie('--poort') ? Number(optie('--poort')) : config.poorten.http;
    const namen = lanNamen({ extra: config.server?.lan_namen ?? [] });
    const adressen = cockpitAdressen({ namen, adressen: lanAdressen(), poort, token: t.token });
    const fluxHost = mdnsNaam(namen) ?? lanAdressen()[0] ?? '<mac>.local';
    console.log(`Token: ${t.token}\nCockpit op een tablet:\n${adressen.map((a) => `  ${a}`).join('\n')}\nflux: VARVE_HUB=ws://${fluxHost}:${poort}/app?token=${t.token}`);
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
  start             de hub: cockpit op http://localhost:7700 (--poort, --host, --lan, --zonder-midi, --geen-drivers)
                    --lan: ook op het netwerk, met token (~/.varve-hub/token) en mDNS
  installeer        altijd aan bij inloggen (launchd/systemd --user); --weg haalt weg, --lokaal zonder --lan
  token [--nieuw]   token en cockpit-adressen voor een tablet (--nieuw: ander token, --poort N)
  doctor [--json]   overzicht: MIDI, controllers, poorten, apps
  proef [naam]      begeleide hardwareproef (${Object.keys(PROTOCOLLEN).join(', ')})
  testpatroon       regenboog op de APC + live wat binnenkomt
  opname [naam]     speelsessie opnemen in proef/`);
  },
};

const fn = /** @type {Record<string, () => Promise<void>|void>} */ (opdrachten)[opdracht];
if (!fn) { opdrachten.help(); process.exit(1); }
await fn();
