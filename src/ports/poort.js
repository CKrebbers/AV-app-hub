// @ts-check
// De poortlaag: alles wat de hub van MIDI weet, loopt via deze twee vormen.
// Zo kan alles boven deze laag getest worden met nep.js, zonder hardware.

/**
 * Een duplex-verbinding met één apparaat (ingang + uitgang met dezelfde naam).
 * `stuur` mag gooien (apparaat weg, poort kapot); de hub vangt dat af en opent de poort opnieuw (golf 8).
 * `levend` is optioneel: false = deze poort is stuk of het apparaat erachter is weg (ook als er alweer een apparaat
 * met dezelfde naam is). De hotplug-ronde opent hem dan opnieuw. Weet een poort het niet (RtMidi), dan ontbreekt hij.
 * @typedef {{
 *   naam: string,
 *   stuur: (bytes: number[]) => void,
 *   bijBericht: (fn: (bytes: number[]) => void) => () => void,
 *   sluit: () => void,
 *   levend?: () => boolean,
 * }} Poort
 */

/**
 * Het MIDI-systeem van de machine: poorten opsommen en openen.
 * @typedef {{
 *   soort: string,
 *   lijst: () => { ingangen: string[], uitgangen: string[] },
 *   open: (naam: string) => Poort,
 *   virtueel?: (naam: string) => Poort,
 * }} Systeem
 */

/**
 * Zoek een poortnaam die op het patroon past en zowel als ingang als uitgang bestaat.
 * Virtuele/doorgeefpoorten (IAC, through, de hub zelf) worden overgeslagen.
 * @param {{ ingangen: string[], uitgangen: string[] }} l
 * @param {RegExp} patroon
 */
export function zoekNaam(l, patroon) {
  const nep = /iac|through|virtual|varve-hub/i;
  return l.ingangen.find((n) => patroon.test(n) && !nep.test(n) && l.uitgangen.some((u) => kern(u) === kern(n))) ?? null;
}
/** Linux/ALSA zet er "MIDI 1 20:0" achter; vergelijk op de kern van de naam. @param {string} n */
export const kern = (n) => n.replace(/\s+\d+:\d+$/, '').trim();
