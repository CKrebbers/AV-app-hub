// De opdrachtregel voor het netwerk: `start --lan`, `token`, `installeer`. Elk in een eigen tijdelijke HOME,
// zodat ~/.varve-hub/token en de dienstbestanden nooit in de echte thuismap belanden.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHub } from '../src/hub.js';
import { laadConfig } from '../src/config.js';
import { NepSysteem } from '../src/ports/nep.js';
import { NepKlok } from '../src/core/klok.js';
import { lanAdressen } from '../src/lan.js';
import { wachtOp } from './nepkern.js';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(HUB, 'src', 'cli.js');
const LAN = lanAdressen()[0];

// Geeft src/hub.js het token door aan de server? (Zo niet, dan weigert `start --lan` netjes; zie open vraag.)
const proef = await startHub({ config: laadConfig(), systeem: new NepSysteem(), klok: new NepKlok(), poort: 0, host: '127.0.0.1', drivers: false, ...{ token: 'proef-token-0123456789abcdef' } });
const HUB_GEEFT_TOKEN_DOOR = proef.server.tokenVereist === true;
await proef.stop();

/** @type {string} */ let home;
/** @type {import('node:child_process').ChildProcess[]} */ let processen;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'varve-cli-home-')); processen = []; });
afterEach(() => { for (const p of processen) p.kill('SIGKILL'); rmSync(home, { recursive: true, force: true }); });

/** @param {string[]} args */
function start(args) {
  const p = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home } });
  processen.push(p);
  const r = { p, uit: '', fout: '', code: /** @type {number|null|undefined} */ (undefined) };
  p.stdout?.on('data', (d) => { r.uit += d; });
  p.stderr?.on('data', (d) => { r.fout += d; });
  p.on('exit', (code) => { r.code = code; });
  return r;
}
/** @param {string[]} args */
async function draai(args) { const r = start(args); await wachtOp(() => r.code !== undefined, 8000); return r; }

/** @returns {Promise<number>} */
const vrijePoort = () => new Promise((goed) => { const s = net.createServer().listen(0, '0.0.0.0', () => { const p = /** @type {net.AddressInfo} */ (s.address()).port; s.close(() => goed(p)); }); });
/** @param {string} host @param {number} poort @param {string} pad @returns {Promise<number|undefined>} */
const status = (host, poort, pad) => new Promise((goed, fout) => {
  http.get({ host, port: poort, path: pad }, (res) => { res.resume(); goed(res.statusCode); }).on('error', fout);
});
const tokenBestand = () => join(home, '.varve-hub', 'token');

describe('varve-hub start --lan', () => {
  it.skipIf(!HUB_GEEFT_TOKEN_DOOR || !LAN)('luistert op het netwerk, maakt het token (0600) en eist het van buiten', async () => {
    const poort = await vrijePoort();
    const r = start(['start', '--lan', '--zonder-midi', '--geen-drivers', '--poort', String(poort)]);
    await wachtOp(() => /varve-hub draait/.test(r.uit), 8000);
    expect(statSync(tokenBestand()).mode & 0o777).toBe(0o600);
    const token = readFileSync(tokenBestand(), 'utf8').trim();
    expect(r.uit).toMatch(/Nieuw token aangemaakt/);
    expect(r.uit).not.toContain(token);                       // geen terminal: het token niet in het logboek
    expect(r.uit).toMatch(/varve-hub token/);
    expect(r.uit).toMatch(/mDNS/);
    expect(await status('127.0.0.1', poort, '/')).toBe(200);
    expect(await status(/** @type {string} */ (LAN), poort, '/')).toBe(401);
    expect(await status(/** @type {string} */ (LAN), poort, `/?token=${token}`)).toBe(200);
    r.p.kill('SIGTERM');
    await wachtOp(() => r.code !== undefined, 5000);
    expect(r.code).toBe(0);
  });

  it.skipIf(!HUB_GEEFT_TOKEN_DOOR || !LAN)('een --host die niet loopback is krijgt ook een token (geen open hub per ongeluk)', async () => {
    const poort = await vrijePoort();
    const r = start(['start', '--host', '0.0.0.0', '--zonder-midi', '--geen-drivers', '--poort', String(poort)]);
    await wachtOp(() => /varve-hub draait/.test(r.uit), 8000);
    expect(existsSync(tokenBestand())).toBe(true);
    expect(await status(/** @type {string} */ (LAN), poort, '/api/beeld')).toBe(401);
  });

  it.skipIf(HUB_GEEFT_TOKEN_DOOR)('vangnet: geeft de hub het token niet door, dan stopt --lan met een uitleg (nooit open op het netwerk)', async () => {
    const r = await draai(['start', '--lan', '--zonder-midi', '--geen-drivers', '--poort', String(await vrijePoort())]);
    expect(r.code).toBe(4);
    expect(r.fout).toMatch(/token niet door/);
  });

  it('zonder --lan: alleen lokaal, geen token aangemaakt', async () => {
    const r = start(['start', '--zonder-midi', '--geen-drivers', '--poort', String(await vrijePoort())]);
    await wachtOp(() => /varve-hub draait/.test(r.uit), 8000);
    expect(r.uit).toMatch(/Cockpit: http:\/\/127\.0\.0\.1:/);
    expect(existsSync(tokenBestand())).toBe(false);
  });
});

