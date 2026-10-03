// @ts-check
// Hotplug: kijk elke paar seconden of het apparaat er is. Komt het (terug), open het
// en meld 'verbonden'; verdwijnt het, sluit en meld 'weg'. RtMidi heeft geen hotplug-event.
import { zoekNaam } from '../ports/poort.js';

/** @typedef {import('../ports/poort.js').Systeem} Systeem @typedef {import('../ports/poort.js').Poort} Poort @typedef {import('./klok.js').Klok} Klok */

export class Aansluiting {
  /** @param {{ systeem: Systeem, patroon: RegExp, klok: Klok, intervalMs?: number, bijVerbonden: (p: Poort) => void, bijWeg: (naam: string) => void, bijFout?: (e: Error) => void }} o */
  constructor(o) {
    this.o = o;
    /** @type {Poort|null} */
    this.poort = null;
    this.timer = null;
    this.gestopt = false;
  }
  start() { this.gestopt = false; this.kijk(); }
  stop() {
    this.gestopt = true;
    if (this.timer !== null) this.o.klok.wis(this.timer);
    this.timer = null;
    this.poort?.sluit();
    this.poort = null;
  }
  /** Eén ronde: vergelijk poortlijst met de huidige staat. */
  kijk() {
    const { systeem, patroon, klok, intervalMs = 2000 } = this.o;
    try {
      const naam = zoekNaam(systeem.lijst(), patroon);
      if (this.poort && (!naam || naam !== this.poort.naam)) {
        const oud = this.poort.naam;
        this.poort.sluit();
        this.poort = null;
        this.o.bijWeg(oud);
      }
      if (!this.poort && naam) {
        this.poort = systeem.open(naam);
        this.o.bijVerbonden(this.poort);
      }
    } catch (e) {
      this.o.bijFout?.(/** @type {Error} */ (e));
    }
    if (!this.gestopt) this.timer = klok.zet(() => this.kijk(), intervalMs);
  }
}
