// @ts-check
// HTTP-driver (driver.soort "http"): voor apps met een werkwoorden-API, zoals de uurwerk-brug
// (`POST /verb {verb, args, auteur}`). Per parameter max ~10 berichten per seconde, laatste
// waarde wint. Elke 2 s een gezondheidscheck (`GET /`): gelukt → hartslag naar de kern,
// mislukt → geen hartslag (de kern maakt de app dan 'stil' en daarna 'weg').
// Fouten worden nooit gegooid: een app die er niet is, mag de hub niet hinderen.
//
// driver = { soort:"http", url:"http://127.0.0.1:8766", gezond_s?:2, max_hz?:10,
//            verbs: { paramId: { verb, args?, waarde?: "argnaam", bereik?: [min, max] } },
//            lees?: false | LeesSpec }   (teruglezen uit de app, §3.3 van docs/VOLGENDE-KOPPELINGEN.md: zie onderaan)
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
    // ── teruglezen (onderaan het bestand) ──
    const tc = leesTerugleesConfig(config?.teruglezen);
    for (const m of tc?.meldingen ?? []) this.log('driver', manifest.app, m);
    const { lezer, fouten } = tc ? maakLezer(driver.lees === undefined ? STANDAARD_LEES[manifest.app] : driver.lees, manifest, driver) : { lezer: null, fouten: [] };
    if (fouten.length) this.log('driver', manifest.app, 'teruglezen:', fouten.join('; '));
    /** @type {Lezer|null} null = teruglezen uit (geen config, lees:false, of geen geldige regels) */
    this.lezer = lezer;
    this.leesMs = tc?.elkeMs ?? 0;
    this.leesMaxMs = tc?.maxMs ?? 0;
    /** @type {Map<string, number>} wat de hub van elke parameter denkt (0..1): laatste zet van de kern of laatste teruggelezen waarde */
    this.bekend = new Map();
    this.leesTimer = null;
    /** @type {LeesLopend|null} het teruglees-verzoek dat nu loopt */
    this.leesLopend = null;
    /** mislukte teruglees-pogingen op rij (voor de backoff) */
    this.leesFouten = 0;
    /** de storing is al gemeld: niet nog eens loggen tot het weer lukt */
    this.leesGemeld = false;
    /** @type {{ id: string, v: number }[]} wat er is teruggemeld aan de kern (diagnose/tests) */
    this.teruggelezen = [];
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
    this.bekend.set(id, p.soort === 'schakelaar' ? (v >= 0.5 ? 1 : 0) : klem01(v));
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
    if (was === false) this.leesFouten = 0; // de app is terug: meteen weer in het gewone ritme teruglezen
    if (was === false || this.gemist) {
      // terug na een storing: opnieuw aanmelden, zodat de kern (truth:"hub") alles opnieuw afspeelt
      this.gemist = false;
      this.aanmelden();
    }
    this.hartslag();
  }

  /**
   * Wacht nog een waarde van de hub op deze parameter, of stuurde de hub hem kort voor (of na) `sinds`? Dan is wat de
   * app nu meldt misschien nog de oude stand (of een echo): niet vergelijken. @param {string} id @param {number} sinds
   */
  #onrustig(id, sinds) {
    const r = this.rem.get(id);
    return !!r && (r.timer !== null || r.laatstOp >= sinds - ECHO_MARGE_MS);
  }

  /**
   * Eén teruglees-ronde: `GET /verb/<lees.verb>`, de tekst lezen en elk echt verschil als `zet` (bron 'app') aan de
   * kern melden. Alleen als de app gezond is en er geen replay wacht (anders zou de oude stand van de app de waarden
   * van de hub overschrijven). Geeft een belofte die nooit faalt (voor tests).
   */
  lees() {
    const lezer = this.lezer;
    if (!lezer || this.gestopt || this.leesLopend || this.bereikbaar !== true || this.gemist) return Promise.resolve();
    return new Promise((klaar) => {
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      /** @type {LeesLopend} */
      const mijn = { ac, timer: null, klaar: () => klaar(undefined) };
      // De time-out sluit de ronde zelf af: ook een fetch die het afbreken negeert, houdt de volgende niet tegen.
      mijn.timer = this.klok.zet(() => {
        if (this.leesLopend !== mijn) return;
        this.leesLopend = null;
        ac?.abort();
        this.#leesMislukt(`geen antwoord binnen ${LEES_TIMEOUT_MS} ms`);
        mijn.klaar();
      }, LEES_TIMEOUT_MS);
      this.leesLopend = mijn;
      this.#leesRonde(lezer, mijn, this.klok.nu()).then(mijn.klaar, mijn.klaar);
    });
  }

  /** @param {Lezer} lezer @param {LeesLopend} mijn @param {number} start */
  async #leesRonde(lezer, mijn, start) {
    const ac = mijn.ac;
    /** @type {string|null} */
    let fout = null;
    /** @type {string} */
    let tekst = '';
    try {
      const r = await this.fetch(`${this.url}/verb/${lezer.verb}`, { method: 'GET', ...(ac ? { signal: ac.signal } : {}) });
      if (!r || r.ok === false) {
        // de brug zegt waarom (bv. "geen browsertab verbonden"): dat is nuttiger in het log dan alleen de status
        const reden = r && typeof r.text === 'function' ? await r.text().then((/** @type {string} */ x) => { try { return JSON.parse(x)?.fout; } catch { return undefined; } }, () => undefined) : undefined;
        fout = `HTTP ${r?.status ?? '?'}${typeof reden === 'string' ? `: ${reden.slice(0, 200)}` : ''}`;
      } else {
        const ruw = String(typeof r.text === 'function' ? await r.text() : '');
        if (ruw.length > LEES_MAX_TEKENS) fout = `antwoord te groot (${ruw.length} tekens)`;
        else {
          const j = JSON.parse(ruw);
          const t = j && typeof j === 'object' ? j[lezer.veld] : undefined;
          if (typeof t === 'string') tekst = t;
          else fout = j && typeof j.fout === 'string' ? j.fout : `geen "${lezer.veld}" in het antwoord`;
        }
      }
    } catch (e) { fout = /** @type {Error} */ (e)?.message ?? String(e); }
    if (this.leesLopend !== mijn) return; // afgebroken (time-out of gestopt): deze uitslag telt niet
    this.klok.wis(mijn.timer);
    this.leesLopend = null;
    if (this.gestopt) return;
    if (fout !== null) { this.#leesMislukt(fout); return; }
    if (this.leesGemeld) this.log('driver', this.manifest.app, 'teruglezen werkt weer');
    this.leesFouten = 0;
    this.leesGemeld = false;
    // Intussen onbereikbaar geworden, of een verb mislukt (replay wacht): niets melden.
    if (!this.kern || this.bereikbaar !== true || this.gemist) return;
    const waarden = leesTekst(lezer, tekst);
    for (const [id, x] of Object.entries(waarden)) {
      const r = /** @type {Regel} */ (lezer.regels.get(id));
      if (this.#onrustig(id, start)) continue;
      const p = this.params.get(id);
      const hub = this.bekend.get(id) ?? (typeof p?.standaard === 'number' ? p.standaard : 0);
      if (!verschilt(lezer, r, x, hub)) continue;
      const v = naarDraad(r, x);
      this.bekend.set(id, v);
      bewaarBegrensd(this.teruggelezen, { id, v });
      this.kern.ontvang(this.verbinding, { t: 'zet', id, v });
    }
  }

  /** Eén mislukte teruglees-poging: backoff, en alleen de eerste van een storing komt in het log. @param {string} fout */
  #leesMislukt(fout) {
    this.leesFouten++;
    if (this.leesGemeld) return;
    this.leesGemeld = true;
    this.log('driver', this.manifest.app, `teruglezen mislukt: ${fout} (opnieuw met backoff tot ${this.leesMaxMs / 1000} s; verdere fouten niet gelogd)`);
  }

  /** Wachttijd tot de volgende teruglees-ronde: het interval, na fouten verdubbeld tot leesMaxMs. */
  leesWacht() {
    if (!this.leesFouten) return this.leesMs;
    return Math.min(this.leesMaxMs, this.leesMs * 2 ** Math.min(this.leesFouten, 16));
  }

  #planLees() {
    if (this.gestopt || !this.lezer || this.leesTimer !== null) return;
    this.leesTimer = this.klok.zet(() => {
      this.leesTimer = null;
      this.lees().then(() => this.#planLees());
    }, this.leesWacht());
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
    this.#planLees();
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
    if (this.leesTimer !== null) this.klok.wis(this.leesTimer);
    this.leesTimer = null;
    if (this.leesLopend) { const l = this.leesLopend; this.leesLopend = null; this.klok.wis(l.timer); l.ac?.abort(); l.klaar(); }
    this.ontkoppel();
  }
}

