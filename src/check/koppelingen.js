// @ts-check
// Waar de hub-koppeling van elke app in zijn eigen checkout zit. Zonder dat bestand start de app wel, maar meldt
// hij zich nooit bij de hub (en wacht de starter van een set tot de time-out). Paden zijn relatief aan de
// repo-map uit sets/paden.json (niet aan start.map).

/**
 * @typedef {{ bestand: string, bevat?: RegExp, waar: string }} Koppeling
 *   `bestand`: moet bestaan; `bevat`: en dit moet erin staan; `waar`: waar de koppeling vandaan komt.
 */

/** @type {Record<string, Koppeling|null>} null = deze app heeft geen eigen koppeling nodig. */
export const KOPPELINGEN = Object.freeze({
  'formula-lab': { bestand: 'src/sync/hub.js', waar: 'de tak claude/varve-hub-koppeling van formula-lab (de PR)' },
  medisynth: { bestand: 'src/hub.js', waar: 'de tak claude/varve-hub-koppeling van medisynth (de PR)' },
  // Eén HTML-bestand (regel van waterschaal): de koppeling leest ?hub= uit de URL.
  waterschaal: { bestand: 'td/waterschaal-lokaal.html', bevat: /['"]hub['"]/, waar: 'de tak claude/varve-hub-koppeling van waterschaal (de PR)' },
  'varve-dj': { bestand: 'src/control/hub.js', waar: 'koppelingen/varve-dj/LEESMIJ.md (patch; jij commit zelf)' },
  'av-kern': { bestand: 'src/ui/hub.ts', waar: 'koppelingen/av-kern/LEESMIJ.md (patch, pas na 25 okt)' },
  'av-scene-kit': { bestand: 'td/td_build_hub.py', waar: 'docs/TOUCHDESIGNER.md' },
  // Staat een app hier niet in (flux), dan wordt de koppeling niet nagegaan.
  // De hub praat zelf met deze apps (HTTP-, OSC- of MIDI-driver): niets in hun checkout nodig.
  uurwerk: null,
  'td-lab': null,
  sediment: null,
});
