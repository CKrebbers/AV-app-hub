// @ts-check
// Apparaatsessies: de hub-kant van één aangesloten controller.
// ApcSessie zet de modus, tekent LEDs via de wachtrij en meldt gebeurtenissen.
// Lpd8Sessie herkent het model, leest programma's en meldt gebeurtenissen volgens het profiel.
import * as APC from './devices/apc40mk2.js';
import * as LPD8 from './devices/lpd8.js';
import { Aansluiting } from './core/aansluiting.js';
import { LedBeeld } from './core/leds.js';
import { Wachtrij } from './core/wachtrij.js';
import { Zender } from './core/zender.js';

/** @typedef {import('./ports/poort.js').Systeem} Systeem @typedef {import('./ports/poort.js').Poort} Poort
 *  @typedef {import('./core/klok.js').Klok} Klok @typedef {import('./core/logboek.js').Logboek} Logboek */

class Sessie extends Zender {
  /** @param {{ dev: string, patroon: RegExp, systeem: Systeem, klok: Klok, intervalMs?: number, logboek?: Logboek|null, led?: { per_burst: number, burst_ms: number } }} o */
  constructor(o) {
    super();
    this.dev = o.dev;
    this.klok = o.klok;
    this.logboek = o.logboek ?? null;
    /** @type {Poort|null} */
    this.poort = null;
    /** Welke storingen al gemeld zijn (één melding per storing, niet per bericht of per poging). 'sturen' is voorbij
     *  zodra er weer iets verstuurd is, 'openen' zodra de poort weer open is: los van elkaar, zodat de ene de
     *  melding van de andere niet onderdrukt. */
    this.gemeld = { sturen: false, openen: false };
    this.rij = new Wachtrij({
      klok: o.klok, perBurst: o.led?.per_burst ?? 16, burstMs: o.led?.burst_ms ?? 4,
      stuur: (b) => {
        const p = this.poort;
        if (!p) return;
        this.logboek?.midi('uit', this.dev, b);
        // Het apparaat is (even) losgetrokken of de poort is stuk: de poort gooit. Dat mag de hub niet laten vallen
        // (dit draait in een timer: een uitzondering hier stopte het hele proces). De poort meteen opnieuw openen en
        // het apparaat opnieuw initialiseren (golf 8): ook als de kabel al terug is vóór de hotplug-ronde het zag.
        try { p.stuur(b); } catch (e) {
          this.aansluiting.herstel(p);
          this.#storing(/** @type {Error} */ (e), 'sturen');
          return;
        }
        this.gemeld.sturen = false;
        this.aansluiting.gelukt();
      },
    });
    this.aansluiting = new Aansluiting({
      systeem: o.systeem, patroon: o.patroon, klok: o.klok, intervalMs: o.intervalMs,
      bijVerbonden: (p) => this.#verbonden(p),
      bijWeg: (naam) => { this.poort = null; this.rij.wis(); this.logboek?.regel('melding', { dev: this.dev, wat: 'weg', naam }); this.meld('weg', naam); },
      bijFout: (e) => this.#storing(e, 'openen'),
      // Sturen bleef mislukken na een keer opnieuw openen: de poort blijft open (de ingang werkt misschien nog), het
      // apparaat wordt alleen opnieuw geïnitialiseerd.
      bijOpnieuw: (p) => { if (this.poort === p) this.bijAansluiten(); },
    });
  }
  /** Meldt 'fout' (e, soort: 'sturen' | 'openen'), één keer per storing. @param {Error} e @param {'sturen'|'openen'} soort */
  #storing(e, soort) {
    if (this.gemeld[soort]) return;
    this.gemeld[soort] = true;
    this.logboek?.regel('melding', { dev: this.dev, wat: 'fout', soort, fout: e.message });
    this.meld('fout', e, soort);
  }
  get verbonden() { return this.poort !== null; }
  start() { this.aansluiting.start(); }
  /** Poort dicht; wat nog in de wachtrij stond kan nergens meer heen (en geen timer blijft op de klok staan). */
  stop() { this.aansluiting.stop(); this.poort = null; this.rij.wis(); }
  /** @param {number[]} b */
  stuur(b) { this.rij.zet(b); }
  /** @param {Poort} p */
  #verbonden(p) {
    this.poort = p;
    this.gemeld.openen = false;
    this.logboek?.regel('melding', { dev: this.dev, wat: 'verbonden', naam: p.naam });
    p.bijBericht((b) => {
      this.logboek?.midi('in', this.dev, b);
      const g = this.ontleed(b);
      this.logboek?.regel('gebeurtenis', g);
      this.meld('gebeurtenis', g, b);
    });
    this.bijAansluiten();
    this.meld('verbonden', p.naam);
  }
  /** @param {number[]} b @returns {any} */
  ontleed(b) { return { dev: this.dev, el: null, kind: 'onbekend', bytes: b }; }
  bijAansluiten() {}
}

