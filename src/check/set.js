// @ts-check
// De set-kant van `varve-hub check`: per app van de set de map, node_modules, de poort en de hub-koppeling.
// Dezelfde regels als de starter (src/sets/starter.js): map = sets/paden.json → repo + start.map, poort uit de
// set of config.json; een app die al verbonden is met de hub (en, als hij een poort heeft, die poort ook open)
// start de starter niet opnieuw.
import { join, resolve, sep } from 'node:path';
import { thuisPad, vulIn } from '../sets/index.js';
import { KOPPELINGEN } from './koppelingen.js';
import { wieLuistert } from './systeem.js';

/** @typedef {import('./index.js').Punt} Punt @typedef {import('./index.js').Status} Status */

/** Commando's die node_modules nodig hebben (vite, npm run dev, …); python3 en ./start.sh niet. */
const NODE_COMMANDO = /(^|[\s;&|(])(npm|npx|node|vite|yarn|pnpm)(\s|$)/;

/**
 * Koppelingen waarbij de hub zelf een driver draait (src/drivers): zo'n app staat als 'actief' in het beeld zodra de
 * driver er is (een MIDI-driver zodra zijn virtuele poort bestaat), ook als TouchDesigner, Logic of de brug dicht is.
 */
// td (golf 6): die driver meldt zich pas actief als de td-lab-COMP antwoordt, maar ook dan start check niets zelf.
// Er bestaat geen OSC-transport meer (PROTOCOL §2).
export const DRIVER_KOPPELINGEN = Object.freeze(['midi', 'http', 'td']);

/** Praat de hub via een eigen driver met deze app? @param {any} config @param {string} id */
export const isDriver = (config, id) => DRIVER_KOPPELINGEN.includes(config?.apps?.[id]?.koppeling);

/**
 * Hoort een app uit het beeld bij deze app-id? Exact, of `<id>-<monitor>` voor een app met per_monitor (flux).
 * Dezelfde regel als de starter (inBeeld in src/sets/starter.js), plus de monitors.
 * @param {any} config @param {string} id @param {unknown} app
 */
export const hoortBij = (config, id, app) => app === id || (!!config?.apps?.[id]?.per_monitor && String(app).startsWith(`${id}-`));

/**
 * Een pad zoals het op schijf staat, om twee paden te vergelijken: zonder slash erachter, symlinks opgelost (lsof
 * geeft het echte pad), op macOS zonder hoofdlettergevoeligheid (APFS standaard).
 * @param {import('./index.js').Bestanden} fs @param {string} p @param {string} platform
 */
export function echtPad(fs, p, platform) {
  let r = resolve(p);
  try { r = String(fs.realpathSync(r)); } catch { /* bestaat niet (meer): het pad zelf */ }
  return platform === 'darwin' ? r.toLowerCase() : r;
}

/**
 * @param {{
 *   set: import('../sets/set.js').SetDef, config: any, paden: Record<string, string>, padenBekend: boolean, padenNaam: string,
 *   beeld: any, thuis: string, fs: import('./index.js').Bestanden, poortOpen: (p: number) => Promise<boolean>,
 *   spawn: typeof import('node:child_process').spawn, klok: import('../core/klok.js').Klok, toon: (p: string) => string,
 *   platform: string,
 * }} o
 * @returns {Promise<Punt[]>}
 */
export async function controleerSet({ set, config, paden, padenBekend, padenNaam, beeld, thuis, fs, poortOpen, spawn, klok, toon, platform }) {
  /** @type {Punt[]} */
  const uit = [];
  for (const [id, a] of Object.entries(set.apps)) {
    const cfg = config.apps?.[id] ?? {};
    const naam = cfg.naam ?? id;
    /** @param {Status} status @param {string} wat @param {string} uitleg @param {string} [doen] */
    const punt = (status, wat, uitleg, doen = '') => { uit.push({ groep: 'set', naam: `${id}.${wat}`, status, uitleg: `${id}: ${uitleg}`, ...(doen ? { doen } : {}) }); };
    const repo = cfg.repo;
    const basis = repo ? paden[repo] : undefined;
    const repoMap = basis ? thuisPad(basis, thuis) : null;
    const poort = a.poort ?? cfg.poort;
    const start = a.start ?? null;
    const driver = isDriver(config, id);

    // Zoals de starter: 'actief' in het beeld telt alleen samen met een open poort als de app er een heeft. Een
    // driver-app (uurwerk via HTTP, Scene Kit via MIDI) staat ook 'actief' als de app zelf dicht is: daar nooit de
    // kortere weg; dan gaan de gewone punten (handmatig, poort) gewoon door.
    const actief = !driver && (beeld?.apps ?? []).some((/** @type {any} */ x) => hoortBij(config, id, x.app) && x.status === 'actief');
    if (actief && (poort === undefined || await poortOpen(poort))) { punt('ok', 'hub', 'draait al en is verbonden met de hub (de starter laat hem met rust)'); continue; }

    if (start) {
      if (!repoMap) {
        if (padenBekend) punt('fout', 'map', `geen map voor repo "${repo ?? id}" in ${padenNaam}`, `zet er "${repo ?? id}": "~/…" in (voorbeeld: sets/paden.voorbeeld.json)`);
      } else {
        const cwd = join(repoMap, start.map ?? '.');
        if (!fs.existsSync(cwd)) punt('fout', 'map', `map ${toon(cwd)} bestaat niet`, `kijk het pad na in ${padenNaam} → "${repo}" (of clone de repo daar)`);
        else {
          punt('ok', 'map', `map ${toon(cwd)}`);
          if (NODE_COMMANDO.test(start.commando)) uit.push(...nodeModules(fs, cwd, id, toon));
        }
      }
    } else if (a.handmatig) {
      punt('let', 'handmatig', `start je zelf${driver ? ' (de hub ziet alleen zijn eigen driver, niet of de app echt luistert)' : ''}`, vulIn(a.handmatig, { poort, repo: repoMap ?? `<map van ${repo ?? id}>` }));
    }

    if (poort !== undefined && (start || a.url)) {
      if (!(await poortOpen(poort))) punt('ok', 'poort', `poort ${poort} vrij`);
      else {
        const wie = await wieLuistert({ spawn, klok }, poort);
        const app = repoMap ? echtPad(fs, repoMap, platform) : null;
        const daar = wie?.map ? echtPad(fs, wie.map, platform) : null;
        const vanApp = !!(daar && app && (daar === app || daar.startsWith(app.endsWith(sep) ? app : app + sep)));
        if (vanApp) punt('ok', 'poort', `poort ${poort} al door ${naam} bezet${wie?.pid ? ` (pid ${wie.pid})` : ''}: de starter start hem niet opnieuw`);
        else if (wie?.pid && (wie.map || !repoMap)) {
          // Wél te zien wie het is, en het is niet deze app (of we weten niet waar de app staat).
          punt(repoMap ? 'fout' : 'let', 'poort', `poort ${poort} is bezet door ${wie.commando ?? 'een ander proces'} (pid ${wie.pid}${wie.map ? `, in ${toon(wie.map)}` : ''})${repoMap ? `, niet door ${naam}` : ''}`,
            `stop dat (kill ${wie.pid}) of geef ${id} een andere poort in config.json → apps.${id}.poort`);
        } else {
          punt('let', 'poort', `poort ${poort} is al bezet; niet na te gaan door wie${wie === null ? ' (geen lsof)' : ''}`,
            `draait ${naam} al? Zo niet: zoek wat er op ${poort} draait (lsof -nP -iTCP:${poort} -sTCP:LISTEN) en stop het`);
        }
      }
    }

    const k = KOPPELINGEN[id];
    if (k && repoMap && fs.existsSync(repoMap)) {
      const pad = join(repoMap, k.bestand);
      let erin = fs.existsSync(pad);
      if (erin && k.bevat) { try { erin = k.bevat.test(String(fs.readFileSync(pad, 'utf8'))); } catch { erin = false; } }
      if (erin) punt('ok', 'koppeling', `hub-koppeling zit in deze checkout (${k.bestand})`);
      else {
        // Wacht de starter op de hub (standaard), dan wordt deze app nooit klaar: fout. Anders (av-kern vóór 25 okt): let op.
        const status = (a.wacht ?? 'kern') === 'kern' ? 'fout' : 'let';
        punt(status, 'koppeling', `geen hub-koppeling in ${toon(repoMap)} (${k.bestand}${k.bevat && fs.existsSync(pad) ? ' zonder hub' : ' ontbreekt'})`,
          `de app meldt zich niet bij de hub tot de koppeling erin zit (zie koppelingen/ of de PR): ${k.waar}`);
      }
    }
  }
  return uit;
}

/**
 * node_modules nodig als package.json (dev)dependencies heeft; vite apart, want daar draait `npm run dev` op.
 * @param {import('./index.js').Bestanden} fs @param {string} cwd @param {string} id @param {(p: string) => string} toon
 * @returns {Punt[]}
 */
function nodeModules(fs, cwd, id, toon) {
  /** @type {any} */
  let pkg;
  try { pkg = JSON.parse(String(fs.readFileSync(join(cwd, 'package.json'), 'utf8'))); } catch { return []; }
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  if (!Object.keys(deps).length) return [];
  const punt = (/** @type {Status} */ status, /** @type {string} */ uitleg, /** @type {string} */ doen = '') => ({ groep: 'set', naam: `${id}.node_modules`, status, uitleg: `${id}: ${uitleg}`, ...(doen ? { doen } : {}) });
  const doen = `cd ${toon(cwd)} && npm install`;
  if (!fs.existsSync(join(cwd, 'node_modules'))) return [punt('fout', 'node_modules ontbreekt: het startcommando faalt', doen)];
  if ('vite' in deps && !fs.existsSync(join(cwd, 'node_modules', 'vite'))) return [punt('fout', 'vite staat niet in node_modules: npm run dev faalt', doen)];
  return [punt('ok', 'node_modules aanwezig')];
}
