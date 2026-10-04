// @ts-check
// Hotplug: kijk elke paar seconden of het apparaat er is. Komt het (terug), open het
// en meld 'verbonden'; verdwijnt het, sluit en meld 'weg'. RtMidi heeft geen hotplug-event.
//
// Een kabel die korter los is dan één ronde, ziet de poortlijst niet (de naam staat er gewoon weer). Daarom (golf 8)
// ook opnieuw openen als de poort zelf zegt dat hij niet meer leeft (`levend()`, bij de volgende ronde) of als sturen
// mislukt (`herstel()`, meteen): sluiten, 'weg', opnieuw openen, 'verbonden' — en dus opnieuw initialiseren. Begrensd
// met pauzes die verdubbelen (HERSTEL), zodat een kapotte poort geen lus wordt.
import { zoekNaam } from '../ports/poort.js';

/** @typedef {import('../ports/poort.js').Systeem} Systeem @typedef {import('../ports/poort.js').Poort} Poort @typedef {import('./klok.js').Klok} Klok */

/** Opnieuw openen na een storing: de eerste keer meteen, daarna steeds twee keer zo lang wachten (vanaf eersteMs, tot
 *  maxMs). Bleef de poort stabielMs goed, dan begint het weer bij meteen. */
export const HERSTEL = Object.freeze({ eersteMs: 250, maxMs: 30000, stabielMs: 10000 });

export class Aansluiting {
  /** @param {{ systeem: Systeem, patroon: RegExp, klok: Klok, intervalMs?: number, bijVerbonden: (p: Poort) => void, bijWeg: (naam: string) => void, bijFout?: (e: Error) => void }} o */
  constructor(o) {
    this.o = o;
    /** @type {Poort|null} */
    this.poort = null;
    this.timer = null;
    this.gestopt = false;
    /** Timer van een lopend herstel: meteen (0 ms, buiten de wachtrij om) of na een pauze. */
    this.herstelTimer = null;
    /** Storingen kort na elkaar (bepaalt de pauze); terug naar 0 als de poort HERSTEL.stabielMs open bleef. */
    this.pogingen = 0;
    /** Vóór dit moment opent ook de hotplug-ronde niets (pauze na een storing). */
    this.wachtTot = -Infinity;
    this.geopendOp = -Infinity;
  }
  start() { this.gestopt = false; this.kijk(); }
  stop() {
    this.gestopt = true;
    if (this.timer !== null) this.o.klok.wis(this.timer);
    this.timer = null;
    if (this.herstelTimer !== null) this.o.klok.wis(this.herstelTimer);
    this.herstelTimer = null;
    this.poort?.sluit();
    this.poort = null;
  }
  /** Eén ronde: vergelijk poortlijst met de huidige staat. */
  kijk() {
    const { systeem, patroon, klok, intervalMs = 2000 } = this.o;
    try {
      const naam = zoekNaam(systeem.lijst(), patroon);
      if (this.poort && (!naam || naam !== this.poort.naam)) this.#sluit();
      else if (this.poort && this.poort.levend?.() === false) this.#storing();   // kort los geweest: een nieuwe poort
      if (!this.poort && naam && this.herstelTimer === null && klok.nu() >= this.wachtTot) this.#open(naam);
    } catch (e) {
      this.o.bijFout?.(/** @type {Error} */ (e));
    }
    if (!this.gestopt) this.timer = klok.zet(() => this.kijk(), intervalMs);
  }
  /**
   * Sturen naar de poort mislukte: sluit hem en open hem opnieuw, zonder op de volgende ronde te wachten. Loopt via
   * de klok (0 ms), dus veilig vanuit de wachtrij; nog eens aanroepen terwijl het herstel loopt, doet niets extra.
   * @param {Poort} [poort] de poort die faalde; is die intussen al vervangen, dan niets doen
   */
  herstel(poort) {
    if (this.gestopt || !this.poort || this.herstelTimer !== null) return;
    if (poort && poort !== this.poort) return;
    this.herstelTimer = this.o.klok.zet(() => { this.herstelTimer = null; if (!this.gestopt && this.poort) this.#storing(); }, 0);
  }
  /** Poort dicht, 'weg', en opnieuw openen: meteen bij een eerste storing, anders na een pauze. */
  #storing() {
    const { klok } = this.o;
    const nu = klok.nu();
    if (nu - this.geopendOp >= HERSTEL.stabielMs) this.pogingen = 0;
    const pauze = this.pogingen === 0 ? 0 : Math.min(HERSTEL.eersteMs * 2 ** (this.pogingen - 1), HERSTEL.maxMs);
    this.pogingen++;
    this.wachtTot = nu + pauze;
    this.#sluit();
    if (pauze === 0) { this.#probeer(); return; }
    this.herstelTimer = klok.zet(() => { this.herstelTimer = null; if (!this.gestopt) this.#probeer(); }, pauze);
  }
  /** Opnieuw openen als het apparaat er (alweer) is; anders doet de hotplug-ronde het zodra het terugkomt. */
  #probeer() {
    try {
      const naam = zoekNaam(this.o.systeem.lijst(), this.o.patroon);
      if (!this.poort && naam) this.#open(naam);
    } catch (e) {
      this.o.bijFout?.(/** @type {Error} */ (e));
    }
  }
  /** @param {string} naam */
  #open(naam) {
    this.poort = this.o.systeem.open(naam);
    this.geopendOp = this.o.klok.nu();
    this.o.bijVerbonden(this.poort);
  }
  #sluit() {
    const p = /** @type {Poort} */ (this.poort);
    this.poort = null;
    try { p.sluit(); } catch { /* al dicht of weg: niets aan te doen */ }
    this.o.bijWeg(p.naam);
  }
}
