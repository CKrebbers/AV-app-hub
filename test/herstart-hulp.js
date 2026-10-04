// @ts-check
// Hulp voor de herstart-tests (test/herstart*.test.js): de echte hub als proces (`node src/cli.js start`),
// een cockpit over WebSocket, en opruimen van alles wat de test zelf startte (alleen via de eigen pid's).
// Hermetisch: een eigen tijdelijke map voor geheugen, config en avondmap; nooit ~/.varve-hub, de echte avondmap
// (~/Movies/varve-avonden) of de echte apps. De tijdelijke mappen gaan weg in ruimProcessenOp.
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';
import { laadConfig } from '../src/config.js';

export const HUB_MAP = join(import.meta.dirname, '..');
export const CLI = join(HUB_MAP, 'src', 'cli.js');

export const wacht = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/** Wacht tot fn iets waars geeft (of de tijd op is; dan de laatste uitkomst). @template T @param {() => T} fn */
export async function tot(fn, ms = 5000) {
  const eind = Date.now() + ms;
  while (Date.now() < eind) { const x = fn(); if (x) return x; await wacht(20); }
  return fn();
}

/** Een vrije TCP-poort (zodat de hub na een herstart op dezelfde poort terugkomt). @returns {Promise<number>} */
export function vrijePoort() {
  return new Promise((goed, fout) => {
    const s = net.createServer();
    s.once('error', fout);
    s.listen(0, '127.0.0.1', () => { const p = /** @type {net.AddressInfo} */ (s.address()).port; s.close(() => goed(p)); });
  });
}

/** Tijdelijke mappen van deze tests (weg in ruimProcessenOp). @type {string[]} */
const mappen = [];

/** Tijdelijke map. */
export const maakMap = () => { const m = mkdtempSync(join(tmpdir(), 'varve-herstart-')); mappen.push(m); return m; };

/**
 * Een config.json in de tijdelijke map: de echte, met `extra` eroverheen (geen avondmap tenzij gevraagd).
 * @param {string} map @param {Record<string, unknown>} [extra] @returns {string} pad
 */
export function maakConfig(map, extra = {}) {
  const c = { ...laadConfig(), avondmap: undefined, ...extra };
  const pad = join(map, 'config.json');
  writeFileSync(pad, JSON.stringify(c, null, 1));
  return pad;
}

/**
 * @typedef {{
 *   p: import('node:child_process').ChildProcess, pid: number, uitvoer: () => string,
 *   wachtOp: (re: RegExp, ms?: number) => Promise<string>,
 *   einde: Promise<{ code: number|null, sein: NodeJS.Signals|null }>,
 *   sein: (s: NodeJS.Signals) => void,
 * }} HubProces
 */

/** Alle processen die deze tests startten (opruimen per pid, nooit met een patroon). @type {Set<HubProces>} */
const levend = new Set();

/**
 * Start `node src/cli.js <args>` met een eigen geheugen en config.
 * @param {{ args: string[], staat?: string|null, config?: string, env?: Record<string, string>, klaar?: RegExp|null, ms?: number }} o
 * @returns {Promise<HubProces>}
 */
export async function startCli({ args, staat = null, config, env = {}, klaar = /varve-hub draait/, ms = 15000 }) {
  const p = spawn(process.execPath, [CLI, ...args], {
    cwd: HUB_MAP, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, ...(staat ? { VARVE_HUB_STAAT: staat } : {}), ...(config ? { VARVE_HUB_CONFIG: config } : {}),
      VARVE_HUB_PADEN: join(HUB_MAP, 'sets', 'paden.voorbeeld.json'), ...env,
    },
  });
  let uit = '';
  /** @type {(() => void)[]} */
  const luister = [];
  const lees = (/** @type {Buffer} */ b) => { uit += String(b); for (const f of luister.splice(0)) f(); };
  p.stdout?.on('data', lees);
  p.stderr?.on('data', lees);
  const einde = new Promise((goed) => p.on('exit', (code, sein) => goed({ code, sein })));
  /** @type {HubProces} */
  const h = {
    p, pid: /** @type {number} */ (p.pid), uitvoer: () => uit, einde,
    sein: (s) => { try { p.kill(s); } catch { /* al weg */ } },
    wachtOp: (re, wachtMs = 10000) => new Promise((goed, fout) => {
      const t = setTimeout(() => fout(new Error(`niet gezien: ${re} in\n${uit}`)), wachtMs);
      const kijk = () => { const m = re.exec(uit); if (m) { clearTimeout(t); goed(m[0]); } else luister.push(kijk); };
      kijk();
    }),
  };
  levend.add(h);
  void einde.then(() => levend.delete(h));
  if (klaar) await h.wachtOp(klaar, ms);
  return h;
}

