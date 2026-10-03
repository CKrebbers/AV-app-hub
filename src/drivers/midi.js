// @ts-check
// MIDI-driver (driver.soort "midi"): voor apps die alleen MIDI verstaan (TouchDesigner via de
// MIDI Device Mapper, Logic → Sediment). De hub opent een virtuele poort en speelt daarop
// precies de CC's en noten die de app verwacht (ONDERZOEK.md §3 punt 7, §7).
//
// driver = { soort:"midi", poort:"VARVE-HUB TD", kanaal?:0,
//            map: { paramId: {cc, kanaal?} | {noot, kanaal?} },
//            scenes?: [{noot, kanaal?} | {cc, kanaal?}] }   // scène i → korte aanslag
import { DriverBasis, scheidStatisch } from './basis.js';

/** @typedef {import('../protocol/types.js').NaarApp} NaarApp @typedef {import('../ports/poort.js').Poort} Poort */
/** @typedef {import('../ports/poort.js').Systeem} Systeem @typedef {import('../core/klok.js').Klok} Klok */
/** @typedef {{ cc?: number, noot?: number, kanaal?: number }} MidiDoel */

/** Hoe lang een scène-aanslag duurt: TD ziet een noot die in hetzelfde frame aan en uit gaat soms niet. */
export const SCENE_MS = 100;

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
  const aan = typeof v === 'boolean' ? v : v >= 0.5;
  if (typeof doel.cc === 'number') {
    const w = soort === 'trigger' || soort === 'schakelaar' ? (aan ? 127 : 0) : Math.round(Math.max(0, Math.min(1, Number(v))) * 127);
    return [0xb0 | k, doel.cc & 0x7f, w];
  }
  if (typeof doel.noot === 'number') return aan ? [0x90 | k, doel.noot & 0x7f, 127] : [0x80 | k, doel.noot & 0x7f, 0];
  return null;
}

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
    /** @type {Map<string, string>} laatst gestuurde bytes per param (dubbele niet opnieuw) */
    this.laatste = new Map();
    /** @type {Set<string>} triggers die nu ingedrukt zijn */
    this.ingedrukt = new Set();
    this.hbTimer = null;
    /** @type {Map<any, number[]>} lopende scène-aanslagen → hun note-off */
    this.sceneTimers = new Map();
    /** @type {number[][]} alles wat de driver verstuurde (ook handig voor diagnose) */
    this.verstuurd = [];
  }

  /** @returns {boolean} poort open? */
  #open() {
    if (this.poort) return true;
    try {
      if (typeof this.systeem?.virtueel !== 'function') throw new Error('MIDI-systeem kan geen virtuele poort maken');
      this.poort = this.systeem.virtueel(this.poortNaam);
      this.log('driver', this.manifest.app, `virtuele poort "${this.poortNaam}" open`);
      return true;
    } catch (e) {
      this.log('driver', this.manifest.app, `poort "${this.poortNaam}" niet te openen:`, /** @type {Error} */ (e).message);
      return false;
    }
  }

  /** @param {number[]} b */
  #stuur(b) {
    if (!this.poort) return;
    try { this.poort.stuur(b); this.verstuurd.push(b); } catch (e) { this.log('driver', this.manifest.app, 'sturen mislukt', /** @type {Error} */ (e).message); }
  }

  /** @param {string} id @param {number|boolean} v */
  #zet(id, v) {
    const doel = this.driver.map?.[id];
    const p = this.params.get(id);
    if (!doel || !p) return;
    const b = midiBytes(doel, p.soort, v, this.kanaal);
    if (!b) return;
    const sleutel = b.join(',');
    if (this.laatste.get(id) === sleutel) return;
    this.laatste.set(id, sleutel);
    if (p.soort === 'trigger') { if (v === true) this.ingedrukt.add(id); else this.ingedrukt.delete(id); }
    this.#stuur(b);
  }

  /** @param {number} i */
  #scene(i) {
    const doel = this.driver.scenes?.[i];
    if (!doel) return;
    const aan = midiBytes(doel, 'trigger', true, this.kanaal);
    const uit = midiBytes(doel, 'trigger', false, this.kanaal);
    if (!aan || !uit) return;
    this.#stuur(aan);
    const h = this.klok.zet(() => { this.sceneTimers.delete(h); this.#stuur(uit); }, SCENE_MS);
    this.sceneTimers.set(h, uit);
  }

  /** @param {NaarApp} b */
  vertaal(b) {
    switch (b.t) {
      case 'zet': return this.#zet(b.id, b.v);
      case 'trig': return this.#zet(b.id, b.aan === true);
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
    this.#open();
    this.koppel(kern);
    this.hbTimer = this.klok.zet(() => this.#tik(), (this.manifest.hb_s ?? 1) * 1000);
  }

  stop() {
    if (this.hbTimer !== null) this.klok.wis(this.hbTimer);
    this.hbTimer = null;
    for (const [h, uit] of this.sceneTimers) { this.klok.wis(h); this.#stuur(uit); }
    this.sceneTimers.clear();
    for (const id of [...this.ingedrukt]) this.#zet(id, false); // niets laten hangen
    this.ontkoppel();
    try { this.poort?.sluit(); } catch { /* al dicht */ }
    this.poort = null;
    this.laatste.clear();
  }
}
