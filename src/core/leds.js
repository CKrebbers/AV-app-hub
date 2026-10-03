// @ts-check
// LED-beeld: wat er op het oppervlak HOORT te staan, en wat er al verstuurd is.
// Alleen verschillen gaan de draad op; na opnieuw aansluiten tekent `vergeet()` alles opnieuw.

/** @typedef {import('../devices/apc40mk2.js').Control} Control @typedef {import('../devices/apc40mk2.js').LedStaat} LedStaat */

export class LedBeeld {
  /** @param {{ controls: readonly Control[], berichten: (c: Control, s: LedStaat) => number[][] }} apparaat */
  constructor(apparaat) {
    this.apparaat = apparaat;
    this.opId = new Map(apparaat.controls.map((c) => [c.id, c]));
    /** @type {Map<string, LedStaat>} */
    this.staat = new Map();
    /** @type {Map<string, string>} sleutel = id, waarde = laatst verstuurde berichten (JSON) */
    this.verstuurd = new Map();
  }
  /** @param {string} id @param {LedStaat} s */
  zet(id, s) {
    if (!this.opId.has(id)) throw new Error(`onbekende control: ${id}`);
    this.staat.set(id, s);
  }
  /** @param {string} id */
  lees(id) { return this.staat.get(id); }
  /** Alles uit (in het model). */
  zwart() { for (const c of this.apparaat.controls) if (c.led !== 'geen') this.staat.set(c.id, c.led === 'ring' ? { waarde: 0 } : {}); }
  /** Volgende verzending wordt een volledige repaint. */
  vergeet() { this.verstuurd.clear(); }
  /** Berichten voor alles wat veranderd is sinds de vorige keer; markeert ze als verstuurd. */
  wijzigingen() {
    /** @type {number[][]} */
    const uit = [];
    for (const [id, s] of this.staat) {
      const c = /** @type {Control} */ (this.opId.get(id));
      const msgs = this.apparaat.berichten(c, s);
      const sleutel = JSON.stringify(msgs);
      if (this.verstuurd.get(id) === sleutel) continue;
      this.verstuurd.set(id, sleutel);
      uit.push(...msgs);
    }
    return uit;
  }
}
