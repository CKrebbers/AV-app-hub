// @ts-check
// Sets: één bestand in sets/<naam>.json beschrijft een hele avond — welke apps, hoe elk start, welke URL
// (met ?hub=) in Chrome open moet, de beginsnapshot en de beginfocus. Zie docs/SETS.md.
//
// Paden naar Clay's repo's staan nooit in een set (en nooit in de code): ze komen uit sets/paden.json
// (lokaal, niet in git; voorbeeld in sets/paden.voorbeeld.json), per repo-naam uit config.json → apps.<id>.repo.
// Poorten komen uit config.json → apps.<id>.poort (huisregel 6); in een set staat {poort}.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { HUB_MAP } from '../config.js';

export const SETS_MAP = join(HUB_MAP, 'sets');
/** sets/paden.json, of $VARVE_HUB_PADEN (tests, of een tweede computer). */
export const PADEN_PAD = process.env.VARVE_HUB_PADEN || join(SETS_MAP, 'paden.json');
/** Hoe de starter weet dat een app klaar is (zie docs/SETS.md). */
export const WACHT_SOORTEN = /** @type {const} */ (['kern', 'poort', 'geen']);
/** Standaard time-out per app (seconden) als de set niets zegt. Een eerste `npm run dev` kan traag zijn. */
export const STANDAARD_TIME_OUT_S = 60;
/** Bestanden in sets/ die geen set zijn. */
const GEEN_SET = new Set(['paden.json', 'paden.voorbeeld.json']);

/**
 * @typedef {{ commando: string, map?: string, omgeving?: Record<string, string> }} StartSpec
 * @typedef {{
 *   start?: StartSpec|null, url?: string|null, wacht?: 'kern'|'poort'|'geen', poort?: number,
 *   time_out_s?: number, opmerking?: string, handmatig?: string,
 * }} SetApp
 * @typedef {{
 *   naam: string, beschrijving?: string, time_out_s?: number,
 *   apps: Record<string, SetApp>, snapshot?: Record<string, Record<string, number>>, focus?: string|null,
 * }} SetDef
 */

/** De namen van alle sets in een map (zonder .json). @param {string} [map] */
export function lijstSets(map = SETS_MAP) {
  if (!existsSync(map)) return [];
  return readdirSync(map).filter((f) => f.endsWith('.json') && !GEEN_SET.has(f)).map((f) => f.slice(0, -5)).sort();
}

/** Lees een JSON-bestand en zeg duidelijk wat er mis is. @param {string} pad */
function leesJson(pad) {
  let tekst;
  try { tekst = readFileSync(pad, 'utf8'); } catch (e) { throw new Error(`kan ${pad} niet lezen: ${/** @type {Error} */ (e).message}`); }
  try { return JSON.parse(tekst); } catch (e) { throw new Error(`${pad} is geen geldige JSON: ${/** @type {Error} */ (e).message}`); }
}

/**
 * Een set laden en controleren. Gooit met een leesbare melding (welke sets er wel zijn, wat er mis is).
 * @param {string} naam  naam (sets/<naam>.json) of pad naar een .json-bestand
 * @param {{ config: any, map?: string }} o
 * @returns {SetDef}
 */
export function laadSet(naam, { config, map = SETS_MAP }) {
  const pad = naam.endsWith('.json') ? resolve(naam) : join(map, `${naam}.json`);
  if (!existsSync(pad)) {
    const er = lijstSets(map);
    throw new Error(`onbekende set "${naam}" — beschikbaar: ${er.length ? er.join(', ') : '(geen)'}`);
  }
  const r = valideerSet(leesJson(pad), config);
  if (!r.ok) throw new Error(`set ${naam} klopt niet:\n  - ${r.fouten.join('\n  - ')}`);
  return r.set;
}

const isObject = (/** @type {unknown} */ x) => !!x && typeof x === 'object' && !Array.isArray(x);
const VARIABELEN = new Set(['poort', 'hub', 'hub_poort', 'repo']);

/**
 * Controleer een set tegen config.json. Puur (geen bestanden), zodat tests elke fout kunnen maken.
 * @param {unknown} ruw @param {any} config
 * @returns {{ ok: true, set: SetDef } | { ok: false, fouten: string[] }}
 */
