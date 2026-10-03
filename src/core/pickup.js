// @ts-check
// Soft-takeover voor potmeters (faders, LPD8-knoppen, ringknoppen zonder overname). Puur.
// "pickup": een control neemt pas over als zijn fysieke stand de doelwaarde kruist of er
// binnen MARGE van komt. Daarvoor springt er niets. "direct": altijd meteen. "schaal": de
// waarde loopt evenredig mee tot fysiek en doel elkaar raken (geen sprong, geen dode zone).

/** @typedef {'pickup'|'direct'|'schaal'} Modus
 *  @typedef {{ modus: Modus, doel: number, fysiek: number|null, gevangen: boolean }} Pickup */

export const MARGE = 0.02;

const dichtbij = (/** @type {number|null} */ a, /** @type {number} */ b) => a !== null && Math.abs(a - b) <= MARGE;
const klem = (/** @type {number} */ v) => Math.max(0, Math.min(1, v));

/**
 * Nieuwe pickup. Is de fysieke stand al bekend en dichtbij het doel, dan is hij meteen gevangen.
 * @param {number} doel @param {number|null} [fysiek] @param {Modus} [modus]
 * @returns {Pickup}
 */
export function nieuwePickup(doel, fysiek = null, modus = 'pickup') {
  return { modus, doel, fysiek, gevangen: modus === 'direct' || dichtbij(fysiek, doel) };
}

/**
 * De control bewoog naar v. `uit` is de waarde die naar de app moet, of null (nog niet gevangen).
 * @param {Pickup} p @param {number} v
 * @returns {{ p: Pickup, uit: number|null }}
 */
export function beweeg(p, v) {
  const vorige = p.fysiek;
  if (p.modus === 'direct' || p.gevangen) return { p: { ...p, doel: v, fysiek: v, gevangen: true }, uit: v };
  if (dichtbij(v, p.doel) || (vorige !== null && (vorige - p.doel) * (v - p.doel) < 0)) {
    return { p: { ...p, doel: v, fysiek: v, gevangen: true }, uit: v };
  }
  if (p.modus === 'schaal' && vorige !== null && v !== vorige) {
    // Evenredig: de resterende afstand tot de rand wordt in dezelfde verhouding afgelegd.
    const d = v - vorige;
    const uit = klem(d > 0 ? (vorige >= 1 ? p.doel : p.doel + (d * (1 - p.doel)) / (1 - vorige))
      : (vorige <= 0 ? p.doel : p.doel + (d * p.doel) / vorige));
    return { p: { ...p, doel: uit, fysiek: v, gevangen: dichtbij(v, uit) }, uit };
  }
  return { p: { ...p, fysiek: v }, uit: null };
}

/**
 * Het doel veranderde van buitenaf (app, snapshot, cockpit, LPD8-macro). De control moet weer
 * "wachten", tenzij hij er fysiek al dichtbij staat.
 * @param {Pickup} p @param {number} doel
 * @returns {Pickup}
 */
export function zetDoel(p, doel) {
  return { ...p, doel, gevangen: p.modus === 'direct' || dichtbij(p.fysiek, doel) };
}

/**
 * De control bewoog zonder dat de waarde door mocht (bv. terwijl de hubtoets is ingedrukt).
 * @param {Pickup} p @param {number} v
 * @returns {Pickup}
 */
export function volg(p, v) {
  return { ...p, fysiek: v, gevangen: p.modus === 'direct' || dichtbij(v, p.doel) };
}
