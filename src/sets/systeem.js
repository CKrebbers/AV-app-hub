// @ts-check
// De echte wereld voor de starter: processen starten en stoppen, een URL in Chrome openen, kijken of een
// poort bezet is. Alles hier is klein en vervangbaar; de starter krijgt het geïnjecteerd (tests gebruiken nep).
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import net from 'node:net';

/**
 * Een gestart proces zoals de starter het ziet.
 * @typedef {{
 *   pid: number|undefined,
 *   bij: (naam: 'uitvoer'|'einde', fn: (x: any) => void) => void,
 *   stop: (sein?: NodeJS.Signals) => void,
 *   leeft: () => boolean,
 * }} Proces
 * @typedef {(o: { commando: string, cwd: string, omgeving: Record<string, string> }) => Proces} StartProces
 */

/** Hoe vaak na het einde van het commando gekeken wordt of zijn procesgroep leeg is. */
export const GROEP_KIJK_MS = 2000;

/**
 * Start een commando via de shell in een eigen procesgroep (`detached`). Zo kan de starter later alles
 * stoppen wat het commando zelf startte — ook wat `./start.sh` op de achtergrond zette, of vite onder
 * `npm run dev` — en krijgen de kinderen Ctrl-C van de terminal niet rechtstreeks (de starter ruimt op).
 *
 * Is de groep eenmaal leeg gezien, dan krijgt hij nooit meer een sein: zijn nummer kan na een lange avond
 * hergebruikt zijn voor een heel ander proces (macOS: pid-max ±99999). Daarom wordt na het einde van het
 * commando om de GROEP_KIJK_MS gekeken tot de groep leeg is (zolang er nog iets in zit, wordt het nummer niet
 * hergebruikt).
 * @param {{ commando: string, cwd: string, omgeving: Record<string, string> }} o
 * @param {{ kill?: (pid: number, sein: NodeJS.Signals|0) => unknown, kijkMs?: number }} [x] (tests)
 * @returns {Proces}
 */
