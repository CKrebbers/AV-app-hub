// @ts-check
// De kern van de hub: staat per app, laagstapel, focus, indeling, pickup, lease, LPD8-globaal,
// snapshots en hartslag (PROTOCOL.md §3-§7). Geen I/O en geen eigen klok: tijd komt via `klok`,
// LEDs gaan via het `oppervlak` (ApcSessie), berichten naar apps via `verbinding.stuur()`.
//
// Laagstapel per binnenkomende gebeurtenis:
//   1. LPD8 → globale laag (altijd, los van focus)
//   2. hubtoets ingedrukt → hublaag (focus, hub-snapshots); niets gaat naar een app
//   3. anders → app met focus: lease (ruwe bytes) of manifest-indeling
// Een 'los' gaat altijd naar waar de bijbehorende 'druk' heen ging (geen hangende triggers).
//
// Geheugen: `exporteer()`/`importeer(data)` (puur) geven en nemen de snapshots en de waarden van apps met
// truth:"hub"; het event 'geheugen' meldt dat daar iets aan veranderde (src/opslag.js schrijft het weg).
// Slots en focus alleen na een herstart midden in de set: `slotsEnFocus()`/`herstelSlotsEnFocus(d)` (loopbestand).
import * as APC from '../devices/apc40mk2.js';
import { klem01 } from '../protocol/berichten.js';
import { valideerManifest, keuzeNaarWaarde, waardeNaarKeuze, ROLLEN, APP_ID, PARAM_ID, MAX_PARAMS } from '../protocol/manifest.js';
import { Zender } from './zender.js';
import { maakIndeling, toewijzingen, controlsVoor } from './indeling.js';
import { nieuwePickup, beweeg, zetDoel, volg } from './pickup.js';
import { maakSlew, slewWaarde, slewKlaar, SLEW_TIK_MS } from './slew.js';

/** @typedef {import('./klok.js').Klok} Klok
 *  @typedef {import('../devices/apc40mk2.js').LedStaat} LedStaat @typedef {import('../devices/apc40mk2.js').Control} Control
 *  @typedef {import('../protocol/types.js').Manifest} Manifest @typedef {import('../protocol/types.js').Param} Param
 *  @typedef {import('../protocol/types.js').NaarApp} NaarApp @typedef {import('../protocol/types.js').AppStatus} AppStatus
 *  @typedef {import('./indeling.js').Indeling} Indeling @typedef {import('./pickup.js').Pickup} Pickup
 *  @typedef {import('./slew.js').Slew} Slew
 *  @typedef {{ app: string|null, stuur: (b: NaarApp) => void, sluit?: () => void }} Verbinding
 *  @typedef {{ zet: (id: string, s: LedStaat) => void, teken: () => number|void, stuur: (b: number[]) => void, vergeet: () => void }} Oppervlak
 *  @typedef {{ dev: string, el: string|null, kind: string, v?: number, raw?: number, delta?: number }} Gebeurtenis
 *  @typedef {{
 *    app: string, slot: number|null, naam: string, kleurHex: string, kleur: number, dim: number,
 *    manifest: Manifest|null, indeling: Indeling|null, pagina: number, waarden: Record<string, number>,
 *    status: AppStatus, v: Verbinding|null, inst: string|null, replay: boolean,
 *    timers: { stil: any, weg: any }, kaart: Map<string, number[][]>, pickups: Map<string, Pickup>,
 *    vast: Map<string, string>, scene: number|null, knoppen: Map<string, number>,
 *  }} AppStaat */

export const BEELD_MS = 100;
export const ADEM_MS = 100;
export const PANIEK_MS = 1000;
export const LANG_MS = 600;
export const TAP_RESET_MS = 2000;
/** Hoe ver (in tijd) de wachtrij van het oppervlak hooguit vooruit mag lopen met LEDs van een lease-app. */
export const LEASE_ACHTERSTAND_MS = 40;
/** Na een herstart midden in de set (herstelSlotsEnFocus): zo lang mag de focus-app van toen de focus terugpakken. */
export const FOCUS_TERUG_MS = 60_000;
const WIT = 3;
const SLOTS = 8;
const OVERLAY = Object.freeze([
  ...Array.from({ length: SLOTS }, (_, i) => APC.padId(5, i + 1)),
  ...Array.from({ length: SLOTS }, (_, i) => `sel${i + 1}`),
  ...Array.from({ length: 5 }, (_, i) => `scene${i + 1}`),
]);
const RINGKNOP = /^(dk|tk)[1-8]$/;
const RINGEN = Object.freeze(APC.MET_LED.filter((c) => c.led === 'ring'));
/** Ringwaarde zoals hij over de draad gaat (7 bit). @param {number} v */
const r7 = (v) => Math.round(klem01(v) * 127);

/** LED uit, zoals LedBeeld.zwart() het noteert. @param {Control} c @returns {LedStaat} */
const uit = (c) => (c.led === 'ring' ? { waarde: 0 } : {});
const gelijk = (/** @type {unknown} */ a, /** @type {unknown} */ b) => JSON.stringify(a) === JSON.stringify(b);
/** Gedimde variant van een hexkleur (≈ een derde helderheid, zoals de donkere tinten in het palet). @param {string} hex */
const gedimd = (hex) => '#' + APC.rgb(hex).map((x) => Math.round(x * 0.35).toString(16).padStart(2, '0')).join('');

/**
 * Waarde zoals de parameter hem kan aannemen (keuze → optie, schakelaar → 0/1).
 * @param {Param|undefined} p @param {number} v
 */
function kwantiseer(p, v) {
  const w = klem01(v);
  if (p?.soort === 'keuze') { const n = p.keuzes?.length ?? 2; return keuzeNaarWaarde(waardeNaarKeuze(w, n), n); }
  if (p?.soort === 'schakelaar') return w >= 0.5 ? 1 : 0;
  return w;
}

/**
 * config.paniek.naloop_s (PROTOCOL §14) in ms. Geen getal ≥ 0 (bv. "5s" of "vijf") → melden en 5 s gebruiken,
 * anders zou nu < nu + NaN de naloop stilletjes uitzetten.
 * @param {unknown} s
 */
export function leesNaloopMs(s) {
  if (s === undefined) return 5000;
  if (typeof s === 'number' && Number.isFinite(s) && s >= 0) return s * 1000;
  console.warn(`[kern] config.json paniek.naloop_s moet een getal in seconden zijn (bv. 5), niet ${JSON.stringify(s)}; nu genegeerd, 5 gebruikt`);
  return 5000;
}

/** Sleutel van een LED-adres in de LED-kaart van een lease-app. @param {number[]} m */
export function ledSleutel(m) {
  const st = m[0] & 0xf0, ch = m[0] & 0x0f;
  if (st === 0x90 || st === 0x80) {
    const c = APC.vindNoot(m[1], ch);
    return c?.led === 'rgb' ? `rgb:${m[1]}` : `n:${ch}:${m[1]}`;
  }
  if (st === 0xb0) return `cc:${ch}:${m[1]}`;
  return null;
}
/**
 * Een LED-element van een lease-app is precies één bericht: note-off, note-on of CC, 3 bytes, data 0..127.
 * Zo komt er nooit (mode-)SysEx, een realtime-byte of een losse statusbyte op de draad, hoe het ook verpakt is.
 * @param {unknown} m @returns {m is number[]}
 */
const isLedBericht = (m) => Array.isArray(m) && m.length === 3 && m.every((x) => Number.isInteger(x) && x >= 0)
  && [0x80, 0x90, 0xb0].includes(m[0] & 0xf0) && m[0] <= 0xff && m[1] <= 0x7f && m[2] <= 0x7f;
/** @param {Control} c */
const sleutelVan = (c) => (c.led === 'rgb' ? `rgb:${c.n}` : `${c.t === 'cc' ? 'cc' : 'n'}:${c.ch}:${c.n}`);
/** Control achter een LED-bericht. @param {number[]} m */
const controlVan = (m) => {
  const st = m[0] & 0xf0, ch = m[0] & 0x0f;
  const c = st === 0x90 || st === 0x80 ? APC.vindNoot(m[1], ch) : st === 0xb0 ? APC.vindCC(m[1], ch) : null;
  return c && c.led !== 'geen' ? c : null;
};

/**
 * LED-kaartregel → LedStaat (voor de cockpit en om verschillen te zien).
 * @param {Control} c @param {number[][]|undefined} regel
 * @returns {LedStaat}
 */
export function decodeer(c, regel) {
  if (!regel?.length) return uit(c);
  const aanNoot = (/** @type {number[]} */ m) => (m[0] & 0xf0) === 0x90 && m[2] > 0;
  if (c.led === 'rgb') {
    const basis = regel.find((m) => aanNoot(m) && (m[0] & 0x0f) === 0);
    const anim = regel.find((m) => aanNoot(m) && (m[0] & 0x0f) > 0);
    if (!anim) return basis ? { kleur: basis[2] } : {};
    const ch = anim[0] & 0x0f;
    const soort = ch <= 5 ? 'oneshot' : ch <= 10 ? 'puls' : 'knipper';
    const snelheid = ch - (ch <= 5 ? 1 : ch <= 10 ? 6 : 11);
    return basis ? { kleur: basis[2], anim: { soort, snelheid, kleur2: anim[2] } } : { kleur: anim[2], anim: { soort, snelheid } };
  }
  const m = regel[regel.length - 1];
  const w = (m[0] & 0xf0) === 0x80 ? 0 : m[2];
  switch (c.led) {
    case 'aan': return w > 0 ? { aan: true } : {};
    case 'clipstop': return w === 0 ? {} : w === 2 ? { knipper: true } : { aan: true };
    case 'ab': return w > 0 ? { stand: /** @type {1|2} */ (Math.min(2, w)) } : {};
    case 'ring': return { waarde: w / 127 };
    default: return {};
  }
}

