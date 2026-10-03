// @ts-check
/** Minimale event-zender. Een fout in een luisteraar breekt de andere niet. */
export class Zender {
  constructor() { /** @type {Map<string, Set<Function>>} */ this.l = new Map(); }
  /** @param {string} naam @param {Function} fn */
  bij(naam, fn) {
    if (!this.l.has(naam)) this.l.set(naam, new Set());
    /** @type {Set<Function>} */ (this.l.get(naam)).add(fn);
    return () => this.l.get(naam)?.delete(fn);
  }
  /** @param {string} naam @param {...unknown} args */
  meld(naam, ...args) {
    for (const fn of this.l.get(naam) ?? []) {
      try { fn(...args); } catch (e) { console.error(`[zender] fout in luisteraar ${naam}:`, e); }
    }
  }
}