export function startProces({ commando, cwd, omgeving }, { kill = (pid, sein) => process.kill(pid, sein), kijkMs = GROEP_KIJK_MS } = {}) {
  const p = spawn(commando, { cwd, env: { ...process.env, ...omgeving }, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  /** @type {{ uitvoer: ((x: any) => void)[], einde: ((x: any) => void)[] }} */
  const l = { uitvoer: [], einde: [] };
  let klaar = false;
  /** De groep is leeg gezien: nooit meer signaleren. */
  let leeg = p.pid === undefined;
  /** @type {ReturnType<typeof setInterval>|null} */
  let kijker = null;
  const groepLeeft = () => {
    if (leeg) return false;
    try { kill(-(/** @type {number} */ (p.pid)), 0); return true; } catch { leeg = true; if (kijker) clearInterval(kijker); return false; }
  };
  const meld = (/** @type {'uitvoer'|'einde'} */ n, /** @type {any} */ x) => { for (const fn of l[n]) fn(x); };
  for (const s of [p.stdout, p.stderr]) s?.on('data', (/** @type {Buffer} */ d) => meld('uitvoer', String(d)));
  p.on('error', (e) => { if (klaar) return; klaar = true; meld('einde', { code: null, fout: e.message }); });
  p.on('exit', (code, sein) => {
    if (!leeg && groepLeeft()) { kijker = setInterval(groepLeeft, kijkMs); kijker.unref(); }
    if (klaar) return; klaar = true; meld('einde', { code, sein });
  });
  return {
    pid: p.pid,
    bij: (naam, fn) => { l[naam].push(fn); },
    // Een negatieve pid = de hele procesgroep. Is de groep al weg (ESRCH), dan is er niets te doen.
    stop: (sein = 'SIGTERM') => {
      if (!groepLeeft()) return;
      try { kill(-(/** @type {number} */ (p.pid)), sein); } catch { /* net weg */ }
    },
    leeft: groepLeeft,
  };
}

/** Programma's die als Chrome tellen buiten macOS, in deze volgorde gezocht in PATH (check en de starter). */
export const CHROME_LINUX = Object.freeze(['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']);

/** @param {string} p */
const uitvoerbaar = (p) => { try { accessSync(p, constants.X_OK); return true; } catch { return false; } };

/**
 * Chrome buiten macOS: het pad of de naam uit config.json (`linux.chrome`), anders de eerste uit CHROME_LINUX in PATH.
 * Null = niet gevonden (dan xdg-open).
 * @param {{ chrome?: string|null, pad?: string, kan?: (p: string) => boolean }} [o] kan: is dit bestand uitvoerbaar (tests)
 * @returns {string|null}
 */
export function vindChrome({ chrome = null, pad = process.env.PATH ?? '', kan = uitvoerbaar } = {}) {
  const inPad = (/** @type {string} */ naam) => pad.split(delimiter).filter(Boolean).map((m) => join(m, naam)).find(kan) ?? null;
  if (typeof chrome === 'string' && chrome.trim()) {
    const c = chrome.trim();
    if (isAbsolute(c)) return kan(c) ? c : null;
    return inPad(c);
  }
  for (const n of CHROME_LINUX) { const p = inPad(n); if (p) return p; }
  return null;
}

/**
 * Open een URL in Chrome: macOS `open -a "Google Chrome" <url>`; Linux `<chrome> --new-window <url>` (vindChrome,
 * `linux.chrome` uit config.json), en als dat niet lukt of er geen Chrome is: `xdg-open <url>` (de standaardbrowser).
 * Chrome start op Linux zelf door als hij nog niet liep: dan geldt "gestart" (het spawn-event) als gelukt.
 * @param {string} [platform] @param {typeof spawn} [start] (tests)
 * @param {{ chrome?: string|null, pad?: string, kan?: (p: string) => boolean, log?: (t: string) => void }} [o] zie vindChrome
 * @returns {(url: string) => Promise<void>}
 */
export function openInChrome(platform = process.platform, start = spawn, o = {}) {
  /** @param {string} cmd @param {string[]} args @param {boolean} gestartIsGenoeg */
  const draai = (cmd, args, gestartIsGenoeg) => new Promise((goed, fout) => {
    const p = start(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', (e) => fout(new Error(`${cmd} lukt niet: ${e.message}`)));
    if (gestartIsGenoeg) p.on('spawn', () => goed(undefined));
    p.on('exit', (code) => (code === 0 ? goed(undefined) : fout(new Error(`${cmd} stopte met code ${code}`))));
    p.unref();
  });
  if (platform === 'darwin') return (url) => /** @type {Promise<void>} */ (draai('open', ['-a', 'Google Chrome', url], false));
  const chrome = vindChrome(o);
  const xdg = (/** @type {string} */ url) => /** @type {Promise<void>} */ (draai('xdg-open', [url], false));
  if (!chrome) return xdg;
  return (url) => /** @type {Promise<void>} */ (draai(chrome, ['--new-window', url], true).catch((e) => {
    o.log?.(`${e.message} — ik probeer xdg-open`);
    return xdg(url);
  }));
}

/**
 * Is er iets dat luistert op deze poort? Probeert 127.0.0.1 én ::1 (vite op macOS luistert soms alleen op ::1).
 * @param {number} poort @param {number} [ms] time-out per poging
 * @returns {Promise<boolean>}
 */
export async function poortOpen(poort, ms = 400) {
  const probeer = (/** @type {string} */ host) => new Promise((goed) => {
    const s = net.connect({ host, port: poort });
    const klaar = (/** @type {boolean} */ ja) => { s.destroy(); goed(ja); };
    s.setTimeout(ms, () => klaar(false));
    s.once('connect', () => klaar(true));
    s.once('error', () => klaar(false));
  });
  if (await probeer('127.0.0.1')) return true;
  return probeer('::1');
}
