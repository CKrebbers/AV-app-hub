// @ts-check
// Nep-MIDI voor tests en voor draaien zonder hardware (zoals in de cloud).
// NepSysteem gedraagt zich als de echte poortlijst: apparaten kunnen erbij komen en weggaan.

/** @typedef {import('./poort.js').Poort} Poort */

export class NepPoort {
  /** @param {string} naam */
  constructor(naam) {
    this.naam = naam;
    /** @type {number[][]} wat de hub naar het apparaat stuurde */
    this.verstuurd = [];
    /** @type {Set<(b: number[]) => void>} */
    this.luisteraars = new Set();
    this.open = true;
    /** @type {((b: number[]) => void) | null} optioneel: apparaat antwoordt op wat de hub stuurt */
    this.antwoord = null;
  }
  /** @param {number[]} b */
  stuur(b) {
    if (!this.open) throw new Error(`poort ${this.naam} is dicht`);
    this.verstuurd.push([...b]);
    this.antwoord?.(b);
  }
  /** @param {(b: number[]) => void} fn */
  bijBericht(fn) { this.luisteraars.add(fn); return () => this.luisteraars.delete(fn); }
  /** Apparaat stuurt iets naar de hub. @param {number[]} b */
  injecteer(b) { if (this.open) for (const fn of this.luisteraars) fn([...b]); }
  sluit() { this.open = false; this.luisteraars.clear(); }
}

export class NepSysteem {
  constructor() {
    this.soort = 'nep';
    /** @type {Map<string, NepPoort>} */
    this.apparaten = new Map();
    /** @type {Map<string, NepPoort>} */
    this.geopend = new Map();
  }
  /** Sluit een (nep-)apparaat aan. @param {string} naam */
  voegToe(naam) { const p = new NepPoort(naam); this.apparaten.set(naam, p); return p; }
  /** Trek een apparaat los. @param {string} naam */
  verwijder(naam) { this.apparaten.get(naam)?.sluit(); this.apparaten.delete(naam); }
  lijst() { const n = [...this.apparaten.keys()]; return { ingangen: n, uitgangen: n }; }
  /** @param {string} naam @returns {Poort} */
  open(naam) {
    const p = this.apparaten.get(naam);
    if (!p) throw new Error(`geen apparaat ${naam}`);
    this.geopend.set(naam, p);
    return p;
  }
  /** @param {string} naam */
  virtueel(naam) { return this.voegToe(naam); }
}
