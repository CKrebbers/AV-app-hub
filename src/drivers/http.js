// @ts-check
// HTTP-driver (driver.soort "http"): voor apps met een werkwoorden-API, zoals de uurwerk-brug
// (`POST /verb {verb, args, auteur}`). Per parameter max ~10 berichten per seconde, laatste
// waarde wint. Elke 2 s een gezondheidscheck (`GET /`): gelukt → hartslag naar de kern,
// mislukt → geen hartslag (de kern maakt de app dan 'stil' en daarna 'weg').
// Fouten worden nooit gegooid: een app die er niet is, mag de hub niet hinderen.
//
// driver = { soort:"http", url:"http://127.0.0.1:8766", gezond_s?:2, max_hz?:10,
//            verbs: { paramId: { verb, args?, waarde?: "argnaam", bereik?: [min, max] } } }
import { DriverBasis, scheidStatisch, bewaarBegrensd } from './basis.js';
import { klem01 } from '../protocol/berichten.js';

/** @typedef {import('../protocol/types.js').NaarApp} NaarApp @typedef {import('../core/klok.js').Klok} Klok */
/** @typedef {{ verb: string, args?: Record<string, unknown>, waarde?: string, bereik?: [number, number] }} VerbSpec */
/** @typedef {(url: string, init?: any) => Promise<any>} Fetch */

export const AUTEUR = 'varve-hub';
/**
 * Hoe lang een gezondheidscheck mag duren. Klein genoeg dat check-periode (2 s) + time-out onder
 * config.hartslag.stil_s (3 s) blijft: een trage brug knippert dan niet op 'stil'.
 */
export const CHECK_TIMEOUT_MS = 800;
/** Hoe lang een POST /verb open mag blijven (de brug wacht op de tab, tot 90 s). */
export const POST_TIMEOUT_MS = 2000;

/**
 * Het verb-bericht voor een waarde (0..1) of een trigger. Puur, voor driver en tests.
 * - waarde/keuze: arg `waarde` = bereik[0] + v·(bereik[1]-bereik[0]) (standaard 0..1), afgerond op 4 decimalen
 * - schakelaar: arg `waarde` = boolean (v ≥ 0.5)
 * - trigger: vaste args (en `waarde` = true als die genoemd is)
 * @param {VerbSpec} spec
 * @param {'waarde'|'schakelaar'|'trigger'|'keuze'} soort
 * @param {number|boolean} v
 */
export function verbBericht(spec, soort, v) {
  /** @type {Record<string, unknown>} */
  const args = { ...(spec.args ?? {}) };
  if (spec.waarde) {
    if (soort === 'schakelaar' || soort === 'trigger') args[spec.waarde] = typeof v === 'boolean' ? v : v >= 0.5;
    else {
      const [lo, hi] = spec.bereik ?? [0, 1];
      const x = lo + klem01(Number(v)) * (hi - lo);
      args[spec.waarde] = Math.round(x * 1e4) / 1e4;
    }
  }
  return { verb: spec.verb, args, auteur: AUTEUR };
}

/** URL zonder slash aan het eind. @param {string} u */
const basisUrl = (u) => String(u).replace(/\/+$/, '');

