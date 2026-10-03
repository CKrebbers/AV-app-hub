// @ts-check
// MIDI-driver (driver.soort "midi"): voor apps die alleen MIDI verstaan (TouchDesigner via de
// MIDI Device Mapper, Logic → Sediment). De hub opent een virtuele poort en speelt daarop
// precies de CC's en noten die de app verwacht (ONDERZOEK.md §3 punt 7, §7).
//
// driver = { soort:"midi", poort:"VARVE-HUB TD", kanaal?:0,
//            map: { paramId: {cc, kanaal?} | {noot, kanaal?} },
//            scenes?: [{noot, kanaal?} | {cc, kanaal?}],                // scène i → korte aanslag
//            presets?: [{noot, kanaal?, waarden: { paramId: 0..1 }}] }   // wat de app zelf zet bij die noot
import { DriverBasis, scheidStatisch, bewaarBegrensd } from './basis.js';
import { klem01 } from '../protocol/berichten.js';

/** @typedef {import('../protocol/types.js').NaarApp} NaarApp @typedef {import('../ports/poort.js').Poort} Poort */
/** @typedef {import('../ports/poort.js').Systeem} Systeem @typedef {import('../core/klok.js').Klok} Klok */
/** @typedef {{ cc?: number, noot?: number, kanaal?: number }} MidiDoel */

/** Hoe lang een scène-aanslag duurt: TD ziet een noot die in hetzelfde frame aan en uit gaat soms niet. */
export const SCENE_MS = 100;
/** Bronnen die altijd door de dubbelfilter gaan: de app moet dan alles (opnieuw) krijgen. */
export const ALTIJD_STUREN = new Set(['replay', 'snapshot']);

/**
 * De MIDI-bytes voor een waarde of trigger. Puur, voor driver en tests.
 * @param {MidiDoel} doel
 * @param {'waarde'|'schakelaar'|'trigger'|'keuze'} soort
 * @param {number|boolean} v  0..1 voor waarden, boolean (aan) voor triggers
 * @param {number} standaardKanaal
 * @returns {number[]|null}
 */
export function midiBytes(doel, soort, v, standaardKanaal = 0) {
  const k = (doel.kanaal ?? standaardKanaal) & 0x0f;
  const aan = typeof v === 'boolean' ? v : klem01(v) >= 0.5;
  if (typeof doel.cc === 'number') {
    const w = soort === 'trigger' || soort === 'schakelaar' ? (aan ? 127 : 0) : Math.round(klem01(Number(v)) * 127);
    return [0xb0 | k, doel.cc & 0x7f, w];
  }
  if (typeof doel.noot === 'number') return aan ? [0x90 | k, doel.noot & 0x7f, 127] : [0x80 | k, doel.noot & 0x7f, 0];
  return null;
}

/** Sleutel van een MIDI-adres (zelfde noot = zelfde sleutel, of hij nu van een pad of een scène komt). */
const adres = (/** @type {MidiDoel} */ d, /** @type {number} */ kanaal) => `${typeof d.cc === 'number' ? 'cc' : 'n'}${d.cc ?? d.noot}@${d.kanaal ?? kanaal}`;

