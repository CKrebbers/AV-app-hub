// @ts-check
// Processen voor de generale repetitie (tools/repetitie.mjs): starten, wachten tot ze antwoorden, en vooral
// weer opruimen — ook bij Ctrl-C, SIGTERM, een gesloten terminal, een onverwachte fout of een run die blijft
// hangen. Los van repetitie.mjs, zodat test/repetitie-script.test.js dit zonder echte apps kan toetsen.
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const wacht = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Race een belofte tegen een time-out: na `ms` komt `anders` terug (de belofte zelf loopt door, maar niemand
 * wacht er nog op). Voor alles wat een pagina kan laten hangen (page.evaluate op een vastgelopen hoofdthread).
 * @template T, A
 * @param {Promise<T>} belofte @param {number} ms @param {A} anders
 * @returns {Promise<T|A>}
 */
export function metTijd(belofte, ms, anders) {
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let t;
  const tijd = new Promise((r) => { t = setTimeout(() => r(anders), ms); });
  return /** @type {Promise<T|A>} */ (Promise.race([belofte, tijd]).finally(() => clearTimeout(t)));
}

/** Is dit bestand het script dat node startte? Ook met een spatie in het pad of via een symlink. @param {string} url import.meta.url */
export function isHoofdmodule(url) {
  if (!process.argv[1]) return false;
  try { return url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href; } catch { return url === pathToFileURL(resolve(process.argv[1])).href; }
}

/**
 * Opruimlijst: wat later is toegevoegd, wordt eerder opgeruimd (de browser vóór de servers die hij bezoekt,
 * de servers vóór de tijdelijke map waar ze in draaien). Draait hoogstens één keer, wie er ook om vraagt.
 */
export class Opruimer {
  /** @type {{ naam: string, fn: () => unknown }[]} */
  #lijst = [];
  /** @type {Promise<void>|null} */
  #bezig = null;
  /** Per stap hoogstens zo lang (een vastgelopen browser of hub mag het opruimen niet tegenhouden). */
  stapMs = 15000;
  /** @param {string} naam @param {() => unknown} fn */
  voeg(naam, fn) { this.#lijst.push({ naam, fn }); }
  get aantal() { return this.#lijst.length; }
  /** Ruim alles op, in omgekeerde volgorde. Een tweede aanroep wacht op de eerste. */
  draai() {
    this.#bezig ??= (async () => {
      for (const { naam, fn } of this.#lijst.splice(0).reverse()) {
        try {
          const klaar = await metTijd(Promise.resolve().then(fn).then(() => true), this.stapMs, false);
          if (!klaar) console.error(`opruimen: ${naam} duurde langer dan ${this.stapMs} ms, overgeslagen`);
        } catch (e) { console.error(`opruimen: ${naam}:`, e); }
      }
    })();
    return this.#bezig;
  }

  /**
   * Stop het script: eerst `voorAf` (bv. een gedeeltelijk rapport), dan opruimen, dan process.exit(code).
   * @param {string} reden @param {number} code
   */
  async stop(reden, code) {
    if (this.gestopt) return;
    this.gestopt = true;
    try { await metTijd(Promise.resolve().then(() => this.voorAf?.(reden)), this.stapMs, undefined); } catch (e) { console.error('voor het opruimen:', e); }
    await this.draai();
    process.exit(code);
  }
  /** @type {((reden: string) => unknown)|undefined} */
  voorAf = undefined;
  gestopt = false;

  /**
   * Vang Ctrl-C (SIGINT), SIGTERM, SIGHUP, een onverwachte uitzondering en een onafgehandelde belofte af:
   * dan één keer opruimen en stoppen (130/143/129, of 1). Elke handler geldt één keer: een tweede Ctrl-C
   * tijdens het opruimen stopt node meteen (de standaard van node).
   * @param {{ voorAf?: (reden: string) => unknown, log?: (s: string) => void }} [o]
   */
  vangAf(o = {}) {
    if (o.voorAf) this.voorAf = o.voorAf;
    const log = o.log ?? ((s) => console.error(s));
    /** @type {[NodeJS.Signals, number][]} */
    const signalen = [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]];
    for (const [sig, code] of signalen) {
      process.once(sig, () => {
        log(`\n${sig}: de repetitie stopt en ruimt op (servers, browser, tijdelijke worktree)… nog een keer Ctrl-C = meteen stoppen, zonder opruimen`);
        void this.stop(sig, code);
      });
    }
    process.once('uncaughtException', (e) => { log(`onverwachte fout: ${e?.stack ?? e}`); void this.stop('uncaughtException', 1); });
    process.once('unhandledRejection', (e) => { log(`onafgehandelde belofte: ${/** @type {any} */ (e)?.stack ?? e}`); void this.stop('unhandledRejection', 1); });
    return this;
  }

  /**
   * Waakhond: na `ms` stopt het script (met voorAf en opruimen), wat er ook hangt.
   * @param {number} ms @param {(s: string) => void} [log]
   * @returns {() => void} uitzetten
   */
  waakhond(ms, log = (s) => console.error(s)) {
    const t = setTimeout(() => {
      log(`\nde repetitie duurt langer dan ${Math.round(ms / 1000)} s (--max-duur): afgebroken, opruimen…`);
      void this.stop(`afgebroken na ${Math.round(ms / 1000)} s (--max-duur)`, 1);
    }, ms);
    return () => clearTimeout(t);
  }
}