export class HttpDriver extends DriverBasis {
  /**
   * @param {Record<string, any>} statisch
   * @param {{ klok: Klok, fetch?: Fetch, config?: any, log?: (...a: unknown[]) => void }} o
   */
  constructor(statisch, { klok, fetch = globalThis.fetch, config, log }) {
    const { manifest, driver } = scheidStatisch(statisch);
    super({ manifest, klok, log });
    this.driver = driver;
    this.fetch = fetch;
    // config.json wint (huisregel 6): apps.<app>.poort → http://127.0.0.1:<poort>
    const poort = config?.apps?.[manifest.app]?.poort;
    this.url = basisUrl(poort ? `http://127.0.0.1:${poort}` : driver.url);
    this.gezondMs = (driver.gezond_s ?? 2) * 1000;
    this.minAfstandMs = 1000 / (driver.max_hz ?? 10);
    /** @type {Map<string, any>} */
    this.params = new Map((manifest.params ?? []).map((/** @type {any} */ p) => [p.id, p]));
    /** @type {Map<string, { laatstOp: number, wachtend?: number, timer: any }>} coalescing per param */
    this.rem = new Map();
    /** null = nog onbekend, true/false = uitslag van de laatste check */
    this.bereikbaar = /** @type {boolean|null} */ (null);
    /** een verb mislukte sinds de laatste geslaagde check → bij herstel opnieuw aanmelden (replay) */
    this.gemist = false;
    this.checkTimer = null;
    this.checkBezig = false;
    /** @type {{ ac: AbortController|null, timer: any } | null} de check die nu loopt */
    this.lopend = null;
    this.gestopt = true;
    /** @type {Map<any, AbortController|null>} lopende POSTs: klok-handle van hun time-out → afbreker */
    this.posts = new Map();
    /** @type {{ verb: string, args: Record<string, unknown>, auteur: string }[]} alles wat verstuurd is (diagnose/tests) */
    this.verstuurd = [];
  }