export class ApcSessie extends Sessie {
  /** @param {ConstructorParameters<typeof Sessie>[0] & { modus?: number }} o */
  constructor(o) {
    super(o);
    this.modus = o.modus ?? APC.MODUS.alternatief;
    this.leds = new LedBeeld({ controls: APC.CONTROLS, berichten: APC.ledBerichten });
    this.leds.zwart();
  }
  /** @param {number[]} b */
  ontleed(b) { return APC.ontleed(b); }
  /** Bij (her)aansluiten: modus, ringtypes en alles opnieuw tekenen. Het apparaat valt na replug terug op modus 0. */
  bijAansluiten() { this.init(); }
  init() {
    this.rij.wis();
    this.stuur(APC.intro(this.modus));
    for (const b of APC.ringTypeBerichten(APC.RING.single)) this.stuur(b);
    this.leds.vergeet();
    this.teken();
  }
  /** @param {string} id @param {import('./devices/apc40mk2.js').LedStaat} s */
  zet(id, s) { this.leds.zet(id, s); }
  /** Stuur alle LED-wijzigingen. Geeft het aantal berichten terug. */
  teken() { const w = this.leds.wijzigingen(); this.rij.zetAlle(w); return w.length; }
  /** De volgende `teken()` stuurt alles opnieuw (bv. nadat een lease-app buiten het LED-model om tekende). */
  vergeet() { this.leds.vergeet(); }
  zwart() { this.leds.zwart(); return this.teken(); }
  /** Bij afsluiten: alles uit via de wachtrij (niet overspoelen), en wachten tot het verstuurd is. */
  async zwartEnWacht(maxMs = 500) {
    this.zwart();
    /** @type {any} */ let h;
    await Promise.race([this.rij.leeg(), new Promise((r) => { h = this.klok.zet(() => r(undefined), maxMs); })]);
    this.klok.wis(h);   // leeg op tijd: de wachttimer niet laten staan (hield de hub na stop() nog 0,5 s in leven)
  }
}

export class Lpd8Sessie extends Sessie {
  /** @param {ConstructorParameters<typeof Sessie>[0] & { profiel?: import('./devices/lpd8.js').Profiel|null }} o */
  constructor(o) {
    super(o);
    /** @type {import('./devices/lpd8.js').Model|null} */
    this.model = null;
    /** @type {Map<number, any>} */
    this.programmas = new Map();
    this.vastProfiel = o.profiel ?? null;
    this.profiel = o.profiel ?? LPD8.standaardProfiel(null);
    this.ontleder = LPD8.maakOntleder(this.profiel);
  }
  /** @param {import('./devices/lpd8.js').Profiel} p */
  zetProfiel(p) { this.profiel = p; this.ontleder = LPD8.maakOntleder(p); this.meld('profiel', p); }
  /** @param {number[]} b */
  ontleed(b) {
    if (b[0] === 0xf0) {
      const m = LPD8.modelUit(b);
      if (m && !this.model) { this.model = m; if (!this.vastProfiel) this.zetProfiel(LPD8.standaardProfiel(m)); this.meld('model', m); }
      const p = LPD8.ontleedProgramma(b);
      if (p) { this.programmas.set('prog' in p ? p.prog : -1, p); this.meld('programma', p); }
      return { dev: 'lpd8', el: null, kind: 'onbekend', sysex: true, model: m, programma: p ?? undefined };
    }
    return this.ontleder(b);
  }
  bijAansluiten() { this.stuur([...LPD8.IDENTITEIT_VRAAG]); }
  /** Vraag programma's op (na het model). @param {number[]} nummers */
  vraagProgrammas(nummers) { if (this.model) for (const n of nummers) this.stuur(LPD8.vraagProgramma(this.model, n)); }
}

/**
 * Beide controllers, met hotplug.
 * @param {{ systeem: Systeem, klok: Klok, config: any, logboek?: Logboek|null, lpd8Profiel?: any }} o
 */
export function maakApparaten({ systeem, klok, config, logboek = null, lpd8Profiel = null }) {
  const gemeen = { systeem, klok, logboek, intervalMs: config.hotplug_ms, led: config.led };
  const apc = new ApcSessie({ ...gemeen, dev: 'apc40', patroon: new RegExp(config.apparaten.apc40.naam, 'i'), modus: config.apparaten.apc40.modus });
  const lpd8 = new Lpd8Sessie({ ...gemeen, dev: 'lpd8', patroon: new RegExp(config.apparaten.lpd8.naam, 'i'), profiel: lpd8Profiel });
  return {
    apc, lpd8,
    start() { apc.start(); lpd8.start(); },
    /** LEDs uit, poorten dicht. */
    async stop() { if (apc.verbonden) await apc.zwartEnWacht(); apc.stop(); lpd8.stop(); },
  };
}