export function valideerSet(ruw, config) {
  /** @type {string[]} */
  const f = [];
  if (!isObject(ruw)) return { ok: false, fouten: ['een set is een JSON-object'] };
  const s = /** @type {Record<string, any>} */ (ruw);
  const bekend = config?.apps ?? {};
  if (typeof s.naam !== 'string' || !s.naam) f.push('naam ontbreekt');
  if (s.time_out_s !== undefined && !(typeof s.time_out_s === 'number' && s.time_out_s > 0)) f.push('time_out_s moet een getal > 0 zijn');
  if (!isObject(s.apps) || !Object.keys(s.apps).length) f.push('apps ontbreekt (een object: app-id → hoe hij start)');
  const apps = isObject(s.apps) ? /** @type {Record<string, any>} */ (s.apps) : {};
  /** @param {string} waar @param {unknown} tekst */
  const sjabloon = (waar, tekst) => {
    if (typeof tekst !== 'string') return;
    for (const [, v] of tekst.matchAll(/\{([^}]*)\}/g)) if (!VARIABELEN.has(v)) f.push(`${waar}: onbekende variabele {${v}} (wel: ${[...VARIABELEN].map((x) => `{${x}}`).join(', ')})`);
  };
  for (const [id, a] of Object.entries(apps)) {
    const waar = `apps.${id}`;
    if (!(id in bekend)) { f.push(`${waar}: geen app in config.json → apps (wel: ${Object.keys(bekend).join(', ')})`); continue; }
    if (!isObject(a)) { f.push(`${waar}: geen object`); continue; }
    const poort = a.poort ?? bekend[id].poort;
    if (a.poort !== undefined && !(Number.isInteger(a.poort) && a.poort > 0 && a.poort < 65536)) f.push(`${waar}.poort: geen geldige poort`);
    if (a.start !== undefined && a.start !== null) {
      if (!isObject(a.start)) f.push(`${waar}.start: een object { commando, map?, omgeving? } of null`);
      else {
        if (typeof a.start.commando !== 'string' || !a.start.commando.trim()) f.push(`${waar}.start.commando ontbreekt`);
        if (a.start.map !== undefined && typeof a.start.map !== 'string') f.push(`${waar}.start.map moet tekst zijn (relatief aan de repo)`);
        if (typeof a.start.map === 'string' && isAbsolute(a.start.map)) f.push(`${waar}.start.map moet relatief aan de repo zijn (paden horen in sets/paden.json)`);
        if (a.start.omgeving !== undefined && !(isObject(a.start.omgeving) && Object.values(a.start.omgeving).every((v) => typeof v === 'string'))) f.push(`${waar}.start.omgeving: een object met tekstwaarden`);
        if (!bekend[id].repo) f.push(`${waar}: config.json → apps.${id}.repo ontbreekt (waar moet hij starten?)`);
        sjabloon(`${waar}.start.commando`, a.start.commando);
        for (const [k, v] of Object.entries(isObject(a.start.omgeving) ? a.start.omgeving : {})) sjabloon(`${waar}.start.omgeving.${k}`, v);
      }
    }
    if (a.url !== undefined && a.url !== null && typeof a.url !== 'string') f.push(`${waar}.url moet tekst zijn`);
    sjabloon(`${waar}.url`, a.url);
    const gebruiktPoort = [a.url, a.start?.commando, ...Object.values(isObject(a.start?.omgeving) ? a.start.omgeving : {})].some((x) => typeof x === 'string' && x.includes('{poort}'));
    if (gebruiktPoort && poort === undefined) f.push(`${waar}: {poort} gebruikt, maar config.json → apps.${id}.poort ontbreekt`);
    if (a.wacht !== undefined && !WACHT_SOORTEN.includes(a.wacht)) f.push(`${waar}.wacht moet ${WACHT_SOORTEN.join('|')} zijn`);
    if (a.wacht === 'poort' && poort === undefined) f.push(`${waar}.wacht is "poort", maar er is geen poort`);
    if (a.time_out_s !== undefined && !(typeof a.time_out_s === 'number' && a.time_out_s > 0)) f.push(`${waar}.time_out_s moet een getal > 0 zijn`);
    for (const k of ['opmerking', 'handmatig']) if (a[k] !== undefined && typeof a[k] !== 'string') f.push(`${waar}.${k} moet tekst zijn`);
    sjabloon(`${waar}.handmatig`, a.handmatig);
    sjabloon(`${waar}.opmerking`, a.opmerking);
  }
  if (s.snapshot !== undefined) {
    if (!isObject(s.snapshot)) f.push('snapshot: een object app-id → { parameter: waarde 0..1 }');
    else for (const [id, w] of Object.entries(s.snapshot)) {
      if (!(id in apps)) { f.push(`snapshot.${id}: die app zit niet in deze set`); continue; }
      if (!isObject(w)) { f.push(`snapshot.${id}: een object { parameter: waarde }`); continue; }
      for (const [p, v] of Object.entries(w)) if (!(typeof v === 'number' && v >= 0 && v <= 1)) f.push(`snapshot.${id}.${p}: waarden op de draad zijn 0..1 (PROTOCOL §1)`);
    }
  }
  if (s.focus !== undefined && s.focus !== null && !(typeof s.focus === 'string' && s.focus in apps)) f.push(`focus: "${s.focus}" zit niet in deze set`);
  if (f.length) return { ok: false, fouten: f };
  return { ok: true, set: /** @type {SetDef} */ (s) };
}

/**
 * sets/paden.json lezen: repo-naam → map op deze computer. Ontbreekt het bestand, dan een leeg object
 * (apps die al draaien hebben geen pad nodig; de starter meldt per app wat ontbreekt).
 * @param {string} [pad]
 * @returns {Record<string, string>}
 */
export function laadPaden(pad = PADEN_PAD) {
  if (!existsSync(pad)) return {};
  const ruw = leesJson(pad);
  if (!isObject(ruw)) throw new Error(`${pad}: een object repo-naam → map`);
  /** @type {Record<string, string>} */
  const uit = {};
  for (const [k, v] of Object.entries(ruw)) {
    if (k.startsWith('_')) continue;
    if (typeof v !== 'string' || !v) throw new Error(`${pad}: "${k}" moet een map zijn (tekst)`);
    uit[k] = v;
  }
  return uit;
}

/** `~` en `~/…` worden de thuismap. @param {string} pad @param {string} [thuis] */
export const thuisPad = (pad, thuis = homedir()) => (pad === '~' ? thuis : pad.startsWith('~/') ? join(thuis, pad.slice(2)) : pad);

/** {poort}, {hub}, {hub_poort} en {repo} invullen. @param {string} tekst @param {Record<string, string|number|undefined>} vars */
export function vulIn(tekst, vars) {
  return tekst.replace(/\{([a-z_]+)\}/g, (heel, k) => (vars[k] === undefined ? heel : String(vars[k])));
}
