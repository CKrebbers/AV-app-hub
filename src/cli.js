#!/usr/bin/env node
// @ts-check
// varve-hub — opdrachten:
//   start [set] [--poort N] [--host H] [--lan] [--zonder-midi] [--geen-drivers] [--zonder-chrome] [--uitvoer] [--zonder-geheugen]
//                            de hub: controllers, kern, cockpit op http://localhost:7700, drivers, geheugen;
//                            met een set (sets/<set>.json) ook alle apps van die avond (docs/SETS.md)
//                            --lan: ook op het netwerk (0.0.0.0), met token en mDNS (docs/NETWERK.md)
//   installeer [--weg] [--lokaal] [--node PAD]  altijd aan: launchd (macOS) / systemd --user (Linux)
//   token [--nieuw] [--poort N]  het token en de cockpit-adressen voor een tablet
//   doctor [--json]          overzicht: MIDI, controllers, poorten, apps
//   check [set] [--json] [--lan] [--poort N]
//                            vlak vóór een optreden: alles nalopen, per punt ✓/!/✗ en wat te doen (docs/CHECK.md);
//                            exitcode 1 als er iets ✗ is
//   proef [naam]             begeleide hardwareproef (standaard f0-hardware), opgenomen in proef/
//   testpatroon              regenboog op de APC + live wat binnenkomt (Ctrl-C stopt)
//   opname [naam]            speelsessie opnemen in proef/ (Ctrl-C stopt)
//   herhaal <bestand> [--snelheid x] [--hub adres] [--zonder-beginstand]
//                            een opgenomen avond (avondmap, LPD8-pad 4) opnieuw afspelen tegen een draaiende hub
//   spiekbrief <set|alle> [--uit bestand.html]
//                            wat doet welke knop, per set: een HTML om te printen (A4 liggend), zonder hub (docs/SPIEKBRIEF.md)
import { createWriteStream, existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import readline from 'node:readline';
import { laadConfig, laadLpd8Profiel, HUB_MAP, LPD8_PROFIEL_PAD } from './config.js';
import { laadRtMidi } from './ports/rtmidi.js';
import { maakApparaten } from './apparaten.js';
import { echteKlok } from './core/klok.js';
import { Logboek } from './core/logboek.js';
import { doctor, tcpOpen } from './doctor.js';
import { voerUit, terminalIO } from './proef/runner.js';
import { PROTOCOLLEN } from './proef/index.js';
import * as A from './devices/apc40mk2.js';
import { startHub } from './hub.js';
import { geheugenPad } from './opslag.js';
import { NepSysteem } from './ports/nep.js';
import { laadSet, laadPaden, lijstSets, startSet, kernToegang, cockpitToegang, startProces, openInChrome, poortOpen, PADEN_PAD, toonPad } from './sets/index.js';
import { leesOpname, herhaal, verslag } from './opname/herhaal.js';
import { doelVanCockpit } from './opname/cockpit-doel.js';
import { GEBAREN } from './opname/opnemer.js';
import { check, tekstVan, jsonVan } from './check/index.js';
import { schrijfSpiekbrief } from './spiekbrief/index.js';
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

/**
 * Netjes afsluiten bij Ctrl-C (SIGINT), kill (SIGTERM) en bij het sluiten van het Terminal-venster (SIGHUP):
 * LEDs uit, poorten dicht, logboek dicht, gestarte apps dicht.
 * @param {() => Promise<void>|void} opruimen
 */
function bijStoppen(opruimen) {
  let bezig = false;
  const stop = async () => {
    // Tweede Ctrl-C terwijl het opruimen nog loopt (bv. een hangende schijf): meteen weg.
    if (bezig) { console.error('\nNogmaals gestopt — afsluiten zonder verder op te ruimen.'); process.exit(1); }
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

/** Hoe je de hub stopt die als dienst draait (voor de melding 'poort bezet'), of null op een ander platform. */
function stopDienstRegel() {
  try { return dienstVoor({ hubMap: HUB_MAP }).ontlaad; } catch { return null; }
}

/**
 * Draait er al een hub (poort uit config.json bezet)? Dan openen twee processen de APC en vechten de lampjes:
 * proef en opname stoppen dan met een duidelijke melding. Zelfde poortcheck als doctor.
 * @param {string} wat
 */
async function geenHubErnaast(wat) {
  const poort = config.poorten.http;
  if (!(await tcpOpen(poort))) return;
  console.error(`Er draait al iets op poort ${poort} — waarschijnlijk de hub (in een ander venster, of als dienst na 'installeer').`
    + ` Stop die eerst: de ${wat} opent de APC40 en LPD8 zelf, en twee programma's tegelijk laten de lampjes vechten.`
    + (process.platform === 'darwin' ? ' Als dienst: launchctl bootout gui/$(id -u)/nl.varve.hub' : ''));
  process.exit(3);
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
    // Op het netwerk = altijd met token: --lan, maar ook een --host of server.host die niet alleen loopback is.
    const host = optie('--host') ?? (args.includes('--lan') ? '0.0.0.0' : config.server?.host ?? '127.0.0.1');
    const lan = !isLoopbackHost(host);
    let hubConfig = config, token = null, namen = /** @type {string[]} */ ([]);
    if (lan) {
      const t = leesOfMaakToken();
      token = t.token;
      if (t.nieuw) console.log(`Nieuw token aangemaakt in ${t.pad} (alleen leesbaar voor jou).`);
      if (t.hersteld) console.log(`Rechten van ${t.pad} waren te ruim (anderen konden het token lezen); hersteld naar 0600. Maak voor de zekerheid een nieuw token: node src/cli.js token --nieuw`);
      namen = lanNamen({ extra: config.server?.lan_namen ?? [] });
      hubConfig = { ...config, server: { ...config.server, origins: [...(config.server?.origins ?? []), ...lanOrigins(namen, poort)] } };
    }
    let hub;
    try {
      hub = await startHub({
        config: hubConfig, systeem, poort, host, token,
        drivers: !args.includes('--geen-drivers'), lpd8Profiel: laadLpd8Profiel(), log,
        // Snapshots en truth:"hub"-waarden over een herstart heen (config.json → geheugen.pad, $VARVE_HUB_STAAT).
        geheugen: args.includes('--zonder-geheugen') ? null : geheugenPad(config),
      });
    } catch (e) {
      const code = /** @type {any} */ (e)?.code;
      if (code === 'GEEN_TOKEN') {
        // Vangnet in de server zelf: zonder token wordt er niet eens op het netwerk geluisterd.
        console.error(`${/** @type {Error} */ (e).message}. Start met --lan (dan maakt de hub een token).`);
        return stopMetVasteFout(4);
      }
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
    console.log(hub.opslag ? `Geheugen: ${hub.opslag.pad}` : 'Geheugen uit: snapshots en waarden gaan bij stoppen verloren.');
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
    const stopHub = async () => { mdns?.stop(); await hub.stop(); };
    if (set) draaiSet(set, kernToegang(hub.kern), hub.server.poort, stopHub);
    else bijStoppen(stopHub);
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

  async check() {
    const ruw = optie('--poort');
    const poort = args.includes('--poort') ? Number(ruw) : undefined;
    if (poort !== undefined && !(Number.isInteger(poort) && poort > 0 && poort < 65536)) {
      console.error(`--poort moet een poortnummer zijn (1-65535), niet "${ruw ?? ''}"`);
      process.exit(2);
    }
    const r = await check({ config, laadMidi: laadRtMidi, set: setNaam() ?? null, lan: args.includes('--lan'), ...(poort ? { poort } : {}) });
    // Geen process.exit hier: een pipe naar stdout (check --json | script) is op macOS asynchroon en kan nog vol zitten.
    console.log(args.includes('--json') ? JSON.stringify(jsonVan(r), null, 2) : tekstVan(r));
    process.exitCode = r.code;
  },

  async proef() {
    const naam = args[0] ?? 'f0-hardware';
    const protocol = PROTOCOLLEN[naam];
    if (!protocol) { console.error(`Onbekende proef "${naam}". Beschikbaar: ${Object.keys(PROTOCOLLEN).join(', ')}`); process.exit(1); }
    await geenHubErnaast('proef');
    const systeem = await midiOfStop();
    const { pad, logboek, sluit } = nieuwLogboek('proef', naam);
    const apparaten = maakApparaten({ systeem, klok: echteKlok, config, logboek, lpd8Profiel: laadLpd8Profiel() });
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const opruimen = async () => { await apparaten.stop(); rl.close(); await sluit(); console.log(`\nLogboek: ${pad}`); };
    bijStoppen(opruimen);
    apparaten.start();
    const bevindingen = await voerUit(protocol, { apparaten, io: terminalIO(rl), klok: echteKlok, logboek, config });
    const prof = /** @type {any} */ (bevindingen['lpd8-profiel'])?.profiel;
    if (prof && !prof.pads.some((/** @type {any} */ p) => p.n < 0)) {
      writeFileSync(LPD8_PROFIEL_PAD, JSON.stringify(prof, null, 2) + '\n');
      console.log(`LPD8-profiel bewaard in ${LPD8_PROFIEL_PAD}`);
    }
    console.log('\nSamenvatting:\n' + JSON.stringify(bevindingen, null, 2));
    await opruimen();
    console.log('\nPush dit bestand zodat Claude het kan verwerken (zie ook docs/HARDWARE-AVOND.md, blok 6):\n' +
      `  git add proef/\n  git add lpd8-profiel.json   # als dat bestand er is\n  git commit -m "proef ${naam}" && git push`);
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
    await geenHubErnaast('opname');
    const systeem = await midiOfStop();
    const { pad, logboek, sluit } = nieuwLogboek('opname', naam);
    const lpd8Profiel = laadLpd8Profiel();
    // Het profiel in het logboek, zodat de golden test de LPD8-bytes van deze opname met hetzelfde profiel leest.
    if (lpd8Profiel) logboek.regel('bevinding', { id: 'lpd8-profiel', data: { profiel: lpd8Profiel } });
    const apparaten = maakApparaten({ systeem, klok: echteKlok, config, logboek, lpd8Profiel });
    let n = 0;
    for (const s of [apparaten.apc, apparaten.lpd8]) s.bij('gebeurtenis', () => { n++; if (n % 50 === 0) process.stdout.write(`\r${n} gebeurtenissen`); });
    bijStoppen(async () => { await apparaten.stop(); await sluit(); console.log(`\nOpname: ${pad}`); });
    apparaten.start();
    console.log(`Opname loopt naar ${pad}. Ctrl-C stopt.`);
  },

  async herhaal() {
    const bestand = args[0] && !args[0].startsWith('--') ? args[0] : undefined;
    if (!bestand) { console.error('Gebruik: npm run herhaal -- <avondmap of gebaren.jsonl> [--snelheid x] [--hub adres] [--zonder-beginstand]'); process.exit(2); }
    const ruw = optie('--snelheid');
    const zonderWaarde = ruw === undefined || ruw.startsWith('--');
    const snelheid = args.includes('--snelheid') ? (zonderWaarde ? NaN : Number(ruw)) : 1;
    if (!(snelheid > 0) || !Number.isFinite(snelheid)) { console.error(`--snelheid moet een getal > 0 zijn (bv. 2 = twee keer zo snel), niet "${zonderWaarde ? '' : ruw}"`); process.exit(2); }
    let opname;
    try {
      const pad = statSync(bestand).isDirectory() ? join(bestand, GEBAREN) : bestand;
      opname = leesOpname(readFileSync(pad, 'utf8'));
    } catch (e) {
      const x = /** @type {any} */ (e);
      console.error(x?.code === 'ENOENT' ? `${bestand} bestaat niet` : `${bestand} is geen leesbare opname: ${x?.message ?? x}`);
      process.exit(2);
    }
    const adres = optie('--hub') ?? `127.0.0.1:${config.poorten.http}`;
    let doel;
    try { doel = await doelVanCockpit(adres); } catch (e) { console.error(/** @type {any} */ (e).message); process.exit(2); }
    const invoer = opname.stappen.filter((s) => 'dev' in s);
    const laatste = invoer.at(-1)?.ms ?? 0;
    const eerste = invoer[0]?.ms ?? 0;
    console.log(`Avond van ${opname.kop.begon ?? '?'} (hub ${String(opname.kop['hub-git'] ?? opname.eind?.['hub-git'] ?? '?').slice(0, 10)}), ${invoer.length} gebaren,`
      + ` ±${((laatste - eerste) / 1000 / snelheid).toFixed(1)} s afspelen${snelheid !== 1 ? ` (×${snelheid})` : ''}.`);
    const nu = new Set(doel.apps);
    const mist = Object.keys(opname.eind?.apps ?? opname.beginstand?.apps ?? {}).filter((a) => !nu.has(a));
    if (mist.length) console.log(`Let op: niet verbonden met de hub: ${mist.join(', ')}`);
    if (opname.kapot) console.log(`Let op: ${opname.kapot} onleesbare regel(s) overgeslagen.`);
    const beginstand = !args.includes('--zonder-beginstand');
    const toen = Object.keys(opname.beginstand?.snapshots ?? {}).map(Number);
    if (beginstand) {
      console.log('Let op: herhaal zet je apps terug op de stand van toen'
        + (toen.length ? ` en overschrijft snapshot ${toen.join(', ')} in de hub` : '')
        + ' — doe het niet midden in een set (--zonder-beginstand slaat dit over).');
    }
    const extra = doel.snapshots.filter((nr) => !toen.includes(nr));
    if (extra.length) console.log(`Let op: snapshot ${extra.join(', ')} staat nu in de hub maar was leeg bij het begin van de opname; laden met een korte LPD8-druk op een toen lege plek wordt overgeslagen, laden via de APC-scèneknoppen niet.`);
    let gedaan = 0, totaal = invoer.length;
    let r;
    try {
      r = await herhaal({
        opname, doel, klok: echteKlok, snelheid, beginstand, aanwezig: nu,
        bijStap: (i, n) => { gedaan = i; totaal = n; if (i % 100 === 0 || i === n) process.stdout.write(`\r${i}/${n}`); },
      });
      await doel.sluit();
    } catch (e) {
      console.error(`\nherhaal afgebroken na ${gedaan}/${totaal} gebaren: ${/** @type {any} */ (e)?.message ?? e}\n`
        + 'Draait varve-hub nog? Start hem opnieuw (npm start) en herhaal de avond.');
      process.exit(2);
    }
    console.log('\n' + verslag(r));
    process.exit(r.verschillen?.length ? 1 : 0);
  },

  spiekbrief() {
    const uit = optie('--uit');
    const naam = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--uit');
    if (!naam || (args.includes('--uit') && !uit)) {
      console.error(`gebruik: varve-hub spiekbrief <set|alle> [--uit bestand.html] — sets: ${lijstSets().join(', ') || '(geen)'}`);
      process.exit(1);
    }
    let r;
    try {
      // Een relatief --uit-pad geldt vanaf waar Clay het typte (npm run zet de map anders op die van de hub).
      r = schrijfSpiekbrief(naam, { config, uit: uit && resolve(process.env.INIT_CWD ?? process.cwd(), uit), gemaakt: new Date() });
    } catch (e) {
      console.error(/** @type {Error} */ (e).message);
      process.exit(1);
    }
    for (const b of r.brieven) {
      const volgt = b.apps.filter((a) => a.soort === 'volgt' || a.soort === 'fout').map((a) => a.naam);
      console.log(`${b.set.naam}: ${b.apps.map((a) => a.naam).join(', ')}${volgt.length ? ` — indeling volgt als ${volgt.join(', ')} zich meldt` : ''}`);
    }
    console.log(`spiekbrief → ${r.pad}\nOpen hem in Chrome en druk ⌘P (A4 liggend). Draait de hub, dan staat hij ook live op http://localhost:${config.poorten?.http ?? 7700}/spiekbrief`);
  },

  help() {
    console.log(`varve-hub — opdrachten:
  start [set]       de hub: cockpit op http://localhost:7700 (--poort, --host, --lan, --zonder-midi, --geen-drivers, --zonder-geheugen);
                    met een set ook de apps van die avond (${lijstSets().join(', ') || 'geen sets'}; --zonder-chrome, --uitvoer)
                    --lan: ook op het netwerk, met token (~/.varve-hub/token) en mDNS
  installeer        altijd aan bij inloggen (launchd/systemd --user); --weg haalt weg, --lokaal zonder --lan
  token [--nieuw]   token en cockpit-adressen voor een tablet (--nieuw: ander token, --poort N)
  doctor [--json]   overzicht: MIDI, controllers, poorten, apps
  check [set]       vlak vóór een optreden: hub, controllers, proef, geheugen, avondmap, Chrome en de apps van de set
                    (--json, --lan: ook het token, --poort N); per punt ✓/!/✗ en wat te doen, exitcode 1 bij een ✗
  proef [naam]      begeleide hardwareproef (${Object.keys(PROTOCOLLEN).join(', ')})
  testpatroon       regenboog op de APC + live wat binnenkomt
  opname [naam]     speelsessie opnemen in proef/
  herhaal <bestand> opgenomen avond opnieuw afspelen tegen een draaiende hub (--snelheid x, --hub adres, --zonder-beginstand)
  spiekbrief <set>  wat doet welke knop: HTML om te printen, zonder hub (alle = elke set een pagina; --uit bestand.html)`);
  },
};

const fn = /** @type {Record<string, () => Promise<void>|void>} */ (opdrachten)[opdracht];
if (!fn) { opdrachten.help(); process.exit(1); }
await fn();
