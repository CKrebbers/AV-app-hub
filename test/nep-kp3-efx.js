// Nep-KP3+ en nep-EFX-500 achter een nep-USB-MIDI-interface (twee ingangen), en wat een mens doet bij elke vraag van
// de proeven kp3plus en efx500 (src/proef/kp3-efx.js). Geen hardware nodig.
import { KLOK_TIKKEN } from '../src/proef/kp3-efx.js';

export const KP3_POORT = 'USB MIDI Interface MIDI 1';
export const EFX_POORT = 'USB MIDI Interface MIDI 2';
/** config.json zoals Clay hem zet voor deze interface. @param {any} config */
export const metInterface = (config) => ({ ...config, apparaten: { ...config.apparaten, kp3plus: { ...config.apparaten?.kp3plus, poort_patroon: 'interface midi 1' }, efx500: { ...config.apparaten?.efx500, poort_patroon: 'interface midi 2' } } });

/** @typedef {{ x?: number, y?: number, aanraak?: number|null, diepte?: number, hold?: number, kanaal?: number }} Kp3Gedrag  kanaal 1..16 */

const later = (fn, ms = 1) => setTimeout(fn, ms);

/**
 * De KP3+: wat hij stuurt als Clay doet wat de proef vraagt.
 * @param {any} w verwacht-melding @param {import('../src/ports/nep.js').NepPoort} p @param {Kp3Gedrag} [o]
 */
export function kp3Doet(w, p, { x = 12, y = 13, aanraak = 92, diepte = 94, hold = 95, kanaal = 11 } = {}) {
  if (w.soort !== 'eerste') return;
  const cc = (/** @type {number} */ n, /** @type {number} */ v) => [0xb0 | (kanaal - 1), n, v];
  const raak = (/** @type {boolean} */ aan) => (aanraak === null ? [] : [cc(aanraak, aan ? 127 : 0)]);
  const veeg = (/** @type {number} */ as, /** @type {number} */ ander) => [
    ...raak(true), ...Array.from({ length: 17 }, (_, i) => [cc(as, Math.min(127, i * 8)), cc(ander, 60 + (i % 3))]).flat(), ...raak(false),
  ];
  /** @type {number[][]} */
  let b = [];
  if (w.wat === 'x') b = veeg(x, y);
  else if (w.wat === 'y') b = veeg(y, x);
  else if (w.wat === 'aanraak') b = [0, 1, 2].flatMap(() => [...raak(true), cc(x, 64), cc(y, 64), ...raak(false)]);
  else if (w.wat === 'programma') b = [[0xc0 | (kanaal - 1), 9 + w.nr]];
  else if (w.wat === 'diepte') b = [0, 32, 64, 96, 127, 64, 0].map((v) => cc(diepte, v));
  else if (w.wat === 'hold') b = [cc(hold, 127), cc(hold, 0)];
  later(() => { for (const x of b) p.injecteer(x); });
}

/**
 * Kloktikken op een tempo, op vaste tijdstippen (niet telkens d ms ná de vorige: dan loopt het uit).
 * @param {import('../src/ports/nep.js').NepPoort} p @param {number} bpm @param {number} n
 */
export function tikken(p, bpm, n) {
  const d = 60000 / (24 * bpm);
  const t0 = performance.now() + 5;
  let i = 0;
  const volgende = () => {
    if (i >= n) return;
    p.injecteer([0xf8]);
    i++;
    setTimeout(volgende, Math.max(0, t0 + i * d - performance.now()));
  };
  setTimeout(volgende, 5);
}

/**
 * De EFX-500: klok op 250 BPM (elke 10 ms, zo kort mogelijk voor een test), na de tempowissel 200 BPM, zonder muziek
 * niets, en bij de knoppen een start, een CC en een stop.
 * @param {any} w @param {import('../src/ports/nep.js').NepPoort} p
 */
export function efxDoet(w, p) {
  if (w.soort === 'eerste' && w.wat === 'klok') return tikken(p, 250, KLOK_TIKKEN);
  if (w.soort === 'eerste' && w.wat === 'wissel') return tikken(p, 200, KLOK_TIKKEN);
  if (w.soort === 'knoppen') later(() => { for (const b of [[0xfa], [0xb0, 20, 64], [0xfc]]) p.injecteer(b); }, 5);
}
