// @ts-check
// Drivers voor passieve apps: apps die zichzelf niet bij de hub kunnen aanmelden (TD via MIDI,
// Logic → Sediment via MIDI, uurwerk via HTTP). Elk heeft een statisch manifest in apps/<app>.json:
// een gewoon manifest (truth:"hub") plus een veld "driver" (PROTOCOL.md §2, ONDERZOEK.md §4).
//
//   const d = maakDriver(statisch, { systeem, klok, fetch });
//   d.start(kern);   // verbind + hallo + manifest, daarna hartslagen zolang de app bereikbaar lijkt
//   d.opnieuw();  // nieuwe aanmelding: de kern speelt alle waarden opnieuw af (na een herstart van de app)
//   d.stop();
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { valideerManifest } from '../protocol/manifest.js';
import { scheidStatisch } from './basis.js';
import { MidiDriver } from './midi.js';
import { HttpDriver } from './http.js';

export { MidiDriver, midiBytes } from './midi.js';
export { HttpDriver, verbBericht } from './http.js';
export { scheidStatisch } from './basis.js';

/** @typedef {import('../protocol/types.js').Verbinding} Verbinding @typedef {import('./basis.js').KernVoorDriver} KernVoorDriver */

/** De map met statische manifesten in de repo. */
export const APPS_MAP = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'apps');
export const DRIVER_SOORTEN = /** @type {const} */ (['midi', 'http']);

/**
 * @param {Record<string, any>} statisch  inhoud van apps/<app>.json
 * @param {{ systeem?: any, klok: import('../core/klok.js').Klok, fetch?: any, config?: any, log?: (...a: unknown[]) => void }} o
 * @returns {{ verbinding: Verbinding, start: (kern: KernVoorDriver) => void, stop: () => void, opnieuw: () => void, driver: MidiDriver|HttpDriver }}
 */
export function maakDriver(statisch, { systeem, klok, fetch, config, log }) {
  const soort = statisch?.driver?.soort;
  /** @type {MidiDriver|HttpDriver} */
  let d;
  if (soort === 'midi') d = new MidiDriver(statisch, { systeem, klok, config, log });
  else if (soort === 'http') d = new HttpDriver(statisch, { klok, fetch, config, log });
  else throw new Error(`onbekende driver-soort: ${soort} (${statisch?.app ?? '?'})`);
  return { verbinding: d.verbinding, start: (kern) => d.start(kern), stop: () => d.stop(), opnieuw: () => d.opnieuw(), driver: d };
}

const isInt = (/** @type {unknown} */ x, lo = 0, hi = 127) => Number.isInteger(x) && /** @type {number} */ (x) >= lo && /** @type {number} */ (x) <= hi;

/**
 * Controleer een statisch manifest: geldig manifest (valideerManifest) + een driver die past.
 * @param {unknown} statisch
 * @returns {{ ok: true, manifest: import('../protocol/types.js').Manifest, driver: Record<string, any> } | { ok: false, fouten: string[] }}
 */
