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
import * as APC from '../devices/apc40mk2.js';
import { klem01, isModeSysex } from '../protocol/berichten.js';
import { valideerManifest, keuzeNaarWaarde, waardeNaarKeuze, ROLLEN } from '../protocol/manifest.js';
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
 *    vast: Set<string>, scene: number|null, knoppen: Map<string, number>,
 *  }} AppStaat */

export const BEELD_MS = 100;
export const ADEM_MS = 100;
export const PANIEK_MS = 1000;
export const LANG_MS = 600;
export const TAP_RESET_MS = 2000;
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
    /** @type {Map<string, { app: string, id: string, slew: Slew }>} */
    this.slews = new Map();
    /** @type {Map<number, Record<string, Record<string, number>>>} */
    this.snapshots = new Map();
    /** @type {Map<string, LedStaat>} wat er nu op het oppervlak staat (volgens de kern) */
    this.getoond = new Map(APC.MET_LED.map((c) => [c.id, uit(c)]));
    /** @type {{ soort: 'lease'|'manifest', app: string|null }|null} */
    this.getekend = null;
    this.paniekActief = false;
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
    /** De volgende tekening is een volledige repaint (na opnieuw aansluiten of een nieuw manifest). */
    this.alles = false;
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
    this.verbindingen.add(v);
    this.#naarV(v, { t: 'welkom', hub: 'varve-hub', v: 1 });
  }

  /** @param {Verbinding} v @param {any} b gecontroleerd bericht (leesVanApp) */
  ontvang(v, b) {
    if (!b || typeof b !== 'object') return;
    if (b.t === 'hallo') return this.#hallo(v, b);
    if (!v.app) { this.#naarV(v, { t: 'fout', reden: 'stuur eerst hallo' }); return; }
    const a = this.apps.get(v.app);
    if (!a || a.v !== v) return; // een oude, vervangen verbinding
    this.#hartslag(a);
    switch (b.t) {
      case 'manifest': return this.#manifest(a, b.manifest);
      case 'staat': return this.#staat(a, b.waarden ?? {});
      case 'zet': if (typeof b.id === 'string' && typeof b.v === 'number') this.#zetWaarde(a, b.id, b.v, { naarApp: false }); return;
      case 'led': if (Array.isArray(b.bytes)) this.#leaseLed(a, b.bytes); return;
      default: return; // hb en onbekende types: alleen hartslag
    }
  }

  /** Verbinding dicht: app blijft bekend met status 'weg', waarden bewaard. @param {Verbinding} v */
  verbreek(v) {
    this.verbindingen.delete(v);
    const a = v.app ? this.apps.get(v.app) : undefined;
    if (!a || a.v !== v) return;
    a.v = null;
    this.#wisHartslag(a);
    a.status = 'weg';
    this.#statusGewijzigd(a);
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
      this.verbindingen.delete(oud);
      this.#naarV(oud, { t: 'fout', reden: 'vervangen door een nieuwere verbinding van deze app' });
      try { oud.sluit?.(); } catch (e) { console.error('[kern] sluiten van vervangen verbinding mislukt:', e); }
    }
    const herstart = a.inst !== null && a.inst !== b.inst;
    a.v = v;
    a.inst = b.inst;
    a.replay = false;
    a.status = a.manifest ? 'actief' : 'nieuw';
    if (herstart) a.pickups = new Map();
    this.#hartslag(a);
    this.#naar(a, { t: 'globaal', waarden: { ...this.globaal } });
    if (a.manifest?.truth === 'hub') {
      for (const p of a.manifest.params) {
        if (p.soort === 'trigger' || !(p.id in a.waarden)) continue;
        this.#naar(a, { t: 'zet', id: p.id, v: a.waarden[p.id], bron: 'replay' });
      }
      a.replay = true;
    }
    if (this.focusApp === null) this.focus(a.app);
    else if (this.focusApp === a.app) { this.#naar(a, { t: 'focus', aan: true }); this.#teken(); }
    else if (this.hubIn) this.#teken();
    this.#startAdem();
    this.#beeldGewijzigd();
  }

  /** @param {string} app @returns {AppStaat} */
  #nieuweApp(app) {
    let slot = this.slots.length < SLOTS ? this.slots.push(app) : null;
    const cfg = this.config.apps?.[app] ?? {};
    /** @type {AppStaat} */
    const a = {
      app, slot, naam: cfg.naam ?? app, kleurHex: '#ffffff', kleur: 3, dim: 1,
      manifest: null, indeling: null, pagina: 0, waarden: {}, status: 'nieuw', v: null, inst: null, replay: false,
      timers: { stil: null, weg: null }, kaart: new Map(), pickups: new Map(), vast: new Set(), scene: null, knoppen: new Map(),
    };
    this.#zetKleur(a, cfg.kleur);
    return a;
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
    const cfg = this.config.apps?.[a.app] ?? {};
    // rings valt terug op config.apps.<app>.rings, zoals kleur (de validator vult anders 'host' in).
    if (man.lease && /** @type {any} */ (m).rings === undefined && (cfg.rings === 'auto' || cfg.rings === 'host')) man.rings = cfg.rings;
    a.manifest = man;
    a.naam = man.naam;
    this.#zetKleur(a, man.kleur ?? cfg.kleur);
    for (const p of man.params) if (p.soort !== 'trigger' && !(p.id in a.waarden)) a.waarden[p.id] = p.standaard ?? 0;
    a.indeling = man.lease ? null : maakIndeling(man, this.config.kaarten?.[a.app] ?? null);
    a.pagina = Math.min(a.pagina, (a.indeling?.paginas.length ?? 1) - 1);
    a.pickups = new Map();
    if (a.status === 'nieuw') a.status = 'actief';
    this.#hartslag(a); // opnieuw, nu met de hb_s van het manifest
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
    for (const [id, v] of Object.entries(waarden)) if (typeof v === 'number') this.#zetWaarde(a, id, v, { naarApp: false });
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
   * @param {AppStaat} a @param {string} id @param {number} v
   * @param {{ naarApp: boolean, bron?: string, slew?: boolean, ctrl?: string }} o  ctrl: de control die de waarde zelf zette
   */
  #zetWaarde(a, id, v, { naarApp, bron, slew = false, ctrl: van = undefined }) {
    const p = this.#param(a, id);
    if (a.manifest && (!p || p.soort === 'trigger')) return;
    const w = kwantiseer(p, v);
    if (!slew) this.slews.delete(`${a.app}\u0000${id}`);
    a.waarden[id] = w;
    if (naarApp) this.#naar(a, { t: 'zet', id, v: w, ...(bron ? { bron } : {}) });
    if (this.focusApp === a.app && a.indeling) {
      for (const ctrl of controlsVoor(a.indeling, a.pagina, id)) {
        if (ctrl === van) continue; // de bewegende control houdt zijn eigen (ongekwantiseerde) stand
        const pk = a.pickups.get(ctrl);
        if (pk) a.pickups.set(ctrl, zetDoel(pk, w));
      }
      this.#teken();
    }
    this.#beeldGewijzigd();
  }

  // ── focus ──────────────────────────────────────────────────────────────────

  /** Focus naar app (id) of null. Geeft false als de app onbekend is. @param {string|null} app */
  focus(app) {
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
          for (const b of APC.ledBerichten(c, { waarde: w })) this.opp.stuur(b);
          this.fysiek.set(el, r7(w) / 127);
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
    const t = toewijzingen(ind, a.pagina)[el];
    const druk = g.kind === 'druk', los = g.kind === 'los';
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
          if (druk) { a.vast.add(el); this.#naar(a, { t: 'trig', id: t.id, aan: true }); }
          else if (los) { a.vast.delete(el); this.#naar(a, { t: 'trig', id: t.id, aan: false }); }
          else return;
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
    if (el === 'stopall' && ind.paniek && (druk || los)) { this.#naar(a, { t: 'trig', id: ind.paniek, aan: druk }); return; }
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

  /**
   * Doel voor de pickup van een LPD8-knop: de globale waarde als die er is, anders de huidige waarde
   * van de eerste app met een parameter met die rol, anders 0.5. Zo springt er ook bij de eerste aanraking niets.
   * @param {string} rol
   */
  #macroDoel(rol) {
    const g = this.globaal[rol];
    if (typeof g === 'number') return g;
    for (const a of this.apps.values()) {
      const p = a.manifest?.params.find((x) => x.rol === rol && x.soort !== 'trigger');
      if (p) return a.waarden[p.id] ?? p.standaard ?? 0;
    }
    return 0.5;
  }

  /** Globale macro: elke app met die rol krijgt een zet (met slew), iedereen krijgt globaal. @param {string} rol @param {number} v */
  #macro(rol, v) {
    if (rol === 'klok.adem_periode') this.adem = { t: this.klok.nu(), fase: this.#ademFase() };
    for (const a of this.apps.values()) {
      for (const p of a.manifest?.params ?? []) {
        if (p.rol !== rol || p.soort === 'trigger') continue;
        if (p.slew_s && p.slew_s > 0) this.#startSlew(a, p.id, v, p.slew_s);
        else this.#zetWaarde(a, p.id, v, { naarApp: true, bron: 'lpd8' });
      }
    }
    this.#globaal({ [rol]: v });
  }

  /** @param {boolean} aan */
  #paniek(aan) {
    this.paniekActief = aan;
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
    for (const a of this.apps.values()) this.#naar(a, { t: 'globaal', waarden: { adem: 0, adem_fase: 0 } });
  }
  #startAdem() {
    if (this.ademTimer !== null) return;
    const tik = () => {
      this.ademTimer = this.klok.zet(tik, ADEM_MS);
      const adem = Math.round(this.#ademFase() * 1000) / 1000;
      this.globaal.adem = adem;
      for (const a of this.apps.values()) this.#naar(a, { t: 'globaal', waarden: { adem } });
    };
    this.ademTimer = this.klok.zet(tik, ADEM_MS);
  }

  // ── slew ───────────────────────────────────────────────────────────────────

  /** @param {AppStaat} a @param {string} id @param {number} naar @param {number} s */
  #startSlew(a, id, naar, s) {
    this.slews.set(`${a.app}\u0000${id}`, { app: a.app, id, slew: maakSlew(a.waarden[id] ?? 0, naar, this.klok.nu(), s) });
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
      this.#zetWaarde(a, x.id, slewWaarde(x.slew, nu), { naarApp: true, bron: 'lpd8', slew: true });
    }
    if (this.slews.size) this.slewTimer = this.klok.zet(() => this.#slewTik(), SLEW_TIK_MS);
  }

  // ── snapshots ──────────────────────────────────────────────────────────────

  /** Hub-snapshot: waarden van alle manifest-apps. @param {number} nr */
  bewaar(nr) {
    /** @type {Record<string, Record<string, number>>} */
    const s = {};
    for (const a of this.apps.values()) {
      if (!a.manifest || a.manifest.lease) continue;
      s[a.app] = Object.fromEntries(a.manifest.params.filter((p) => p.soort !== 'trigger' && p.id in a.waarden).map((p) => [p.id, a.waarden[p.id]]));
    }
    this.snapshots.set(nr, s);
    if (this.hubIn) this.#teken();
    this.#beeldGewijzigd();
  }

  /** @param {number} nr */
  laad(nr) {
    const s = this.snapshots.get(nr);
    if (!s) return false;
    for (const [app, w] of Object.entries(s)) {
      const a = this.apps.get(app);
      if (!a) continue;
      for (const [id, v] of Object.entries(w)) if (a.waarden[id] !== v) this.#zetWaarde(a, id, v, { naarApp: true, bron: 'snapshot' });
    }
    return true;
  }

  // ── cockpit ────────────────────────────────────────────────────────────────

  /** @param {any} b {t:'focus', app} | {t:'zet', app, id, v} | {t:'snapshot', nr, actie} */
  cockpit(b) {
    if (!b || typeof b !== 'object') return;
    if (b.t === 'focus') { this.focus(typeof b.app === 'string' ? b.app : null); return; }
    if (b.t === 'zet') {
      const a = this.apps.get(b.app);
      if (!a || typeof b.id !== 'string' || typeof b.v !== 'number') return;
      const p = this.#param(a, b.id);
      if (p?.soort === 'trigger') this.#naar(a, { t: 'trig', id: b.id, aan: b.v > 0 });
      else this.#zetWaarde(a, b.id, b.v, { naarApp: true, bron: 'cockpit' });
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
    if (volledig) {
      // De lease-app tekende buiten het LED-model om (of alles moet opnieuw): alles opnieuw, ringtypes terug.
      this.opp.vergeet();
      for (const b of APC.ringTypeBerichten(APC.RING.single)) this.opp.stuur(b);
    }
    const m = this.#manifestBeeld(a);
    if (this.hubIn) for (const [id, s] of this.#overlay()) m.set(id, s);
    const oud = new Map(this.getoond);
    for (const [id, s] of m) { this.opp.zet(id, s); this.getoond.set(id, s); }
    this.opp.teken();
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
      for (const b of APC.ledBerichten(c, { waarde: s })) this.opp.stuur(b);
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
    if (volledig) {
      // Het LED-model van het oppervlak klopt hierna niet meer met de draad: leeg + vergeten, zodat een
      // latere teken() of zwart() (afsluiten, opnieuw aansluiten) alles opnieuw stuurt.
      for (const c of APC.MET_LED) this.opp.zet(c.id, uit(c));
      this.opp.vergeet();
      // Ringen niet op 0: in 0x42 zet de ring-CC ook de knopwaarde. Elke ring krijgt de laatste stand
      // die deze app kende (zijn eigen ring-LED of de knop zelf), anders 0.
      for (const c of APC.MET_LED) {
        const s = c.led === 'ring' ? { waarde: a.knoppen.get(c.id) ?? 0 } : uit(c);
        for (const b of APC.ledBerichten(c, s)) this.opp.stuur(b);
        this.getoond.set(c.id, s);
        if (c.led === 'ring') { a.knoppen.set(c.id, s.waarde); this.fysiek.set(c.id, r7(s.waarde) / 127); }
      }
      for (const b of APC.ringTypeBerichten(APC.RING.single)) this.opp.stuur(b);
      for (const [k, regel] of a.kaart) {
        const c = controlVan(regel[regel.length - 1]);
        if (c?.led === 'ring') continue; // al getekend met de laatste stand
        for (const b of regel) this.opp.stuur(b);
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
      const bytes = ov ? APC.ledBerichten(c, s) : regel ?? APC.ledBerichten(c, uit(c));
      for (const b of bytes) this.opp.stuur(b);
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
      if (!Array.isArray(m) || !m.length || isModeSysex(m)) continue;
      const k = ledSleutel(m);
      if (k) this.#bewaarLed(a, k, m);
      const c = controlVan(m);
      const ring = c?.led === 'ring' && k === sleutelVan(c) ? c.id : null;
      if (ring) a.knoppen.set(ring, m[2] / 127); // de nieuwste wens voor ring én knop
      if (!zichtbaar) continue;
      if (ring) this.fysiek.set(ring, m[2] / 127);
      if (this.hubIn && c && OVERLAY.includes(c.id)) continue; // de hublaag ligt erover; komt terug bij loslaten
      this.opp.stuur(m);
      if (c && k && sleutelVan(c) === k) this.getoond.set(c.id, decodeer(c, a.kaart.get(k)));
    }
    if (zichtbaar) this.#meldLeds(oud);
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
    if (this.beeldTimer !== null) return;
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
      apparaten: {},
      snapshots: [...this.snapshots.keys()].sort((x, y) => x - y),
      opname: this.opname,
      pickup,
    };
  }

  /** Alle timers weg. */
  stop() {
    for (const k of /** @type {const} */ (['beeldTimer', 'ademTimer', 'slewTimer', 'p1Timer'])) {
      if (this[k] !== null) this.klok.wis(this[k]);
      this[k] = null;
    }
    for (const a of this.apps.values()) this.#wisHartslag(a);
    this.slews.clear();
    for (const f of this.afmelden) f();
    this.afmelden = [];
  }
}
