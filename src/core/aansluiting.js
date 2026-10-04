// @ts-check
// Hotplug: kijk elke paar seconden of het apparaat er is. Komt het (terug), open het
// en meld 'verbonden'; verdwijnt het, sluit en meld 'weg'. RtMidi heeft geen hotplug-event.
//
// Een kabel die korter los is dan één ronde, ziet de poortlijst bij de ronde niet (de naam staat er alweer). Daarom
// (golf 8):
// - kijkt de hub vaker (elke LIJST_MS, 250 ms) in de lijst of het apparaat weg is. Zag hij het zo verdwijnen, dan
//   opent hij het ook bij de eerstvolgende tik dat het er weer is; verder opent hij alleen in de gewone ronde
//   (`hotplug_ms`). Dit is het enige dat met RtMidi werkt: daar meldt de poort niets en gooit sturen niet (zie
//   src/ports/rtmidi.js). Een kabel die korter los is dan LIJST_MS blijft daar onzichtbaar.
// - opent de hub opnieuw als de poort zelf zegt dat hij niet meer leeft (`levend()` false, bij de volgende tik) of
//   als sturen mislukt (`herstel()`, meteen): sluiten, 'weg', opnieuw openen, 'verbonden' — en dus opnieuw
//   initialiseren. Alleen de eerste keer (en bij een poort die niet meer leeft): blijft sturen daarna mislukken, dan
//   blijft de poort open (de ingang werkt misschien nog: de knoppen blijven aankomen) en initialiseert de hub het
//   apparaat alleen opnieuw (`bijOpnieuw`), met pauzes die verdubbelen (HERSTEL), zodat een kapotte poort geen lus
//   wordt.
import { zoekNaam } from '../ports/poort.js';

/** @typedef {import('../ports/poort.js').Systeem} Systeem @typedef {import('../ports/poort.js').Poort} Poort @typedef {import('./klok.js').Klok} Klok */

/** Na een storing: de eerste keer meteen, daarna steeds twee keer zo lang wachten (vanaf eersteMs, tot maxMs).
 *  Lukte sturen weer stabielMs lang, dan begint het weer bij meteen. */
export const HERSTEL = Object.freeze({ eersteMs: 250, maxMs: 30000, stabielMs: 10000 });
/** Zo vaak kijkt de hub in de poortlijst of het apparaat weg is (los van het openen, dat elke `hotplug_ms` gebeurt). */
export const LIJST_MS = 250;