  /** @param {{ verb: string, args: Record<string, unknown>, auteur: string }} bericht */
  #post(bericht) {
    if (this.gestopt) return;
    // Onbereikbaar: niet sturen (geen stapel open verzoeken); bij herstel speelt de kern alles opnieuw af.
    if (this.bereikbaar === false) { this.gemist = true; return; }
    bewaarBegrensd(this.verstuurd, bericht);
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    let verlopen = false;
    const timer = this.klok.zet(() => { verlopen = true; this.posts.delete(timer); ac?.abort(); }, POST_TIMEOUT_MS);
    this.posts.set(timer, ac);
    const klaar = () => { if (this.posts.delete(timer)) this.klok.wis(timer); };
    let p;
    try {
      p = this.fetch(`${this.url}/verb`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bericht), ...(ac ? { signal: ac.signal } : {}) });
    } catch (e) { klaar(); this.#mislukt(bericht, e); return; }
    Promise.resolve(p).then(
      (r) => { klaar(); if (r && r.ok === false) this.#mislukt(bericht, new Error(`HTTP ${r.status}`)); },
      (e) => {
        klaar();
        // Afgebroken na POST_TIMEOUT_MS: de brug heeft het verb wel, de tab is alleen traag. Geen replay.
        if (verlopen) this.log('driver', this.manifest.app, `verb ${bericht.verb}: geen antwoord binnen ${POST_TIMEOUT_MS} ms`);
        else this.#mislukt(bericht, e);
      },
    );
  }

  /** @param {{ verb: string }} bericht @param {unknown} e */
  #mislukt(bericht, e) {
    this.gemist = true;
    this.log('driver', this.manifest.app, `verb ${bericht.verb} mislukt:`, /** @type {Error} */ (e)?.message ?? e);
  }

  /** Waarde-zet met coalescing: max één bericht per minAfstandMs per param, laatste waarde wint. @param {string} id @param {number} v */
  #zet(id, v) {
    const spec = this.driver.verbs?.[id];
    const p = this.params.get(id);
    if (!spec || !p || p.soort === 'trigger' || !Number.isFinite(v)) return;
    const nu = this.klok.nu();
    let r = this.rem.get(id);
    if (!r) { r = { laatstOp: -Infinity, timer: null }; this.rem.set(id, r); }
    if (r.timer === null && nu - r.laatstOp >= this.minAfstandMs) {
      r.laatstOp = nu;
      this.#post(verbBericht(spec, p.soort, v));
      return;
    }
    r.wachtend = v;
    if (r.timer !== null) return;
    const rr = r;
    rr.timer = this.klok.zet(() => {
      rr.timer = null;
      if (rr.wachtend === undefined) return;
      const w = rr.wachtend;
      rr.wachtend = undefined;
      rr.laatstOp = this.klok.nu();
      this.#post(verbBericht(spec, p.soort, w));
    }, Math.max(0, rr.laatstOp + this.minAfstandMs - nu));
  }

  /** @param {string} id @param {boolean} aan */
  #trig(id, aan) {
    const spec = this.driver.verbs?.[id];
    const p = this.params.get(id);
    if (!spec || !p || !aan) return; // werkwoorden zijn momenten: alleen bij indrukken
    this.#post(verbBericht(spec, p.soort, true));
  }

  /** @param {NaarApp} b */
  vertaal(b) {
    if (b.t === 'zet') this.#zet(b.id, b.v);
    else if (b.t === 'trig') this.#trig(b.id, b.aan === true);
    // welkom, scene, focus, globaal, midi, fout: niets voor uurwerk
  }

  /** Eén gezondheidscheck. Geeft een belofte die nooit faalt (voor tests). */
  async controleer() {
    if (this.checkBezig || this.gestopt) return;
    this.checkBezig = true;
    let ok = false;
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    // De time-out sluit de check zelf af: ook een fetch die het afbreken negeert, blokkeert de volgende niet.
    /** @type {{ ac: AbortController|null, timer: any }} */
    const mijn = { ac, timer: null };
    mijn.timer = this.klok.zet(() => {
      if (this.lopend !== mijn) return;
      this.lopend = null;
      this.checkBezig = false;
      this.bereikbaar = false;
      ac?.abort();
    }, CHECK_TIMEOUT_MS);
    this.lopend = mijn;
    try {
      const r = await this.fetch(`${this.url}/`, { method: 'GET', ...(ac ? { signal: ac.signal } : {}) });
      ok = !!r && r.ok !== false;
      // de uurwerk-brug draait wel, maar zonder browsertab gebeurt er niets: "tabs: 0"
      if (ok && typeof r.text === 'function') {
        const tekst = await r.text().catch(() => '');
        if (/tabs:\s*0\b/.test(String(tekst))) ok = false;
      }
    } catch { ok = false; }
    if (this.lopend !== mijn) return; // intussen gestopt (en misschien opnieuw gestart): deze uitslag telt niet
    this.klok.wis(mijn.timer);
    this.lopend = null;
    this.checkBezig = false;
    if (this.gestopt) return;
    const was = this.bereikbaar;
    this.bereikbaar = ok;
    if (!ok) return;
    if (was === false || this.gemist) {
      // terug na een storing: opnieuw aanmelden, zodat de kern (truth:"hub") alles opnieuw afspeelt
      this.gemist = false;
      this.aanmelden();
    }
    this.hartslag();
  }

  /** Laat de kern alles opnieuw afspelen (bijv. na een herlaadde uurwerk-tab). */
  opnieuw() { if (this.kern) this.aanmelden(); }

  #plan() {
    this.checkTimer = this.klok.zet(() => { this.controleer(); this.#plan(); }, this.gezondMs);
  }

  /** @param {import('./basis.js').KernVoorDriver} kern */
  start(kern) {
    if (!this.gestopt) return; // loopt al: geen tweede timerketen
    this.gestopt = false;
    this.koppel(kern);
    this.controleer();
    this.#plan();
  }

  stop() {
    this.gestopt = true;
    if (this.checkTimer !== null) this.klok.wis(this.checkTimer);
    this.checkTimer = null;
    if (this.lopend) { this.klok.wis(this.lopend.timer); this.lopend.ac?.abort(); this.lopend = null; }
    this.checkBezig = false;
    for (const [h, ac] of this.posts) { this.klok.wis(h); ac?.abort(); }
    this.posts.clear();
    for (const r of this.rem.values()) if (r.timer !== null) this.klok.wis(r.timer);
    this.rem.clear();
    this.ontkoppel();
  }
}
