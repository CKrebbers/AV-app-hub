// @ts-check
// Schrijven zonder ooit te blokkeren: regels gaan eerst in een buffer in het geheugen en worden met een
// timer (via de geïnjecteerde Klok) of bij een volle buffer asynchroon aan het bestand toegevoegd.
// Een schijf die vol is of een map die niet schrijfbaar is, geeft een melding — nooit een exceptie in de
// kern of de hub. Lukt schrijven later weer, dan gaat de achterstand er alsnog in (volgorde blijft goed).
// Een schrijfactie die halverwege mislukt (schijf vol: write(2) schrijft eerst een deel, dan ENOSPC) laat
// geen halve regel achter: de schrijver onthoudt hoe groot het bestand zeker goed is en kort het bij een
// fout daartoe in, vóór hij het hele blok opnieuw probeert.
import { promises as fsp } from 'node:fs';

/** @typedef {import('../core/klok.js').Klok} Klok */
/**
 * Wat de opname van het bestandssysteem nodig heeft (injecteerbaar voor tests).
 * @typedef {{
 *   mkdir: (pad: string, o?: { recursive?: boolean }) => Promise<unknown>,
 *   appendFile: (pad: string, tekst: string) => Promise<void>,
 *   writeFile: (pad: string, tekst: string) => Promise<void>,
 *   truncate: (pad: string, lengte: number) => Promise<void>,
 * }} Bestanden
 */

/** @type {Bestanden} */
export const echteBestanden = {
  mkdir: (pad, o) => fsp.mkdir(pad, o),
  appendFile: (pad, tekst) => fsp.appendFile(pad, tekst, 'utf8'),
  writeFile: (pad, tekst) => fsp.writeFile(pad, tekst, 'utf8'),
  truncate: (pad, lengte) => fsp.truncate(pad, lengte),
};

export const SPOEL_MS = 1000;
/** Bij zoveel tekens in de buffer wordt meteen (asynchroon) gespoeld. */
export const SPOEL_TEKENS = 64 * 1024;
/** Zoveel tekens mag de buffer hooguit bevatten als schrijven blijft mislukken; daarboven vallen regels weg (geteld). */
export const MAX_ACHTERSTAND = 16 * 1024 * 1024;

/** Korte, begrijpelijke reden bij een fout van het bestandssysteem. @param {unknown} e */
export function redenVan(e) {
  const code = /** @type {any} */ (e)?.code;
  if (code === 'ENOSPC') return 'de schijf is vol';
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'de map is niet schrijfbaar';
  if (code === 'ENOTDIR') return 'een deel van het pad is geen map';
  if (code === 'ENOENT') return 'de map bestaat niet';
  return /** @type {any} */ (e)?.message ?? String(e);
}

