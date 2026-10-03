// @ts-check
// LedStaat (src/devices/apc40mk2.js) → wat de virtuele APC toont. Puur: palet en bpm komen binnen,
// zodat dit in Node te toetsen is. Volgt dezelfde betekenis als ledBerichten():
//   rgb zonder kleur2: animatie van `kleur` tegen zwart.
//   rgb met kleur2:    basis `kleur` op kanaal 0, animatie met `kleur2` erover.

import { animDuur } from './midi.js';

/** @typedef {import('../src/devices/apc40mk2.js').LedStaat} LedStaat */
/**
 * @typedef {{ aan: boolean, kleur: string|null, kleur2: string|null,
 *             anim: 'puls'|'knipper'|'oneshot'|null, duur: number, ring: number|null, stand: number }} Weergave
 */

/** Vaste kleuren voor eenkleurige LEDs per soort knop. */
export const LED_KLEUR = Object.freeze({
  rec: '#ff4040', solo: '#4c8dff', act: '#ff7a2a', sel: '#e6b04a', stop: '#3ecf8e',
  ab1: '#e6c84a', ab2: '#ff8a1e', standaard: '#e6b04a',
});

/** @param {string} id */
const prefix = (id) => (id.match(/^[a-z]+/) || [''])[0];

/**
 * @param {{ id: string, led: string }} c control uit CONTROLS
 * @param {LedStaat|undefined|null} s
 * @param {readonly string[]} palet PALET uit apc40mk2.js
 * @param {number} [bpm]
 * @returns {Weergave}
 */
export function weergave(c, s, palet, bpm = 120) {
  /** @type {Weergave} */
  const w = { aan: false, kleur: null, kleur2: null, anim: null, duur: 0, ring: null, stand: 0 };
  if (!s) return w;
  const kleurVan = (/** @type {number|undefined} */ i) => {
    const n = Math.max(0, Math.min(127, Math.round(i ?? 0)));
    return n ? palet[n] : null;
  };
  switch (c.led) {
    case 'rgb': {
      if (s.anim) {
        const heeft2 = s.anim.kleur2 !== undefined;
        w.kleur = heeft2 ? kleurVan(s.kleur) : null; // achtergrond
        w.kleur2 = heeft2 ? kleurVan(s.anim.kleur2) : kleurVan(s.kleur); // wat animeert
        w.anim = s.anim.soort === 'puls' || s.anim.soort === 'knipper' || s.anim.soort === 'oneshot' ? s.anim.soort : 'puls';
        w.duur = animDuur(s.anim.snelheid, bpm);
        w.aan = !!(w.kleur || w.kleur2);
      } else {
        w.kleur = kleurVan(s.kleur);
        w.aan = !!w.kleur;
      }
      return w;
    }
    case 'aan': {
      w.aan = !!s.aan;
      w.kleur = w.aan ? (LED_KLEUR[/** @type {keyof typeof LED_KLEUR} */ (prefix(c.id))] ?? LED_KLEUR.standaard) : null;
      return w;
    }
    case 'clipstop': {
      w.aan = !!(s.aan || s.knipper);
      w.kleur = w.aan ? LED_KLEUR.stop : null;
      if (s.knipper) { w.anim = 'knipper'; w.kleur2 = LED_KLEUR.stop; w.kleur = null; w.duur = animDuur(2, bpm); } // 0x34: knippert op 1/8 (protocol)
      return w;
    }
    case 'ab': {
      w.stand = typeof s.stand === 'number' && Number.isFinite(s.stand) ? s.stand : 0;
      w.aan = w.stand > 0;
      w.kleur = w.stand === 1 ? LED_KLEUR.ab1 : w.stand >= 2 ? LED_KLEUR.ab2 : null;
      return w;
    }
    case 'ring': {
      w.ring = typeof s.waarde === 'number' && Number.isFinite(s.waarde) ? Math.max(0, Math.min(1, s.waarde)) : 0;
      w.aan = true;
      return w;
    }
    default:
      return w;
  }
}
