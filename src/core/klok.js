// @ts-check
// Tijd wordt altijd geïnjecteerd: de echte klok in de app, een nep-klok in tests.

/** @typedef {{ nu: () => number, zet: (fn: () => void, ms: number) => any, wis: (h: any) => void }} Klok */

/** @type {Klok} */
export const echteKlok = {
  nu: () => performance.now(),
  zet: (fn, ms) => setTimeout(fn, ms),
  wis: (h) => clearTimeout(h),
};

/** Nep-klok: timers lopen alleen als de test `loop(ms)` aanroept. */
export class NepKlok {
  constructor() {
    this.t = 0;
    this.volgnr = 0;
    /** @type {Map<number, { op: number, fn: () => void }>} */
    this.timers = new Map();
  }
  nu() { return this.t; }
  /** @param {() => void} fn @param {number} ms */
  zet(fn, ms) { const id = ++this.volgnr; this.timers.set(id, { op: this.t + Math.max(0, ms), fn }); return id; }
  /** @param {any} h */
  wis(h) { this.timers.delete(h); }
  /** Laat de tijd ms verstrijken en voer timers in volgorde uit. @param {number} ms */
  loop(ms) {
    const eind = this.t + ms;
    for (;;) {
      let volgende = null;
      for (const [id, x] of this.timers) if (x.op <= eind && (!volgende || x.op < volgende[1].op || (x.op === volgende[1].op && id < volgende[0]))) volgende = [id, x];
      if (!volgende) break;
      this.timers.delete(volgende[0]);
      this.t = volgende[1].op;
      volgende[1].fn();
    }
    this.t = eind;
  }
}
