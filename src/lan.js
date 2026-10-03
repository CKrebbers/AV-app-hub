// @ts-check
// Altijd aan + veilig netwerk (docs/NETWERK.md):
//   - het token in ~/.varve-hub/token (0600), aangemaakt bij de eerste `--lan`;
//   - de eigen LAN-namen (<naam>, <naam>.local) als toegestane origins/hosts voor de cockpit op een tablet;
//   - mDNS-aankondiging zonder npm-dependency: `dns-sd -R` (macOS) of `avahi-publish -s` (Linux) als kindproces;
//   - de dienst die de hub bij het inloggen start: launchd (macOS) of systemd --user (Linux). Nooit sudo.
// Alles wat de buitenwereld raakt (thuismap, hostnaam, netwerkkaarten, PATH, kindprocessen, tijd) is injecteerbaar.
import { randomBytes } from 'node:crypto';
import { spawn as echteSpawn, execFileSync } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, linkSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { echteKlok } from './core/klok.js';

// ── Token ────────────────────────────────────────────────────────────────────

/** @param {string} [home] */
export const tokenPad = (home = os.homedir()) => join(home, '.varve-hub', 'token');

/** Een nieuw token: 32 willekeurige bytes, URL-veilig (mag zo in ?token=). */
export const nieuwToken = () => randomBytes(32).toString('base64url');

const GELDIG = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * Lees het token, of maak het (eerste keer `--lan`). Map 0700, bestand 0600; te ruime rechten worden
 * hersteld en gemeld. Een leeg of onleesbaar bestand is een fout (nooit stilletjes een ander token).
 * @param {{ home?: string, maak?: () => string, opnieuw?: boolean }} [o] `opnieuw`: altijd een nieuw token schrijven
 * @returns {{ token: string, pad: string, nieuw: boolean, hersteld: boolean }}
 */