/** Wat Clay eraan kan doen (of '' als we het niet weten). @param {unknown} e */
export function hulpVan(e) {
  const code = /** @type {any} */ (e)?.code;
  if (code === 'ENOSPC') return `maak ruimte vrij; de hub houdt tot ${Math.round(MAX_ACHTERSTAND / 1024 / 1024)} MB vast en schrijft daarna verder`;
  if (['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'ENOENT'].includes(code)) return 'kies een andere map met "avondmap" in config.json';
  return '';
}

export class BufferSchrijver {
  /**
   * klaar: voorbereiden (map maken) en het pad van het bestand geven; mislukt het, dan volgende spoeling opnieuw.
   * @param {{
   *   klaar: () => Promise<string>, bestanden?: Bestanden, klok: Klok, spoelMs?: number, spoelTekens?: number, maxAchterstand?: number,
   *   melding?: (tekst: string, e?: unknown) => void, waar?: string,
   * }} o  waar: de map, voor in de meldingen
   */
  constructor({ klaar, bestanden = echteBestanden, klok, spoelMs = SPOEL_MS, spoelTekens = SPOEL_TEKENS, maxAchterstand = MAX_ACHTERSTAND, melding = () => {}, waar = '' }) {
    this.klaarFn = klaar;
    /** @type {Promise<string>|null} */
    this.klaarBelofte = null;
    /** @type {string|null} */
    this.pad = null;
    this.bestanden = bestanden;
    this.klok = klok;
    this.spoelMs = spoelMs;
    this.spoelTekens = spoelTekens;
    this.maxAchterstand = maxAchterstand;
    this.melding = melding;
    this.waar = waar;
    /** Bytes in het bestand die zeker goed zijn (hele regels). Het bestand is nieuw, dus 0. */
    this.grootte = 0;
    /** Na een mislukte schrijfactie: eerst terug inkorten tot `grootte` (er kan een halve regel staan). */
    this.inkorten = false;
    /** Er kwam een volle buffer bij terwijl er al geschreven werd: na afloop meteen nog een keer. */
    this.opnieuw = false;
    /** @type {string[]} */
    this.buffer = [];
    this.tekens = 0;
    this.regels = 0;
    this.verloren = 0;
    /** @type {any} */ this.timer = null;
    /** @type {Promise<void>|null} */ this.bezig = null;
    this.dicht = false;
    /** @type {string|null} laatste foutmelding (om niet elke seconde hetzelfde te melden) */
    this.fout = null;
    this.verlorenGemeld = false;
  }

  /** Eén regel erbij (zonder '\n'). Keert altijd meteen terug. @param {string} regel */
  schrijf(regel) {
    if (this.dicht) return;
    if (this.tekens + regel.length + 1 > this.maxAchterstand) {
      this.verloren++;
      if (!this.verlorenGemeld) { this.verlorenGemeld = true; this.melding(`opname: achterstand te groot (${this.fout ?? 'schrijven loopt achter'}) — regels vallen weg`); }
      return;
    }
    this.buffer.push(regel + '\n');
    this.tekens += regel.length + 1;
    this.regels++;
    // Hangt er een schrijfactie, dan geen nieuwe `.then` aan dezelfde belofte per regel (dat groeit
    // onbegrensd): één vlag, en #spoel kijkt na afloop zelf of er nog een keer moet.
    if (this.tekens >= this.spoelTekens) { if (this.bezig) this.opnieuw = true; else void this.spoel(); }
    else this.#plan();
  }

  #plan() {
    if (this.timer !== null || this.dicht) return;
    this.timer = this.klok.zet(() => { this.timer = null; void this.spoel(); }, this.spoelMs);
  }

  /** @param {unknown} e */
  #fout(e) {
    const reden = redenVan(e);
    if (this.fout === reden) return;
    this.fout = reden;
    const hulp = hulpVan(e);
    this.melding(`opname: kan niet schrijven${this.waar ? ` in ${this.waar}` : ''} — ${reden}${hulp ? ` — ${hulp}` : ''}`, e);
  }

  /** Map alvast maken (zonder te schrijven), zodat een fout meteen gemeld wordt. Gooit nooit. */
  bereidVoor() {
    return this.#klaar().then(() => {}, (e) => this.#fout(e));
  }

  /** Map/bestand klaarmaken; bij een fout volgende keer opnieuw. */
  async #klaar() {
    if (!this.klaarBelofte) this.klaarBelofte = this.klaarFn();
    try {
      this.pad = await this.klaarBelofte;
      return this.pad;
    } catch (e) {
      this.klaarBelofte = null;
      throw e;
    }
  }

  /** Schrijf de buffer weg (asynchroon, nooit tegelijk twee keer). Gooit nooit. @returns {Promise<void>} */
  spoel() {
    if (this.bezig) return this.bezig.then(() => (this.buffer.length ? this.spoel() : undefined));
    if (!this.buffer.length) return Promise.resolve();
    this.bezig = this.#spoel().finally(() => {
      this.bezig = null;
      if (this.opnieuw) { this.opnieuw = false; if (this.tekens >= this.spoelTekens) void this.spoel(); }
    });
    return this.bezig;
  }

  async #spoel() {
    const deel = this.buffer;
    const tekens = this.tekens;
    this.buffer = [];
    this.tekens = 0;
    /** @type {string|null} */
    let pad = null;
    try {
      pad = await this.#klaar();
      if (this.inkorten) { await this.bestanden.truncate(pad, this.grootte); this.inkorten = false; }
      const tekst = deel.join('');
      await this.bestanden.appendFile(pad, tekst);
      this.grootte += Buffer.byteLength(tekst, 'utf8');
      if (this.fout) { this.melding(`opname: schrijven lukt weer (${pad})`); this.fout = null; this.verlorenGemeld = false; }
    } catch (e) {
      // Een deel kan al in het bestand staan (halve regel): terug naar de laatste goede grootte. Lukt dat nu
      // niet, dan vóór de volgende poging. Het hele blok gaat terug vooraan in de buffer, in dezelfde volgorde.
      if (pad !== null) {
        this.inkorten = true;
        try { await this.bestanden.truncate(pad, this.grootte); this.inkorten = false; } catch { /* volgende keer */ }
      }
      this.buffer = deel.concat(this.buffer);
      this.tekens += tekens;
      this.#fout(e);
      if (!this.dicht) this.#plan();
    }
  }

  /** Laatste spoeling en dicht. Wat dan nog niet geschreven kon worden, telt als verloren. */
  async sluit() {
    if (this.timer !== null) { this.klok.wis(this.timer); this.timer = null; }
    this.dicht = true;
    await this.spoel();
    if (this.buffer.length) {
      this.verloren += this.buffer.length;
      this.buffer = [];
      this.tekens = 0;
    }
    return { pad: this.pad, regels: this.regels, verloren: this.verloren, fout: this.fout };
  }
}
