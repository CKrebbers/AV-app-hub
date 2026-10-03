// @ts-check
// Gedeelde basis voor drivers: een driver doet zich tegenover de kern voor als een app
// (PROTOCOL.md §2, §9). Hij is zelf de Verbinding, meldt zich aan met hallo + manifest en
// stuurt hartslagen zolang de app bereikbaar lijkt. Wat er naar de app moet, vertaalt de
// concrete driver (midi.js, http.js).
import { nieuweInst } from '../protocol/berichten.js';

/** @typedef {import('../protocol/types.js').Manifest} Manifest @typedef {import('../protocol/types.js').NaarApp} NaarApp */
/** @typedef {import('../protocol/types.js').Verbinding} Verbinding @typedef {import('../core/klok.js').Klok} Klok */

/**
 * De minimale kern-vorm waar een driver mee praat (src/core/kern.js).
 * @typedef {{
 *   verbind: (v: Verbinding) => void,
 *   ontvang: (v: Verbinding, bericht: any) => void,
 *   verbreek: (v: Verbinding) => void,
 * }} KernVoorDriver
 */

/**
 * Een statisch manifest (apps/<app>.json) = gewoon manifest + `driver`. Splits ze.
 * @param {Record<string, any>} statisch
 * @returns {{ manifest: Record<string, any>, driver: Record<string, any> }}
 */
export function scheidStatisch(statisch) {
  const { driver, ...manifest } = statisch;
  return { manifest, driver: driver ?? {} };
}

export class DriverBasis {
  /**
   * @param {{ manifest: Record<string, any>, klok: Klok, log?: (...a: unknown[]) => void }} o
   */
  constructor({ manifest, klok, log = () => {} }) {
    this.manifest = manifest;
    this.klok = klok;
    this.log = log;
    /** @type {KernVoorDriver|null} */
    this.kern = null;
    /** @type {Verbinding} */
    this.verbinding = { app: null, stuur: (b) => { try { this.vertaal(b); } catch (e) { this.log('driver', manifest.app, 'fout bij vertalen', e); } } };
  }

  /** Vertaal een hub-bericht naar de app. Overschrijven. @param {NaarApp} _b */
  vertaal(_b) {}

  /** Verbind met de kern en meld de app aan (nieuwe `inst`: voor de kern een (her)start). */
  aanmelden() {
    if (!this.kern) return;
    this.kern.ontvang(this.verbinding, { t: 'hallo', app: this.manifest.app, inst: nieuweInst(), v: 1 });
    this.kern.ontvang(this.verbinding, { t: 'manifest', manifest: this.manifest });
  }

  /** @param {KernVoorDriver} kern */
  koppel(kern) {
    this.kern = kern;
    kern.verbind(this.verbinding);
    this.aanmelden();
  }

  hartslag() { this.kern?.ontvang(this.verbinding, { t: 'hb' }); }

  ontkoppel() {
    const k = this.kern;
    this.kern = null;
    if (k) k.verbreek(this.verbinding);
  }
}
