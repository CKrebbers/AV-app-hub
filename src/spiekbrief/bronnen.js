// @ts-check
// Waar de spiekbrief zijn manifesten vandaan haalt als de app (nog) niet bij de hub is (docs/SPIEKBRIEF.md):
//   1. de draaiende hub zelf (de server geeft zijn kern mee; zie model.js) — wat de app nu echt stuurde;
//   2. apps/<app>.json — de statische manifesten van de driver-apps (uurwerk, Scene Kit, Sediment, td-lab);
//      precies wat de driver bij de kern aanmeldt (laadStatisch + scheidStatisch, src/drivers/);
//   3. de manifesten die de echte apps het laatst stuurden, vastgelegd door tools/repetitie.mjs --fixtures
//      (test/fixtures/manifesten/<app>.json, met in `_bron` de tak en de datum);
//   4. niets: dan staat de app op de spiekbrief met "indeling volgt als de app zich meldt".
// De opgeslagen staat (~/.varve-hub/staat.json) en een avondopname bewaren geen manifesten (alleen waarden en
// een hash), dus daar valt niets uit te halen.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HUB_MAP, laadKaarten } from '../config.js';
import { laadStatisch, scheidStatisch, APPS_MAP } from '../drivers/index.js';
import { laadSet, lijstSets, SETS_MAP } from '../sets/index.js';
import { maakSpiekbrief, uitKern } from './model.js';

/** @typedef {import('./model.js').Bron} Bron @typedef {import('./model.js').Spiekbrief} Spiekbrief */

/** Map met de manifesten die tools/repetitie.mjs --fixtures van de echte apps vastlegde. */
export const VASTGELEGD_MAP = join(HUB_MAP, 'test', 'fixtures', 'manifesten');

const MAANDEN = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
/** "3 okt 2026" uit een ISO-datum ergens in een tekst, of null. @param {string} tekst */
export function datumUit(tekst) {
  const m = /(\d{4})-(\d{2})-(\d{2})T/.exec(tekst);
  return m ? `${Number(m[3])} ${MAANDEN[Number(m[2]) - 1]} ${m[1]}` : null;
}

/**
 * Alle bekende manifesten buiten de hub om. Een driver-manifest gaat voor een vastgelegd (de driver meldt
 * precies dat aan). Kapotte bestanden worden overgeslagen (en gemeld in `fouten`), nooit gegooid.
 * @param {{ appsMap?: string, vastgelegdMap?: string }} [o]
 * @returns {{ bronnen: Record<string, Bron>, fouten: string[] }}
 */
export function laadBronnen({ appsMap = APPS_MAP, vastgelegdMap = VASTGELEGD_MAP } = {}) {
  /** @type {Record<string, Bron>} */
  const bronnen = {};
  /** @type {string[]} */
  const fouten = [];
  if (existsSync(vastgelegdMap)) {
    for (const f of readdirSync(vastgelegdMap).filter((x) => x.endsWith('.json')).sort()) {
      try {
        const x = JSON.parse(readFileSync(join(vastgelegdMap, f), 'utf8'));
        const manifest = x?.manifest;
        if (!manifest || typeof manifest.app !== 'string') { fouten.push(`${f}: geen manifest`); continue; }
        const d = datumUit(String(x._bron ?? ''));
        bronnen[manifest.app] = { manifest, bron: 'vastgelegd', uitleg: `zoals de app hem stuurde${d ? ` op ${d}` : ''} (generale repetitie)` };
      } catch (e) { fouten.push(`${f}: ${/** @type {Error} */ (e).message}`); }
    }
  }
  const { statisch, fouten: sf } = laadStatisch(appsMap);
  for (const f of sf) fouten.push(`${f.bestand}: ${f.fouten.join('; ')}`);
  for (const s of statisch) {
    const { manifest, driver } = scheidStatisch(s);
    bronnen[manifest.app] = { manifest, bron: 'driver', uitleg: `apps/${manifest.app}.json (${driver.soort}-driver)` };
  }
  return { bronnen, fouten };
}

/** De config zoals de hub hem de kern geeft: met de kaarten uit maps/ (src/hub.js). @param {any} config */
export const hubConfig = (config) => ({ ...config, kaarten: { ...laadKaarten(), ...(config?.kaarten ?? {}) } });

/**
 * De spiekbrief van een set uit sets/. Alleen namen die lijstSets kent (geen paden: de server geeft de naam
 * uit de URL door). Gooit met een leesbare melding bij een onbekende of kapotte set.
 * @param {string} naam
 * @param {{ config: any, kern?: any, setsMap?: string, appsMap?: string, vastgelegdMap?: string }} o
 *   `kern`: de kern van een draaiende hub (dan staat er wat de hub nu doet); `config` is dan al de hub-config.
 * @returns {Spiekbrief}
 */
export function spiekbriefVoorSet(naam, { config, kern = null, setsMap = SETS_MAP, appsMap, vastgelegdMap }) {
  const sets = lijstSets(setsMap);
  if (!sets.includes(naam)) throw new Error(`onbekende set "${naam}" — beschikbaar: ${sets.length ? sets.join(', ') : '(geen)'}`);
  const cfg = kern?.config ?? hubConfig(config);
  const set = laadSet(naam, { config: cfg, map: setsMap });
  const { bronnen } = laadBronnen({ appsMap, vastgelegdMap });
  return maakSpiekbrief({ id: naam, set, config: cfg, bronnen, kern: kern ? uitKern(kern) : null });
}