export class Aansluiting {
  /** @param {{ systeem: Systeem, patroon: RegExp, klok: Klok, intervalMs?: number, bijVerbonden: (p: Poort) => void, bijWeg: (naam: string) => void, bijFout?: (e: Error) => void, bijOpnieuw?: (p: Poort) => void }} o */
  constructor(o) {
    this.o = o;
    /** @type {Poort|null} */
    this.poort = null;
    this.timer = null;
    this.gestopt = false;
    /** Tikken (elk LIJST_MS) per gewone ronde, en de hoeveelste tik dit is (0 = een gewone ronde). */
    const interval = o.intervalMs ?? 2000;
    this.tikken = Math.max(1, Math.ceil(interval / LIJST_MS));
    this.tikMs = interval / this.tikken;
    this.tik = 0;
    /** Timer van een gepland herstel: meteen (0 ms, buiten de wachtrij om) of na een pauze. */
    this.herstelTimer = null;
    /** Storingen kort na elkaar (bepaalt de pauze); terug naar 0 als sturen HERSTEL.stabielMs lukte of het apparaat
     *  echt uit de lijst was. */
    this.pogingen = 0;
    /** Sinds wanneer sturen (weer) lukt; null na een storing tot het weer lukt. @type {number|null} */
    this.goedSinds = null;
    /** Net uit de lijst verdwenen: open hem bij de eerstvolgende tik dat hij er weer is (niet pas bij de ronde). */
    this.netWeg = false;
  }
  start() { this.gestopt = false; this.tik = 0; this.netWeg = false; this.kijk(); }
  stop() {
    this.gestopt = true;
    if (this.timer !== null) this.o.klok.wis(this.timer);
    this.timer = null;
    this.#wisHerstel();
    this.poort?.sluit();
    this.poort = null;
  }
  /** Eén tik: is het apparaat weg (elke tik), en zo niet verbonden: is het er (elke gewone ronde)? */
  kijk() {
    const { systeem, patroon, klok } = this.o;
    const ronde = this.tik === 0;
    this.tik = (this.tik + 1) % this.tikken;
    /** @type {string|null} */
    let naam = null;
    let lijstGelukt = false;
    try {
      naam = zoekNaam(systeem.lijst(), patroon);
      lijstGelukt = true;
    } catch (e) {
      // Een hikje in de lijst terwijl de poort open is en werkt, is geen storing (en geen melding waard); de volgende
      // tik kijkt opnieuw. Alleen als er niets open is, kan de hub het apparaat zo niet vinden.
      if (!this.poort && ronde) this.o.bijFout?.(/** @type {Error} */ (e));
    }
    if (lijstGelukt) {
      try {
        if (this.poort && (!naam || naam !== this.poort.naam)) {
          // Echt uit de lijst: geen storing van de poort. Wat er gepland stond, vervalt; terug komt hij als nieuw.
          this.#wisHerstel();
          this.pogingen = 0;
          this.netWeg = true;
          this.#sluit();
        } else if (this.poort && this.herstelTimer === null && this.poort.levend?.() === false) {
          this.#plan(this.poort);   // kort los geweest (sneller dan de lijst zag): een nieuwe poort
        }
        if ((ronde || this.netWeg) && !this.poort && naam && this.herstelTimer === null) this.#open(naam);
      } catch (e) {
        this.netWeg = false;   // openen mislukt: verder alleen in de gewone ronde (geen poging per tik)
        this.o.bijFout?.(/** @type {Error} */ (e));
      }
    }
    if (!this.gestopt) this.timer = klok.zet(() => this.kijk(), this.tikMs);
  }
  /**
   * Sturen naar de poort mislukte: herstel zonder op de volgende ronde te wachten. Loopt via de klok, dus veilig
   * vanuit de wachtrij; nog eens aanroepen terwijl het herstel gepland staat, doet niets extra.
   * @param {Poort} [poort] de poort die faalde; is die intussen al vervangen, dan niets doen
   */
  herstel(poort) {
    if (this.gestopt || !this.poort || this.herstelTimer !== null) return;
    if (poort && poort !== this.poort) return;
    this.#plan(this.poort);
  }
  /** Sturen lukte (de sessie meldt het bij elk bericht): na HERSTEL.stabielMs begint het herstel weer bij meteen. */
  gelukt() { if (this.goedSinds === null) this.goedSinds = this.o.klok.nu(); }
  /** Plan het herstel van poort p: de eerste keer meteen, daarna na een pauze. @param {Poort} p */
  #plan(p) {
    const { klok } = this.o;
    const nu = klok.nu();
    if (this.goedSinds !== null && nu - this.goedSinds >= HERSTEL.stabielMs) this.pogingen = 0;
    const eerste = this.pogingen === 0;
    const pauze = eerste ? 0 : Math.min(HERSTEL.eersteMs * 2 ** (this.pogingen - 1), HERSTEL.maxMs);
    this.pogingen++;
    this.goedSinds = null;
    this.herstelTimer = klok.zet(() => {
      this.herstelTimer = null;
      // Intussen al vervangen of gesloten (bv. door de hotplug-ronde): dit herstel geldt niet meer.
      if (this.gestopt || this.poort !== p) return;
      if (eerste || p.levend?.() === false) {
        this.#sluit();
        this.#probeer();
      } else {
        try { this.o.bijOpnieuw?.(p); } catch (e) { this.o.bijFout?.(/** @type {Error} */ (e)); }
      }
    }, pauze);
  }
  /** Opnieuw openen als het apparaat er (alweer) is; anders doet de hotplug-ronde het zodra het terugkomt. */
  #probeer() {
    try {
      const naam = zoekNaam(this.o.systeem.lijst(), this.o.patroon);
      if (!this.poort && naam) this.#open(naam);
      else if (!naam) this.netWeg = true;   // (nog) los: open hem bij de eerste tik dat hij er weer is
    } catch (e) {
      this.o.bijFout?.(/** @type {Error} */ (e));
    }
  }
  #wisHerstel() {
    if (this.herstelTimer !== null) this.o.klok.wis(this.herstelTimer);
    this.herstelTimer = null;
  }
  /** @param {string} naam */
  #open(naam) {
    this.netWeg = false;
    this.poort = this.o.systeem.open(naam);
    this.o.bijVerbonden(this.poort);
  }
  #sluit() {
    const p = /** @type {Poort} */ (this.poort);
    this.poort = null;
    try { p.sluit(); } catch { /* al dicht of weg: niets aan te doen */ }
    this.o.bijWeg(p.naam);
  }
}