/**
 * @typedef {{
 *   p: import('node:child_process').ChildProcess, naam: string,
 *   uitvoer: () => string, fout: () => Error|null, gestopt: () => boolean, verwachtStop: () => void,
 * }} Proces
 *   verwachtStop: dit proces gaat zo bewust stoppen (een herstart): niet als "onverwacht" melden.
 */

/** Terminal-opmaak (kleuren, cursor) uit procesuitvoer halen. @param {string} s */
export const kaal = (s) => s.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\r/g, '');

/** De laatste regels van wat een proces schreef, voor in een foutmelding. @param {Proces} pr @param {number} [n] */
export function staart(pr, n = 15) {
  const regels = kaal(pr.uitvoer()).split('\n').map((x) => x.trimEnd()).filter(Boolean).slice(-n);
  return regels.length ? `\n  laatste uitvoer van ${pr.naam}:\n    ${regels.join('\n    ')}` : `\n  (${pr.naam} schreef niets)`;
}

/** Is het proces al gestopt (of nooit gestart)? @param {Proces} pr */
export const isWeg = (pr) => pr.fout() !== null || pr.p.exitCode !== null || pr.p.signalCode !== null;

/**
 * Start een proces in een eigen procesgroep, dat bij het opruimen weer stopt (met de hele groep).
 * Een programma dat niet bestaat (ENOENT) laat node niet crashen: de fout staat in fout() en wachtOpUrl meldt hem.
 * @param {string} cmd @param {string[]} a @param {import('node:child_process').SpawnOptions} o @param {string} naam
 * @param {Opruimer} opruimer
 * @param {(s: string) => void} [log] meldt een proces dat onverwacht stopt
 * @returns {Proces}
 */
export function start(cmd, a, o, naam, opruimer, log) {
  const p = spawn(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, ...o });
  let uitvoer = '';
  /** @type {Error|null} */
  let fout = null;
  let gestopt = false;
  p.stdout?.on('data', (d) => { uitvoer = (uitvoer + d).slice(-8000); });
  p.stderr?.on('data', (d) => { uitvoer = (uitvoer + d).slice(-8000); });
  /** @type {Proces} */
  const pr = { p, naam, uitvoer: () => uitvoer, fout: () => fout, gestopt: () => gestopt, verwachtStop: () => { gestopt = true; } };
  p.on('error', (e) => { fout = e; log?.(`${naam}: ${cmd} starten mislukt: ${e.message}`); });
  p.on('exit', (code, sig) => { if (!gestopt && log) log(`${naam}: proces stopte onverwacht (${sig ?? `code ${code}`})${staart(pr, 8)}`); });
  opruimer.voeg(naam, async () => { gestopt = true; await stopProces(p); });
  return pr;
}

/** Stop een proces en zijn procesgroep: SIGTERM, na 4 s SIGKILL. @param {import('node:child_process').ChildProcess} p */
export async function stopProces(p) {
  if (p.exitCode !== null || p.signalCode !== null || !p.pid) return;
  const klaar = new Promise((r) => p.once('exit', r));
  try { process.kill(-p.pid, 'SIGTERM'); } catch { try { p.kill('SIGTERM'); } catch { /* al weg */ } }
  if (await Promise.race([klaar.then(() => true), wacht(4000).then(() => false)])) return;
  try { process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch { /* al weg */ } }
  await metTijd(klaar, 2000, undefined);
}

/**
 * Wacht tot een URL antwoordt. Met `proces`: stopt meteen als dat proces niet startte of al gestopt is,
 * met de laatste regels van zijn uitvoer in de melding (anders zie je alleen "antwoordt niet").
 * @param {string} url @param {{ ms?: number, proces?: Proces }} [o]
 */
export async function wachtOpUrl(url, { ms = 30000, proces } = {}) {
  const eind = Date.now() + ms;
  const naam = proces ? `${proces.naam}: ` : '';
  for (;;) {
    if (proces?.fout()) throw new Error(`${naam}starten mislukt: ${proces.fout()?.message}${staart(proces)}`);
    if (proces && isWeg(proces)) throw new Error(`${naam}het proces stopte (${proces.p.signalCode ?? `code ${proces.p.exitCode}`}) voordat ${url} antwoordde${staart(proces)}`);
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.status < 500) return; } catch { /* nog niet */ }
    if (Date.now() >= eind) break;
    await wacht(200);
  }
  throw new Error(`${naam}${url} antwoordt niet binnen ${ms} ms${proces ? staart(proces) : ''}`);
}

/** Is er al iets op deze poort? @param {number} poort */
export async function poortBezet(poort) {
  try { await fetch(`http://127.0.0.1:${poort}/`, { signal: AbortSignal.timeout(500) }); return true; } catch (e) { return /** @type {any} */ (e)?.name === 'TimeoutError'; }
}

/** Melding bij een bezette poort. @param {string} app @param {number} poort */
export const poortBezetMelding = (app, poort) =>
  `${app}: poort ${poort} (config.json) is bezet. Draait er nog een vorige repetitie of de app zelf? Stop hem (lsof -i :${poort}) of gebruik --zonder ${app}.`;

/**
 * Wacht tot fn() waar is, met een deadline; anders een fout met `melding`.
 * @param {() => unknown} fn @param {number} ms @param {string} melding @param {(ms: number) => Promise<unknown>} [w]
 */
export async function totUiterlijk(fn, ms, melding, w = wacht) {
  const eind = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() >= eind) throw new Error(melding);
    await w(50);
  }
}