/**
 * De hub zelf: zonder MIDI, zonder drivers (geen /home/user/av-scene-kit enz. nodig), op een vaste poort.
 * Zonder `config`: een eigen config.json naast het geheugen, zonder avondmap.
 * @param {{ poort: number, staat: string|null, config?: string, extra?: string[], env?: Record<string, string>, klaar?: RegExp|null }} o
 */
export function startHubProces({ poort, staat, config, extra = [], env, klaar }) {
  const cfg = config ?? maakConfig(staat ? dirname(staat) : maakMap());
  return startCli({ args: ['start', '--zonder-midi', '--geen-drivers', '--poort', String(poort), ...extra], staat, config: cfg, env, klaar });
}

/** Ruim op wat nog leeft (alleen eigen processen, via hun pid), en de tijdelijke mappen. */
export async function ruimProcessenOp() {
  for (const h of [...levend]) { h.sein('SIGKILL'); await h.einde; }
  for (const m of mappen.splice(0)) rmSync(m, { recursive: true, force: true });
}

/**
 * Een cockpit over WebSocket: houdt het laatste beeld bij en alle LED-standen (samengevoegd).
 * @param {number} poort
 */
export function cockpit(poort) {
  return new Promise((goed, fout) => {
    const ws = new WebSocket(`ws://127.0.0.1:${poort}/cockpit`);
    const c = {
      /** @type {any} */ beeld: null,
      /** @type {Record<string, any>} */ leds: {},
      /** @param {object} b */ stuur: (b) => ws.send(JSON.stringify(b)),
      /** Virtuele APC- of LPD8-bytes, alsof ze van USB kwamen. @param {'apc40'|'lpd8'} dev @param {number[]} bytes */
      virtueel: (dev, bytes) => ws.send(JSON.stringify({ t: 'virtueel', dev, bytes })),
      sluit: () => ws.close(),
    };
    ws.on('message', (d) => {
      const b = JSON.parse(String(d));
      if (b.t === 'beeld') { c.beeld = b; goed(c); }
      if (b.t === 'leds') Object.assign(c.leds, b.staat);
    });
    ws.on('error', fout);
  });
}

/**
 * Een set met één nep-app (tools/nep-app.mjs) die de set zelf start, zonder poort (alleen te herkennen aan zijn
 * proces), met een beginsnapshot en focus. Alles in `map`.
 * @param {string} map @param {number} poort
 */
export function nepSet(map, poort) {
  const config = maakConfig(map, { apps: { 'nep-a': { naam: 'Nep A', kleur: '#ff00ff', repo: 'hub' } } });
  const paden = join(map, 'paden.json');
  writeFileSync(paden, JSON.stringify({ hub: HUB_MAP }));
  const setPad = join(map, 'herstartproef.json');
  writeFileSync(setPad, JSON.stringify({
    naam: 'Herstartproef',
    apps: { 'nep-a': { start: { commando: `${JSON.stringify(process.execPath)} tools/nep-app.mjs --url {hub} --app nep-a` }, time_out_s: 20 } },
    snapshot: { 'nep-a': { helder: 0.2 } },
    focus: 'nep-a',
  }));
  return {
    config, staat: join(map, 'staat.json'), env: { VARVE_HUB_PADEN: paden },
    args: ['start', setPad, '--zonder-midi', '--geen-drivers', '--zonder-chrome', '--poort', String(poort)],
    klaar: /Set "Herstartproef": 1\/1 klaar/,
  };
}

/** Leeft procesgroep `pgid` nog (zonder zombies mee te tellen: die zijn gestopt, alleen nog niet opgeruimd)? @param {number} pgid */
export function groepLeeft(pgid) {
  try { process.kill(-pgid, 0); } catch { return false; }
  const ps = execFileSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' });
  return ps.split('\n').some((r) => { const [g, st] = r.trim().split(/\s+/); return Number(g) === pgid && !!st && !st.startsWith('Z'); });
}