export class MidiDriver extends DriverBasis {
  /**
   * @param {Record<string, any>} statisch
   * @param {{ systeem: Systeem, klok: Klok, config?: any, log?: (...a: unknown[]) => void }} o
   */
  constructor(statisch, { systeem, klok, config, log }) {
    const { manifest, driver } = scheidStatisch(statisch);
    super({ manifest, klok, log });
    this.driver = driver;
    this.systeem = systeem;
    /** config.json wint (huisregel 6); het statische manifest is de terugval. */
    this.poortNaam = config?.apps?.[manifest.app]?.midipoort ?? driver.poort;
    this.kanaal = driver.kanaal ?? 0;
    /** @type {Map<string, any>} */
    this.params = new Map((manifest.params ?? []).map((/** @type {any} */ p) => [p.id, p]));
    /** @type {Poort|null} */
    this.poort = null;
    /** @type {Map<string, string>} laatst écht verstuurde bytes per waarde-param (dubbele niet opnieuw) */
    this.laatste = new Map();
    /** @type {Map<string, string>} triggers die nu ingedrukt zijn → hun MIDI-adres */
    this.ingedrukt = new Map();
    /** @type {Map<string, number[]>} MIDI-adressen die nu 'aan' staan → hun note-off */
    this.klinkt = new Map();
    /** @type {Map<string, any>} lopende scène-aanslagen per MIDI-adres → klok-handle van hun note-off */
    this.sceneTimers = new Map();
    /** @type {any[]} uitgestelde 'zet'-meldingen aan de kern (presets) */
    this.meldTimers = [];
    this.hbTimer = null;
    /** laatste foutmelding bij openen (alleen loggen als die verandert) */
    this.openFout = /** @type {string|null} */ (null);
    /** @type {number[][]} de laatste VERSTUURD_MAX berichten die de driver verstuurde (diagnose/tests) */
    this.verstuurd = [];
  }