export function valideerStatisch(statisch) {
  if (!statisch || typeof statisch !== 'object' || Array.isArray(statisch)) return { ok: false, fouten: ['statisch manifest is geen object'] };
  const { manifest, driver } = scheidStatisch(/** @type {Record<string, any>} */ (statisch));
  const r = valideerManifest(manifest);
  /** @type {string[]} */
  const f = r.ok ? [] : [...r.fouten];
  if (manifest.truth !== 'hub') f.push('een passieve app is truth:"hub" (de hub onthoudt en speelt opnieuw af)');
  const params = new Map((Array.isArray(manifest.params) ? manifest.params : []).map((/** @type {any} */ p) => [p?.id, p]));
  if (!DRIVER_SOORTEN.includes(driver.soort)) f.push(`driver.soort moet ${DRIVER_SOORTEN.join('|')} zijn`);
  if (driver.soort === 'midi') {
    if (typeof driver.poort !== 'string' || !driver.poort) f.push('driver.poort (naam van de virtuele MIDI-poort) ontbreekt');
    if (driver.kanaal !== undefined && !isInt(driver.kanaal, 0, 15)) f.push('driver.kanaal moet 0..15 zijn');
    const map = driver.map && typeof driver.map === 'object' ? driver.map : {};
    if (!driver.map) f.push('driver.map ontbreekt');
    const bezet = new Map();
    /** @param {string} waar @param {any} d */
    const doel = (waar, d) => {
      if (!d || typeof d !== 'object') { f.push(`${waar}: geen object`); return; }
      const heeftCc = d.cc !== undefined, heeftNoot = d.noot !== undefined;
      if (heeftCc === heeftNoot) f.push(`${waar}: precies één van cc of noot`);
      if (heeftCc && !isInt(d.cc)) f.push(`${waar}: cc moet 0..127 zijn`);
      if (heeftNoot && !isInt(d.noot)) f.push(`${waar}: noot moet 0..127 zijn`);
      if (d.kanaal !== undefined && !isInt(d.kanaal, 0, 15)) f.push(`${waar}: kanaal moet 0..15 zijn`);
      const sleutel = `${heeftCc ? 'cc' : 'noot'}${heeftCc ? d.cc : d.noot}@${d.kanaal ?? driver.kanaal ?? 0}`;
      return sleutel;
    };
    for (const [id, d] of Object.entries(map)) {
      if (!params.has(id)) f.push(`driver.map.${id}: geen param met die id`);
      const ps = params.get(id)?.soort;
      if (d && typeof d === 'object' && d.noot !== undefined && ps && ps !== 'trigger' && ps !== 'schakelaar') f.push(`driver.map.${id}: een ${ps} kan niet op een noot (alleen trigger of schakelaar)`);
      const s = doel(`driver.map.${id}`, d);
      if (s) { if (bezet.has(s)) f.push(`driver.map.${id}: ${s} al gebruikt door ${bezet.get(s)}`); else bezet.set(s, id); }
    }
    for (const [i, d] of (Array.isArray(driver.scenes) ? driver.scenes : []).entries()) doel(`driver.scenes[${i}]`, d);
    if (driver.scenes !== undefined && !Array.isArray(driver.scenes)) f.push('driver.scenes moet een lijst zijn');
    if (driver.presets !== undefined && !Array.isArray(driver.presets)) f.push('driver.presets moet een lijst zijn');
    for (const [i, pr] of (Array.isArray(driver.presets) ? driver.presets : []).entries()) {
      doel(`driver.presets[${i}]`, pr && typeof pr === 'object' ? { cc: pr.cc, noot: pr.noot, kanaal: pr.kanaal } : pr);
      const w = pr?.waarden;
      if (!w || typeof w !== 'object' || Array.isArray(w)) { f.push(`driver.presets[${i}].waarden ontbreekt`); continue; }
      for (const [id, v] of Object.entries(w)) {
        const p = params.get(id);
        if (!p) f.push(`driver.presets[${i}].waarden.${id}: geen param met die id`);
        else if (p.soort === 'trigger') f.push(`driver.presets[${i}].waarden.${id}: een trigger heeft geen waarde`);
        if (typeof v !== 'number' || !(v >= 0 && v <= 1)) f.push(`driver.presets[${i}].waarden.${id}: moet 0..1 zijn`);
      }
    }
    for (const id of params.keys()) if (!(id in map)) f.push(`param ${id} heeft geen MIDI-doel in driver.map`);
  }
  if (driver.soort === 'http') {
    if (typeof driver.url !== 'string' || !/^https?:\/\//.test(driver.url)) f.push('driver.url moet http(s)://… zijn');
    const verbs = driver.verbs && typeof driver.verbs === 'object' ? driver.verbs : {};
    if (!driver.verbs) f.push('driver.verbs ontbreekt');
    for (const [id, v] of Object.entries(verbs)) {
      const p = params.get(id);
      if (!p) f.push(`driver.verbs.${id}: geen param met die id`);
      if (!v || typeof v.verb !== 'string' || !v.verb) { f.push(`driver.verbs.${id}: verb ontbreekt`); continue; }
      if (v.args !== undefined && (typeof v.args !== 'object' || Array.isArray(v.args))) f.push(`driver.verbs.${id}: args moet een object zijn`);
      if (v.bereik !== undefined && !(Array.isArray(v.bereik) && v.bereik.length === 2 && v.bereik.every(Number.isFinite))) f.push(`driver.verbs.${id}: bereik moet [min, max] zijn`);
      if (p && p.soort !== 'trigger' && typeof v.waarde !== 'string') f.push(`driver.verbs.${id}: waarde (naam van het argument) nodig voor een ${p.soort}`);
    }
    for (const id of params.keys()) if (!(id in verbs)) f.push(`param ${id} heeft geen verb in driver.verbs`);
  }
  if (f.length || !r.ok) return { ok: false, fouten: f };
  return { ok: true, manifest: r.manifest, driver };
}

/**
 * Lees alle statische manifesten uit een map (standaard apps/). Ongeldige worden overgeslagen
 * en gemeld, nooit gegooid.
 * @param {string} [map]
 * @returns {{ statisch: Record<string, any>[], fouten: { bestand: string, fouten: string[] }[] }}
 */
export function laadStatisch(map = APPS_MAP) {
  /** @type {Record<string, any>[]} */
  const statisch = [];
  /** @type {{ bestand: string, fouten: string[] }[]} */
  const fouten = [];
  let bestanden = [];
  try { bestanden = readdirSync(map).filter((n) => n.endsWith('.json')).sort(); } catch (e) { return { statisch, fouten: [{ bestand: map, fouten: [/** @type {Error} */ (e).message] }] }; }
  for (const bestand of bestanden) {
    try {
      const x = JSON.parse(readFileSync(join(map, bestand), 'utf8'));
      const r = valideerStatisch(x);
      if (r.ok) statisch.push(x); else fouten.push({ bestand, fouten: r.fouten });
    } catch (e) { fouten.push({ bestand, fouten: [/** @type {Error} */ (e).message] }); }
  }
  return { statisch, fouten };
}

/** Standaard wachttijd voor de drivers starten: echte (WS-)apps die al draaien, verbinden eerst. */
export const DRIVER_UITSTEL_MS = 3000;

/**
 * Start een driver voor elk statisch manifest. Handig voor de daemon (cli.js).
 *
 * Volgorde en moment doen ertoe: de kern geeft slots in volgorde van eerste hallo, en de eerste app
 * krijgt de focus. Een MIDI-driver is altijd 'bereikbaar', ook als TD of Logic dicht is. Daarom:
 * - drivers starten pas na `uitstel_ms` (standaard config.drivers.uitstel_ms of 3 s), zodat apps die
 *   zichzelf aanmelden eerst hun slot (en de focus) krijgen;
 * - in de volgorde van config.apps (daarna alfabetisch);
 * - `config.apps.<app>.autostart: false` slaat een driver over.
 * @param {{ kern: KernVoorDriver, klok: import('../core/klok.js').Klok, systeem?: any, fetch?: any, config?: any, map?: string, uitstel_ms?: number, log?: (...a: unknown[]) => void }} o
 */
export function startDrivers({ kern, klok, systeem, fetch, config, map, uitstel_ms, log = () => {} }) {
  const { statisch, fouten } = laadStatisch(map);
  for (const f of fouten) log('drivers', `${f.bestand} overgeslagen:`, f.fouten.join('; '));
  const volgorde = Object.keys(config?.apps ?? {});
  const plek = (/** @type {string} */ app) => { const i = volgorde.indexOf(app); return i < 0 ? Infinity : i; };
  const lijst = [...statisch].sort((a, b) => plek(a.app) - plek(b.app) || String(a.app).localeCompare(String(b.app)));
  /** @type {ReturnType<typeof maakDriver>[]} */
  const drivers = [];
  for (const s of lijst) {
    if (config?.apps?.[s.app]?.autostart === false) { log('drivers', `${s.app}: autostart uit in config.json, overgeslagen`); continue; }
    if (s.driver.soort === 'midi' && !systeem?.virtueel) {
      const poort = config?.apps?.[s.app]?.midipoort ?? s.driver.poort;
      log('drivers', `${s.app}: geen MIDI-systeem met virtuele poorten — poort "${poort}" bestaat niet, driver overgeslagen`);
      continue;
    }
    drivers.push(maakDriver(s, { systeem, klok, fetch, config, log }));
  }
  let gestopt = false;
  const startAlle = () => { timer = null; if (!gestopt) for (const d of drivers) d.start(kern); };
  const wacht = uitstel_ms ?? config?.drivers?.uitstel_ms ?? DRIVER_UITSTEL_MS;
  /** @type {any} */
  let timer = null;
  if (wacht > 0) timer = klok.zet(startAlle, wacht); else startAlle();
  return {
    drivers,
    stop: () => {
      gestopt = true;
      if (timer !== null) { klok.wis(timer); timer = null; }
      for (const d of drivers) d.stop();
    },
  };
}