// ───────────────────────── teruglezen ─────────────────────────
//
// Verandert iemand iets in de app zelf (de uurwerk-tab), dan leest de driver dat terug met `GET /verb/<lees.verb>`
// en meldt hij elk echt verschil als `zet` aan de kern: bron 'app', zoals een zet van een app (pickup volgt de
// buitenwereld, PROTOCOL §11/§14; de kern stuurt het niet terug). Alleen als config.json `teruglezen.elke_s` zet
// (de enige bron voor het interval) en de app gezond is. Met tolerantie (afronding van de app) en zonder echo (een
// parameter die de hub net zelf stuurde, slaat hij die ronde over). Na een mislukte poging met backoff tot
// `teruglezen.max_s`, en hooguit één logregel per storing. Zonder `driver.lees` geldt STANDAARD_LEES[app] (de
// patchtaal van uurwerk); `lees: false` zet teruglezen uit.

/**
 * Hoe lang één teruglees-verzoek mag duren (de brug vraagt het aan de tab). De volgende ronde wordt pas gepland als
 * deze klaar of opgegeven is: er loopt er nooit meer dan één.
 */
export const LEES_TIMEOUT_MS = 1500;
/** Kortste teruglees-interval, wat config.json ook zegt (begrensd: de tab krijgt hooguit 2 verzoeken per seconde). */
export const LEES_MIN_MS = 500;
/** Standaard en grens voor de backoff na mislukte pogingen, als config.json geen (geldige) `teruglezen.max_s` heeft. */
export const LEES_MAX_S = 30;
/** Meer tekst dan dit wordt niet gelezen (een patch is een paar kB). */
export const LEES_MAX_TEKENS = 200_000;
/**
 * Geen echo: een parameter die de hub binnen deze tijd vóór het verzoek (of erna) zelf stuurde, of waarvan nog een
 * waarde wacht, wordt bij deze ronde niet vergeleken. De tab heeft de waarde dan misschien nog niet; vergelijken
 * zou een oude waarde als wijziging melden en de hub terugtrekken (en een lopende slew afbreken). Even lang als een
 * POST open mag blijven.
 */
