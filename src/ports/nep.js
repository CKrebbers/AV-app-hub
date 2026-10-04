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
    /** Een kapotte poort: openen lukt, sturen niet (een kabel die half contact maakt, een stuk USB-hub). */
    this.kapot = false;
  }
  /** @param {number[]} b */
  stuur(b) {
    if (!this.open) throw new Error(`poort ${this.naam} is dicht`);
    if (this.kapot) throw new Error(`poort ${this.naam} stuurt niet`);
    this.verstuurd.push([...b]);
    this.antwoord?.(b);
  }
  /** @param {(b: number[]) => void} fn */
  bijBericht(fn) { this.luisteraars.add(fn); return () => this.luisteraars.delete(fn); }
  /** Apparaat stuurt iets naar de hub. @param {number[]} b */
  injecteer(b) { if (this.open) for (const fn of this.luisteraars) fn([...b]); }
  sluit() { this.open = false; this.luisteraars.clear(); }
  /** Is de poort nog bruikbaar? Na `NepSysteem.verwijder` niet meer: dat apparaat is weg, ook als er intussen een
   *  nieuw met dezelfde naam is (een snelle replug), want dat is een nieuwe poort. */
  levend() { return this.open; }
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
  /** Trek een apparaat los. De poort die de hub open had, gaat dicht zonder melding (net als bij RtMidi, zie
   *  rtmidi.js): sturen gooit, er komt niets meer binnen, `levend()` is false. Steek je hem weer in (`voegToe`), dan is
   *  dat een nieuwe poort met dezelfde naam, ook als de hotplug-ronde het weg-zijn niet zag. @param {string} naam */
  verwijder(naam) { this.apparaten.get(naam)?.sluit(); this.apparaten.delete(naam); }
  lijst() { const n = [...this.apparaten.keys()]; return { ingangen: n, uitgangen: n }; }
  /** Een apparaat dat er nog is, gaat na `sluit()` gewoon weer open (zoals een echte poort). @param {string} naam @returns {Poort} */
  open(naam) {
    const p = this.apparaten.get(naam);
    if (!p) throw new Error(`geen apparaat ${naam}`);
    p.open = true;
    this.geopend.set(naam, p);
    return p;
  }
  /** @param {string} naam */
  virtueel(naam) { return this.voegToe(naam); }
}