describe('varve-hub token', () => {
  it('toont het token, de cockpit-adressen en de VARVE_HUB-regel voor flux; --nieuw maakt een ander', async () => {
    const r = await draai(['token']);
    expect(r.code).toBe(0);
    const token = readFileSync(tokenBestand(), 'utf8').trim();
    expect(r.uit).toContain(`Token: ${token}`);
    expect(r.uit).toMatch(new RegExp(`http://[^\\s]+:7700/\\?token=${token}`));
    expect(r.uit).toMatch(new RegExp(`VARVE_HUB=ws://[^\\s]+:7700/app\\?token=${token}`));
    const n = await draai(['token', '--nieuw']);
    expect(readFileSync(tokenBestand(), 'utf8').trim()).not.toBe(token);
    expect(n.uit).toMatch(/herstart de hub/);
  });
});

describe('varve-hub installeer', () => {
  const root = process.getuid?.() === 0;
  it.skipIf(root)('schrijft de systemd-user-unit met deze checkout en zegt hoe te laden; --weg haalt hem weg', async () => {
    const r = await draai(['installeer']);
    expect(r.code).toBe(0);
    const pad = join(home, '.config', 'systemd', 'user', 'varve-hub.service');
    expect(readFileSync(pad, 'utf8')).toContain(`"${CLI}" "start" "--lan"`);
    expect(r.uit).toMatch(/systemctl --user daemon-reload && systemctl --user enable --now varve-hub\.service/);
    const w = await draai(['installeer', '--weg']);
    expect(w.code).toBe(0);
    expect(existsSync(pad)).toBe(false);
  });
  it.skipIf(!root)('als root: weigert (nooit sudo), schrijft niets', async () => {
    const r = await draai(['installeer']);
    expect(r.code).toBe(1);
    expect(r.fout).toMatch(/niet als root of met sudo/);
    expect(existsSync(join(home, '.config'))).toBe(false);
  });
});

describe('docs/NETWERK.md klopt met de opdrachtregel', () => {
  it('noemt alleen opdrachten die bestaan, en de hulp noemt --lan, installeer en token', async () => {
    const doc = readFileSync(join(HUB, 'docs', 'NETWERK.md'), 'utf8');
    expect(JSON.parse(readFileSync(join(HUB, 'package.json'), 'utf8')).scripts.start).toBe('node src/cli.js start');
    expect(doc).toContain('npm start -- --lan');
    for (const o of ['token', 'token --nieuw', 'installeer', 'installeer --weg', 'installeer --lokaal']) expect(doc).toContain(o);
    expect(doc).not.toMatch(/^\s*varve-hub /m);                // zonder npm link bestaat `varve-hub` niet
    const hulp = await draai(['help']);
    for (const w of ['--lan', 'installeer', 'token']) expect(hulp.uit).toContain(w);
  });
});