export class Kern extends Zender {
  /** @param {{ klok: Klok, config?: any, oppervlak: Oppervlak }} o */
  constructor({ klok, config = {}, oppervlak }) {
    super();
    this.klok = klok;
    this.config = config ?? {};
    this.opp = oppervlak;
    /** @type {Map<string, AppStaat>} */
    this.apps = new Map();
    /** @type {(string|null)[]} slot 1..8 → app-id */
    this.slots = [];
    /** @type {string|null} */
    this.focusApp = null;
    /** @type {Set<Verbinding>} */
    this.verbindingen = new Set();
    /** @type {WeakMap<Verbinding, string>} inst van de laatste hallo per verbinding */
    this.instVan = new WeakMap();
    const ht = this.config.hubtoets ?? 'bank';
    this.hubtoets = typeof ht === 'number' ? (APC.CONTROLS.find((c) => c.t === 'note' && c.n === ht && c.ch === 0)?.id ?? 'bank') : ht;
    this.overname = this.config.ringen_nemen_waarde_over ?? true;
    this.stilMs = (this.config.hartslag?.stil_s ?? 3) * 1000;
    this.wegMs = (this.config.hartslag?.weg_s ?? 10) * 1000;
    this.hubIn = false;
    this.shiftIn = false;
    /** @type {Record<string, number|string>} */
    this.globaal = { grondtoon: 'D', bpm: 120, 'klok.adem_periode': 0.5, adem: 0 };
    this.adem = { t: klok.nu(), fase: 0 };
    /** @type {Map<string, number>} laatst bekende fysieke stand per control (apc: id, lpd8: 'lpd8:k1') */
    this.fysiek = new Map();
    /** @type {Map<string, 'hub'|string>} waar de 'druk' van een control heen ging */
    this.routes = new Map();
    /** @type {Map<string, Pickup>} */
    this.lpdPickups = new Map();
    /** @type {Map<string, { app: string, id: string, slew: Slew, bron: string }>} */
    this.slews = new Map();
    /** Bewaarde waarden (van schijf) van truth:"hub"-apps die zich deze sessie nog niet aanmeldden. @type {Map<string, Record<string, number>>} */
    this.bewaard = new Map();
    /** De `inst` waarmee zo'n app zich de vorige hub-sessie het laatst aanmeldde (zie #manifest). @type {Map<string, string>} */
    this.bewaardInst = new Map();
    /** Na een herstart midden in de set: de focus-app van toen, tot hij terug is (of tot bewaardFocusTot). @type {string|null} */
    this.bewaardFocus = null;
    this.bewaardFocusTot = -Infinity;
    /** @type {Map<number, Record<string, Record<string, number>>>} */
    this.snapshots = new Map();
    /** @type {Map<string, LedStaat>} wat er nu op het oppervlak staat (volgens de kern) */
    this.getoond = new Map(APC.MET_LED.map((c) => [c.id, uit(c)]));
    /** @type {{ soort: 'lease'|'manifest', app: string|null }|null} */
    this.getekend = null;
    this.paniekActief = false;
    // §14: tot wanneer een zet die een app zelf doet het pickup-doel van een LPD8-macroknop niet verplaatst
    // (Infinity zolang de paniek loopt, daarna loslaten + paniek.naloop_s). Globaal (LPD8 P1) en per app (Stop All).
    this.paniekNaloopMs = leesNaloopMs(this.config.paniek?.naloop_s);
    this.paniekTot = -Infinity;
    /** @type {Map<string, number>} */
    this.appPaniekTot = new Map();
    /** @type {number[]} */
    this.taps = [];
    /** @type {Map<string, number>} */
    this.padDruk = new Map();
    this.opname = false;
    /** @type {any} */ this.beeldTimer = null;
    this.laatsteBeeld = -Infinity;
    /** @type {any} */ this.ademTimer = null;
    /** @type {any} */ this.slewTimer = null;
    /** @type {any} */ this.p1Timer = null;
    // LEDs van een lease-app gaan pas naar het oppervlak als zijn wachtrij (config.led: per_burst per burst_ms)
    // ruimte heeft; wat daarboven komt wacht hier, per LED-adres samengevoegd (nieuwste wint). Zo loopt die
    // wachtrij nooit vol en zijn Bank en een focuswissel meteen te zien. ledRij schat hoeveel berichten van
    // de kern daar nog wachten.
    this.ledPerBurst = Math.max(1, this.config.led?.per_burst ?? 16);
    this.ledBurstMs = Math.max(1, this.config.led?.burst_ms ?? 4);
    this.ledRij = { t: klok.nu(), n: 0 };
    this.ledMaxRij = this.ledPerBurst * Math.ceil(LEASE_ACHTERSTAND_MS / this.ledBurstMs);
    /** @type {Map<string, number[]>} */
    this.leaseRij = new Map();
    /** @type {any} */ this.leaseTimer = null;
    /** De volgende tekening is een volledige repaint (na opnieuw aansluiten of een nieuw manifest). */
    this.alles = false;
    /** Na stop(): geen nieuwe verbindingen, invoer of timers meer (de hub sluit nog af). */
    this.gestopt = false;
    /** Stand van de fysieke controllers voor de cockpit (gezet door de hub-bedrading). @type {Record<string, { verbonden: boolean, naam?: string|null, model?: string|null }>} */
    this.apparaatInfo = { apc40: { verbonden: false }, lpd8: { verbonden: false } };
    // Een ApcSessie meldt zelf wanneer hij (opnieuw) is aangesloten of wegvalt.
    /** @type {(() => void)[]} */
    this.afmelden = [];
    const o = /** @type {any} */ (oppervlak);
    if (typeof o?.bij === 'function') {
      this.afmelden.push(o.bij('verbonden', () => this.herteken()), o.bij('weg', () => this.apparaatWeg('apc40')));
    }
  }

  // ── verbindingen en berichten van apps ─────────────────────────────────────

  /** Nieuwe verbinding; de app is nog onbekend tot `hallo`. @param {Verbinding} v */
  verbind(v) {
    if (this.gestopt) return;
    this.verbindingen.add(v);
    this.#naarV(v, { t: 'welkom', hub: 'varve-hub', v: 1 });
  }

  /** @param {Verbinding} v @param {any} b gecontroleerd bericht (leesVanApp) */
  ontvang(v, b) {
    if (this.gestopt || !b || typeof b !== 'object') return;
    if (b.t === 'hallo') return this.#hallo(v, b);
    if (!v.app) { this.#naarV(v, { t: 'fout', reden: 'stuur eerst hallo' }); return; }
    const a = this.apps.get(v.app);
    // Een vervangen verbinding die niet dicht kan (een driver) blijft achter de hand: is de nieuwere
    // weer weg, dan neemt hij het bij zijn volgende bericht weer over, als na een eigen hallo.
    if (a && a.v === null && this.verbindingen.has(v)) this.#hallo(v, { app: a.app, inst: this.instVan.get(v) ?? '' });
    if (!a || a.v !== v) return; // een oude, vervangen verbinding
    this.#hartslag(a);
    switch (b.t) {
      case 'manifest': return this.#manifest(a, b.manifest);
      case 'staat': return this.#staat(a, b.waarden ?? {});
      case 'zet': if (typeof b.id === 'string' && typeof b.v === 'number') this.#zetWaarde(a, b.id, b.v, { naarApp: false, bron: 'app' }); return;
      case 'led': if (Array.isArray(b.bytes)) this.#leaseLed(a, b.bytes); return;
      default: return; // hb en onbekende types: alleen hartslag
    }
  }

  /**
   * Verbinding dicht: app blijft bekend met status 'weg', waarden bewaard. Een app die nooit een (geldig) manifest
   * stuurde, heeft niets om te bewaren en wordt vergeten: anders groeit de lijst (en elk beeld voor de cockpit) met
   * elke half afgebouwde app en elke steeds andere naam, een hele avond lang (docs/DUURTEST.md).
   * @param {Verbinding} v
   */
  verbreek(v) {
    this.verbindingen.delete(v);
    const a = v.app ? this.apps.get(v.app) : undefined;
    if (!a || a.v !== v) return;
    a.v = null;
    this.#wisHartslag(a);
    if (!a.manifest) { this.#vergeet(a); return; }
    a.status = 'weg';
    this.#statusGewijzigd(a);
  }

  /** Een app zonder manifest helemaal vergeten: zijn slot komt vrij, de focus (als hij die had) gaat naar niemand. @param {AppStaat} a */
  #vergeet(a) {
    this.apps.delete(a.app);
    this.appPaniekTot.delete(a.app);
    if (a.slot !== null && this.slots[a.slot - 1] === a.app) this.slots[a.slot - 1] = null;
    a.slot = null;
    // Niet via focus(null): dat is een keuze van Clay (of de set). Hier valt alleen een app weg; wat de hub nog
    // weet over wie de focus hoort te krijgen (bv. na een herstart midden in de set), blijft staan.
    const hadFocus = this.focusApp === a.app;
    if (hadFocus) this.focusApp = null;
    if (hadFocus || this.hubIn) this.#teken();
    this.#beeldGewijzigd();
  }

  /** @param {Verbinding} v @param {{ app: string, inst: string }} b */
  #hallo(v, b) {
    if (!this.verbindingen.has(v)) return; // al verbroken of vervangen
    if (v.app && v.app !== b.app) { this.#naarV(v, { t: 'fout', reden: `deze verbinding is al ${v.app}` }); return; }
    v.app = b.app;
    let a = this.apps.get(b.app);
    if (!a) {
      a = this.#nieuweApp(b.app);
      this.apps.set(b.app, a);
    }
    if (a.v && a.v !== v) {
      // Een nieuwere verbinding van dezelfde app neemt het over; de oude hoort dat en gaat dicht.
      const oud = a.v;
      this.#naarV(oud, { t: 'fout', reden: 'vervangen door een nieuwere verbinding van deze app' });
      // Een driver (geen sluit) gaat niet dicht en meldt zich niet opnieuw aan: hij blijft bekend, zodat hij
      // het weer overneemt als de nieuwere verbinding wegvalt (zie ontvang).
      if (oud.sluit) {
        this.verbindingen.delete(oud);
        try { oud.sluit(); } catch (e) { console.error('[kern] sluiten van vervangen verbinding mislukt:', e); }
      }
    }
    this.instVan.set(v, b.inst);
    const herstart = a.inst !== null && a.inst !== b.inst;
    a.v = v;
    a.inst = b.inst;
    a.replay = false;
    a.status = a.manifest ? 'actief' : 'nieuw';
    this.#geefSlot(a);
    if (herstart) a.pickups = new Map();
    this.#hartslag(a);
    this.#naar(a, { t: 'globaal', waarden: { ...this.globaal } });
    if (a.manifest?.truth === 'hub') {
      for (const p of a.manifest.params) {
        if (p.soort === 'trigger' || !(p.id in a.waarden)) continue;
        // Na een herstart staat de app weer op zijn standaardwaarde: van daaruit verlopen (slew_s).
        // Bij een netwerkhapering (zelfde inst) heeft hij de waarde nog: gewoon opnieuw sturen.
        if (herstart && this.#slewt(p)) {
          const doel = this.#doel(a, p.id);
          a.waarden[p.id] = kwantiseer(p, p.standaard ?? 0);
          this.#zetZacht(a, p.id, doel, 'replay');
        } else this.#naar(a, { t: 'zet', id: p.id, v: a.waarden[p.id], bron: 'replay' });
      }
      a.replay = true;
    }
    // Had deze app de focus vóór een herstart van de hub, dan krijgt hij hem terug (ook als een andere app eerder
    // terugkwam en de focus tijdelijk kreeg), tenzij Clay intussen zelf een focus koos (focus() wist bewaardFocus).
    const terug = this.#bewaardeFocus() === a.app;
    if (terug) this.bewaardFocus = null;
    if (this.focusApp === null || (terug && this.focusApp !== a.app)) this.#zetFocus(a.app);
    else if (this.focusApp === a.app) { this.#naar(a, { t: 'focus', aan: true }); this.#teken(); }
    else if (this.hubIn) this.#teken();
    this.#startAdem();
    this.#beeldGewijzigd();
  }

  /** @param {string} app @returns {AppStaat} */
  #nieuweApp(app) {
    const cfg = this.#appCfg(app);
    /** @type {AppStaat} */
    const a = {
      app, slot: null, naam: cfg.naam ?? app, kleurHex: '#ffffff', kleur: 3, dim: 1,
      manifest: null, indeling: null, pagina: 0, waarden: {}, status: 'nieuw', v: null, inst: null, replay: false,
      timers: { stil: null, weg: null }, kaart: new Map(), pickups: new Map(), vast: new Map(), scene: null, knoppen: new Map(),
    };
    this.#zetKleur(a, cfg.kleur);
    return a;
  }

  /**
   * Een levende app zonder slot krijgt er een: een vrij slot, of anders dat van een weggevallen app
   * (liefst niet die met focus). Een weggevallen app houdt zijn slot zolang niemand het nodig heeft.
   * @param {AppStaat} a
   */
  #geefSlot(a) {
    if (a.slot !== null) return;
    // Zijn eigen slot van vóór een herstart van de hub (herstelSlotsEnFocus), of een gat: dat eerst.
    const eigen = this.slots.indexOf(a.app);
    const gat = eigen >= 0 ? eigen : this.slots.indexOf(null);
    if (gat >= 0) { this.slots[gat] = a.app; a.slot = gat + 1; return; }
    if (this.slots.length < SLOTS) { a.slot = this.slots.push(a.app); return; }
    const weg = (/** @type {string|null} */ id) => { const st = this.apps.get(id ?? '')?.status; return st === undefined || st === 'weg'; };
    const bewaard = this.#bewaardeFocus();
    let i = this.slots.findIndex((id) => weg(id) && id !== this.focusApp && id !== bewaard);
    if (i < 0) i = this.slots.findIndex((id) => weg(id));
    if (i < 0) return;
    const oud = this.apps.get(this.slots[i] ?? '');
    if (oud) oud.slot = null;
    this.slots[i] = a.app;
    a.slot = i + 1;
  }

