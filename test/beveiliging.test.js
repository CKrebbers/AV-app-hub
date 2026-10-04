// @ts-check
// Beveiliging (golf 5, uit de beveiligingsreview): elke test hier faalde vóór de fix.
//   - /cockpit alleen same-origin of `origins` (niet elke localhost-poort); /app blijft localhost op elke poort
//   - van buiten zonder token: begrensd aantal tegelijk wachtend op een hallo, kortere wachttijd
//   - begrensd aantal verbindingen; snapshotnummer 1..99; inst max 64 tekens
//   - geen framen (clickjacking), redirect blijft op de hub, meerdere cookies: het echte telt
//   - ~/.varve-hub 0700, staat.json 0600
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer, originToegestaan, tokenVanVerzoek, leesVanCockpit, MAX_WACHTEND_PER_ADRES, TOKEN_COOKIE } from '../src/transports/server.js';
import { leesVanApp } from '../src/protocol/berichten.js';
import { lanAdressen, leesOfMaakToken } from '../src/lan.js';
import { schrijfGeheugen } from '../src/opslag.js';
import { NepKern, wachtOp } from './nepkern.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const TOKEN = 'dit-is-het-goede-token-0123456789';
const LAN = lanAdressen()[0];
const UNIX = process.platform !== 'win32';

/** @type {string} */ let uiMap;
/** @type {NepKern} */ let kern;
/** @type {Awaited<ReturnType<typeof startServer>>} */ let srv;
/** @type {(() => void)[]} */ let opruimen;

/** @param {string} host @param {string} pad @param {Record<string, string>} [headers] */
function haal(host, pad, headers = {}) {
  return new Promise((goed, fout) => {
    const req = http.request({ host, port: srv.poort, path: pad, headers }, (res) => {
      res.resume();
      res.on('end', () => goed({ status: res.statusCode, kop: res.headers }));
    });
    req.on('error', fout);
    req.end();
  });
}

/** @param {string} url @param {object} [opties] */
function client(url, opties = {}) {
  const ws = new WebSocket(url, opties);
  const c = { ws, open: false, code: /** @type {number|null} */ (null), status: /** @type {number|null} */ (null), weg: false };
  ws.on('open', () => { c.open = true; });
  ws.on('close', (code) => { c.code = code; c.weg = true; });
  ws.on('error', () => { c.weg = true; });
  ws.on('unexpected-response', (_req, res) => { c.status = res.statusCode; c.weg = true; ws.terminate(); });
  opruimen.push(() => ws.terminate());
  return c;
}

function vrijePoort() {
  return new Promise((goed) => {
    const s = net.createServer().listen(0, '0.0.0.0', () => { const p = /** @type {net.AddressInfo} */ (s.address()).port; s.close(() => goed(p)); });
  });
}

/** @param {object} [extra] */
async function start(extra = {}) {
  uiMap = mkdtempSync(join(tmpdir(), 'varve-sec-ui-'));
  writeFileSync(join(uiMap, 'index.html'), '<!doctype html><title>Cockpit</title>');
  kern = new NepKern();
  srv = await startServer({ poort: await vrijePoort(), kern, uiMap, srcMap: SRC, ...extra });
}

beforeEach(() => { opruimen = []; });
afterEach(async () => {
  for (const f of opruimen) { try { f(); } catch { /* dicht */ } }
  await srv?.stop();
  if (uiMap) rmSync(uiMap, { recursive: true, force: true });
});

