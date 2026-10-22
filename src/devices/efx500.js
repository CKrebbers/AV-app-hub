// @ts-check
// Pioneer EFX-500: de puls (PROTOCOL §20). Puur: herkennen op naam (patroon uit config.json) en invoer ontleden.
//
// Wat hij stuurt (handleiding; TE METEN met `node src/cli.js proef efx500`):
//   MIDI-klok (F8, 24 per kwartnoot), 40–250 BPM, geteld uit de audio-ingang of met TAP.
//   Start/Continue/Stop (FA/FB/FC): ONBEKEND of hij die stuurt.
//   Knoppen en draaiknoppen: ONBEKEND of die MIDI sturen. Alles wat geen klok is, komt als 'onbekend' (met de bytes)
//   in het logboek, zodat de proef het ziet.
// Ook hij hangt met MIDI-DIN aan een USB-MIDI-interface: de poortnaam is die van de interface.

/**
 * @typedef {{ dev: 'efx500', el: string|null, kind: 'tik'|'start'|'verder'|'stop'|'onbekend', bytes?: number[] }} Gebeurtenis
 */

export const DEV = 'efx500';
export const NAAM = 'Pioneer EFX-500';
/** Realtime-berichten van de klok. */
export const KLOK = Object.freeze({ tik: 0xf8, start: 0xfa, verder: 0xfb, stop: 0xfc });

/**
 * Het naampatroon van de MIDI-ingang uit config.json (`apparaten.efx500.poort_patroon`), of null zonder die sleutel.
 * @param {any} config
 */
export function patroon(config) {
  const p = config?.apparaten?.efx500?.poort_patroon;
  if (typeof p !== 'string' || !p.trim()) return null;
  try { return new RegExp(p, 'i'); } catch { return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
}

/**
 * Instellingen uit config.json → apparaten.efx500 (met standaarden): `weg_ms` (zo lang geen tik = de klok is weg,
 * standaard 2000), `venster` (intervallen voor het gemiddelde, standaard 96), `stabiel_bpm` (pas een nieuw tempo
 * als het meer dan dit afwijkt, standaard 0,2).
 * @param {any} config
 */
export function instellingen(config) {
  const c = config?.apparaten?.efx500 ?? {};
  const getal = (/** @type {unknown} */ v, /** @type {number} */ s, /** @type {number} */ min, /** @type {number} */ max) => (typeof v === 'number' && v >= min && v <= max ? v : s);
  return {
    wegMs: getal(c.weg_ms, 2000, 100, 60000),
    venster: Math.round(getal(c.venster, 96, 24, 960)),
    stabiel: getal(c.stabiel_bpm, 0.2, 0, 5),
  };
}

/** @param {number[]} b @returns {Gebeurtenis} */
export function ontleed(b) {
  if (b.length === 1 || b[0] >= 0xf8) {
    if (b[0] === KLOK.tik) return { dev: DEV, el: 'klok', kind: 'tik' };
    if (b[0] === KLOK.start) return { dev: DEV, el: 'transport', kind: 'start' };
    if (b[0] === KLOK.verder) return { dev: DEV, el: 'transport', kind: 'verder' };
    if (b[0] === KLOK.stop) return { dev: DEV, el: 'transport', kind: 'stop' };
  }
  return { dev: DEV, el: null, kind: 'onbekend', bytes: [...b] };
}
