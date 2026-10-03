// @ts-check
// Lineair verlopen van een waarde over een vaste tijd (slew_s uit het manifest). Puur:
// de kern roept `slewWaarde` aan op zijn eigen klok-tik (~33 ms).

/** @typedef {{ van: number, naar: number, start: number, duurMs: number }} Slew */

export const SLEW_TIK_MS = 33;

/** @param {number} van @param {number} naar @param {number} start ms @param {number} duurS */
export const maakSlew = (van, naar, start, duurS) => ({ van, naar, start, duurMs: Math.max(0, duurS * 1000) });

/** Waarde op tijdstip nu. @param {Slew} s @param {number} nu */
export function slewWaarde(s, nu) {
  if (s.duurMs <= 0) return s.naar;
  const f = Math.max(0, Math.min(1, (nu - s.start) / s.duurMs));
  return s.van + (s.naar - s.van) * f;
}

/** @param {Slew} s @param {number} nu */
export const slewKlaar = (s, nu) => nu - s.start >= s.duurMs;
