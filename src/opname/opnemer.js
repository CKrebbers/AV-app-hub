// @ts-check
// Avondmap: een avond spelen opnemen. LPD8-pad 4 zet de opname aan/uit (de kern meldt 'opname').
// Bij aan komt er een map <avondmap>/<datum-tijd>/ met gebaren.jsonl (logboek-formaat, zie core/logboek.js):
//   regel 1  kop     { v:1, soort:'avond', begon, 'hub-git', apps: { <app>: { naam, status, manifest: <hash> } }, lpd8 }
//   regel 2  { ms:0, e:'beginstand', focus, globaal, apps: { <app>: waarden }, snapshots: { <nr>: … } }
//   daarna   [ms, 'in', dev, bytes]          elke controller-invoer (dev: apc40, lpd8, apc40-virtueel, lpd8-virtueel,
//                                            xboard49, maschine-mk2 = de virtuele MIDI van de Maschine, al uitgedund)
//            [ms, 'naar', app, bericht]      elke zet/trig/scene/focus naar een app
//            { ms, e:'lpd8profiel', profiel } als het LPD8-profiel verandert (nodig om LPD8-bytes te lezen)
//   laatste  { ms, e:'eind', duur_ms, 'hub-git', apps: { <app>: { waarden, hash } }, rust? }
// Bij uit: eerst wachten tot er niets meer vanzelf beweegt (een LPD8-macro-slew, de paniektimer van P1;
// begrensd), dan de eindstaat, dicht + samenvatting.md. Zo is de eindstaat een vaste stand die een herhaling
// ook bereikt; invoer in die uitloop gaat nog mee de opname in. Stopt de hub (Ctrl-C), dan wordt er niet
// gewacht en krijgt 'eind' rust:false als er nog iets liep. Schrijven blokkeert nooit (BufferSchrijver); fouten worden meldingen.
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { Logboek } from '../core/logboek.js';
import { Zender } from '../core/zender.js';
import { HUB_MAP } from '../config.js';
import { PANIEK_MS } from '../core/kern.js';
import { SLEW_TIK_MS } from '../core/slew.js';
import { BufferSchrijver, echteBestanden, redenVan, hulpVan } from './schrijver.js';
import { staatHash, manifestHash, eindstaatUitBeeld } from './staat.js';

/** @typedef {import('../core/klok.js').Klok} Klok @typedef {import('./schrijver.js').Bestanden} Bestanden */

export const GEBAREN = 'gebaren.jsonl';
export const SAMENVATTING = 'samenvatting.md';
/** Berichten naar apps die in de opname komen. */
export const NAAR_SOORTEN = Object.freeze(['zet', 'trig', 'scene', 'focus']);

/** Hoe lang de opname bij het stoppen hooguit wacht tot slews en de P1-timer klaar zijn (bovenop wat nodig is). */
export const RUST_MARGE_MS = 200;
export const RUST_MAX_MS = 10_000;

/**
 * Pad van de avondmap uit config.json (sleutel 'avondmap', de enige bron): '~' is de thuismap, een relatief
 * pad geldt vanaf de hub-map (zoals proefmap), niet vanaf waar `npm start` draaide. Zonder sleutel: null.
 * @param {any} config @param {string} [thuis] @param {string} [basis]
 * @returns {string|null}
 */
export function avondmapPad(config, thuis = homedir(), basis = HUB_MAP) {
  const p = typeof config?.avondmap === 'string' && config.avondmap.trim() ? config.avondmap.trim() : null;
  if (p === null) return null;
  if (p === '~') return thuis;
  if (p.startsWith('~/')) return join(thuis, p.slice(2));
  return isAbsolute(p) ? p : resolve(basis, p);
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
 *   onderbreek?: (() => void)|null,
 *   apps: Record<string, { naam: string, manifest: string|null }>,
 *   invoer: Record<string, number>, naar: Record<string, Record<string, number>>,
 * }} Sessie
 */

