// @ts-check
// De bytes die een echte controller zou sturen, gemaakt uit een Control van src/devices/apc40mk2.js.
// Puur en zonder imports, zodat het in Node te toetsen is.

/** @typedef {{ id: string, soort: string, t: 'note'|'cc', n: number, ch: number }} ControlLike */

/** @param {number} v */
const byte7 = (v) => Math.max(0, Math.min(127, Math.round(v)));

/**
 * Indrukken. Knoppen en pads: note-on velocity 127 op het kanaal van de strip.
 * Footswitch: CC 64 met 127.
 * @param {ControlLike} c
 */
export const drukBytes = (c) => (c.t === 'cc' ? [0xb0 | c.ch, c.n, 127] : [0x90 | c.ch, c.n, 127]);

/**
 * Loslaten. De APC40 mkII stuurt note-off (0x80) met velocity 127; de footswitch CC 64 met 0.
 * @param {ControlLike} c
 */
export const losBytes = (c) => (c.t === 'cc' ? [0xb0 | c.ch, c.n, 0] : [0x80 | c.ch, c.n, 127]);

/** Absolute CC (faders, ringknoppen) voor een waarde 0..1. @param {ControlLike} c @param {number} v */
export const ccBytes = (c, v) => [0xb0 | c.ch, c.n, byte7(v * 127)];

/**
 * Relatieve CC (tempo, cue) in two's complement: +1..+63 → 1..63, −1..−64 → 127..64.
 * @param {ControlLike} c @param {number} delta geheel getal, wordt op −64..63 geklemd
 */
export function relBytes(c, delta) {
  const d = Math.max(-64, Math.min(63, Math.trunc(delta)));
  return [0xb0 | c.ch, c.n, d < 0 ? 128 + d : d];
}

/** Waarde 0..1 uit een CC-byte. @param {number} raw */
export const vanCC = (raw) => byte7(raw) / 127;

// LPD8 (mk2-fabrieksstand): pads note 36-43, knoppen CC 70-77, kanaal 10 (0x_9).
export const LPD8 = Object.freeze({ kanaal: 9, padNoot: 36, knopCC: 70 });

/** @param {number} i 0..7 @param {number} [velocity] */
export const lpdDruk = (i, velocity = 127) => [0x90 | LPD8.kanaal, LPD8.padNoot + i, byte7(Math.max(1, velocity))];
/** @param {number} i 0..7 */
export const lpdLos = (i) => [0x80 | LPD8.kanaal, LPD8.padNoot + i, 0];
/** @param {number} i 0..7 @param {number} v 0..1 */
export const lpdKnop = (i, v) => [0xb0 | LPD8.kanaal, LPD8.knopCC + i, byte7(v * 127)];

/**
 * Pulsduur in seconden voor een APC-animatiesnelheid (0..4 = 1/24, 1/16, 1/8, 1/4, 1/2 noot).
 * @param {number|undefined} snelheid @param {number} [bpm]
 */
export function animDuur(snelheid, bpm = 120) {
  const deel = [1 / 24, 1 / 16, 1 / 8, 1 / 4, 1 / 2][Math.max(0, Math.min(4, snelheid ?? 3))];
  const b = Number.isFinite(bpm) && bpm > 20 ? bpm : 120;
  return deel * 4 * (60 / b);
}
