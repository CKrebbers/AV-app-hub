// @ts-check
// De grammatica in woorden (PROTOCOL §19, ../werkplek/bediening/SYSTEEM.md §3): wat elke knopgroep overal betekent.
// Alleen data, voor de spiekbrief (src/spiekbrief/) en de cockpit (ui/cockpit.js, via /src/protocol/). `hub` zegt
// of de hub het nu al doet (true) of dat het nog komt (false): de spiekbrief belooft niets wat er niet is.
import { ALFABET, MOMENTEN, rolWoord, macroVan } from './manifest.js';

/** Wat elke alfabet-plek betekent (SYSTEEM §3.3), in de volgorde van ALFABET. */
export const ALFABET_BETEKENIS = Object.freeze(/** @type {Record<string, string>} */ ({
  schaal: 'maat, zoom, rastergrootte',
  dichtheid: 'aantal, fijnheid',
  beweging: 'snelheid, tempo-deling',
  vervorming: 'vervormen, draaien, buigen',
  kleur: 'tint, palet',
  helderheid: 'contrast, drempel',
  variatie: 'toeval, zaadje, mutatie',
  ruimte: 'naloop, terugkoppeling, sporen',
}));

/** Hoe elk moment heet (SYSTEEM §3.4), in de volgorde van MOMENTEN (pad 1–8). */
export const MOMENT_NAAM = Object.freeze(/** @type {Record<string, string>} */ ({
  flits: 'flits', stoot: 'stoot', omkeren: 'omkeren', bevriezen: 'bevriezen',
  zaad: 'nieuw zaadje', terug: 'terug naar begin', wis: 'wis spoor', halvetijd: 'halve tijd',
}));

/** De LPD8-knop van een macro-rol (PROTOCOL §6). */
const LPD8 = Object.freeze(/** @type {Record<string, string>} */ ({
  'macro.helderheid': 'K2', 'macro.ruimte': 'K3', 'macro.beweging': 'K4', 'macro.kleur': 'K5', 'macro.dichtheid': 'K6',
}));

/**
 * @typedef {{ wat: string, betekent: string, hub: boolean }} Regel
 * @typedef {{ id: string, titel: string, waar: string, regels: Regel[] }} Deel
 */

/** De acht alfabet-plekken als regels: "1 schaal" — betekenis (en de LPD8-knop als die er is). */
export const ALFABET_REGELS = Object.freeze(ALFABET.map((rol, i) => {
  const w = rolWoord(rol), m = macroVan(rol);
  return { wat: `${i + 1} ${w}`, betekent: `${ALFABET_BETEKENIS[w]}${m ? ` · ook LPD8 ${LPD8[m]}` : ''}`, hub: true };
}));

/** De grammatica in zes delen (SYSTEEM §3.1–§3.6). @type {readonly Deel[]} */
export const GRAMMATICA = Object.freeze([
  {
    id: 'lagen', titel: 'Lagen', waar: 'APC40 kanalen 1–8 · Maschine groep A–H',
    regels: [
      { wat: 'Fader', betekent: 'hoeveel van deze laag (zichtbaarheid, volume, sterkte); Master = alles', hub: true },
      { wat: 'Track Select / groep A–H', betekent: 'focus op deze laag: de device-knoppen en de Maschine volgen (Track Select met de hubtoets)', hub: true },
      { wat: 'Activator · Solo · Arm', betekent: 'aan · alleen deze · opnemen', hub: false },
      { wat: 'Track-knoppen (boven)', betekent: 'hoeveel van het "zend"-effect van deze laag (naloop, glitch, dither)', hub: false },
      { wat: 'Crossfader', betekent: 'vervormen tussen stand A en stand B', hub: false },
    ],
  },
  {
    id: 'toestanden', titel: 'Toestanden', waar: 'APC40-raster 5×8 · scène-knoppen',
    regels: [
      { wat: 'Pad in het raster', betekent: 'een opgeslagen toestand van die laag; kleur = soort, puls = actief', hub: false },
      { wat: 'Scène 1–5', betekent: 'een hele toestand van alle lagen tegelijk ("een beeld"); nu: scène van de app, met de hubtoets een hub-snapshot', hub: true },
      { wat: 'Clip Stop', betekent: 'laag leeg (nu: knippert zolang de fader nog niet heeft opgepakt)', hub: false },
      { wat: 'Stop All', betekent: 'paniek van de app met focus (vasthouden)', hub: true },
      { wat: 'Lang drukken', betekent: 'huidige toestand opslaan op die plek; nu: LPD8 P5–P8 en Bank + Shift + Scene', hub: true },
    ],
  },
  {
    id: 'alfabet', titel: 'Het parameter-alfabet', waar: 'APC40 device-knoppen 1–8 = Maschine-draaiknoppen 1–8',
    regels: [...ALFABET_REGELS, { wat: 'lege plek', betekent: 'doet niets, ring uit: elke plek betekent in elke app hetzelfde', hub: true }],
  },
  {
    id: 'gebaren', titel: 'Gebaren', waar: 'Maschine-pads · KP3+',
    regels: [
      ...MOMENTEN.map((rol, i) => ({ wat: `pad ${i + 1}`, betekent: MOMENT_NAAM[rolWoord(rol)], hub: true })),
      { wat: 'velocity · aftertouch', betekent: 'hoe hard · hoe lang/hoe diep (0..1 naar de app)', hub: true },
      { wat: 'pad 9–16', betekent: 'per app vrij (noten, samples, favoriete toestanden)', hub: true },
      { wat: 'KP3+ XY', betekent: 'vervormen tussen twee parameters (X = vervorming, Y = ruimte); loslaten = terugveren of blijven', hub: false },
    ],
  },
  {
    id: 'tijd', titel: 'Tijd', waar: 'EFX-500 · APC40 Tap/Nudge · transport',
    regels: [
      { wat: 'Tap', betekent: 'de klok voor alle apps (globaal.bpm); nu: LPD8 P2', hub: true },
      { wat: 'EFX-500', betekent: 'de BPM van de muziek op de ingang als klok', hub: false },
      { wat: 'Nudge −/+ · Play · Record', betekent: 'verschuiven · tijd aan/uit · beeld en gebaren opnemen', hub: false },
    ],
  },
  {
    id: 'navigatie', titel: 'Navigatie', waar: 'overal hetzelfde',
    regels: [
      { wat: 'Bank (hubtoets) + bovenste padrij', betekent: 'wissel van doel (app); lampjes = welk doel actief is', hub: true },
      { wat: 'Shift', betekent: 'de tweede laag van elke knop; op de Maschine-draaiknoppen: fijn', hub: true },
      { wat: 'Device ◄/►', betekent: 'volgende acht parameters (na het alfabet)', hub: true },
      { wat: 'Maschine-masterwiel', betekent: 'bladeren (toestanden, bestanden); indrukken = kiezen', hub: false },
    ],
  },
]);
