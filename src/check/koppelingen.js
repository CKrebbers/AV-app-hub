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
  'formula-lab': { bestand: 'src/sync/hub.js', waar: 'formula-lab main sinds 19 okt (PR #1): git switch main && git pull' },
  medisynth: { bestand: 'src/hub.js', waar: 'medisynth main sinds 19 okt (PR #4): git switch main && git pull' },
  // Eén HTML-bestand (regel van waterschaal): de koppeling leest ?hub= uit de URL.
  waterschaal: { bestand: 'td/waterschaal-lokaal.html', bevat: /['"]hub['"]/, waar: 'waterschaal main sinds 19 okt (PR #1): git switch main && git pull' },
  'varve-dj': { bestand: 'src/control/hub.js', waar: 'youtube-mixer main sinds 5 okt (PR #6); op een oudere kopie: git pull, zie koppelingen/varve-dj/LEESMIJ.md' },
  'av-kern': { bestand: 'src/ui/hub.ts', waar: 'koppelingen/av-kern/LEESMIJ.md (patch, pas na 25 okt)' },
  'av-scene-kit': { bestand: 'td/td_build_hub.py', waar: 'docs/TOUCHDESIGNER.md' },
  // Staat een app hier niet in (flux), dan wordt de koppeling niet nagegaan.
  // De hub praat zelf met deze apps (HTTP-, OSC- of MIDI-driver): niets in hun checkout nodig.
  uurwerk: null,
  'td-lab': null,
  sediment: null,
});