export const ECHO_MARGE_MS = POST_TIMEOUT_MS;

/**
 * De patchtaal van uurwerk (uurwerk/taal.js `serialize`, via `GET /verb/toon` → `{ tekst }`). Macro's staan er met
 * twee decimalen in (`toFixed(2)`), dus alles binnen 0,005 (in eenheden van de app) is afronding, geen wijziging.
 * - `licht x` (-1..1) en `samenhang x` ontbreken bij 0;
 * - `tuinman onrust x [bevroren] [op-tijd]` ontbreekt als de tuinman uit staat en onrust 0 is (bevroren dan onbekend);
 * - `dicht x` staat in de `stem`-regel, die ontbreekt zonder stemmen (dan onbekend).
 * Het bereik komt uit driver.verbs (licht: [-1, 1]).
 * @type {Record<string, LeesSpec>}
 */
export const STANDAARD_LEES = {
  uurwerk: {
    verb: 'toon',
    veld: 'tekst',
    tolerantie: 0.005,
    regels: {
      onrust: { patroon: '^tuinman onrust (-?\\d+(?:\\.\\d+)?)\\b', ontbreekt: 0 },
      licht: { patroon: '^licht (-?\\d+(?:\\.\\d+)?)\\s*$', ontbreekt: 0 },
      dicht: { patroon: '^stem .*\\bdicht (-?\\d+(?:\\.\\d+)?)\\b' },
      samenhang: { patroon: '^samenhang (-?\\d+(?:\\.\\d+)?)\\s*$', ontbreekt: 0 },
      bevries: { patroon: '^tuinman onrust \\S+( bevroren)?' },
    },
  },
};

