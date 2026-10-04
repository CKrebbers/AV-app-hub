// @ts-check
// Spiekbrief: wat doet welke knop, per set, afdrukbaar (docs/SPIEKBRIEF.md).
//   model.js   puur: set + config + manifesten → overzicht, via een echte Kern (of de kern van de draaiende hub)
//   bronnen.js waar manifesten vandaan komen als de app niet bij de hub is (apps/, vastgelegde manifesten)
//   html.js    puur: overzicht → HTML (scherm in cockpitstijl, papier A4 liggend)
// Hier: de pagina voor de server (GET /spiekbrief[?set=<naam>|alle]) en het bestand voor de CLI.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { HUB_MAP, laadConfig } from '../config.js';
import { laadSet, lijstSets, SETS_MAP } from '../sets/index.js';
import { spiekbriefVoorSet, laadBronnen } from './bronnen.js';
import { spiekbriefHtml, lijstHtml } from './html.js';

export { maakSpiekbrief, schaduwKern, uitKern, lpdPads, ROL_NAMEN } from './model.js';
export { laadBronnen, spiekbriefVoorSet, hubConfig, VASTGELEGD_MAP } from './bronnen.js';
export { spiekbriefHtml, lijstHtml, gewicht, dichtheid, verdeel, esc } from './html.js';

/** Waar de CLI de spiekbrief standaard neerzet (staat in .gitignore). */
export const UITVOER_MAP = join(HUB_MAP, 'tools', 'uitvoer');
/** Alle sets in één pagina, elk op een eigen A4. */
export const ALLE = 'alle';

/**
 * De namen voor een verzoek: één set, of alle sets bij "alle". Gooit bij een onbekende naam.
 * @param {string} naam @param {string} [setsMap]
 */
function namenVoor(naam, setsMap = SETS_MAP) {
  const sets = lijstSets(setsMap);
  if (naam === ALLE && !sets.includes(ALLE)) return sets;
  if (!sets.includes(naam)) throw Object.assign(new Error(`onbekende set "${naam}" — beschikbaar: ${sets.length ? sets.join(', ') : '(geen)'}`), { code: 'ONBEKEND' });
  return [naam];
}

/**
 * Het antwoord op GET /spiekbrief (zonder set: de lijst) en /spiekbrief?set=<naam> voor de server.
 * Met de kern van de draaiende hub: wat de hub nu doet, met de echte Track Select-nummers.
 * @param {string|null} set @param {{ kern?: any, setsMap?: string, gemaakt?: Date|null, appsMap?: string, vastgelegdMap?: string }} [o]
 * @returns {{ code: number, html: string }}
 */
export function spiekbriefPagina(set, { kern = null, setsMap = SETS_MAP, gemaakt = null, appsMap, vastgelegdMap } = {}) {
  const config = kern?.config ?? laadConfig();
  if (set === null || set === '') {
    /** @type {string[]} */
    const fouten = [];
    const sets = lijstSets(setsMap).flatMap((id) => {
      try { const s = laadSet(id, { config, map: setsMap }); return [{ id, naam: s.naam, beschrijving: s.beschrijving ?? '' }]; } catch (e) { fouten.push(`${id}: ${/** @type {Error} */ (e).message}`); return []; }
    });
    // kapotte bronbestanden (apps/*.json, vastgelegde manifesten): die apps staan op de bladen zonder indeling
    fouten.push(...laadBronnen({ appsMap, vastgelegdMap }).fouten);
    return { code: 200, html: lijstHtml(sets, { fouten }) };
  }
  try {
    const brieven = namenVoor(set, setsMap).map((naam) => spiekbriefVoorSet(naam, { config, kern, setsMap, appsMap, vastgelegdMap }));
    return { code: 200, html: spiekbriefHtml(brieven, { css: 'link', gemaakt }) };
  } catch (e) {
    const fout = /** @type {Error & { code?: string }} */ (e);
    const html = lijstHtml([], { fouten: [fout.message] }).replace('<p class="leeg">Er staan geen sets in sets/.</p>', '<p><a href="/spiekbrief">← alle sets</a></p>');
    return { code: fout.code === 'ONBEKEND' ? 404 : 500, html };
  }
}

/**
 * De spiekbrief als los HTML-bestand (CLI: varve-hub spiekbrief <set> [--uit bestand.html]), zonder hub.
 * @param {string} naam set of "alle"
 * @param {{ config: any, uit?: string, gemaakt?: Date|null, setsMap?: string, appsMap?: string, vastgelegdMap?: string }} o
 * @returns {{ pad: string, sets: string[], brieven: import('./model.js').Spiekbrief[] }}
 */
export function schrijfSpiekbrief(naam, { config, uit, gemaakt = null, setsMap = SETS_MAP, appsMap, vastgelegdMap }) {
  const namen = namenVoor(naam, setsMap);
  const brieven = namen.map((n) => spiekbriefVoorSet(n, { config, setsMap, appsMap, vastgelegdMap }));
  const pad = resolve(uit ?? join(UITVOER_MAP, `spiekbrief-${naam}.html`));
  mkdirSync(dirname(pad), { recursive: true });
  writeFileSync(pad, spiekbriefHtml(brieven, { css: 'inline', gemaakt, opHub: false }));
  return { pad, sets: namen, brieven };
}

