// @ts-check
// Avondmap: een avond spelen opnemen. LPD8-pad 4 zet de opname aan/uit (de kern meldt 'opname').
// Bij aan komt er een map <avondmap>/<datum-tijd>/ met gebaren.jsonl (logboek-formaat, zie core/logboek.js):
//   regel 1  kop     { v:1, soort:'avond', begon, 'hub-git', apps: { <app>: { naam, status, manifest: <hash> } }, lpd8 }
//   regel 2  { ms:0, e:'beginstand', focus, globaal, apps: { <app>: waarden }, snapshots: { <nr>: … } }
//   daarna   [ms, 'in', dev, bytes]          elke controller-invoer (dev: apc40, lpd8, apc40-virtueel, lpd8-virtueel)
//            [ms, 'naar', app, bericht]      elke zet/trig/scene/focus naar een app
//            { ms, e:'lpd8profiel', profiel } als het LPD8-profiel verandert (nodig om LPD8-bytes te lezen)
//   laatste  { ms, e:'eind', duur_ms, apps: { <app>: { waarden, hash } } }
// Bij uit: dicht + samenvatting.md. Schrijven blokkeert nooit (BufferSchrijver); fouten worden meldingen.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Logboek } from '../core/logboek.js';
import { Zender } from '../core/zender.js';
import { HUB_MAP } from '../config.js';
import { BufferSchrijver, echteBestanden, redenVan } from './schrijver.js';
import { staatHash, manifestHash, eindstaatUitBeeld } from './staat.js';

/** @typedef {import('../core/klok.js').Klok} Klok @typedef {import('./schrijver.js').Bestanden} Bestanden */

export const STANDAARD_AVONDMAP = '~/Movies/varve-avonden';
export const GEBAREN = 'gebaren.jsonl';
export const SAMENVATTING = 'samenvatting.md';
/** Berichten naar apps die in de opname komen. */
export const NAAR_SOORTEN = Object.freeze(['zet', 'trig', 'scene', 'focus']);

/** Pad van de avondmap uit config (sleutel 'avondmap'), met '~' uitgeschreven. @param {any} config @param {string} [thuis] */
export function avondmapPad(config, thuis = homedir()) {
  const p = typeof config?.avondmap === 'string' && config.avondmap ? config.avondmap : STANDAARD_AVONDMAP;
  if (p === '~') return thuis;
  if (p.startsWith('~/')) return join(thuis, p.slice(2));
  return p;
}

const twee = (/** @type {number} */ n) => String(n).padStart(2, '0');
/** Mapnaam voor een avond: lokale datum-tijd, sorteerbaar. @param {Date} d */
export const mapNaam = (d) => `${d.getFullYear()}-${twee(d.getMonth() + 1)}-${twee(d.getDate())}_${twee(d.getHours())}-${twee(d.getMinutes())}-${twee(d.getSeconds())}`;

/** Huidige commit van de hub (of null zonder git). @param {string} [map] @returns {Promise<string|null>} */
export function hubGit(map = HUB_MAP) {
  return new Promise((goed) => {
    try {
      execFile('git', ['rev-parse', 'HEAD'], { cwd: map, timeout: 2000 }, (/** @type {unknown} */ e, /** @type {string} */ uit) => goed(e ? null : String(uit).trim() || null));
    } catch { goed(null); }
  });
}

/** @param {number} ms */
export function duurTekst(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const u = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return u ? `${u}:${twee(m)}:${twee(s % 60)}` : `${m}:${twee(s % 60)}`;
}

/**
 * @typedef {{
 *   naam: string, begon: Date, t0: number, map: string|null, log: Logboek, schrijver: BufferSchrijver,
 *   apps: Record<string, { naam: string, manifest: string|null }>,
 *   invoer: Record<string, number>, naar: Record<string, Record<string, number>>,
 * }} Sessie
 */

export class Opnemer extends Zender {
  /**
   * @param {{
   *   kern: any, klok: Klok, map: string, bestanden?: Bestanden, datum?: () => Date,
   *   git?: string|null|(() => Promise<string|null>), lpd8Profiel?: () => unknown,
   *   spoelMs?: number, maxAchterstand?: number,
   * }} o
   */
  constructor({ kern, klok, map, bestanden = echteBestanden, datum = () => new Date(), git = hubGit, lpd8Profiel = () => null, spoelMs, maxAchterstand }) {
    super();
    this.kern = kern;
    this.klok = klok;
    this.map = map;
    this.bestanden = bestanden;
    this.datum = datum;
    this.lpd8Profiel = lpd8Profiel;
    this.spoelMs = spoelMs;
    this.maxAchterstand = maxAchterstand;
    /** @type {string|null} */
    this.git = typeof git === 'function' ? null : git;
    this.gitKlaar = typeof git === 'function' ? Promise.resolve(git()).then((g) => { this.git = g; }, () => {}) : Promise.resolve();
    /** @type {Sessie|null} */
    this.huidig = null;
    /** @type {Promise<any>} de laatste afsluiting (voor tests en hub.stop) */
    this.afgesloten = Promise.resolve(null);
    /** @type {(() => void)[]} */
    this.afmelden = [];
  }