describe('beveiliging: losse regels', () => {
  it('/cockpit: geen willekeurige localhost-poort meer; same-origin en `origins` wel. /app: localhost op elke poort', () => {
    for (const o of ['http://localhost:9999', 'https://127.0.0.1:1', 'HTTP://LOCALHOST:1', 'http://127.0.0.1:5173'])
      expect(originToegestaan(o, [], 'localhost:7700', { cockpit: true }), o).toBe(false);
    expect(originToegestaan('http://localhost:7700', [], 'localhost:7700', { cockpit: true })).toBe(true);
    expect(originToegestaan('http://127.0.0.1:7700', [], '127.0.0.1:7700', { cockpit: true })).toBe(true);
    expect(originToegestaan('https://cockpit.example', ['https://cockpit.example'], 'localhost:7700', { cockpit: true })).toBe(true);
    expect(originToegestaan(undefined, [], 'localhost:7700', { cockpit: true })).toBe(true);   // Node-client
    for (const o of ['http://localhost:5174', 'http://127.0.0.1:8080']) expect(originToegestaan(o, [], 'localhost:7700'), o).toBe(true);
  });
  it('meerdere token-cookies: één goede is genoeg (een vals cookie van een andere dienst sluit niet buiten)', () => {
    const req = /** @type {any} */ ({ url: '/', headers: { cookie: `${TOKEN_COOKIE}=${TOKEN}; ${TOKEN_COOKIE}=fout` } });
    expect(tokenVanVerzoek(req).uitKoekjes).toEqual([TOKEN, 'fout']);
  });
  it('snapshotnummer 1..99 vanuit de cockpit; inst max 64 tekens', () => {
    expect(leesVanCockpit(JSON.stringify({ t: 'snapshot', nr: 99, actie: 'bewaar' }))).toMatchObject({ ok: true });
    expect(leesVanCockpit(JSON.stringify({ t: 'snapshot', nr: 100, actie: 'bewaar' }))).toMatchObject({ ok: false });
    expect(leesVanCockpit(JSON.stringify({ t: 'snapshot', nr: 1e6, actie: 'bewaar' }))).toMatchObject({ ok: false });
    expect(leesVanApp(JSON.stringify({ t: 'hallo', app: 'x', inst: 'a'.repeat(64), v: 1 }))).toMatchObject({ ok: true });
    expect(leesVanApp(JSON.stringify({ t: 'hallo', app: 'x', inst: 'a'.repeat(65), v: 1 }))).toMatchObject({ ok: false });
  });
  it.skipIf(!UNIX)('~/.varve-hub wordt 0700, ook als het geheugen de map eerder aanmaakte; staat.json is 0600', () => {
    const home = mkdtempSync(join(tmpdir(), 'varve-sec-home-'));
    try {
      const map = join(home, '.varve-hub');
      mkdirSync(map, { mode: 0o755 });
      schrijfGeheugen(join(map, 'staat.json'), { v: 1, snapshots: {}, waarden: {} });
      expect(statSync(join(map, 'staat.json')).mode & 0o777).toBe(0o600);
      leesOfMaakToken({ home });
      expect(statSync(map).mode & 0o777).toBe(0o700);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('beveiliging: de server lokaal', () => {
  it('HTML en API mogen niet in een frame van een andere site (clickjacking), geen Referer naar buiten', async () => {
    await start();
    for (const pad of ['/', '/api/beeld', '/bestaat-niet']) {
      const r = /** @type {any} */ (await haal('127.0.0.1', pad));
      expect(r.kop['x-frame-options'], pad).toBe('DENY');
      expect(r.kop['content-security-policy'], pad).toBe("frame-ancestors 'none'");
      expect(r.kop['referrer-policy'], pad).toBe('no-referrer');
    }
  });
  it('/cockpit vanaf een andere localhost-poort → 403; /app vanaf zo\'n poort (een app-dev-server) mag', async () => {
    await start();
    const vreemd = client(`ws://127.0.0.1:${srv.poort}/cockpit`, { origin: 'http://localhost:9999' });
    await wachtOp(() => vreemd.weg);
    expect(vreemd.status).toBe(403);
    const zelf = client(`ws://127.0.0.1:${srv.poort}/cockpit`, { origin: `http://127.0.0.1:${srv.poort}` });
    await wachtOp(() => zelf.open);
    const app = client(`ws://127.0.0.1:${srv.poort}/app`, { origin: 'http://localhost:5174' });
    await wachtOp(() => app.open);
  });
  it('meer verbindingen dan maxKlanten: de volgende krijgt 503', async () => {
    await start({ maxKlanten: 3 });
    const c = [0, 1, 2].map(() => client(`ws://127.0.0.1:${srv.poort}/app`));
    await wachtOp(() => c.every((x) => x.open));
    const teVeel = client(`ws://127.0.0.1:${srv.poort}/cockpit`);
    await wachtOp(() => teVeel.weg);
    expect(teVeel.status).toBe(503);
  });
});

describe.skipIf(!LAN)(`beveiliging: van buiten (LAN-adres ${LAN ?? 'ontbreekt'})`, () => {
  it(`zonder token wachten er hooguit ${MAX_WACHTEND_PER_ADRES} per adres op een hallo; de rest gaat meteen dicht; een cockpit met token komt er nog in`, async () => {
    await start({ host: '0.0.0.0', token: TOKEN, halloMs: 60000 });
    const c = Array.from({ length: 12 }, () => client(`ws://${LAN}:${srv.poort}/app`));
    await wachtOp(() => c.filter((x) => x.open).length >= MAX_WACHTEND_PER_ADRES && c.filter((x) => x.weg && !x.open).length >= 12 - MAX_WACHTEND_PER_ADRES);
    expect(c.filter((x) => x.open && !x.weg)).toHaveLength(MAX_WACHTEND_PER_ADRES);
    const cockpit = client(`ws://${LAN}:${srv.poort}/cockpit?token=${TOKEN}`, { origin: `http://${LAN}:${srv.poort}` });
    await wachtOp(() => cockpit.open);
    // een wachtende die een hallo met token stuurt, maakt zijn plek vrij
    const eerste = /** @type {any} */ (c.find((x) => x.open && !x.weg));
    eerste.ws.send(JSON.stringify({ t: 'hallo', app: 'formula-lab', inst: 'i1', v: 1, token: TOKEN }));
    await wachtOp(() => kern.van('verbind').length >= 1);
    const nog = client(`ws://${LAN}:${srv.poort}/app`);
    await wachtOp(() => nog.open);
  });
  it('de 302 die het token uit de URL haalt, blijft op de hub (geen //ander.domein)', async () => {
    await start({ host: '0.0.0.0', token: TOKEN });
    for (const pad of [`/.//evil.com/x?token=${TOKEN}`, `//evil.com/x?token=${TOKEN}`]) {
      const r = /** @type {any} */ (await haal(/** @type {string} */ (LAN), pad, { accept: 'text/html' }));
      expect(r.status, pad).toBe(302);
      expect(r.kop.location, pad).toMatch(/^\/[^/\\]/);
    }
  });
  it('een vals cookie naast het echte sluit de tablet niet buiten', async () => {
    await start({ host: '0.0.0.0', token: TOKEN });
    const r = /** @type {any} */ (await haal(/** @type {string} */ (LAN), '/', { cookie: `${TOKEN_COOKIE}=${TOKEN}; ${TOKEN_COOKIE}=fout` }));
    expect(r.status).toBe(200);
  });
});
