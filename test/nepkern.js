// @ts-check
// Nep-kern voor transporttests: volgt het kern-contract (src/core/kern.js) en legt elke aanroep vast.
// Gedrag is minimaal: hallo zet v.app, een ongeldig manifest krijgt een fout terug, de rest wordt alleen genoteerd.
import { Zender } from '../src/core/zender.js';
import { valideerManifest } from '../src/protocol/manifest.js';

/** @typedef {import('../src/protocol/types.js').Verbinding} Verbinding */

export class NepKern extends Zender {
  constructor() {
    super();
    /** @type {{ naam: string, args: any[] }[]} */
    this.aanroepen = [];
    /** @type {Set<Verbinding>} */
    this.verbindingen = new Set();
    /** @type {Record<string, any>} */
    this.huidigBeeld = { apps: [], focus: null, globaal: { grondtoon: 'D', bpm: 120 }, apparaten: {} };
    /** Laat een aanroep mislukken om de robuustheid van de server te toetsen. @type {Set<string>} */
    this.faal = new Set();
  }
  /** @param {string} naam @param {any[]} args */
  #noteer(naam, args) {
    this.aanroepen.push({ naam, args });
    if (this.faal.has(naam)) throw new Error(`nep-kern: ${naam} faalt met opzet`);
  }
  /** @param {string} naam */
  van(naam) { return this.aanroepen.filter((a) => a.naam === naam); }
  /** Berichten die via kern.ontvang binnenkwamen, eventueel alleen van één type. @param {string} [t] */
  ontvangen(t) { return this.van('ontvang').map((a) => a.args[1]).filter((b) => !t || b.t === t); }
  /** Verbinding van een app (na hallo). @param {string} app */
  verbindingVan(app) { return [...this.verbindingen].find((v) => v.app === app) ?? null; }

  /** @param {Verbinding} v */
  verbind(v) { this.#noteer('verbind', [v]); this.verbindingen.add(v); }
  /** @param {Verbinding} v @param {any} b */
  ontvang(v, b) {
    this.#noteer('ontvang', [v, b]);
    if (b.t === 'hallo') v.app = b.app;
    if (b.t === 'manifest') {
      const r = valideerManifest(b.manifest);
      if (!r.ok) v.stuur({ t: 'fout', reden: r.fouten.join('; ') });
    }
  }
  /** @param {Verbinding} v */
  verbreek(v) { this.#noteer('verbreek', [v]); this.verbindingen.delete(v); }
  /** @param {any} g @param {number[]} bytes */
  invoer(g, bytes) { this.#noteer('invoer', [g, bytes]); }
  /** @param {any} b */
  cockpit(b) { this.#noteer('cockpit', [b]); }
  /** @param {string|null} app */
  focus(app) { this.#noteer('focus', [app]); }
  beeld() { this.#noteer('beeld', []); return structuredClone(this.huidigBeeld); }
  stop() { this.#noteer('stop', []); }
  /** Aantal luisteraars op een event (om afmelden te toetsen). @param {string} naam */
  luisteraars(naam) { return this.l.get(naam)?.size ?? 0; }
}

/**
 * Wacht tot `fn` iets waars teruggeeft (echte tijd; voor netwerktests).
 * @template T @param {() => T} fn @param {number} [ms]
 * @returns {Promise<NonNullable<T>>}
 */
export async function wachtOp(fn, ms = 3000) {
  const eind = Date.now() + ms;
  for (;;) {
    const x = fn();
    if (x) return /** @type {NonNullable<T>} */ (x);
    if (Date.now() > eind) throw new Error(`wachtOp: niet binnen ${ms} ms`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