  get actief() { return this.huidig !== null; }

  /** Luister naar de kern: 'opname' (aan/uit) en 'naarApp'. Geeft een afmeldfunctie. @param {any} [kern] */
  koppel(kern = this.kern) {
    this.afmelden.push(
      kern.bij('opname', (/** @type {boolean} */ aan) => { if (aan) this.start(); else void this.stop(); }),
      kern.bij('naarApp', (/** @type {string|null} */ app, /** @type {any} */ b) => this.naar(app, b)),
    );
    return () => { for (const f of this.afmelden.splice(0)) f(); };
  }

  /** @param {string} tekst @param {unknown} [e] */
  #melding(tekst, e) { this.meld('melding', tekst, e); }

  /** Begin een avond. Synchroon: alles vanaf nu staat erin, ook als de map pas straks bestaat. */
  start() {
    if (this.huidig) return this.huidig;
    const begon = this.datum();
    const naam = mapNaam(begon);
    const beeld = this.kern.beeld();
    /** @type {Sessie['apps']} */
    const apps = {};
    for (const a of this.kern.apps?.values?.() ?? []) apps[a.app] = { naam: a.naam, manifest: manifestHash(a.manifest) };
    /** @type {Sessie} */
    const s = /** @type {any} */ ({ naam, begon, t0: this.klok.nu(), map: null, apps, invoer: {}, naar: {} });
    s.schrijver = new BufferSchrijver({
      klaar: () => this.#maakMap(s), bestanden: this.bestanden, klok: this.klok,
      ...(this.spoelMs !== undefined ? { spoelMs: this.spoelMs } : {}),
      ...(this.maxAchterstand !== undefined ? { maxAchterstand: this.maxAchterstand } : {}),
      melding: (/** @type {string} */ t, /** @type {unknown} */ e) => this.#melding(t, e),
    });
    s.log = new Logboek({
      klok: this.klok, schrijf: (r) => s.schrijver.schrijf(r),
      kop: {
        soort: 'avond', begon: begon.toISOString(), 'hub-git': this.git,
        apps: Object.fromEntries(beeld.apps.map((/** @type {any} */ a) => [a.app, { naam: a.naam, status: a.status, manifest: apps[a.app]?.manifest ?? null }])),
        lpd8: this.lpd8Profiel() ?? null,
      },
    });
    /** @type {Record<string, unknown>} */
    const snapshots = {};
    for (const [nr, x] of this.kern.snapshots ?? []) snapshots[nr] = structuredClone(x);
    s.log.regel('beginstand', { focus: beeld.focus, globaal: beeld.globaal, apps: eindstaatUitBeeld(beeld), snapshots });
    this.huidig = s;
    this.#melding(`opname loopt: ${join(this.map, naam)}`);
    return s;
  }

