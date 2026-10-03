// @ts-check
// Uitgaande MIDI in porties: 16 berichten per 4 ms (zoals Varve DJ en av-kern).
// De APC laat berichten vallen als je hem overspoelt; dit houdt het tempo veilig.

/** @typedef {import('./klok.js').Klok} Klok */

export class Wachtrij {
  /** @param {{ stuur: (b: number[]) => void, klok: Klok, perBurst?: number, burstMs?: number }} o */
  constructor({ stuur, klok, perBurst = 16, burstMs = 4 }) {
    this.stuur = stuur;
    this.klok = klok;
    this.perBurst = perBurst;
    this.burstMs = burstMs;
    /** @type {number[][]} */
    this.rij = [];
    this.timer = null;
    /** @type {(() => void)[]} */
    this.wachtenden = [];
  }
  /** @param {number[]} b */
  zet(b) {
    this.rij.push(b);
    if (this.timer === null) this.timer = this.klok.zet(() => this.#stroom(), 0);
  }
  /** @param {number[][]} lijst */
  zetAlle(lijst) { for (const b of lijst) this.zet(b); }
  get lengte() { return this.rij.length; }
  /** Belooft op het moment dat de rij leeg is (voor meten en netjes afsluiten). */
  leeg() { return this.rij.length === 0 && this.timer === null ? Promise.resolve() : new Promise((r) => this.wachtenden.push(r)); }
  /** Gooi alles weg wat nog niet verstuurd is (bv. als het apparaat weg is). */
  wis() {
    this.rij = [];
    if (this.timer !== null) this.klok.wis(this.timer);
    this.timer = null;
    this.#klaar();
  }
  /** Stuur alles direct, zonder pauzes (alleen bij afsluiten). */
  spoel() { const r = this.rij; this.rij = []; for (const b of r) this.stuur(b); this.wis(); }
  #stroom() {
    this.timer = null;
    for (const b of this.rij.splice(0, this.perBurst)) this.stuur(b);
    if (this.rij.length) this.timer = this.klok.zet(() => this.#stroom(), this.burstMs);
    else this.#klaar();
  }
  #klaar() { const w = this.wachtenden; this.wachtenden = []; for (const r of w) r(); }
}
