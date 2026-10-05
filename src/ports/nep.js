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
    /** false = alleen een ingang (zie NepSysteem.voegToe). */
    this.uitgang = true;
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
  /**
   * Sluit een (nep-)apparaat aan. `uitgang: false` = een apparaat met alleen een ingang (zoals de Xboard49): het staat
   * niet tussen de uitgangen en gaat alleen open met `{ alleenIngang: true }`.
   * @param {string} naam @param {{ uitgang?: boolean }} [o]
   */
  voegToe(naam, { uitgang = true } = {}) {
    const p = new NepPoort(naam);
    p.uitgang = uitgang;
    this.apparaten.set(naam, p);
    return p;
  }
  /** Trek een apparaat los. De poort die de hub open had, gaat dicht zonder melding (net als bij RtMidi, zie
   *  rtmidi.js): sturen gooit, er komt niets meer binnen, `levend()` is false. Steek je hem weer in (`voegToe`), dan is
   *  dat een nieuwe poort met dezelfde naam, ook als de hotplug-ronde het weg-zijn niet zag. @param {string} naam */
  verwijder(naam) { this.apparaten.get(naam)?.sluit(); this.apparaten.delete(naam); }
  lijst() {
    const n = [...this.apparaten.keys()];
    return { ingangen: n, uitgangen: n.filter((x) => this.apparaten.get(x)?.uitgang !== false) };
  }
  /**
   * Een apparaat dat er nog is, gaat na `sluit()` gewoon weer open (zoals een echte poort).
   * @param {string} naam @param {{ alleenIngang?: boolean }} [o] @returns {Poort}
   */
  open(naam, { alleenIngang = false } = {}) {
    const p = this.apparaten.get(naam);
    if (!p) throw new Error(`geen apparaat ${naam}`);
    if (p.uitgang === false && !alleenIngang) throw new Error(`poort niet gevonden: ${naam} (alleen een ingang)`);
    p.open = true;
    this.geopend.set(naam, p);
    return p;
  }
  /** @param {string} naam */
  virtueel(naam) { return this.voegToe(naam); }
}

// ── HID (de Maschine MK2) ─────────────────────────────────────────────────────

/** @typedef {import('./hid.js').HidPoort} HidPoort @typedef {import('./hid.js').HidApparaat} HidApparaat */

/** Een nep-HID-toestel: wat de hub schreef (`verstuurd`), en `injecteer` om een invoerrapport te sturen. */
export class NepHidPoort {
  /** @param {string} naam @param {string} product */
  constructor(naam, product) {
    this.naam = naam;
    this.product = product;
    /** @type {number[][]} */
    this.verstuurd = [];
    /** @type {Set<(b: Uint8Array) => void>} */
    this.luisteraars = new Set();
    this.open = false;
    this.kapot = false;
    /** Opties van de laatste keer openen (bv. nietExclusief). @type {Record<string, unknown>|null} */
    this.opties = null;
  }
  /** @param {number[]} b */
  stuur(b) {
    if (!this.open) throw new Error(`${this.product} is dicht`);
    if (this.kapot) throw new Error(`${this.product}: schrijven mislukt`);
    this.verstuurd.push([...b]);
  }
  /** @param {(b: Uint8Array) => void} fn */
  bijBericht(fn) { this.luisteraars.add(fn); return () => this.luisteraars.delete(fn); }
  /** Het toestel stuurt een invoerrapport. @param {ArrayLike<number>} b */
  injecteer(b) { if (this.open) for (const fn of this.luisteraars) fn(Uint8Array.from(b)); }
  sluit() { this.open = false; this.luisteraars.clear(); }
  levend() { return this.open; }
}

/**
 * Nep-HID-systeem (src/ports/hid.js zonder node-hid): toestellen erbij en weg, en een toestel dat 'bezet' is
 * (een ander programma heeft het exclusief open: openen gooit, zoals hidapi dan doet).
 */
export class NepHidSysteem {
  constructor() {
    this.soort = 'nep-hid';
    /** @type {Map<string, { vid: number, pid: number, product: string, poort: NepHidPoort, bezet: boolean }>} */
    this.toestellen = new Map();
    this.volgnr = 0;
    /** Wordt aangeroepen na elke geslaagde `open` (de gesimuleerde Maschine stuurt dan zijn eerste rapport). @type {((p: NepHidPoort) => void)|null} */
    this.bijOpen = null;
  }
  /** @param {{ vid: number, pid: number, product?: string, bezet?: boolean }} o */
  voegToe({ vid, pid, product = 'HID-toestel', bezet = false }) {
    const naam = `nep-hid:${vid.toString(16)}:${pid.toString(16)}:${++this.volgnr}`;
    const poort = new NepHidPoort(naam, product);
    this.toestellen.set(naam, { vid, pid, product, poort, bezet });
    return poort;
  }
  /** Trek een toestel los: de open poort gaat dicht zonder melding (`levend()` false). @param {string} naam */
  verwijder(naam) { this.toestellen.get(naam)?.poort.sluit(); this.toestellen.delete(naam); }
  /** @param {string} naam @param {boolean} bezet */
  zetBezet(naam, bezet) { const t = this.toestellen.get(naam); if (t) t.bezet = bezet; }
  /** @returns {HidApparaat[]} */
  apparaten() { return [...this.toestellen].map(([naam, t]) => ({ naam, pad: naam, vid: t.vid, pid: t.pid, product: t.product })); }
  /** @param {number} vid @param {number} pid */
  zoek(vid, pid) { return this.apparaten().find((a) => a.vid === vid && a.pid === pid)?.naam ?? null; }
  /** @param {string} naam @param {{ nietExclusief?: boolean }} [o] @returns {HidPoort} */
  open(naam, o = {}) {
    const t = this.toestellen.get(naam);
    if (!t) throw new Error(`geen HID-toestel ${naam}`);
    if (t.bezet) throw new Error(`cannot open device with path ${naam}`);
    t.poort.open = true;
    t.poort.opties = { ...o };
    this.bijOpen?.(t.poort);
    return t.poort;
  }
}