  /** Map van deze avond maken (bestaat hij al, dan -2, -3, …). @param {Sessie} s */
  async #maakMap(s) {
    await this.bestanden.mkdir(this.map, { recursive: true });
    for (let i = 1; ; i++) {
      const pad = join(this.map, i === 1 ? s.naam : `${s.naam}-${i}`);
      try {
        await this.bestanden.mkdir(pad);
        s.map = pad;
        return join(pad, GEBAREN);
      } catch (e) {
        if (/** @type {any} */ (e)?.code !== 'EEXIST' || i >= 99) throw e;
      }
    }
  }

  /** Ruwe controller-invoer (de hub roept dit aan vóór kern.invoer). @param {string} dev @param {number[]} bytes */
  invoer(dev, bytes) {
    const s = this.huidig;
    if (!s || !Array.isArray(bytes)) return;
    s.log.midi(/** @type {any} */ ('in'), dev, [...bytes]);
    s.invoer[dev] = (s.invoer[dev] ?? 0) + 1;
  }

  /** Bericht van de hub naar een app (kern-event 'naarApp'). @param {string|null} app @param {any} b */
  naar(app, b) {
    const s = this.huidig;
    if (!s || !app || !b || !NAAR_SOORTEN.includes(b.t)) return;
    s.log.schrijf(JSON.stringify([s.log.ms(), 'naar', app, b]));
    const t = (s.naar[app] ??= {});
    t[b.t] = (t[b.t] ?? 0) + 1;
  }

  /** Het LPD8-profiel veranderde (Lpd8Sessie 'profiel'): nodig om latere LPD8-bytes te lezen. */
  profielGewijzigd() {
    this.huidig?.log.regel('lpd8profiel', { profiel: this.lpd8Profiel() ?? null });
  }

  /** Stop de avond: eindstaat, dicht, samenvatting.md. Gooit nooit. */
  stop() {
    const s = this.huidig;
    if (!s) return this.afgesloten;
    this.huidig = null;
    this.afgesloten = this.#sluit(s).catch((e) => { this.#melding(`opname: afsluiten mislukt — ${redenVan(e)}`, e); return null; });
    return this.afgesloten;
  }

  /** @param {Sessie} s */
  async #sluit(s) {
    const duur = this.klok.nu() - s.t0;
    const eind = eindstaatUitBeeld(this.kern.beeld());
    const apps = Object.fromEntries(Object.entries(eind).map(([app, w]) => [app, { waarden: w, hash: staatHash(w) }]));
    s.log.regel('eind', { duur_ms: Math.round(duur), apps });
    const r = await s.schrijver.sluit();
    const resultaat = { map: s.map, bestand: r.pad, regels: r.regels, verloren: r.verloren, duur_ms: Math.round(duur), invoer: s.invoer, naar: s.naar, apps };
    if (!s.map) {
      this.#melding(`opname: niets bewaard — ${r.fout ?? 'map niet gemaakt'}`);
      this.meld('klaar', resultaat);
      return resultaat;
    }
    try {
      await this.bestanden.writeFile(join(s.map, SAMENVATTING), samenvatting(s, resultaat, this.git));
    } catch (e) {
      this.#melding(`opname: samenvatting niet geschreven — ${redenVan(e)}`, e);
    }
    this.#melding(`opname klaar: ${s.map} (${duurTekst(duur)}, ${r.regels} regels${r.verloren ? `, ${r.verloren} verloren` : ''})`);
    this.meld('klaar', resultaat);
    return resultaat;
  }

  /** Afmelden bij de kern; een lopende opname wordt netjes afgesloten. */
  async sluit() {
    for (const f of this.afmelden.splice(0)) f();
    return this.stop();
  }
}

/**
 * @param {Sessie} s
 * @param {{ regels: number, verloren: number, duur_ms: number, apps: Record<string, { waarden: Record<string, number>, hash: string }> }} r
 * @param {string|null} git
 */
function samenvatting(s, r, git) {
  const som = (/** @type {Record<string, number>} */ o) => Object.values(o).reduce((a, b) => a + b, 0);
  const naarTotaal = Object.values(s.naar).reduce((a, t) => a + som(t), 0);
  const alleApps = [...new Set([...Object.keys(s.apps), ...Object.keys(r.apps), ...Object.keys(s.naar)])].sort();
  const regels = [
    `# Avond ${s.naam}`,
    '',
    `- Begon: ${s.begon.toISOString()}`,
    `- Duur: ${duurTekst(r.duur_ms)}`,
    `- Hub: ${git ? `git ${git}` : 'git onbekend'}`,
    `- Invoer: ${som(s.invoer)}${Object.keys(s.invoer).length ? ` (${Object.entries(s.invoer).map(([d, n]) => `${d} ${n}`).join(', ')})` : ''}`,
    `- Naar apps: ${naarTotaal}`,
    `- Bestand: ${GEBAREN} (${r.regels} regels${r.verloren ? `, **${r.verloren} verloren**` : ''})`,
    '',
    '| App | Naam | Manifest | zet | trig | scene | focus | Eind-hash |',
    '|---|---|---|---:|---:|---:|---:|---|',
    ...alleApps.map((app) => {
      const t = s.naar[app] ?? {};
      return `| ${app} | ${s.apps[app]?.naam ?? ''} | ${s.apps[app]?.manifest ?? '–'} | ${t.zet ?? 0} | ${t.trig ?? 0} | ${t.scene ?? 0} | ${t.focus ?? 0} | ${r.apps[app]?.hash ?? '–'} |`;
    }),
    '',
    `Opnieuw afspelen tegen een draaiende hub: \`varve-hub herhaal "${join(s.map ?? '', GEBAREN)}"\` (zie docs/OPNAME.md).`,
    '',
  ];
  return regels.join('\n');
}
