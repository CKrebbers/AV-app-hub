// @ts-check
// Waar elke control van de APC40 mkII op het paneel staat, in eenheden (--u).
// Afgeleid van av-kern src/ui/virtual.ts + src/kern/apc40.ts, maar met ONZE ids
// (src/devices/apc40mk2.js): `left` (note 97) staat links, `right` (note 96) rechts.
// Alleen plaatsing en korte opschriften — MIDI-nummers komen uit apc40mk2.js, nooit hier.
// Geen imports, zodat dit ook in Node te toetsen is.

/** @typedef {{ x: number, y: number, w: number, h: number, kort: string }} Plek */

export const BREEDTE = 15.5;
export const HOOGTE = 10.9;

const OX = 0.2, OY = 0.5;
/** Rechterdeel (transport, device control). */
const X = 10.6;

/** @type {Record<string, Plek>} */
export const INDELING = {};
/** @param {string} id @param {number} x @param {number} y @param {number} w @param {number} h @param {string} kort */
const P = (id, x, y, w, h, kort) => { INDELING[id] = { x: x + OX, y: y + OY, w, h, kort }; };

for (let i = 0; i < 8; i++) P(`tk${i + 1}`, i * 1.1 + 0.05, 0, 0.9, 0.9, `${i + 1}`);
// Grid: rij 5 bovenaan, rij 1 onderaan.
for (let r = 5; r >= 1; r--) for (let c = 1; c <= 8; c++) P(`pad${r}-${c}`, (c - 1) * 1.1, 1.2 + (5 - r) * 0.75, 1, 0.65, `${r}·${c}`);
for (let r = 5; r >= 1; r--) P(`scene${r}`, 9, 1.2 + (5 - r) * 0.75 + 0.05, 0.8, 0.55, `${r}`);
for (let c = 1; c <= 8; c++) {
  const x = (c - 1) * 1.1;
  P(`stop${c}`, x, 5.05, 1, 0.38, '■');
  P(`sel${c}`, x, 5.5, 1, 0.38, `${c}`);
  P(`act${c}`, x, 5.95, 0.48, 0.38, `${c}`);
  P(`ab${c}`, x + 0.52, 5.95, 0.48, 0.38, 'A|B');
  P(`solo${c}`, x, 6.4, 0.48, 0.38, 'S');
  P(`rec${c}`, x + 0.52, 6.4, 0.48, 0.38, '●');
  P(`fader${c}`, x + 0.15, 7.1, 0.7, 2.8, `${c}`);
}
P('stopall', 9, 5.05, 0.8, 0.38, 'stop all');
P('mastersel', 9, 5.5, 0.8, 0.38, 'master');
P('cue', 9, 5.95, 0.8, 0.8, 'cue');
P('master', 9.05, 7.1, 0.7, 2.8, 'M');

P('pan', X, 0, 0.9, 0.4, 'pan');
P('sends', X, 0.55, 0.9, 0.4, 'sends');
P('user', X, 1.1, 0.9, 0.4, 'user');
P('play', X + 1.1, 0, 1, 0.4, 'play');
P('record', X + 2.2, 0, 1, 0.4, 'record');
P('session', X + 3.3, 0, 1, 0.4, 'session');
P('metro', X + 1.1, 0.7, 1, 0.4, 'metro');
P('tap', X + 2.2, 0.7, 1, 0.4, 'tap');
P('tempo', X + 3.4, 0.55, 0.8, 0.8, 'tempo');
P('nudgeM', X + 1.1, 1.3, 1, 0.4, 'nudge −');
P('nudgeP', X + 2.2, 1.3, 1, 0.4, 'nudge +');
for (let i = 0; i < 8; i++) P(`dk${i + 1}`, X + (i % 4) * 1.1, 2.1 + Math.floor(i / 4) * 1.1, 0.9, 0.9, `${i + 1}`);
P('devL', X, 4.35, 1, 0.38, '◄ dev');
P('devR', X + 1.1, 4.35, 1, 0.38, 'dev ►');
P('bankL', X + 2.2, 4.35, 1, 0.38, '◄ bank');
P('bankR', X + 3.3, 4.35, 1, 0.38, 'bank ►');
P('devOn', X, 4.8, 1, 0.38, 'on/off');
P('lock', X + 1.1, 4.8, 1, 0.38, 'lock');
P('clipdev', X + 2.2, 4.8, 1, 0.38, 'clip/dev');
P('detail', X + 3.3, 4.8, 1, 0.38, 'detail');
P('up', X + 0.55, 5.4, 0.5, 0.35, '▲');
P('left', X, 5.8, 0.5, 0.35, '◄');
P('right', X + 1.1, 5.8, 0.5, 0.35, '►');
P('down', X + 0.55, 6.2, 0.5, 0.35, '▼');
P('shift', X + 2.2, 5.6, 1, 0.4, 'shift');
P('bank', X + 3.3, 5.6, 1, 0.4, 'bank');
P('voet', X + 3.3, 6.15, 1, 0.38, 'voet');
P('xf', X + 1.4, 6.95, 3, 0.5, 'crossfader A — B');

/** Opschriften op het paneel: [tekst, x, y]. */
export const OPSCHRIFTEN = /** @type {[string, number, number][]} */ ([
  ['track-knoppen', 0 + OX, -0.38 + OY],
  ['scene', 9 + OX, 0.85 + OY],
  ['device control', X + 1.1 + OX, 1.78 + OY],
]);