export class Opnemer extends Zender {
  /**
   * @param {{
   *   kern: any, klok: Klok, map: string|null, bestanden?: Bestanden, datum?: () => Date,
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
    /** @type {Promise<any>} de laatste afsluiting (voor tests) */
    this.afgesloten = Promise.resolve(null);
    /** @type {Set<Promise<any>>} alle afsluitingen die nog bezig zijn (sluit() wacht op allemaal) */
    this.lopend = new Set();
    /** @type {Set<Sessie>} gestopt, maar wachtend tot er niets meer vanzelf beweegt */
    this.uitlopend = new Set();
    /** @type {(() => void)[]} */
    this.afmelden = [];
  }

  get actief() { return this.huidig !== null; }

  /** Sessies die nu invoer opnemen: de lopende en die in hun uitloop. */
  #sessies() { return this.huidig ? [this.huidig, ...this.uitlopend] : [...this.uitlopend]; }

  /** Beweegt er nog iets vanzelf in de kern (slew van een LPD8-macro, P1 vastgehouden)? */
  #inRust() { return (this.kern.slews?.size ?? 0) === 0 && (this.kern.p1Timer ?? null) === null; }

  /** Hoe lang het hooguit nog duurt tot de kern in rust is. */
  #rustBinnen() {
    const nu = this.klok.nu();
    let ms = 0;
    for (const x of this.kern.slews?.values?.() ?? []) ms = Math.max(ms, (x.slew?.start ?? nu) + (x.slew?.duurMs ?? 0) - nu + SLEW_TIK_MS);
    if ((this.kern.p1Timer ?? null) !== null) ms = Math.max(ms, PANIEK_MS);
    return Math.min(RUST_MAX_MS, ms + RUST_MARGE_MS);
  }

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
    if (!this.map) {
      this.#melding('opname: geen "avondmap" in config.json — er wordt niets opgenomen. Zet bv. "avondmap": "~/Movies/varve-avonden" in config.json.');
      return null;
    }
    const begon = this.datum();
    const naam = mapNaam(begon);
    const beeld = this.kern.beeld();
    /** @type {Sessie['apps']} */
    const apps = {};
    for (const a of this.kern.apps?.values?.() ?? []) apps[a.app] = { naam: a.naam, manifest: manifestHash(a.manifest) };
    /** @type {Sessie} */
    const s = /** @type {any} */ ({ naam, begon, t0: this.klok.nu(), map: null, apps, invoer: {}, naar: {} });
    s.schrijver = new BufferSchrijver({
      klaar: () => this.#maakMap(s), bestanden: this.bestanden, klok: this.klok, waar: this.map,
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
    this.#melding(`opname gestart — map wordt gemaakt in ${this.map}…`);
    void s.schrijver.bereidVoor();   // map nu al maken: 'opname loopt' of een fout komt meteen, niet pas bij de eerste spoeling
    return s;
  }

  /**
   * Na een herstart van de hub die midden in een opname omviel: de opname weer aan, alsof LPD8-pad 4 nog aan
   * stond (de kern meldt 'opname'; een volgende druk op pad 4 stopt hem gewoon). Het wordt een nieuwe avond;
   * de afgebroken avond herstelt src/opname/herstel.js. Geeft de nieuwe sessie (of null zonder avondmap).
   */
  hervat() {
    if (!this.kern.opname) {
      this.kern.opname = true;
      this.kern.meld('opname', true);
    }
    return this.huidig;
  }

  /** Map van deze avond maken (bestaat hij al, dan -2, -3, …). @param {Sessie} s */
  async #maakMap(s) {
    const map = /** @type {string} */ (this.map);
    await this.bestanden.mkdir(map, { recursive: true });
    for (let i = 1; ; i++) {
      const pad = join(map, i === 1 ? s.naam : `${s.naam}-${i}`);
      try {
        await this.bestanden.mkdir(pad);
        s.map = pad;
        this.#melding(`opname loopt: ${pad}`);
        return join(pad, GEBAREN);
      } catch (e) {
        if (/** @type {any} */ (e)?.code !== 'EEXIST' || i >= 99) throw e;
      }
    }
  }

  /** Ruwe controller-invoer (de hub roept dit aan vóór kern.invoer). @param {string} dev @param {number[]} bytes */
  invoer(dev, bytes) {
    if (!Array.isArray(bytes)) return;
    for (const s of this.#sessies()) {
      s.log.midi(/** @type {any} */ ('in'), dev, [...bytes]);
      s.invoer[dev] = (s.invoer[dev] ?? 0) + 1;
    }
  }

  /** Bericht van de hub naar een app (kern-event 'naarApp'). @param {string|null} app @param {any} b */
  naar(app, b) {
    if (!app || !b || !NAAR_SOORTEN.includes(b.t)) return;
    for (const s of this.#sessies()) {
      s.log.schrijf(JSON.stringify([s.log.ms(), 'naar', app, b]));
      const t = (s.naar[app] ??= {});
      t[b.t] = (t[b.t] ?? 0) + 1;
    }
  }

  /** Het LPD8-profiel veranderde (Lpd8Sessie 'profiel'): nodig om latere LPD8-bytes te lezen. */
  profielGewijzigd() {
    for (const s of this.#sessies()) s.log.regel('lpd8profiel', { profiel: this.lpd8Profiel() ?? null });
  }

  /**
   * Stop de avond: (wachten op rust,) eindstaat, dicht, samenvatting.md. Gooit nooit.
   * @param {{ wachtOpRust?: boolean }} [o]
   */
  stop({ wachtOpRust = true } = {}) {
    const s = this.huidig;
    if (!s) return this.afgesloten;
    this.huidig = null;
    this.uitlopend.add(s);
    const p = this.#sluit(s, wachtOpRust)
      .catch((e) => { this.#melding(`opname: afsluiten mislukt — ${redenVan(e)}`, e); return null; })
      .finally(() => { this.uitlopend.delete(s); this.lopend.delete(p); });
    this.lopend.add(p);
    this.afgesloten = p;
    return p;
  }

  /** Wacht (via de klok) tot de kern in rust is, begrensd. Geeft of hij in rust kwam. @param {Sessie} s @returns {Promise<boolean>} */
  #wachtOpRust(s) {
    return new Promise((goed) => {
      const tot = this.klok.nu() + this.#rustBinnen();
      /** @type {any} */ let timer = null;
      const klaar = () => { s.onderbreek = null; if (timer !== null) this.klok.wis(timer); timer = null; goed(this.#inRust()); };
      s.onderbreek = klaar;
      const kijk = () => {
        timer = null;
        if (this.#inRust() || this.klok.nu() >= tot) return klaar();
        timer = this.klok.zet(kijk, SLEW_TIK_MS);
      };
      kijk();
    });
  }

  /** @param {Sessie} s @param {boolean} wachtOpRust */
  async #sluit(s, wachtOpRust) {
    let rust = this.#inRust();
    if (!rust && wachtOpRust) rust = await this.#wachtOpRust(s);
    this.uitlopend.delete(s);               // vanaf hier geen invoer meer in deze avond
    const duur = this.klok.nu() - s.t0;
    const eind = eindstaatUitBeeld(this.kern.beeld());
    const apps = Object.fromEntries(Object.entries(eind).map(([app, w]) => [app, { waarden: w, hash: staatHash(w) }]));
    // rust:false = er liep bij het vastleggen nog een slew of de P1-timer (hub gestopt): een herhaling kan daardoor verschillen.
    s.log.regel('eind', { duur_ms: Math.round(duur), 'hub-git': this.git, apps, ...(rust ? {} : { rust: false }) });
    const r = await s.schrijver.sluit();
    const resultaat = { map: s.map, bestand: r.pad, regels: r.regels, verloren: r.verloren, duur_ms: Math.round(duur), invoer: s.invoer, naar: s.naar, apps };
    if (!s.map) {
      this.#melding(`opname: niets bewaard in ${this.map} — ${r.fout ?? 'map niet gemaakt'} — kies een andere map met "avondmap" in config.json`);
      this.meld('klaar', resultaat);
      return resultaat;
    }
    try {
      await this.bestanden.writeFile(join(s.map, SAMENVATTING), samenvatting(s, resultaat, this.git));
    } catch (e) {
      const hulp = hulpVan(e);
      this.#melding(`opname: samenvatting niet geschreven in ${s.map} — ${redenVan(e)}${hulp ? ` — ${hulp}` : ''}`, e);
    }
    this.#melding(`opname klaar: ${s.map} (${duurTekst(duur)}, ${r.regels} regels${r.verloren ? `, ${r.verloren} verloren` : ''})`);
    this.meld('klaar', resultaat);
    return resultaat;
  }

  /**
   * Afmelden bij de kern (de hub stopt): een lopende opname wordt meteen afgesloten (niet op rust gewacht),
   * avonden in hun uitloop ook, en er wordt gewacht op álle afsluitingen die nog bezig zijn. Geeft het
   * resultaat van de laatste. hub.stop() begrenst hoe lang dit mag duren.
   */
  async sluit() {
    for (const f of this.afmelden.splice(0)) f();
    for (const s of this.uitlopend) s.onderbreek?.();
    const laatste = this.stop({ wachtOpRust: false });
    await Promise.all([...this.lopend]);
    return laatste;
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
    `Opnieuw afspelen tegen een draaiende hub (in de AV-app-hub-map): \`npm run herhaal -- "${s.map ?? ''}"\` (zie docs/OPNAME.md).`,
    '',
  ];
  return regels.join('\n');
}