/** @typedef {{ patroon: string, ontbreekt?: number }} LeesRegel */
/** @typedef {{ verb: string, veld?: string, tolerantie?: number, regels: Record<string, LeesRegel> }} LeesSpec */
/** @typedef {{ re: RegExp, soort: 'waarde'|'schakelaar', lo: number, hi: number, ontbreekt?: number }} Regel */
/** @typedef {{ verb: string, veld: string, tolerantie: number, regels: Map<string, Regel> }} Lezer */
/** @typedef {{ ac: AbortController|null, timer: any, klaar: () => void }} LeesLopend */

/**
 * Maak een lezer uit een lees-spec: per parameter een regex en het bereik uit driver.verbs. Ongeldige regels vallen weg
 * en staan in `fouten` (de driver meldt ze één keer); zonder één geldige regel is er geen lezer.
 * @param {unknown} spec  driver.lees (of STANDAARD_LEES[app])
 * @param {Record<string, any>} manifest @param {Record<string, any>} driver
 * @returns {{ lezer: Lezer|null, fouten: string[] }}
 */
export function maakLezer(spec, manifest, driver) {
  /** @type {string[]} */
  const fouten = [];
  if (spec === undefined || spec === null || spec === false) return { lezer: null, fouten };
  const s = /** @type {any} */ (spec);
  if (typeof s !== 'object' || Array.isArray(s)) return { lezer: null, fouten: ['lees moet een object zijn (of false)'] };
  if (typeof s.verb !== 'string' || !/^[a-z0-9_]+$/i.test(s.verb)) fouten.push('lees.verb moet een werkwoord zijn (letters, cijfers, _)');
  if (s.veld !== undefined && typeof s.veld !== 'string') fouten.push('lees.veld moet tekst zijn');
  if (s.tolerantie !== undefined && !(typeof s.tolerantie === 'number' && s.tolerantie >= 0)) fouten.push('lees.tolerantie moet een getal ≥ 0 zijn');
  if (!s.regels || typeof s.regels !== 'object' || Array.isArray(s.regels)) fouten.push('lees.regels ontbreekt');
  if (fouten.length) return { lezer: null, fouten };
  const params = new Map((manifest.params ?? []).map((/** @type {any} */ p) => [p.id, p]));
  /** @type {Map<string, Regel>} */
  const regels = new Map();
  for (const [id, r] of Object.entries(/** @type {Record<string, any>} */ (s.regels))) {
    const p = params.get(id);
    if (!p) { fouten.push(`lees.regels.${id}: geen param met die id`); continue; }
    if (p.soort !== 'waarde' && p.soort !== 'schakelaar') { fouten.push(`lees.regels.${id}: een ${p.soort} wordt niet teruggelezen`); continue; }
    if (!r || typeof r.patroon !== 'string') { fouten.push(`lees.regels.${id}: patroon ontbreekt`); continue; }
    if (r.ontbreekt !== undefined && !Number.isFinite(r.ontbreekt)) { fouten.push(`lees.regels.${id}: ontbreekt moet een getal zijn`); continue; }
    let re;
    try { re = new RegExp(r.patroon); } catch (e) { fouten.push(`lees.regels.${id}: ongeldig patroon (${/** @type {Error} */ (e).message})`); continue; }
    const b = driver.verbs?.[id]?.bereik;
    const [lo, hi] = Array.isArray(b) && b.length === 2 && b.every(Number.isFinite) && b[0] !== b[1] ? b : [0, 1];
    regels.set(id, { re, soort: p.soort, lo, hi, ...(r.ontbreekt !== undefined ? { ontbreekt: r.ontbreekt } : {}) });
  }
  if (!regels.size) return { lezer: null, fouten: [...fouten, 'lees: geen geldige regels'] };
  return { lezer: { verb: s.verb, veld: s.veld ?? 'tekst', tolerantie: s.tolerantie ?? 0.005, regels }, fouten };
}