  /**
   * Instellingen van een app uit config.apps. Een app die zich per monitor aanmeldt (`flux-dp-1`) valt terug
   * op de basis-app met `per_monitor: true` (`flux`): zijn kleur, en als naam "Flux (dp-1)" (`monitor`: "dp-1").
   * @param {string} app @returns {Record<string, any>}
   */
  #appCfg(app) {
    const apps = this.config.apps ?? {};
    if (apps[app]) return apps[app];
    for (const [basis, cfg] of Object.entries(apps)) {
      if (!cfg?.per_monitor || !app.startsWith(`${basis}-`) || app.length <= basis.length + 1) continue;
      const monitor = app.slice(basis.length + 1);
      return { ...cfg, naam: `${cfg.naam ?? basis} (${monitor})`, monitor };
    }
    return {};
  }

  /** @param {AppStaat} a @param {string|undefined} hex */
  #zetKleur(a, hex) {
    a.kleurHex = typeof hex === 'string' && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toLowerCase() : '#ffffff';
    a.kleur = APC.dichtsteKleur(a.kleurHex);
    a.dim = APC.dichtsteKleur(gedimd(a.kleurHex));
  }

  /** @param {AppStaat} a @param {unknown} m */
  #manifest(a, m) {
    const r = valideerManifest(m);
    if (!r.ok) { this.#naar(a, { t: 'fout', reden: `ongeldig manifest: ${r.fouten.join('; ')}` }); return; }
    if (r.manifest.app !== a.app) { this.#naar(a, { t: 'fout', reden: `manifest.app (${r.manifest.app}) ≠ hallo.app (${a.app})` }); return; }
    const man = r.manifest;
    const cfg = this.#appCfg(a.app);
    // rings valt terug op config.apps.<app>.rings, zoals kleur (de validator vult anders 'host' in).
    if (man.lease && /** @type {any} */ (m).rings === undefined && (cfg.rings === 'auto' || cfg.rings === 'host')) man.rings = cfg.rings;
    a.manifest = man;
    // Per monitor (flux-dp-1, flux-hdmi-1): staat de monitor niet al in de manifest-naam, dan komt hij erachter,
    // anders zijn twee monitoren in de cockpit niet uit elkaar te houden.
    a.naam = cfg.monitor && !man.naam.toLowerCase().includes(String(cfg.monitor).toLowerCase()) ? `${man.naam} (${cfg.monitor})` : man.naam;
    this.#zetKleur(a, man.kleur ?? cfg.kleur);
    // Alleen waarden (en slews) van de eigen parameters: wat een vorig manifest of een staat vóór het manifest
    // achterliet, valt weg. Anders groeit dit met elk ander manifest en elke onbekende id (en elk beeld mee).
    const eigen = new Set(man.params.filter((p) => p.soort !== 'trigger').map((p) => p.id));
    for (const id of Object.keys(a.waarden)) if (!eigen.has(id)) { delete a.waarden[id]; this.slews.delete(`${a.app}\u0000${id}`); }
    for (const p of man.params) if (p.soort !== 'trigger' && !(p.id in a.waarden)) a.waarden[p.id] = p.standaard ?? 0;
    // Waarden van schijf (vorige hub-sessie) voor een truth:"hub"-app: nu pas weten we dat hij ze wil.
    // Komt hij nu als truth:"app", dan zijn ze niet meer nodig: niet eeuwig in het geheugen laten staan.
    const bewaard = man.truth === 'hub' ? this.bewaard.get(a.app) : undefined;
    const bewaardInst = this.bewaardInst.get(a.app);
    const vergeten = this.bewaard.delete(a.app);
    this.bewaardInst.delete(a.app);
    a.indeling = man.lease ? null : maakIndeling(man, this.config.kaarten?.[a.app] ?? null);
    a.pagina = Math.min(a.pagina, (a.indeling?.paginas.length ?? 1) - 1);
    a.pickups = new Map();
    if (a.status === 'nieuw') a.status = 'actief';
    this.#hartslag(a); // opnieuw, nu met de hb_s van het manifest
    if (bewaard) {
      // Opnieuw afspelen (§10, §12). Dezelfde inst als vorige hub-sessie: de app draaide gewoon door en heeft de
      // waarden nog (zoals bij een netwerkhapering) → direct. Een nieuwe inst: de app staat op zijn standaardwaarde
      // → van daaruit verlopen met slew_s.
      const zelfde = bewaardInst !== undefined && bewaardInst === a.inst;
      for (const p of man.params) {
        if (p.soort === 'trigger' || typeof bewaard[p.id] !== 'number') continue;
        if (zelfde) this.#zetWaarde(a, p.id, bewaard[p.id], { naarApp: true, bron: 'replay' });
        else this.#zetZacht(a, p.id, bewaard[p.id], 'replay');
      }
      a.replay = true;
    }
    if (man.truth === 'hub' || vergeten) this.meld('geheugen');
    // `getekend` blijft staan: was het oppervlak door een lease getekend, dan neemt #tekenManifest het vergeet-pad.
    if (this.focusApp === a.app) this.#teken();
    else if (this.hubIn) this.#teken();
    this.#beeldGewijzigd();
  }

  /** @param {AppStaat} a @param {Record<string, number>} waarden */
  #staat(a, waarden) {
    // truth "hub": de hub heeft net zijn waarden opnieuw afgespeeld; de (standaard)staat van de app wint niet.
    // Alleen de eerste staat na de replay; latere (ook gedeeltelijke) staat telt gewoon.
    if (a.manifest?.truth === 'hub' && a.replay) { a.replay = false; return; }
    for (const [id, v] of Object.entries(waarden)) if (typeof v === 'number') this.#zetWaarde(a, id, v, { naarApp: false, bron: 'app' });
  }

  // ── hartslag ───────────────────────────────────────────────────────────────

  /** Elk bericht telt als hartslag. @param {AppStaat} a */
  #hartslag(a) {
    this.#wisHartslag(a);
    if (a.status === 'stil' || a.status === 'weg') { a.status = a.manifest ? 'actief' : 'nieuw'; this.#statusGewijzigd(a); }
    // config.hartslag geldt voor hb_s = 1; een app met een tragere hartslag krijgt evenredig meer tijd.
    const schaal = Math.max(1, a.manifest?.hb_s ?? 1);
    a.timers.stil = this.klok.zet(() => { a.timers.stil = null; if (a.status !== 'weg') { a.status = 'stil'; this.#statusGewijzigd(a); } }, this.stilMs * schaal);
    a.timers.weg = this.klok.zet(() => { a.timers.weg = null; a.status = 'weg'; this.#statusGewijzigd(a); }, this.wegMs * schaal);
  }
  /** @param {AppStaat} a */
  #wisHartslag(a) {
    if (a.timers.stil !== null) this.klok.wis(a.timers.stil);
    if (a.timers.weg !== null) this.klok.wis(a.timers.weg);
    a.timers.stil = a.timers.weg = null;
  }
  /** @param {AppStaat} [a] */
  #statusGewijzigd(a) {
    // Een lease-app met focus die wegvalt: oppervlak uit (geen bevroren beeld); terug = zijn kaart terug.
    if (this.hubIn || (a && a.app === this.focusApp && a.manifest?.lease)) this.#teken();
    this.#beeldGewijzigd();
  }

  // ── waarden ────────────────────────────────────────────────────────────────

  /** @param {AppStaat} a @param {string} id */
  #param(a, id) { return a.manifest?.params.find((p) => p.id === id); }

  /**
   * De enige plek waar een waarde verandert: bijwerken, eventueel naar de app, LEDs en pickup mee.
   * bron 'app': de app meldde het zelf (zet of staat); dan is naarApp altijd false.
   * @param {AppStaat} a @param {string} id @param {number} v
   * @param {{ naarApp: boolean, bron?: string, slew?: boolean, ctrl?: string }} o  ctrl: de control die de waarde zelf zette
   */
  #zetWaarde(a, id, v, { naarApp, bron, slew = false, ctrl: van = undefined }) {
    const p = this.#param(a, id);
    if (a.manifest && (!p || p.soort === 'trigger')) return;
    // Nog geen manifest: alleen geldige ids, en niet meer dan een manifest kan hebben (het manifest ruimt op).
    if (!a.manifest && !(id in a.waarden) && (!PARAM_ID.test(id) || Object.keys(a.waarden).length >= MAX_PARAMS)) return;
    const w = kwantiseer(p, v);
    if (!slew) this.slews.delete(`${a.app}\u0000${id}`);
    const was = a.waarden[id];
    a.waarden[id] = w;
    // §14: een keuze of schakelaar die al op deze stand staat, krijgt geen zet nog eens (LEDs en pickup gaan wel mee).
    // Replay altijd: na een herstart weet de app het nog niet.
    const zelfde = (p?.soort === 'keuze' || p?.soort === 'schakelaar') && w === was && bron !== 'replay';
    if (naarApp && !zelfde) this.#naar(a, { t: 'zet', id, v: w, ...(bron ? { bron } : {}) });
    if (this.focusApp === a.app && a.indeling) {
      for (const ctrl of controlsVoor(a.indeling, a.pagina, id)) {
        if (ctrl === van) continue; // de bewegende control houdt zijn eigen (ongekwantiseerde) stand
        const pk = a.pickups.get(ctrl);
        if (pk) a.pickups.set(ctrl, zetDoel(pk, w));
      }
      this.#teken();
    }
    // Een LPD8-knop met deze rol moet weer 'wachten' als zijn doel van buitenaf veranderde
    // (snapshot, app, cockpit); zijn eigen macro (en de slew daarvan) niet.
    // §14: wat een app zelf verandert tijdens (of vlak na) een paniek, verplaatst het doel niet: de knop blijft
    // gevangen en de eerste tik zet weer alle apps met die rol. Was er nog geen pickup, dan wordt het doel van
    // vóór deze zet vastgelegd (anders nam #macroDoel straks de paniekwaarde).
    const k = p?.rol ? /** @type {readonly string[]} */ (ROLLEN).indexOf(p.rol) : -1;
    const knop = k >= 0 && bron !== 'lpd8' ? `k${k + 1}` : null;
    const lpk = knop ? this.lpdPickups.get(knop) : undefined;
    const vasthouden = knop !== null && bron === 'app' && this.#inPaniek(a);
    if (knop && (lpk || vasthouden) && p?.rol && this.#rolParam(p.rol)?.a === a) {
      if (!vasthouden) this.lpdPickups.set(knop, zetDoel(/** @type {Pickup} */ (lpk), w));
      else if (!lpk) this.lpdPickups.set(knop, nieuwePickup(was ?? p.standaard ?? 0, this.fysiek.get(`lpd8:${knop}`) ?? null));
    }
    // §14: verandert de adem-app zelf (of via cockpit/snapshot) zijn tempo, dan gaat de globale adem-klok mee, zodat
    // alle apps en de cockpit dezelfde periode hebben als de app die je hoort. De LPD8 (K7) zet globaal al in #macro.
    if (p?.rol === 'klok.adem_periode' && bron !== 'lpd8' && this.#rolParam(p.rol)?.a === a
      && Math.abs(Number(this.globaal['klok.adem_periode']) - w) > 1e-9) {
      this.adem = { t: this.klok.nu(), fase: this.#ademFase() };
      this.#globaal({ 'klok.adem_periode': w });
    }
    if (a.manifest?.truth === 'hub') this.meld('geheugen');
    this.#beeldGewijzigd();
  }

  /**
   * Stop All is losgelaten: de paniek van die app gaat over in de naloop. Los van de indeling (de app kan intussen
   * een manifest zonder paniek-trigger of een lease hebben gestuurd, of vergeten zijn), anders bleef hij Infinity.
   * @param {string} app
   */
  #stopAllLos(app) {
    if (this.appPaniekTot.get(app) === Infinity) this.appPaniekTot.set(app, this.klok.nu() + this.paniekNaloopMs);
  }

  /** Loopt er voor deze app een paniek (LPD8 P1 of zijn eigen Stop All), of is hij net voorbij (paniek.naloop_s)? @param {AppStaat} a */
  #inPaniek(a) {
    const nu = this.klok.nu();
    return nu < this.paniekTot || nu < (this.appPaniekTot.get(a.app) ?? -Infinity);
  }

  /** Verloopt een zet op deze parameter over slew_s? Alleen voor `waarde` (een keuze of schakelaar springt). @param {Param|undefined} p */
  #slewt(p) { return !!p && p.soort === 'waarde' && typeof p.slew_s === 'number' && p.slew_s > 0; }

  /** Waar een parameter heen gaat: het doel van een lopende slew, anders de huidige waarde. @param {AppStaat} a @param {string} id */
  #doel(a, id) {
    const s = this.slews.get(`${a.app}\u0000${id}`);
    return s ? s.slew.naar : a.waarden[id];
  }

  /**
   * Een zet van de hub zelf (LPD8-macro, cockpit, snapshot, replay): met slew_s verloopt hij (§4), anders meteen.
   * Directe APC-bewegingen gaan hier niet langs: die zijn al continu en moeten direct voelen.
   * @param {AppStaat} a @param {string} id @param {number} v @param {string} bron
   */
  #zetZacht(a, id, v, bron) {
    const p = this.#param(a, id);
    if (p && this.#slewt(p) && kwantiseer(p, v) !== a.waarden[id]) this.#startSlew(a, id, kwantiseer(p, v), /** @type {number} */ (p.slew_s), bron);
    else this.#zetWaarde(a, id, v, { naarApp: true, bron });
  }

  // ── focus ──────────────────────────────────────────────────────────────────

  /** Focus naar app (id) of null, gekozen door Clay of de set (wint van bewaardFocus); false als de app onbekend is. @param {string|null} app */
  focus(app) { const ok = this.#zetFocus(app); if (ok) this.bewaardFocus = null; return ok; }

  /** @param {string|null} app */
  #zetFocus(app) {
    if (app !== null && !this.apps.has(app)) return false;
    if (app === this.focusApp) return true;
    const oud = this.focusApp ? this.apps.get(this.focusApp) : undefined;
    if (oud) this.#naar(oud, { t: 'focus', aan: false });
    this.focusApp = app;
    const a = app ? this.apps.get(app) : undefined;
    if (a) { a.pickups = new Map(); this.#naar(a, { t: 'focus', aan: true }); }
    this.#teken();
    this.#beeldGewijzigd();
    return true;
  }

  // ── invoer van de controllers ──────────────────────────────────────────────

  /**
   * Gebeurtenis van ApcSessie/Lpd8Sessie (of een virtuele controller) met de ruwe bytes.
   * @param {Gebeurtenis} g @param {number[]} [bytes]
   */
  invoer(g, bytes) {
    if (this.gestopt) return;
    this.meld('invoer', g);
    if (g.dev === 'lpd8') return this.#lpd8(g);
    if (g.dev !== 'apc40') return;
    const el = g.el;
    if (!el) {
      // Niet-herkende MIDI (geen SysEx): een lease-app mag het hebben.
      const a = this.#focusAppStaat();
      if (a?.manifest?.lease && !this.hubIn && bytes && bytes[0] !== 0xf0) this.#naar(a, { t: 'midi', dev: 'apc40', bytes: [...bytes] });
      return;
    }
    const vorig = this.fysiek.get(el);
    if (g.kind === 'waarde' && typeof g.v === 'number') this.fysiek.set(el, g.v);
    if (el === 'shift' && (g.kind === 'druk' || g.kind === 'los')) this.shiftIn = g.kind === 'druk';

    if (el === this.hubtoets) {
      if (g.kind === 'druk') this.hubIn = true;
      else if (g.kind === 'los') this.hubIn = false;
      else return;
      this.#teken();
      return;
    }

    if (g.kind === 'los' && this.routes.has(el)) {
      const r = this.routes.get(el);
      this.routes.delete(el);
      if (el === 'stopall' && r && r !== 'hub') this.#stopAllLos(r);
      const a = r && r !== 'hub' ? this.apps.get(r) : undefined;
      if (a) this.#naarAppInvoer(a, g, bytes, vorig);
      return;
    }

    if (this.hubIn) {
      if (g.kind === 'druk') { this.routes.set(el, 'hub'); this.#hubInvoer(el); }
      else if (g.kind === 'waarde' && typeof g.v === 'number') {
        const a = this.#focusAppStaat(), pk = a?.pickups.get(el);
        if (a && pk) a.pickups.set(el, volg(pk, g.v));
        // Een ringknop: zijn interne waarde terug naar wat de app kent (anders springt hij na loslaten).
        const c = APC.OP_ID.get(el);
        if (a?.manifest?.lease && a.status !== 'weg' && c?.led === 'ring') {
          const w = a.knoppen.get(el) ?? 0;
          for (const b of APC.ledBerichten(c, { waarde: w })) this.#oppStuur(b);
          // Zonder overname is de ring alleen een lampje: de knop blijft waar hij fysiek staat.
          if (this.overname) this.fysiek.set(el, r7(w) / 127);
        } else if ((a && pk) || c?.led === 'ring') this.#teken();
      }
      return;
    }

    const a = this.#focusAppStaat();
    if (!a) return;
    if (g.kind === 'druk') this.routes.set(el, a.app);
    this.#naarAppInvoer(a, g, bytes, vorig);
  }

  /** @param {AppStaat} a @param {Gebeurtenis} g @param {number[]|undefined} bytes @param {number|undefined} vorig */
  #naarAppInvoer(a, g, bytes, vorig) {
    if (a.manifest?.lease) this.#leaseInvoer(a, g, bytes);
    else if (a.indeling) this.#manifestInvoer(a, g, vorig);
  }

  /** Hublaag: Track Select = focus, Scene = hub-snapshot (met Shift: bewaren). @param {string} el */
  #hubInvoer(el) {
    const sel = /^sel([1-8])$/.exec(el);
    if (sel) { const app = this.slots[Number(sel[1]) - 1]; if (app) this.focus(app); return; }
    const sc = /^scene([1-5])$/.exec(el);
    if (sc) { const nr = Number(sc[1]); if (this.shiftIn) this.bewaar(nr); else this.laad(nr); }
  }

  /** @param {AppStaat} a @param {Gebeurtenis} g @param {number[]|undefined} bytes */
  #leaseInvoer(a, g, bytes) {
    if (!bytes || bytes[0] === 0xf0) return;
    if (g.kind === 'waarde' && typeof g.v === 'number' && g.el && RINGKNOP.test(g.el)) a.knoppen.set(g.el, g.v);
    this.#naar(a, { t: 'midi', dev: 'apc40', bytes: [...bytes] });
    // rings:"auto" — emulatie van APC-modus 0x41: de knop-CC terug naar zijn ring.
    if (a.manifest?.rings === 'auto' && g.kind === 'waarde' && g.el && RINGKNOP.test(g.el)) this.#leaseLed(a, [[0xb0 | (bytes[0] & 0x0f), bytes[1], bytes[2]]]);
  }

  /** @param {AppStaat} a @param {Gebeurtenis} g @param {number|undefined} vorig */
  #manifestInvoer(a, g, vorig) {
    const ind = /** @type {Indeling} */ (a.indeling);
    const el = /** @type {string} */ (g.el);
    const druk = g.kind === 'druk', los = g.kind === 'los';
    // Een ingedrukte trigger krijgt zijn 'uit' op de parameter van de druk, ook als de indeling
    // intussen veranderde (nieuw manifest, andere pagina).
    if (los && a.vast.has(el)) {
      const id = /** @type {string} */ (a.vast.get(el));
      a.vast.delete(el);
      this.#naar(a, { t: 'trig', id, aan: false });
      if (this.focusApp === a.app) this.#teken();
      return;
    }
    const t = toewijzingen(ind, a.pagina)[el];
    if (t) {
      const huidig = a.waarden[t.id] ?? 0;
      switch (t.rol) {
        case 'fader': case 'ring': {
          if (g.kind !== 'waarde' || typeof g.v !== 'number') return;
          const modus = t.rol === 'ring' && this.overname ? 'direct' : t.takeover;
          const pk = a.pickups.get(el) ?? nieuwePickup(huidig, vorig ?? null, modus);
          const r = beweeg(pk, g.v);
          a.pickups.set(el, r.p);
          if (r.uit !== null) this.#zetWaarde(a, t.id, r.uit, { naarApp: true, bron: 'apc40', ctrl: el });
          else { this.#teken(); if (r.p.gevangen !== pk.gevangen) this.#beeldGewijzigd(); }
          return;
        }
        case 'keuze':
          if (druk && t.optie !== undefined && t.n !== undefined && t.optie < t.n) this.#zetWaarde(a, t.id, keuzeNaarWaarde(t.optie, t.n), { naarApp: true, bron: 'apc40' });
          return;
        case 'stap': {
          if (!druk) return;
          const n = t.n ?? 2;
          this.#zetWaarde(a, t.id, keuzeNaarWaarde((waardeNaarKeuze(huidig, n) + 1) % n, n), { naarApp: true, bron: 'apc40' });
          return;
        }
        case 'schakelaar':
          if (druk) this.#zetWaarde(a, t.id, huidig >= 0.5 ? 0 : 1, { naarApp: true, bron: 'apc40' });
          return;
        case 'trigger':
          if (!druk) return; // los: hierboven (alleen als de druk een trigger raakte)
          a.vast.set(el, t.id);
          this.#naar(a, { t: 'trig', id: t.id, aan: true });
          if (this.focusApp === a.app) this.#teken();
          return;
      }
    }
    const sc = /^scene([1-5])$/.exec(el);
    if (sc && druk && Number(sc[1]) <= ind.scenes) {
      a.scene = Number(sc[1]) - 1;
      this.#naar(a, { t: 'scene', i: a.scene });
      if (this.focusApp === a.app) this.#teken();
      return;
    }
    if (el === 'stopall' && ind.paniek && (druk || los)) {
      if (druk) this.appPaniekTot.set(a.app, Infinity);
      else this.#stopAllLos(a.app);
      this.#naar(a, { t: 'trig', id: ind.paniek, aan: druk });
      return;
    }
    if ((el === 'devL' || el === 'devR') && druk) {
      const nieuw = Math.max(0, Math.min(ind.paginas.length - 1, a.pagina + (el === 'devR' ? 1 : -1)));
      if (nieuw === a.pagina) return;
      a.pagina = nieuw;
      for (const k of [...a.pickups.keys()]) if (k.startsWith('dk')) a.pickups.delete(k);
      if (this.focusApp === a.app) this.#teken();
      this.#beeldGewijzigd();
    }
  }

  // ── LPD8: de globale laag ──────────────────────────────────────────────────

  /** @param {Gebeurtenis} g */
  #lpd8(g) {
    const el = g.el ?? '';
    const knop = /^k([1-8])$/.exec(el);
    if (knop && g.kind === 'waarde' && typeof g.v === 'number') {
      const rol = ROLLEN[Number(knop[1]) - 1];
      const sleutel = `lpd8:${el}`;
      const vorig = this.fysiek.get(sleutel);
      this.fysiek.set(sleutel, g.v);
      const pk = this.lpdPickups.get(el) ?? nieuwePickup(this.#macroDoel(rol), vorig ?? null);
      const r = beweeg(pk, g.v);
      this.lpdPickups.set(el, r.p);
      if (r.uit !== null) this.#macro(rol, r.uit);
      return;
    }
    const pad = /^p([1-8])$/.exec(el);
    if (!pad) return;
    const nr = Number(pad[1]);
    const nu = this.klok.nu();
    if (g.kind === 'druk') {
      if (nr === 1) { if (this.p1Timer === null) this.p1Timer = this.klok.zet(() => { this.p1Timer = null; this.#paniek(true); }, PANIEK_MS); }
      else if (nr === 2) this.#tap(nu);
      else if (nr === 3) this.#ademOpnieuw();
      else if (nr === 4) { this.opname = !this.opname; this.meld('opname', this.opname); this.#beeldGewijzigd(); }
      else this.padDruk.set(el, nu);
    } else if (g.kind === 'los') {
      if (nr === 1) {
        if (this.p1Timer !== null) { this.klok.wis(this.p1Timer); this.p1Timer = null; }
        if (this.paniekActief) this.#paniek(false);
      } else if (nr >= 5) {
        const start = this.padDruk.get(el);
        this.padDruk.delete(el);
        if (start === undefined) return;
        if (nu - start > LANG_MS) this.bewaar(nr - 4); else this.laad(nr - 4);
      }
    }
  }

  /** De eerste app met een parameter met deze rol (§10), of undefined. @param {string} rol */
  #rolParam(rol) {
    for (const a of this.apps.values()) {
      const p = a.manifest?.params.find((x) => x.rol === rol && x.soort !== 'trigger');
      if (p) return { a, p };
    }
    return undefined;
  }

  /**
   * Doel voor de pickup van een LPD8-knop (§10): de huidige waarde van de eerste app met een parameter
   * met die rol, anders de globale waarde, anders 0.5. Zo springt er ook bij de eerste aanraking niets.
   * @param {string} rol
   */
  #macroDoel(rol) {
    const r = this.#rolParam(rol);
    if (r) return r.a.waarden[r.p.id] ?? r.p.standaard ?? 0;
    const g = this.globaal[rol];
    return typeof g === 'number' ? g : 0.5;
  }

  /** Globale macro: elke app met die rol krijgt een zet (met slew), iedereen krijgt globaal. @param {string} rol @param {number} v */
  #macro(rol, v) {
    if (rol === 'klok.adem_periode') this.adem = { t: this.klok.nu(), fase: this.#ademFase() };
    for (const a of this.apps.values()) {
      for (const p of a.manifest?.params ?? []) {
        if (p.rol !== rol || p.soort === 'trigger') continue;
        this.#zetZacht(a, p.id, v, 'lpd8');
      }
    }
    this.#globaal({ [rol]: v });
  }

  /** @param {boolean} aan */
  #paniek(aan) {
    this.paniekActief = aan;
    this.paniekTot = aan ? Infinity : this.klok.nu() + this.paniekNaloopMs;
    for (const a of this.apps.values()) {
      if (a.manifest?.params.some((p) => p.id === 'paniek' && p.soort === 'trigger')) this.#naar(a, { t: 'trig', id: 'paniek', aan });
    }
    this.#globaal({ paniek: aan ? 1 : 0 });
  }

  /** Tap tempo: gemiddelde van de laatste (max 4) intervallen; na 2 s stilte opnieuw beginnen. @param {number} nu */
  #tap(nu) {
    if (this.taps.length && nu - this.taps[this.taps.length - 1] > TAP_RESET_MS) this.taps = [];
    this.taps.push(nu);
    if (this.taps.length > 5) this.taps.shift();
    if (this.taps.length < 2) return;
    const gem = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
    const bpm = Math.max(20, Math.min(300, Math.round((60000 / gem) * 10) / 10));
    this.#globaal({ bpm });
  }

  /** @param {Record<string, number|string>} delta */
  #globaal(delta) {
    Object.assign(this.globaal, delta);
    for (const a of this.apps.values()) this.#naar(a, { t: 'globaal', waarden: delta });
    this.#beeldGewijzigd();
  }

  // ── adem (globale klok) ────────────────────────────────────────────────────

  #ademPeriodeMs() { return (4 + 12 * klem01(Number(this.globaal['klok.adem_periode']))) * 1000; }
  #ademFase() { return (((this.klok.nu() - this.adem.t) / this.#ademPeriodeMs() + this.adem.fase) % 1 + 1) % 1; }
  #ademOpnieuw() {
    this.adem = { t: this.klok.nu(), fase: 0 };
    this.globaal.adem = 0;
    for (const a of this.apps.values()) this.#naar(a, { t: 'globaal', waarden: { adem: 0 } });
    this.#beeldGewijzigd(); // de cockpit rekent de adem door vanaf het laatste beeld
  }
  #startAdem() {
    if (this.ademTimer !== null || this.gestopt) return;
    const tik = () => {
      this.ademTimer = this.klok.zet(tik, ADEM_MS);
      const adem = Math.round(this.#ademFase() * 1000) / 1000;
      this.globaal.adem = adem;
      for (const a of this.apps.values()) this.#naar(a, { t: 'globaal', waarden: { adem } });
    };
    this.ademTimer = this.klok.zet(tik, ADEM_MS);
  }

  // ── slew ───────────────────────────────────────────────────────────────────

  /** @param {AppStaat} a @param {string} id @param {number} naar @param {number} s @param {string} bron */
  #startSlew(a, id, naar, s, bron) {
    this.slews.set(`${a.app}\u0000${id}`, { app: a.app, id, bron, slew: maakSlew(a.waarden[id] ?? 0, naar, this.klok.nu(), s) });
    if (this.slewTimer === null) this.slewTimer = this.klok.zet(() => this.#slewTik(), SLEW_TIK_MS);
  }
  #slewTik() {
    this.slewTimer = null;
    const nu = this.klok.nu();
    for (const [k, x] of [...this.slews]) {
      const a = this.apps.get(x.app);
      if (!a) { this.slews.delete(k); continue; }
      const klaar = slewKlaar(x.slew, nu);
      if (klaar) this.slews.delete(k);
      // Klaar = precies het doel (niet van + (naar - van) · 1, dat er een afrondingsfout naast kan zitten).
      this.#zetWaarde(a, x.id, klaar ? x.slew.naar : slewWaarde(x.slew, nu), { naarApp: true, bron: x.bron, slew: true });
    }
    if (this.slews.size) this.slewTimer = this.klok.zet(() => this.#slewTik(), SLEW_TIK_MS);
  }

  // ── snapshots ──────────────────────────────────────────────────────────────

  /** Hub-snapshot: waarden van alle manifest-apps (van een lopende slew het doel). @param {number} nr */
  bewaar(nr) {
    /** @type {Record<string, Record<string, number>>} */
    const s = {};
    for (const a of this.apps.values()) {
      if (!a.manifest || a.manifest.lease) continue;
      // Een lopende slew telt met zijn doel: dat is wat er gezet werd.
      s[a.app] = Object.fromEntries(a.manifest.params.filter((p) => p.soort !== 'trigger' && p.id in a.waarden).map((p) => [p.id, this.#doel(a, p.id)]));
    }
    this.snapshots.set(nr, s);
    if (this.hubIn) this.#teken();
    this.meld('geheugen');
    this.#beeldGewijzigd();
  }

  /** @param {number} nr */
  laad(nr) {
    const s = this.snapshots.get(nr);
    if (!s) return false;
    for (const [app, w] of Object.entries(s)) {
      const a = this.apps.get(app);
      if (!a) continue;
      for (const [id, v] of Object.entries(w)) if (this.#doel(a, id) !== v) this.#zetZacht(a, id, v, 'snapshot');
    }
    return true;
  }

  // ── geheugen (over herstarts van de hub) ───────────────────────────────────

  /**
   * Wat de hub over een herstart heen onthoudt: de snapshots en de waarden van apps met truth:"hub"
   * (een lopende slew telt met zijn doel), plus per zo'n app zijn laatste `inst`. Puur; src/opslag.js schrijft het weg.
   * Slots en focus horen er niet bij: die gelden alleen bij een herstart midden in de set (slotsEnFocus/herstelSlotsEnFocus).
   * @returns {{ v: 1, snapshots: Record<string, Record<string, Record<string, number>>>, waarden: Record<string, Record<string, number>>, inst: Record<string, string> }}
   */
  exporteer() {
    /** @type {Record<string, Record<string, number>>} */
    const waarden = {};
    /** @type {Record<string, string>} */
    const inst = {};
    for (const [app, w] of this.bewaard) waarden[app] = { ...w };
    for (const [app, i] of this.bewaardInst) if (this.bewaard.has(app)) inst[app] = i;
    for (const a of this.apps.values()) {
      if (a.manifest?.truth !== 'hub') continue;
      waarden[a.app] = Object.fromEntries(a.manifest.params
        .filter((p) => p.soort !== 'trigger' && typeof a.waarden[p.id] === 'number')
        .map((p) => [p.id, this.#doel(a, p.id)]));
      if (a.inst !== null) inst[a.app] = a.inst;
    }
    /** @type {Record<string, Record<string, Record<string, number>>>} */
    const snapshots = {};
    for (const nr of [...this.snapshots.keys()].sort((x, y) => x - y)) {
      const s = /** @type {Record<string, Record<string, number>>} */ (this.snapshots.get(nr));
      snapshots[nr] = Object.fromEntries(Object.entries(s).map(([app, w]) => [app, { ...w }]));
    }
    return { v: 1, snapshots, waarden, inst };
  }

  /**
   * Welke app in welk slot (`null` = leeg) en wie de focus heeft (of, vlak na een herstart, de app die hem
   * terugkrijgt zodra hij er is). Geen I/O. `varve-hub start` schrijft dit in het loopbestand
   * (src/opslag.js), zodat een herstart midden in de set (de hub viel om) elke app zijn eigen slot teruggeeft. Bij een
   * gewone start (de vorige stopte netjes) begint de indeling leeg: een nieuwe avond, een nieuwe BANK-rij.
   * @returns {{ slots: (string|null)[], focus: string|null }}
   */
  slotsEnFocus() {
    const slots = this.slots.slice(0, SLOTS);
    while (slots.length && slots[slots.length - 1] === null) slots.pop();
    return { slots, focus: this.#bewaardeFocus() ?? this.focusApp };
  }

  /**
   * Na een herstart midden in de set: de indeling van de omgevallen hub terug (zie slotsEnFocus()). Een app die terugkomt
   * krijgt zijn eigen slot; de slots van apps die nog niet terug zijn blijven vrij (tot alle 8 vol zijn); de focus-app
   * van toen pakt de focus terug als hij binnen FOCUS_TERUG_MS terugkomt, tenzij Clay of de set intussen koos.
   * Alleen zolang er nog geen app een slot heeft (vlak na de start); anders verschuift er niets. Geen I/O.
   * Ongeldige onderdelen vallen weg (geteld).
   * @param {unknown} data @returns {{ ok: boolean, overgeslagen: number }}
   */
  herstelSlotsEnFocus(data) {
    const d = /** @type {any} */ (data);
    if (!d || typeof d !== 'object' || Array.isArray(d)) return { ok: false, overgeslagen: 0 };
    if (this.slots.some((x) => x !== null)) return { ok: false, overgeslagen: 0 };
    let overgeslagen = 0;
    if (Array.isArray(d.slots)) {
      /** @type {(string|null)[]} */
      const slots = [];
      for (const id of d.slots.slice(0, SLOTS)) {
        const goed = typeof id === 'string' && APP_ID.test(id) && !slots.includes(id);
        if (!goed && id !== null) overgeslagen++;
        slots.push(goed ? id : null);
      }
      while (slots.length && slots[slots.length - 1] === null) slots.pop();
      this.slots = slots;
    } else if (d.slots !== undefined) overgeslagen++;
    if (typeof d.focus === 'string' && APP_ID.test(d.focus)) {
      if (this.focusApp === null) { this.bewaardFocus = d.focus; this.bewaardFocusTot = this.klok.nu() + FOCUS_TERUG_MS; }
    } else if (d.focus !== undefined && d.focus !== null) overgeslagen++;
    if (this.hubIn) this.#teken();
    this.#beeldGewijzigd();
    return { ok: true, overgeslagen };
  }

  /** De focus-app van vóór de herstart, zolang hij hem nog terug mag pakken (anders null, en dan vergeten). */
  #bewaardeFocus() {
    if (this.bewaardFocus !== null && this.klok.nu() > this.bewaardFocusTot) this.bewaardFocus = null;
    return this.bewaardFocus;
  }

  /**
   * Neem bewaarde snapshots en truth:"hub"-waarden over (bij de start, vóór de apps zich aanmelden).
   * Een truth:"hub"-app krijgt zijn waarden zodra zijn manifest binnenkomt (`bron:"replay"`): met dezelfde `inst`
   * als toen direct, met een nieuwe met slew_s (§12).
   * Ongeldige stukken vallen weg (geteld in `overgeslagen`); is het geheel onbruikbaar, dan verandert er niets.
   * @param {unknown} data @returns {{ ok: boolean, reden?: string, overgeslagen: number }}
   */
  importeer(data) {
    const d = /** @type {any} */ (data);
    const isObj = (/** @type {unknown} */ x) => !!x && typeof x === 'object' && !Array.isArray(x);
    if (!isObj(d)) return { ok: false, reden: 'geen object', overgeslagen: 0 };
    if (d.v !== 1) return { ok: false, reden: `onbekende versie ${JSON.stringify(d.v)}`, overgeslagen: 0 };
    let overgeslagen = 0;
    /** Alleen geldige parameter-ids met een eindig getal; waarden geklemd op 0..1. @param {unknown} x */
    const waardenVan = (x) => {
      /** @type {Record<string, number>} */
      const uit = {};
      if (!isObj(x)) { overgeslagen++; return uit; }
      for (const [id, v] of Object.entries(/** @type {Record<string, unknown>} */ (x))) {
        if (PARAM_ID.test(id) && typeof v === 'number' && Number.isFinite(v)) uit[id] = klem01(v);
        else overgeslagen++;
      }
      return uit;
    };
    /** @param {unknown} x */
    const perApp = (x) => {
      /** @type {Record<string, Record<string, number>>} */
      const uit = {};
      if (!isObj(x)) { if (x !== undefined) overgeslagen++; return uit; }
      for (const [app, w] of Object.entries(/** @type {Record<string, unknown>} */ (x))) {
        if (APP_ID.test(app) && isObj(w)) uit[app] = waardenVan(w);
        else overgeslagen++;
      }
      return uit;
    };
    this.snapshots.clear();
    if (isObj(d.snapshots)) {
      for (const [k, s] of Object.entries(d.snapshots)) {
        const nr = Number(k);
        if (Number.isInteger(nr) && nr >= 1 && nr <= 99 && isObj(s)) this.snapshots.set(nr, perApp(s));
        else overgeslagen++;
      }
    } else if (d.snapshots !== undefined) overgeslagen++;
    this.bewaard.clear();
    this.bewaardInst.clear();
    /** @type {Record<string, unknown>} */
    const insts = isObj(d.inst) ? d.inst : {};
    if (d.inst !== undefined && !isObj(d.inst)) overgeslagen++;
    for (const [app, w] of Object.entries(perApp(d.waarden))) {
      const a = this.apps.get(app);
      const i = insts[app];
      if (!a?.manifest) {
        this.bewaard.set(app, w);
        if (typeof i === 'string' && i.length > 0 && i.length <= 128) this.bewaardInst.set(app, i);
        else if (i !== undefined) overgeslagen++;
      }
      else if (a.manifest.truth === 'hub') { // al aangemeld: alleen onthouden, niets sturen
        for (const p of a.manifest.params) if (p.soort !== 'trigger' && p.id in w) a.waarden[p.id] = kwantiseer(p, w[p.id]);
      }
    }
    if (this.hubIn) this.#teken();
    this.#beeldGewijzigd();
    return { ok: true, overgeslagen };
  }

  // ── cockpit ────────────────────────────────────────────────────────────────

  /** @param {any} b {t:'focus', app} | {t:'zet', app, id, v} | {t:'snapshot', nr, actie} */
  cockpit(b) {
    if (this.gestopt || !b || typeof b !== 'object') return;
    if (b.t === 'focus') { this.focus(typeof b.app === 'string' ? b.app : null); return; }
    if (b.t === 'zet') {
      const a = this.apps.get(b.app);
      if (!a || typeof b.id !== 'string' || typeof b.v !== 'number') return;
      const p = this.#param(a, b.id);
      if (p?.soort === 'trigger') this.#naar(a, { t: 'trig', id: b.id, aan: b.v > 0 });
      else this.#zetZacht(a, b.id, b.v, 'cockpit');
      return;
    }
    if (b.t === 'snapshot' && Number.isInteger(b.nr)) {
      if (b.actie === 'bewaar') this.bewaar(b.nr);
      else if (b.actie === 'laad') this.laad(b.nr);
    }
  }

  // ── LEDs ───────────────────────────────────────────────────────────────────

  #focusAppStaat() { return this.focusApp ? this.apps.get(this.focusApp) : undefined; }

  /**
   * Teken het hele oppervlak opnieuw. Na opnieuw aansluiten van de APC (ApcSessie 'verbonden'; de kern
   * luistert daar zelf naar als het oppervlak `bij` heeft): de knoppen staan dan op wat het LED-model stuurde.
   */
  herteken() {
    for (const c of RINGEN) this.fysiek.delete(c.id);
    this.alles = true;
    this.#teken();
  }

  /**
   * Een controller viel weg ('apc40' | 'lpd8'): niets mag blijven hangen. Ingedrukte toetsen krijgen hun 'los',
   * de hubtoets is los, een lopende paniek eindigt. De ApcSessie meldt zijn eigen 'weg'; voor de LPD8 roept de server dit aan.
   * @param {string} dev
   */
  apparaatWeg(dev) {
    if (dev === 'apc40') {
      const routes = [...this.routes];
      this.routes.clear();
      this.hubIn = false;
      this.shiftIn = false;
      for (const [el, r] of routes) {
        if (el === 'stopall' && r !== 'hub') this.#stopAllLos(r);
        const a = r !== 'hub' ? this.apps.get(r) : undefined;
        const c = APC.OP_ID.get(el);
        if (!a || !c) continue;
        const bytes = [(c.t === 'cc' ? 0xb0 : 0x80) | c.ch, c.n, 0];
        this.#naarAppInvoer(a, { dev: 'apc40', el, kind: 'los' }, bytes, undefined);
      }
      for (const c of RINGEN) this.fysiek.delete(c.id);
      this.#teken(); // het model klopt weer zodra hij terugkomt (ApcSessie.init tekent het)
    } else if (dev === 'lpd8') {
      if (this.p1Timer !== null) { this.klok.wis(this.p1Timer); this.p1Timer = null; }
      if (this.paniekActief) this.#paniek(false);
      this.padDruk.clear();
      this.lpdPickups.clear();
      for (const k of [...this.fysiek.keys()]) if (k.startsWith('lpd8:')) this.fysiek.delete(k);
    }
  }

  #teken() {
    const a = this.#focusAppStaat();
    if (a?.manifest?.lease && a.status !== 'weg') this.#tekenLease(a);
    else this.#tekenManifest(a);
    this.alles = false;
  }

  /** Hublaag-overlay: slots, focus, snapshots. @returns {Map<string, LedStaat>} */
  #overlay() {
    /** @type {Map<string, LedStaat>} */
    const m = new Map();
    for (let i = 1; i <= SLOTS; i++) {
      const a = this.apps.get(this.slots[i - 1] ?? '');
      /** @type {LedStaat} */
      let s = {};
      if (a && a.status !== 'weg') {
        if (a.app === this.focusApp) s = { kleur: a.kleur, anim: { soort: 'puls' } };
        else if (a.status === 'stil') s = { kleur: a.kleur, anim: { soort: 'knipper' } };
        else if (a.status === 'nieuw') s = { kleur: a.dim };
        else s = { kleur: a.kleur };
      }
      m.set(APC.padId(5, i), s);
      m.set(`sel${i}`, a && a.app === this.focusApp ? { aan: true } : {});
    }
    for (let n = 1; n <= 5; n++) m.set(`scene${n}`, this.snapshots.has(n) ? { kleur: WIT } : {});
    return m;
  }

  /** @param {AppStaat|undefined} a @returns {Map<string, LedStaat>} */
  #manifestBeeld(a) {
    const m = new Map(APC.MET_LED.map((c) => [c.id, uit(c)]));
    if (!a?.manifest || !a.indeling) return m;
    const ind = a.indeling;
    const tw = toewijzingen(ind, a.pagina);
    /** @param {Control} c @param {boolean} aan */
    const knop = (c, aan) => (c.led === 'rgb' ? { kleur: aan ? a.kleur : a.dim } : c.led === 'ab' ? (aan ? { stand: /** @type {1} */ (1) } : {}) : aan ? { aan: true } : {});
    for (const [ctrl, t] of Object.entries(tw)) {
      const c = APC.OP_ID.get(ctrl);
      if (!c) continue;
      const v = a.waarden[t.id] ?? 0;
      if (t.rol === 'fader' || t.rol === 'ring') {
        const modus = t.rol === 'ring' && this.overname ? 'direct' : t.takeover;
        if (!a.pickups.has(ctrl)) a.pickups.set(ctrl, nieuwePickup(v, this.fysiek.get(ctrl) ?? null, modus));
        // Zonder overname is de knopstand onbekend tot hij draait: dan de ring alleen tonen als we de stand kennen.
        if (t.rol === 'ring' && c.led === 'ring') {
          const f = this.fysiek.get(ctrl);
          if (this.overname) m.set(ctrl, { waarde: v });
          else if (f !== undefined) m.set(ctrl, { waarde: f });
        }
        const strip = /^fader([1-8])$/.exec(ctrl);
        if (strip && !a.pickups.get(ctrl)?.gevangen) m.set(`stop${strip[1]}`, { knipper: true });
      } else if (t.rol === 'keuze') {
        if (c.led === 'rgb') m.set(ctrl, { kleur: waardeNaarKeuze(v, t.n ?? 2) === t.optie ? a.kleur : a.dim });
      } else if (t.rol === 'schakelaar') {
        m.set(ctrl, knop(c, v >= 0.5));
      } else if (t.rol === 'stap') {
        m.set(ctrl, knop(c, true));
      } else if (t.rol === 'trigger') {
        const vast = a.vast.has(ctrl);
        m.set(ctrl, c.led === 'rgb' ? { kleur: vast ? WIT : a.dim } : knop(c, vast));
      }
    }
    for (let i = 0; i < ind.scenes; i++) if (!tw[`scene${i + 1}`]) m.set(`scene${i + 1}`, { kleur: a.scene === i ? a.kleur : a.dim });
    if (ind.paginas.length > 1) {
      if (!tw.devL) m.set('devL', a.pagina > 0 ? { aan: true } : {});
      if (!tw.devR) m.set('devR', a.pagina < ind.paginas.length - 1 ? { aan: true } : {});
    }
    return m;
  }

  /** Manifest-app (of geen focus): alles via het LED-model van het oppervlak, alleen verschillen gaan de draad op. @param {AppStaat|undefined} a */
  #tekenManifest(a) {
    const volledig = this.alles || this.getekend?.soort === 'lease';
    this.#wisLeaseRij();
    if (volledig) {
      // De lease-app tekende buiten het LED-model om (of alles moet opnieuw): alles opnieuw, ringtypes terug.
      this.opp.vergeet();
      for (const b of APC.ringTypeBerichten(APC.RING.single)) this.#oppStuur(b);
    }
    const m = this.#manifestBeeld(a);
    if (this.hubIn) for (const [id, s] of this.#overlay()) m.set(id, s);
    const oud = new Map(this.getoond);
    for (const [id, s] of m) { this.opp.zet(id, s); this.getoond.set(id, s); }
    const n = this.opp.teken();
    this.#telLeds(typeof n === 'number' ? n : 0);
    // In modus 0x42 zet een ring-CC ook de interne waarde van de knop. Het LED-model stuurt alleen verschillen,
    // dus een knop die zonder echo is gedraaid (hubtoets, ongebonden, andere app) krijgt zijn ring geforceerd.
    // Zonder overname (config.ringen_nemen_waarde_over = false) neemt de knop geen hub-waarde over:
    // dan is een ring-CC alleen een lampje en zegt hij niets over de fysieke stand.
    for (const c of this.overname ? RINGEN : []) {
      const s = /** @type {{ waarde?: number }} */ (m.get(c.id) ?? {}).waarde ?? 0;
      const f = this.fysiek.get(c.id);
      const was = /** @type {{ waarde?: number }} */ (oud.get(c.id) ?? {}).waarde ?? 0;
      // Het LED-model stuurt hem zelf (alles opnieuw, of de ring veranderde); of de knop is nooit gedraaid.
      if (volledig || f === undefined || r7(was) !== r7(s)) { this.fysiek.set(c.id, r7(s) / 127); continue; }
      if (this.#ringKlopt(a, c.id, f, s)) continue;
      for (const b of APC.ledBerichten(c, { waarde: s })) this.#oppStuur(b);
      this.fysiek.set(c.id, r7(s) / 127);
    }
    this.getekend = { soort: 'manifest', app: a?.app ?? null };
    this.#meldLeds(oud);
  }

  /**
   * Klopt de interne knopwaarde `f` met de getoonde ring `s`? Voor een keuze/schakelaar op een ring telt
   * de gekwantiseerde stand (anders zou de knop bij elke tik terugspringen).
   * @param {AppStaat|undefined} a @param {string} id @param {number} f @param {number} s
   */
  #ringKlopt(a, id, f, s) {
    if (r7(f) === r7(s)) return true;
    const t = a?.indeling ? toewijzingen(a.indeling, a.pagina)[id] : undefined;
    const p = t && a ? this.#param(a, t.id) : undefined;
    return !!p && p.soort !== 'waarde' && this.overname && kwantiseer(p, f) === s;
  }

  /** Lease-app: bij wisselen alles uit + de hele LED-kaart; daarna alleen de hub-overlay erbij of eraf. @param {AppStaat} a */
  #tekenLease(a) {
    const oud = new Map(this.getoond);
    const volledig = this.alles || this.getekend?.soort !== 'lease' || this.getekend.app !== a.app;
    if (volledig || this.hubIn) this.#wisLeaseRij(!volledig); // onder de overlay: komt bij loslaten uit de kaart
    if (volledig) {
      // Het LED-model van het oppervlak klopt hierna niet meer met de draad: leeg + vergeten, zodat een
      // latere teken() of zwart() (afsluiten, opnieuw aansluiten) alles opnieuw stuurt.
      for (const c of APC.MET_LED) this.opp.zet(c.id, uit(c));
      this.opp.vergeet();
      // Ringen niet op 0: in 0x42 zet de ring-CC ook de knopwaarde. Elke ring krijgt de laatste stand
      // die deze app kende (zijn eigen ring-LED of de knop zelf), anders 0.
      for (const c of APC.MET_LED) {
        const s = c.led === 'ring' ? { waarde: a.knoppen.get(c.id) ?? 0 } : uit(c);
        for (const b of APC.ledBerichten(c, s)) this.#oppStuur(b);
        this.getoond.set(c.id, s);
        if (c.led === 'ring') { a.knoppen.set(c.id, s.waarde); if (this.overname) this.fysiek.set(c.id, r7(s.waarde) / 127); }
      }
      for (const b of APC.ringTypeBerichten(APC.RING.single)) this.#oppStuur(b);
      for (const [k, regel] of a.kaart) {
        const c = controlVan(regel[regel.length - 1]);
        if (c?.led === 'ring') continue; // al getekend met de laatste stand
        for (const b of regel) this.#oppStuur(b);
        if (c && sleutelVan(c) === k) this.getoond.set(c.id, decodeer(c, regel));
      }
      this.getekend = { soort: 'lease', app: a.app };
    }
    const ov = this.hubIn ? this.#overlay() : null;
    for (const id of OVERLAY) {
      const c = /** @type {Control} */ (APC.OP_ID.get(id));
      const regel = a.kaart.get(sleutelVan(c));
      const s = ov ? /** @type {LedStaat} */ (ov.get(id)) : decodeer(c, regel);
      if (!volledig && gelijk(s, this.getoond.get(id))) continue;
      if (!ov && volledig) continue; // net uit de kaart getekend
      // Terug uit de overlay: een kaartregel met alleen animatie (zonder basis op kanaal 0) knippert
      // tegen de laatste basiskleur, en dat is nu die van de overlay. Die eerst uit, zoals bij de volledige repaint.
      const zonderBasis = c.led === 'rgb' && regel && ((regel[0][0] & 0x0f) !== 0);
      const bytes = ov ? APC.ledBerichten(c, s) : regel ? (zonderBasis ? [...APC.ledBerichten(c, uit(c)), ...regel] : regel) : APC.ledBerichten(c, uit(c));
      for (const b of bytes) this.#oppStuur(b);
      this.getoond.set(id, s);
    }
    this.#meldLeds(oud);
  }

  /** LED-berichten van een lease-app: bewaren in zijn kaart, doorsturen als hij focus heeft. @param {AppStaat} a @param {number[][]} lijst */
  #leaseLed(a, lijst) {
    if (!a.manifest?.lease) return;
    const zichtbaar = this.focusApp === a.app && this.getekend?.soort === 'lease' && this.getekend.app === a.app;
    const oud = new Map(this.getoond);
    for (const m of lijst) {
      if (!isLedBericht(m)) continue; // ook mode-SysEx: alleen de hub zet de modus
      const k = ledSleutel(m);
      if (k) this.#bewaarLed(a, k, m);
      const c = controlVan(m);
      const ring = c?.led === 'ring' && k === sleutelVan(c) ? c.id : null;
      if (ring) a.knoppen.set(ring, m[2] / 127); // de nieuwste wens voor ring én knop
      if (!zichtbaar) continue;
      if (ring && this.overname) this.fysiek.set(ring, m[2] / 127); // zonder overname zegt een ring-LED niets over de knop
      if (this.hubIn && c && OVERLAY.includes(c.id)) continue; // de hublaag ligt erover; komt terug bij loslaten
      this.#leaseStuur(m);
      if (c && k && sleutelVan(c) === k) this.getoond.set(c.id, decodeer(c, a.kaart.get(k)));
    }
    if (zichtbaar) this.#meldLeds(oud);
  }

  /** Geschat aantal berichten van de kern dat nog in de wachtrij van het oppervlak staat. */
  #inRij() {
    const nu = this.klok.nu();
    const n = Math.max(0, this.ledRij.n - ((nu - this.ledRij.t) / this.ledBurstMs) * this.ledPerBurst);
    this.ledRij = { t: nu, n };
    return n;
  }
  /** @param {number} n berichten die net naar het oppervlak gingen */
  #telLeds(n) { this.#inRij(); this.ledRij.n += n; }
  /** @param {number[]} b */
  #oppStuur(b) { this.#telLeds(1); this.opp.stuur(b); }

  /** Eén LED-bericht van de lease-app naar het oppervlak, binnen het LED-tempo (zie leaseRij). @param {number[]} m */
  #leaseStuur(m) {
    if (!this.leaseRij.size && this.#inRij() < this.ledMaxRij) { this.#oppStuur(m); return; }
    const k = `${m[0] & 0x0f}:${(m[0] & 0xf0) === 0xb0 ? 'cc' : 'n'}:${m[1]}`;
    this.leaseRij.delete(k); // achteraan: de volgorde van de nieuwste berichten blijft staan
    this.leaseRij.set(k, m);
    if (this.leaseTimer === null) this.#planLease();
  }
  /** Volgende portie zodra er in de wachtrij van het oppervlak (geschat) weer een burst ruimte is. */
  #planLease() {
    const wacht = Math.max(1, Math.ceil(((this.#inRij() - this.ledMaxRij + this.ledPerBurst) / this.ledPerBurst) * this.ledBurstMs));
    this.leaseTimer = this.klok.zet(() => this.#leaseSpoel(), wacht);
  }
  #leaseSpoel() {
    this.leaseTimer = null;
    for (const [k, m] of this.leaseRij) {
      if (this.#inRij() >= this.ledMaxRij) break;
      this.leaseRij.delete(k);
      this.#oppStuur(m);
    }
    if (this.leaseRij.size) this.#planLease();
  }
  /** Wachtende lease-LEDs vergeten (het oppervlak wordt opnieuw getekend), eventueel alleen die onder de overlay. @param {boolean} [alleenOverlay] */
  #wisLeaseRij(alleenOverlay = false) {
    for (const [k, m] of [...this.leaseRij]) {
      const c = controlVan(m);
      if (!alleenOverlay || (c && OVERLAY.includes(c.id))) this.leaseRij.delete(k);
    }
  }

  /** @param {AppStaat} a @param {string} k @param {number[]} m */
  #bewaarLed(a, k, m) {
    if (!k.startsWith('rgb:')) { a.kaart.set(k, [m]); return; }
    const st = m[0] & 0xf0, ch = m[0] & 0x0f;
    if (st === 0x80 || m[2] === 0) { a.kaart.set(k, [[0x80, m[1], 0]]); return; }
    if (ch === 0) { a.kaart.set(k, [m]); return; }
    const basis = a.kaart.get(k)?.find((x) => (x[0] & 0xf0) === 0x90 && (x[0] & 0x0f) === 0 && x[2] > 0);
    a.kaart.set(k, basis ? [basis, m] : [m]);
  }

  /** @param {Map<string, LedStaat>} oud */
  #meldLeds(oud) {
    /** @type {Record<string, LedStaat>} */
    const staat = {};
    for (const [id, s] of this.getoond) if (!gelijk(oud.get(id), s)) staat[id] = s;
    if (Object.keys(staat).length) this.meld('leds', { dev: 'apc40', staat });
  }

  // ── naar apps en cockpit ───────────────────────────────────────────────────

  /** @param {AppStaat} a @param {NaarApp} b */
  #naar(a, b) {
    if (!a.v) return;
    this.#naarV(a.v, b);
  }
  /** @param {Verbinding} v @param {NaarApp} b */
  #naarV(v, b) {
    try { v.stuur(b); } catch (e) { console.error(`[kern] sturen naar ${v.app ?? '?'} mislukt:`, e); }
    this.meld('naarApp', v.app, b);
  }

  #beeldGewijzigd() {
    if (this.beeldTimer !== null || this.gestopt) return;
    const wacht = Math.max(0, this.laatsteBeeld + BEELD_MS - this.klok.nu());
    this.beeldTimer = this.klok.zet(() => { this.beeldTimer = null; this.laatsteBeeld = this.klok.nu(); this.meld('beeld'); }, wacht);
  }

  /** Alles wat de cockpit nodig heeft (PROTOCOL.md §8). */
  beeld() {
    const f = this.#focusAppStaat();
    /** @type {Record<string, { id: string, doel: number, gevangen: boolean, fysiek: number|null }>} */
    const pickup = {};
    if (f?.indeling) {
      for (const [ctrl, t] of Object.entries(toewijzingen(f.indeling, f.pagina))) {
        const p = f.pickups.get(ctrl);
        if (p && (t.rol === 'fader' || t.rol === 'ring')) pickup[ctrl] = { id: t.id, doel: p.doel, gevangen: p.gevangen, fysiek: p.fysiek };
      }
    }
    return {
      apps: [...this.apps.values()].map((a) => ({
        app: a.app, naam: a.naam, kleur: a.kleurHex, status: a.status, focus: a.app === this.focusApp, slot: a.slot,
        lease: !!a.manifest?.lease, params: a.manifest?.params ?? [], waarden: { ...a.waarden },
        pagina: a.pagina, paginas: a.indeling?.paginaNamen ?? [],
      })),
      focus: this.focusApp,
      globaal: { ...this.globaal },
      apparaten: { ...this.apparaatInfo },
      snapshots: [...this.snapshots.keys()].sort((x, y) => x - y),
      opname: this.opname,
      opnameInfo: { ...this.opnameInfo },
      pickup,
      // Lopende slews (§12): waar een parameter heen glijdt en wanneer hij er is (eindMs op de kern-klok, zie `nu`).
      slews: [...this.slews.values()].map((x) => ({ app: x.app, id: x.id, doel: x.slew.naar, eindMs: x.slew.start + x.slew.duurMs })),
      nu: this.klok.nu(),
    };
  }

  /**
   * Stand van de opname voor de cockpit (beeld.opnameInfo, PROTOCOL.md §8); src/hub.js geeft de meldingen van
   * de Opnemer door. Alleen de meegegeven velden veranderen: map van de lopende avond (null = nog geen of
   * geen map), de laatste melding (blijft staan tot er een nieuwe komt), of die een fout is, en sinds wanneer
   * er opgenomen wordt (kern-klok, ms; null = niet).
   * @param {Partial<{ map: string|null, melding: string|null, fout: boolean, sinds: number|null }>} info
   */
  zetOpnameInfo(info) {
    const oud = this.opnameInfo;
    const nieuw = { ...oud };
    if (info && 'map' in info) nieuw.map = typeof info.map === 'string' ? info.map : null;
    if (info && 'melding' in info) nieuw.melding = typeof info.melding === 'string' ? info.melding : null;
    if (info && 'fout' in info) nieuw.fout = info.fout === true;
    if (info && 'sinds' in info) nieuw.sinds = typeof info.sinds === 'number' && Number.isFinite(info.sinds) ? info.sinds : null;
    if (nieuw.map === oud.map && nieuw.melding === oud.melding && nieuw.fout === oud.fout && nieuw.sinds === oud.sinds) return;
    this.opnameInfo = nieuw;
    this.#beeldGewijzigd();
  }

  /** @type {{ map: string|null, melding: string|null, fout: boolean, sinds: number|null }} */
  opnameInfo = { map: null, melding: null, fout: false, sinds: null };

  /** De hub meldt de stand van een controller (voor de cockpit). @param {string} dev @param {{ verbonden: boolean, naam?: string|null, model?: string|null }} info */
  zetApparaat(dev, info) {
    this.apparaatInfo[dev] = { ...info };
    this.#beeldGewijzigd();
  }

  /** Alle timers weg; daarna negeert de kern nieuwe verbindingen, berichten en invoer. */
  stop() {
    this.gestopt = true;
    for (const k of /** @type {const} */ (['beeldTimer', 'ademTimer', 'slewTimer', 'p1Timer', 'leaseTimer'])) {
      if (this[k] !== null) this.klok.wis(this[k]);
      this[k] = null;
    }
    for (const a of this.apps.values()) this.#wisHartslag(a);
    // De slews blijven staan (hun timer is weg): exporteer() bewaart daarvan het doel, ook als het geheugen
    // pas ná kern.stop() wegschrijft.
    this.leaseRij.clear();
    for (const f of this.afmelden) f();
    this.afmelden = [];
  }
}