export function leesOfMaakToken({ home = os.homedir(), maak = nieuwToken, opnieuw = false } = {}) {
  const pad = tokenPad(home);
  mkdirSync(dirname(pad), { recursive: true, mode: 0o700 });
  if (opnieuw || !existsSync(pad)) {
    const token = maak();
    if (!GELDIG.test(token)) throw new Error('nieuw token is ongeldig');
    // Atomair: eerst volledig naar een eigen tijdelijk bestand (0600), dan in één stap op zijn plaats. Zo blijft er
    // nooit een leeg of half token staan (schijf vol), en wint bij twee tegelijk (dienst + `token`) één van de twee.
    const tmp = `${pad}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(tmp, token + '\n', { mode: 0o600, flag: 'wx' });
      chmodSync(tmp, 0o600);                                 // umask kan de mode hebben ingeperkt, nooit verruimd; toch vastzetten
      if (opnieuw) renameSync(tmp, pad);
      else linkSync(tmp, pad);                               // faalt met EEXIST als een ander net eerder was
      return { token, pad, nieuw: true, hersteld: false };
    } catch (e) {
      if (/** @type {any} */ (e)?.code !== 'EEXIST') throw e;
      // Een ander proces schreef het token net: dat lezen we hieronder.
    } finally {
      try { unlinkSync(tmp); } catch { /* al hernoemd of nooit gemaakt */ }
    }
  }
  let hersteld = false;
  if (process.platform !== 'win32' && (statSync(pad).mode & 0o077) !== 0) { chmodSync(pad, 0o600); hersteld = true; }
  const token = readFileSync(pad, 'utf8').trim();
  if (!GELDIG.test(token)) throw new Error(`${pad} bevat geen geldig token (16-256 tekens A-Z a-z 0-9 _ -). Haal het weg; de hub maakt een nieuw.`);
  return { token, pad, nieuw: false, hersteld };
}

// ── Namen en adressen ────────────────────────────────────────────────────────

/** Luistert de hub alleen op de eigen machine? @param {string|undefined} host */
export const isLoopbackHost = (host) => host === undefined || host === 'localhost' || host === '::1' || /^127\./.test(host);

/**
 * De mDNS-naam van een Mac (`scutil --get LocalHostName`, bv. "Clays-MacBook-Pro"), of null. Die wijkt vaak af van
 * os.hostname(): met een DHCP- of eigen HostName is dat bv. "clays-mbp.fritz.box". Elders: null.
 * @param {{ platform?: string, run?: (bin: string, args: string[]) => string }} [o]
 */
export function bonjourNaam({ platform = process.platform, run = (bin, args) => execFileSync(bin, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }) } = {}) {
  if (platform !== 'darwin') return null;
  try { return run('scutil', ['--get', 'LocalHostName']).trim() || null; } catch { return null; }
}

/**
 * De namen waaronder deze machine in het LAN te vinden is: de hostnaam, de Bonjour-naam (macOS) en <naam>.local.
 * De eerste naam die op .local eindigt is de mDNS-naam om te tonen (cockpit-adressen, flux-regel).
 * @param {{ hostnaam?: string, bonjour?: string|null, extra?: string[] }} [o]
 */
export function lanNamen({ hostnaam = os.hostname(), bonjour = bonjourNaam(), extra = [] } = {}) {
  const kaal = hostnaam.toLowerCase().replace(/\.local\.?$/, '').replace(/\.$/, '');
  const b = bonjour ? bonjour.toLowerCase().replace(/\.local\.?$/, '') : null;
  // Een hostnaam met domein (x.fritz.box): in mDNS heet hij <eerste deel>.local, niet x.fritz.box.local.
  const label = kaal.split('.')[0];
  const namen = [kaal, ...(b ? [`${b}.local`, b] : []), `${label}.local`, ...extra.map((n) => n.toLowerCase())]
    .filter((n) => /^[a-z0-9][a-z0-9.-]*$/.test(n) && n !== 'localhost');
  return [...new Set(namen)];
}

/** De mDNS-naam uit lanNamen (de eerste op .local), of null. @param {string[]} namen */
export const mdnsNaam = (namen) => namen.find((n) => n.endsWith('.local')) ?? null;

/** Origins voor de cockpit vanaf een tablet (http://<naam>:<poort>), voor `origins` van de server. @param {string[]} namen @param {number} poort */
export const lanOrigins = (namen, poort) => namen.map((n) => `http://${n}:${poort}`);

/** IPv4-adressen van de eigen netwerkkaarten (geen loopback). @param {ReturnType<typeof os.networkInterfaces>} [kaarten] */
export function lanAdressen(kaarten = os.networkInterfaces()) {
  /** @type {string[]} */
  const uit = [];
  for (const lijst of Object.values(kaarten)) for (const a of lijst ?? []) if (a.family === 'IPv4' && !a.internal) uit.push(a.address);
  return uit;
}

/** Cockpit-adressen om op een tablet te openen. @param {{ namen: string[], adressen: string[], poort: number, token: string }} o */
export const cockpitAdressen = ({ namen, adressen, poort, token }) =>
  [...namen.filter((n) => n.endsWith('.local')), ...adressen].map((h) => `http://${h}:${poort}/?token=${token}`);

// ── mDNS ─────────────────────────────────────────────────────────────────────

export const MDNS_TYPE = '_varvehub._tcp';

/** Bestaat dit programma in PATH (uitvoerbaar)? @param {string} naam @param {string} [pad] */
export function inPad(naam, pad = process.env.PATH ?? '') {
  for (const map of pad.split(delimiter)) {
    if (!map) continue;
    try { accessSync(join(map, naam), constants.X_OK); return true; } catch { /* volgende */ }
  }
  return false;
}

/**
 * Het commando dat de dienst aankondigt, of null als dit platform er geen heeft. Het token gaat nooit mee.
 * @param {{ platform: string, poort: number, naam: string }} o
 * @returns {{ bin: string, args: string[] } | null}
 */
export function mdnsCommando({ platform, poort, naam }) {
  const txt = ['pad=/cockpit', 'app=/app', 'v=1', 'token=nodig'];
  if (platform === 'darwin') return { bin: 'dns-sd', args: ['-R', naam, MDNS_TYPE, 'local', String(poort), ...txt] };
  if (platform === 'linux') return { bin: 'avahi-publish', args: ['-s', naam, MDNS_TYPE, String(poort), ...txt] };
  return null;
}

/** Na zoveel mislukte starts op rij (elk korter dan 60 s gelopen) geeft de aankondiging het op. */
export const MDNS_POGINGEN = 5;

/**
 * Kondig de hub aan via mDNS zolang hij draait. Bestaat dns-sd/avahi-publish niet, dan een melding en verder
 * niets (de hub werkt, alleen niet vindbaar via mDNS). Stopt het kindproces onverwacht, dan opnieuw na een
 * oplopende pauze (5 → 10 → … → 60 s, via de klok); na MDNS_POGINGEN mislukte starts op rij één melding en klaar
 * (bv. avahi-publish zonder draaiende avahi-daemon). Stopt de hub zelf (ook bij een crash), dan gaat het
 * kindproces mee: anders blijft de dienst als wees aangekondigd.
 * @param {{ poort: number, naam?: string, platform?: string, bestaat?: (bin: string) => boolean,
 *   spawn?: (bin: string, args: string[], o: object) => import('node:child_process').ChildProcess,
 *   klok?: import('./core/klok.js').Klok, log?: (...a: unknown[]) => void,
 *   proces?: { on: (e: 'exit', f: () => void) => unknown, off: (e: 'exit', f: () => void) => unknown } }} o
 * @returns {{ actief: boolean, commando: { bin: string, args: string[] } | null, stop: () => void }}
 */
export function kondigAan({ poort, naam = `Varve hub (${(lanNamen()[0] ?? 'hub').replace(/\.local$/, '')})`, platform = process.platform, bestaat = inPad, spawn = echteSpawn, klok = echteKlok, log = console.log, proces = process }) {
  const commando = mdnsCommando({ platform, poort, naam });
  if (!commando) { log(`mDNS: geen aankondiging op ${platform}; gebruik het IP-adres.`); return { actief: false, commando, stop() {} }; }
  if (!bestaat(commando.bin)) {
    log(`mDNS: ${commando.bin} niet gevonden, de hub wordt niet aangekondigd (${platform === 'linux' ? 'installeer avahi, ' : ''}gebruik anders het IP-adres).`);
    return { actief: false, commando, stop() {} };
  }
  let gestopt = false;
  /** @type {import('node:child_process').ChildProcess | null} */
  let kind = null;
  /** @type {any} */
  let timer = null;
  let pauze = 5000;
  let mislukt = 0;
  // Synchroon in 'exit' (ook na een onafgevangen fout): het kindproces niet als wees achterlaten.
  const bijExit = () => { try { kind?.kill(); } catch { /* al weg */ } };
  proces.on('exit', bijExit);
  const start = () => {
    timer = null;
    if (gestopt) return;
    const gestart = klok.nu();
    let p;
    try { p = spawn(commando.bin, commando.args, { stdio: 'ignore' }); } catch (e) { return opnieuw(`starten mislukte: ${/** @type {Error} */ (e).message}`); }
    kind = p;
    p.on('error', (e) => { if (kind === p) { kind = null; mislukt++; opnieuw(e.message); } });
    p.on('exit', (code, sig) => {
      if (kind !== p) return;
      kind = null;
      if (klok.nu() - gestart > 60000) { pauze = 5000; mislukt = 0; }   // liep een tijd goed: vanaf het begin
      else mislukt++;
      opnieuw(`gestopt (${sig ?? code})`);
    });
  };
  /** @param {string} waarom */
  const opnieuw = (waarom) => {
    if (gestopt || timer) return;
    if (mislukt >= MDNS_POGINGEN) {
      log(`mDNS: ${commando.bin} ${waarom}; na ${mislukt} pogingen op rij geef ik het op. De hub werkt gewoon, alleen niet vindbaar via mDNS` +
        `${platform === 'linux' ? ' (draait avahi-daemon? systemctl status avahi-daemon)' : ''}; gebruik het IP-adres.`);
      gestopt = true;
      proces.off('exit', bijExit);
      return;
    }
    log(`mDNS: ${commando.bin} ${waarom}; opnieuw over ${pauze / 1000} s.`);
    timer = klok.zet(start, pauze);
    pauze = Math.min(pauze * 2, 60000);
  };
  start();
  return {
    actief: true, commando,
    stop() {
      gestopt = true;
      proces.off('exit', bijExit);
      if (timer) klok.wis(timer);
      timer = null;
      const p = kind;
      kind = null;
      try { p?.kill(); } catch { /* al weg */ }
    },
  };
}

// ── Dienst: launchd / systemd --user ─────────────────────────────────────────

export const LAUNCHD_LABEL = 'nl.varve.hub';
export const SYSTEMD_NAAM = 'varve-hub.service';
const DEPLOY = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy');

/** @param {string} s */
const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** Eén argument voor ExecStart= (tussen aanhalingstekens; % en \ en " ontsnapt, en $ want systemd vult $NAAM
 *  ook binnen aanhalingstekens in). @param {string} s */
const systemdArg = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
/** Pad in een systemd-instelling zonder aanhalingstekens (WorkingDirectory=). @param {string} s */
const systemdPad = (s) => s.replace(/%/g, '%%');
/** @param {string} s */
const shell = (s) => (/^[A-Za-z0-9_./~:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Een node in een versiemap (Homebrew-Cellar, nvm, volta, fnm, asdf, mise): weg na een update of wissel. */
export const VERSIEMAP = /\/Cellar\/|\/\.nvm\/versions\/|\/\.volta\/tools\/|\/fnm\/node-versions\/|\/\.asdf\/installs\/|\/mise\/installs\//;

/**
 * Het pad naar node voor het dienstbestand: zoals de shell het vindt (`command -v node`, de eerste in PATH), níét
 * opgelost via symlinks. process.execPath is wél opgelost (/opt/homebrew/Cellar/node/22.x.y/bin/node) en bestaat
 * na `brew upgrade node` niet meer; /opt/homebrew/bin/node blijft. Geen node in PATH: process.execPath.
 * @param {{ PATH?: string, execPath?: string }} [o]
 */
export function stabielNode({ PATH = process.env.PATH ?? '', execPath = process.execPath } = {}) {
  for (const map of PATH.split(delimiter)) {
    if (!map || !map.startsWith('/')) continue;              // alleen absolute mappen: de dienst draait elders
    const p = join(map, 'node');
    try { accessSync(p, constants.X_OK); return p; } catch { /* volgende */ }
  }
  return execPath;
}

/**
 * Het dienstbestand voor dit platform, gevuld met het pad van deze checkout en deze node.
 * @param {{ platform?: string, home?: string, hubMap: string, node?: string, lan?: boolean, sjablonen?: string, PATH?: string }} o
 * @returns {{ soort: 'launchd'|'systemd', pad: string, inhoud: string, laad: string, ontlaad: string, log: string, extraWeg: string[], node: string }}
 */
export function dienstVoor({ platform = process.platform, home = os.homedir(), hubMap, PATH, node = stabielNode({ PATH }), lan = true, sjablonen = DEPLOY }) {
  const cli = join(hubMap, 'src', 'cli.js');
  const args = ['start', ...(lan ? ['--lan'] : [])];
  if (platform === 'darwin') {
    const pad = join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
    const log = join(home, 'Library', 'Logs', 'varve-hub.log');
    const inhoud = readFileSync(join(sjablonen, `${LAUNCHD_LABEL}.plist`), 'utf8')
      // Altijd met een functie vervangen: een pad met $&, $` of $$ is anders een vervangpatroon.
      .replace('{{ARGUMENTEN}}', () => [node, cli, ...args].map((a) => `<string>${xml(a)}</string>`).join('\n    '))
      .replaceAll('{{HUB}}', () => xml(hubMap))
      .replaceAll('{{LOG}}', () => xml(log));
    return {
      soort: 'launchd', pad, inhoud, log, node,
      laad: `launchctl bootstrap gui/$(id -u) ${shell(pad)}`,
      ontlaad: `launchctl bootout gui/$(id -u)/${LAUNCHD_LABEL}`,
      extraWeg: [],
    };
  }
  if (platform === 'linux') {
    const map = join(home, '.config', 'systemd', 'user');
    const inhoud = readFileSync(join(sjablonen, SYSTEMD_NAAM), 'utf8')
      .replace('{{EXEC}}', () => [node, cli, ...args].map(systemdArg).join(' '))
      .replaceAll('{{HUB}}', () => systemdPad(hubMap));
    return {
      soort: 'systemd', pad: join(map, SYSTEMD_NAAM), inhoud, node, log: `journalctl --user -u ${SYSTEMD_NAAM} -f`,
      laad: `systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_NAAM}`,
      ontlaad: `systemctl --user stop ${SYSTEMD_NAAM}; systemctl --user daemon-reload`,
      // Wat `enable` aanlegt; met het unitbestand weg kan `disable` het niet meer vinden, dus ruimen we het zelf op.
      extraWeg: [join(map, 'default.target.wants', SYSTEMD_NAAM)],
    };
  }
  throw new Error(`geen dienst voor platform ${platform} (alleen macOS/launchd en Linux/systemd --user)`);
}

/**
 * `node src/cli.js installeer [--weg]`: schrijf of verwijder het dienstbestand en vertel welke regel Clay moet draaien.
 * Weigert als root: een LaunchAgent/user-unit hoort bij Clay, niet bij root (nooit sudo).
 * @param {Parameters<typeof dienstVoor>[0] & { weg?: boolean, uid?: number }} o
 * @returns {{ regels: string[], pad: string, soort: string }}
 */
export function installeer({ weg = false, uid = process.getuid?.() ?? -1, ...o }) {
  if (uid === 0) throw new Error('niet als root of met sudo: de dienst hoort bij jouw gebruiker. Draai het zonder sudo.');
  const d = dienstVoor(o);
  if (weg) {
    const weggehaald = [d.pad, ...d.extraWeg].filter((p) => { try { unlinkSync(p); return true; } catch { return false; } });
    return {
      pad: d.pad, soort: d.soort,
      regels: [
        weggehaald.length ? `Weggehaald: ${weggehaald.join(', ')}` : `Er stond geen ${d.soort}-dienst (${d.pad}).`,
        'Stop de draaiende hub met:', `  ${d.ontlaad}`,
      ],
    };
  }
  mkdirSync(dirname(d.pad), { recursive: true });
  if (d.soort === 'launchd') mkdirSync(dirname(d.log), { recursive: true });
  const bestond = existsSync(d.pad);
  writeFileSync(d.pad, d.inhoud, { mode: 0o644 });
  return {
    pad: d.pad, soort: d.soort,
    regels: [
      `${bestond ? 'Bijgewerkt' : 'Geschreven'}: ${d.pad}`,
      bestond ? 'Laad hem opnieuw (eerst stoppen, dan laden):' : 'Laad hem met:',
      ...(bestond ? [`  ${d.ontlaad}`] : []),
      `  ${d.laad}`,
      `Logboek: ${d.log}`,
      `Node: ${d.node}`,
      ...(VERSIEMAP.test(d.node)
        ? [`Let op: deze node staat in een versiemap en verdwijnt bij een node-update (brew upgrade, nvm-wissel).${
          d.soort === 'launchd' ? ' Liever een vast pad, bv. /opt/homebrew/bin/node: zet dat eerst in PATH.' : ''}`]
        : []),
      `Na een node-update of verhuizen van de checkout: node src/cli.js installeer opnieuw (in ${o.hubMap}).`,
      `Weghalen: node src/cli.js installeer --weg (in ${o.hubMap})`,
    ],
  };
}
