// @ts-check
// Schrijven zonder ooit te blokkeren: regels gaan eerst in een buffer in het geheugen en worden met een
// timer (via de geïnjecteerde Klok) of bij een volle buffer asynchroon aan het bestand toegevoegd.
// Een schijf die vol is of een map die niet schrijfbaar is, geeft een melding — nooit een exceptie in de
// kern of de hub. Lukt schrijven later weer, dan gaat de achterstand er alsnog in (volgorde blijft goed).
import { promises as fsp } from 'node:fs';

/** @typedef {import('../core/klok.js').Klok} Klok */
/**
 * Wat de opname van het bestandssysteem nodig heeft (injecteerbaar voor tests).
 * @typedef {{
 *   mkdir: (pad: string, o?: { recursive?: boolean }) => Promise<unknown>,
 *   appendFile: (pad: string, tekst: string) => Promise<void>,
 *   writeFile: (pad: string, tekst: string) => Promise<void>,
 * }} Bestanden
 */

/** @type {Bestanden} */
export const echteBestanden = {
  mkdir: (pad, o) => fsp.mkdir(pad, o),
  appendFile: (pad, tekst) => fsp.appendFile(pad, tekst, 'utf8'),
  writeFile: (pad, tekst) => fsp.writeFile(pad, tekst, 'utf8'),
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

export class BufferSchrijver {
  /**
   * klaar: voorbereiden (map maken) en het pad van het bestand geven; mislukt het, dan volgende spoeling opnieuw.
   * @param {{
   *   klaar: () => Promise<string>, bestanden?: Bestanden, klok: Klok, spoelMs?: number, spoelTekens?: number, maxAchterstand?: number,
   *   melding?: (tekst: string, e?: unknown) => void,
   * }} o
   */
  constructor({ klaar, bestanden = echteBestanden, klok, spoelMs = SPOEL_MS, spoelTekens = SPOEL_TEKENS, maxAchterstand = MAX_ACHTERSTAND, melding = () => {} }) {
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
    if (this.tekens >= this.spoelTekens) void this.spoel();
    else this.#plan();
  }

  #plan() {
    if (this.timer !== null || this.dicht) return;
    this.timer = this.klok.zet(() => { this.timer = null; void this.spoel(); }, this.spoelMs);
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
    this.bezig = this.#spoel().finally(() => { this.bezig = null; });
    return this.bezig;
  }

  async #spoel() {
    const deel = this.buffer;
    const tekens = this.tekens;
    this.buffer = [];
    this.tekens = 0;
    try {
      const pad = await this.#klaar();
      await this.bestanden.appendFile(pad, deel.join(''));
      if (this.fout) { this.melding(`opname: schrijven lukt weer (${pad})`); this.fout = null; this.verlorenGemeld = false; }
    } catch (e) {
      // Terug vooraan in de buffer: volgende keer opnieuw, in dezelfde volgorde.
      this.buffer = deel.concat(this.buffer);
      this.tekens += tekens;
      const reden = redenVan(e);
      if (this.fout !== reden) { this.fout = reden; this.melding(`opname: schrijven mislukt — ${reden}`, e); }
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
