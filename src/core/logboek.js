// @ts-check
// Logboek in JSON Lines. Regel 1 is de kop; daarna:
//   [ms, "in"|"uit", apparaat, bytes]           ruwe MIDI
//   { ms, e: "gebeurtenis", ...gebeurtenis }    wat de hub ervan maakte (voor golden tests)
//   { ms, e: "stap"|"antwoord"|"bevinding"|"melding", ... }
// ms = milliseconden sinds de start van het logboek.

/** @typedef {import('./klok.js').Klok} Klok */

export class Logboek {
  /** @param {{ schrijf: (regel: string) => void, klok: Klok, kop: Record<string, unknown> }} o */
  constructor({ schrijf, klok, kop }) {
    this.schrijf = schrijf;
    this.klok = klok;
    this.t0 = klok.nu();
    this.schrijf(JSON.stringify({ v: 1, ...kop }));
  }
  ms() { return Math.round((this.klok.nu() - this.t0) * 10) / 10; }
  /** @param {'in'|'uit'} richting @param {string} dev @param {number[]} b */
  midi(richting, dev, b) { this.schrijf(JSON.stringify([this.ms(), richting, dev, b])); }
  /** @param {string} e @param {Record<string, unknown>} data */
  regel(e, data = {}) { this.schrijf(JSON.stringify({ ms: this.ms(), e, ...data })); }
}

/** Lees een logboek terug. @param {string} tekst */
export function leesLogboek(tekst) {
  const regels = tekst.split('\n').filter((r) => r.trim()).map((r) => JSON.parse(r));
  return { kop: regels[0], regels: regels.slice(1) };
}