/**
 * Lees de waarden uit de tekst van de app, in eenheden van de app (licht -1..1; schakelaar 0/1). Puur.
 * Per parameter telt de eerste regel die past; past er geen, dan `ontbreekt` (of onbekend: niet in de uitkomst).
 * @param {Lezer} lezer @param {string} tekst
 * @returns {Record<string, number>}
 */
export function leesTekst(lezer, tekst) {
  const regels = String(tekst).slice(0, LEES_MAX_TEKENS).split('\n');
  /** @type {Record<string, number>} */
  const uit = {};
  for (const [id, r] of lezer.regels) {
    let gevonden = false;
    for (const regel of regels) {
      const m = r.re.exec(regel);
      if (!m) continue;
      if (r.soort === 'schakelaar') { uit[id] = m[1] !== undefined ? 1 : 0; gevonden = true; break; }
      const x = Number(m[1]);
      if (Number.isFinite(x)) { uit[id] = x; gevonden = true; break; }
    }
    if (!gevonden && r.ontbreekt !== undefined) uit[id] = r.ontbreekt;
  }
  return uit;
}

/** Van eenheden van de app naar 0..1 (de draad, huisregel 4). @param {Regel} r @param {number} x */
export const naarDraad = (r, x) => (r.soort === 'schakelaar' ? (x >= 0.5 ? 1 : 0) : klem01((x - r.lo) / (r.hi - r.lo)));

/**
 * Is de waarde van de app echt anders dan wat de hub denkt? Afronding van de app (tolerantie, in eenheden van de app)
 * telt niet; een schakelaar vergelijkt de stand.
 * @param {Lezer} lezer @param {Regel} r @param {number} appWaarde  eenheden van de app @param {number} hub  0..1
 */
export function verschilt(lezer, r, appWaarde, hub) {
  if (r.soort === 'schakelaar') return (appWaarde >= 0.5) !== (hub >= 0.5);
  const hubApp = r.lo + klem01(hub) * (r.hi - r.lo);
  const appGeklemd = Math.min(Math.max(appWaarde, Math.min(r.lo, r.hi)), Math.max(r.lo, r.hi));
  return Math.abs(appGeklemd - hubApp) > lezer.tolerantie + 1e-9;
}

/**
 * config.json `teruglezen` → intervallen in ms. Ontbreekt de sleutel of is `elke_s` 0: uit (null). Een ongeldige
 * waarde geeft een melding en de standaard (2 s, max 30 s). Het interval is nooit korter dan LEES_MIN_MS.
 * @param {unknown} cfg
 * @returns {{ elkeMs: number, maxMs: number, meldingen: string[] } | null}
 */
export function leesTerugleesConfig(cfg) {
  if (cfg === undefined || cfg === null) return null;
  const c = /** @type {any} */ (cfg);
  /** @type {string[]} */
  const meldingen = [];
  let elke = c.elke_s;
  if (elke === 0) return null;
  if (!(typeof elke === 'number' && elke > 0)) {
    meldingen.push(`config.json teruglezen.elke_s moet een getal in seconden zijn (bv. 2, of 0 = uit), niet ${JSON.stringify(elke)}; 2 gebruikt`);
    elke = 2;
  }
  let max = c.max_s ?? LEES_MAX_S;
  if (!(typeof max === 'number' && max > 0)) {
    meldingen.push(`config.json teruglezen.max_s moet een getal in seconden zijn (bv. 30), niet ${JSON.stringify(c.max_s)}; ${LEES_MAX_S} gebruikt`);
    max = LEES_MAX_S;
  }
  const elkeMs = Math.max(LEES_MIN_MS, elke * 1000);
  return { elkeMs, maxMs: Math.max(elkeMs, max * 1000), meldingen };
}