  /** @returns {boolean} poort open? */
  #open() {
    if (this.poort) return true;
    try {
      if (typeof this.systeem?.virtueel !== 'function') throw new Error('MIDI-systeem kan geen virtuele poort maken');
      this.poort = this.systeem.virtueel(this.poortNaam);
      this.openFout = null;
      this.log('driver', this.manifest.app, `virtuele poort "${this.poortNaam}" open`);
      return true;
    } catch (e) {
      const m = /** @type {Error} */ (e).message;
      if (m !== this.openFout) this.log('driver', this.manifest.app, `poort "${this.poortNaam}" niet te openen:`, m);
      this.openFout = m;
      return false;
    }
  }

  /** @param {number[]} b @returns {boolean} echt verstuurd? */
  #stuur(b) {
    if (!this.poort) return false;
    try { this.poort.stuur(b); bewaarBegrensd(this.verstuurd, b); return true; } catch (e) { this.log('driver', this.manifest.app, 'sturen mislukt', /** @type {Error} */ (e).message); return false; }
  }

  /** Een nieuwe hallo = voor de kern een herstart: daarna moet alles opnieuw over de draad. */
  aanmelden() {
    this.laatste.clear();
    super.aanmelden();
  }

  /** Laat de kern alles opnieuw afspelen (bijv. na een herstart van TD of Logic). */
  opnieuw() { if (this.kern) this.aanmelden(); }

  /** Waarde, keuze of schakelaar. @param {string} id @param {number} v @param {string|undefined} bron */
  #zet(id, v, bron) {
    const doel = this.driver.map?.[id];
    const p = this.params.get(id);
    if (!doel || !p || !Number.isFinite(v)) return;
    if (p.soort === 'trigger') return this.#trig(id, v >= 0.5);
    const b = midiBytes(doel, p.soort, v, this.kanaal);
    if (!b) return;
    const sleutel = b.join(',');
    if (!ALTIJD_STUREN.has(/** @type {string} */ (bron)) && this.laatste.get(id) === sleutel) return;
    if (this.#stuur(b)) this.laatste.set(id, sleutel);
  }

  /** Zet een MIDI-adres aan. Staat het al aan, eerst uit: de app moet een echte overgang uit → aan zien. @param {MidiDoel} doel @returns {string|null} */
  #aan(doel) {
    const aan = midiBytes(doel, 'trigger', true, this.kanaal);
    const uit = midiBytes(doel, 'trigger', false, this.kanaal);
    if (!aan || !uit) return null;
    const a = adres(doel, this.kanaal);
    this.#wisScene(a);
    if (this.klinkt.has(a)) { this.#stuur(uit); this.klinkt.delete(a); }
    if (!this.#stuur(aan)) return null;
    this.klinkt.set(a, uit);
    this.#meldPreset(doel);
    return a;
  }

  /** @param {string} a */
  #uit(a) {
    this.#wisScene(a);
    const uit = this.klinkt.get(a);
    if (!uit) return;
    this.klinkt.delete(a);
    this.#stuur(uit);
  }

  /** @param {string} a */
  #wisScene(a) {
    const h = this.sceneTimers.get(a);
    if (h === undefined) return;
    this.klok.wis(h);
    this.sceneTimers.delete(a);
  }

  /** @param {string} id @param {boolean} aan */
  #trig(id, aan) {
    const doel = this.driver.map?.[id];
    if (!doel || !this.params.has(id)) return;
    if (aan) {
      const a = this.#aan(doel);
      if (a) this.ingedrukt.set(id, a); else this.ingedrukt.delete(id);
      return;
    }
    const a = this.ingedrukt.get(id);
    if (a === undefined) return;
    this.ingedrukt.delete(id);
    this.#uit(a);
  }

  /** @param {number} i */
  #scene(i) {
    const doel = this.driver.scenes?.[i];
    if (!doel) return;
    const a = this.#aan(doel);
    if (!a) return;
    for (const [id, x] of this.ingedrukt) if (x === a) this.ingedrukt.delete(id); // de scène neemt de noot over
    this.sceneTimers.set(a, this.klok.zet(() => { this.sceneTimers.delete(a); this.#uit(a); }, SCENE_MS));
  }

  /**
   * De app zet bij deze noot zelf waarden (TD: een preset zet alle acht knoppen). Meld dat aan de kern
   * als 'zet' (de app veranderde zelf), zodat waarden, ringen en pickup de app volgen. Uitgesteld via
   * de klok: we zitten nu midden in een bericht van de kern.
   * @param {MidiDoel} doel
   */
  #meldPreset(doel) {
    const a = adres(doel, this.kanaal);
    const preset = (this.driver.presets ?? []).find((/** @type {any} */ p) => adres(p, this.kanaal) === a);
    if (!preset?.waarden) return;
    const h = this.klok.zet(() => {
      this.meldTimers = this.meldTimers.filter((x) => x !== h);
      if (!this.kern) return;
      for (const [id, v] of Object.entries(preset.waarden)) {
        const p = this.params.get(id), d = this.driver.map?.[id];
        if (!p || !d || !Number.isFinite(v)) continue;
        const b = midiBytes(d, p.soort, v, this.kanaal);
        if (b) this.laatste.set(id, b.join(','));
        this.kern.ontvang(this.verbinding, { t: 'zet', id, v: klem01(v) });
      }
    }, 0);
    this.meldTimers.push(h);
  }

  /** @param {NaarApp} b */
  vertaal(b) {
    switch (b.t) {
      case 'zet': return this.#zet(b.id, b.v, b.bron);
      case 'trig': return this.#trig(b.id, b.aan === true);
      case 'scene': return this.#scene(b.i);
      default: return; // welkom, focus, globaal, midi, fout: niets voor een MIDI-app
    }
  }

  #tik() {
    const was = !!this.poort;
    if (this.#open()) {
      if (!was) this.aanmelden(); // poort kwam later: opnieuw aanmelden zodat de kern opnieuw afspeelt
      this.hartslag();
    }
    this.hbTimer = this.klok.zet(() => this.#tik(), (this.manifest.hb_s ?? 1) * 1000);
  }

  /** @param {import('./basis.js').KernVoorDriver} kern */
  start(kern) {
    if (this.hbTimer !== null || this.kern) return; // loopt al: geen tweede timerketen
    this.#open();
    this.koppel(kern);
    this.hbTimer = this.klok.zet(() => this.#tik(), (this.manifest.hb_s ?? 1) * 1000);
  }

  stop() {
    if (this.hbTimer !== null) this.klok.wis(this.hbTimer);
    this.hbTimer = null;
    for (const h of this.meldTimers) this.klok.wis(h);
    this.meldTimers = [];
    for (const a of [...this.klinkt.keys()]) this.#uit(a); // niets laten hangen
    for (const h of this.sceneTimers.values()) this.klok.wis(h);
    this.sceneTimers.clear();
    this.ingedrukt.clear();
    this.ontkoppel();
    try { this.poort?.sluit(); } catch { /* al dicht */ }
    this.poort = null;
    this.laatste.clear();
  }
}
