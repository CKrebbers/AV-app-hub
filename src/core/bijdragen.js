// @ts-check
// Bijdragen aan de globale laag (PROTOCOL §18): een app met `levert: ["sectie"]` in zijn manifest stuurt
// `{t:"globaal", waarden}` met sectie.energie (0..1), sectie.label (tekst) en sectie.nieuw (trigger, true). Puur: geen
// I/O en geen klok. De kern geeft door wat binnenkomt en wanneer de apps veranderen (status, manifest); dit bepaalt
// wat er in `globaal` verandert en geeft dat terug als één delta (de kern stuurt het naar alle apps).
//
// - Bron per groep: de eerste app (in volgorde van aanmelden, zoals de adem in §14) die de groep levert en niet weg is.
// - Van elke leverancier wordt het laatste per sleutel bewaard; alleen dat van de bron gaat door, en alleen wat
//   anders is dan wat er al in globaal staat.
// - Een trigger (sectie.nieuw) wordt een teller van de hub: (aantal mod SECTIE_STAPPEN) / SECTIE_STAPPEN, zodat een
//   tekenlus, de cockpit (beeld 10×/s) en herverbinden geen klap missen of verzinnen.
// - Wisselt de bron, dan de bewaarde waarden van de nieuwe (wat verschilt), zonder klap. Geen bron: alles bevriest.

import { GLOBAAL_VAN_APP, SECTIE_STAPPEN, groepVan, klem01, isLabel } from '../protocol/berichten.js';
import { GROEPEN } from '../protocol/manifest.js';

/**
 * @typedef {{ app: string, levert: readonly string[], levend: boolean }} Leverancier
 * @typedef {Record<string, number|string>} Delta
 */

/** Soort van een sleutel die een app mag leveren, of undefined. @param {string} k */
const soortVan = (k) => (Object.hasOwn(GLOBAAL_VAN_APP, k) ? GLOBAAL_VAN_APP[/** @type {keyof typeof GLOBAAL_VAN_APP} */ (k)] : undefined);

export class Bijdragen {
  /** @param {{ apps: () => Iterable<Leverancier> }} o  apps in volgorde van aanmelden */
  constructor({ apps }) {
    this.apps = apps;
    /** Laatste waarden per leverancier (waarde en tekst; triggers niet). @type {Map<string, Record<string, number|string>>} */
    this.bewaard = new Map();
    /** Wat er nu in globaal staat voor de geleverde sleutels (alleen deze klasse zet ze). @type {Record<string, number|string>} */
    this.staat = {};
    /** Teller per trigger-sleutel. @type {Record<string, number>} */
    this.tellers = {};
    /** De bron per groep zoals de kern hem het laatst hoorde (om een wissel te zien). @type {Record<string, string|null>} */
    this.bron = Object.fromEntries(GROEPEN.map((g) => [g, null]));
    for (const [k, soort] of Object.entries(GLOBAAL_VAN_APP)) if (soort === 'trigger') { this.tellers[k] = 0; this.staat[k] = 0; }
  }

  /** Wat er vanaf de start in globaal staat: de tellers op 0 (energie en label pas als een bron ze stuurt). @returns {Delta} */
  beginwaarden() { return { ...this.staat }; }

  /** Per groep de app die hem nu levert, of null. @returns {Record<string, string|null>} */
  bronnen() { return Object.fromEntries(GROEPEN.map((g) => [g, this.#zoekBron(g)])); }

  /**
   * Een app stuurde `globaal` (al gecontroleerd door leesVanApp). Alleen sleutels van groepen uit zijn `levert`.
   * @param {string} app @param {Record<string, unknown>} waarden @returns {Delta} wat er in globaal verandert
   */
  ontvang(app, waarden) {
    const lev = [...this.apps()].find((x) => x.app === app);
    if (!lev || !waarden || typeof waarden !== 'object') return {};
    /** @type {Delta} */
    const delta = this.bijwerken();
    const eigen = this.bewaard.get(app) ?? {};
    /** @type {Set<string>} */
    const triggers = new Set();
    for (const [k, v] of Object.entries(waarden)) {
      const soort = soortVan(k);
      if (!soort || !lev.levert.includes(groepVan(k))) continue;
      if (soort === 'waarde' && typeof v === 'number') eigen[k] = klem01(v);
      else if (soort === 'tekst' && isLabel(v)) eigen[k] = /** @type {string} */ (v);
      else if (soort === 'trigger' && v === true) triggers.add(k);
    }
    this.bewaard.set(app, eigen);
    for (const groep of GROEPEN) {
      if (this.bron[groep] !== app) continue;
      Object.assign(delta, this.#verschil(eigen, groep));
      for (const k of triggers) {
        if (groepVan(k) !== groep) continue;
        this.tellers[k] = (this.tellers[k] + 1) % SECTIE_STAPPEN;
        delta[k] = this.staat[k] = this.tellers[k] / SECTIE_STAPPEN;
      }
    }
    return delta;
  }

  /**
   * Apps veranderden (status, manifest, aanmelden, vergeten): kies per groep de bron opnieuw. Wisselt hij, dan de
   * bewaarde waarden van de nieuwe bron (wat verschilt), zonder klap; geen bron of niets bewaard: alles blijft staan.
   * @returns {Delta}
   */
  bijwerken() {
    /** @type {Delta} */
    const delta = {};
    for (const groep of GROEPEN) {
      const nieuw = this.#zoekBron(groep);
      if (nieuw === this.bron[groep]) continue;
      this.bron[groep] = nieuw;
      if (nieuw) Object.assign(delta, this.#verschil(this.bewaard.get(nieuw) ?? {}, groep));
    }
    return delta;
  }

  /** De app herstartte (nieuwe inst): wat hij vorige keer leverde, geldt niet meer. @param {string} app */
  herstart(app) { this.bewaard.delete(app); }
  /** De app is vergeten (nooit een manifest): weg. @param {string} app */
  vergeet(app) { this.bewaard.delete(app); }

  /** @param {string} groep */
  #zoekBron(groep) {
    for (const x of this.apps()) if (x.levend && x.levert.includes(groep)) return x.app;
    return null;
  }

  /** Wat van `w` (waarden en teksten van één groep) anders is dan in globaal; meteen overgenomen. @param {Record<string, number|string>} w @param {string} groep */
  #verschil(w, groep) {
    /** @type {Delta} */
    const d = {};
    for (const [k, v] of Object.entries(w)) {
      if (groepVan(k) !== groep || this.staat[k] === v) continue;
      d[k] = this.staat[k] = v;
    }
    return d;
  }
}
