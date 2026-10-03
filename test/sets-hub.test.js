// @ts-check
// De starter tegen de echte hub (startHub, WebSocket-apps uit tools/nep-app.mjs), de cockpit-toegang naar een
// hub die al draaide, en de echte proces- en poortfuncties.
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startHub } from '../src/hub.js';
import { NepSysteem } from '../src/ports/nep.js';
import { laadConfig } from '../src/config.js';
import { echteKlok } from '../src/core/klok.js';
import { NepApp, voorbeeldManifest } from '../tools/nep-app.mjs';
import { EventEmitter } from 'node:events';
import { startSet, kernToegang, cockpitToegang, startProces, poortOpen, openInChrome } from '../src/sets/index.js';

const wacht = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @template T @param {() => T} fn */
const tot = async (fn, ms = 3000) => { const eind = Date.now() + ms; while (Date.now() < eind) { const x = fn(); if (x) return x; await wacht(10); } return fn(); };
/** @type {(() => Promise<void>|void)[]} */
const opruimen = [];
afterEach(async () => { for (const f of opruimen.splice(0).reverse()) await f(); });

const config = laadConfig();

async function hub() {
  const h = await startHub({ config, systeem: new NepSysteem(), poort: 0, drivers: false });
  opruimen.push(() => h.stop());
  const poort = Number(new URL(h.adres).port);
  return { h, poort, url: `ws://localhost:${poort}/app` };
}

/** Een "proces" dat een echte WebSocket-app start (nep-app), zoals `npm run dev` + de tab met ?hub= samen. */
function nepAppStarter() {
  /** @type {{ commando: string, app: NepApp }[]} */
  const gestart = [];
  /** @type {import('../src/sets/systeem.js').StartProces} */
  const start = ({ commando, omgeving }) => {
    const app = new NepApp({ url: omgeving.HUB, manifest: voorbeeldManifest(omgeving.APP) }).start();
    gestart.push({ commando, app });
    let levend = true;
    return { pid: 1, bij: () => {}, leeft: () => levend, stop: () => { levend = false; app.stop(); } };
  };
  return { gestart, start };
}

/** @param {string} app */
const setVoor = (app) => ({
  naam: 'Proef',
  apps: { [app]: { start: { commando: 'nep', omgeving: { HUB: '{hub}', APP: app } } } },
  snapshot: { [app]: { helder: 0.2, palet: 1 } },
  focus: app,
});

describe('starter met de echte hub', () => {
  it('in hetzelfde proces: app start, meldt zich over WebSocket, krijgt de snapshot en de focus', async () => {
    const { h, poort, url } = await hub();
    const n = nepAppStarter();
    const andere = new NepApp({ url, manifest: voorbeeldManifest('flux') }).start();  // was er eerst: krijgt de focus vanzelf
    opruimen.push(() => andere.stop());
    await tot(() => h.kern.beeld().focus === 'flux');
    const s = startSet({ set: setVoor('td-lab'), config, paden: { 'td-lab': tmpdir() }, hub: kernToegang(h.kern), hubPoort: poort, klok: echteKlok, startProces: n.start, openUrl: () => {}, poortOpen, tikMs: 20, rustMs: 50 });
    opruimen.push(() => s.stop());
    const u = await s.klaar;
    expect(u).toEqual([{ app: 'td-lab', hoe: 'gestart', klaar: true, melding: 'klaar' }]);
    const app = n.gestart[0].app;
    await tot(() => app.waarden.palet === 1);
    expect(app.waarden).toMatchObject({ helder: 0.2, palet: 1 });
    expect(app.ontvangen.filter((b) => b.t === 'zet').every((b) => b.bron === 'cockpit')).toBe(true);
    await tot(() => app.ontvangen.some((b) => b.t === 'focus' && b.aan));
    expect(h.kern.beeld().focus).toBe('td-lab');
    await s.stop();
    await tot(() => h.kern.beeld().apps.find((a) => a.app === 'td-lab')?.status === 'weg');
    expect(h.kern.beeld().apps.find((a) => a.app === 'flux')?.status).toBe('actief');  // niet van de starter: blijft
  });

  it('naast een hub die al draaide (als cockpit): zelfde uitkomst; een app die al verbonden was, start niet opnieuw', async () => {
    const { h, poort, url } = await hub();
    const al = new NepApp({ url, manifest: voorbeeldManifest('flux') }).start();
    opruimen.push(() => al.stop());
    await tot(() => h.kern.beeld().apps.length === 1);
    const toegang = await cockpitToegang(`ws://localhost:${poort}/cockpit`);
    opruimen.push(() => toegang.sluit());
    const n = nepAppStarter();
    const set = { ...setVoor('td-lab'), apps: { flux: { start: { commando: 'mag niet', omgeving: { HUB: '{hub}', APP: 'flux' } } }, ...setVoor('td-lab').apps } };
    const s = startSet({ set, config, paden: { 'td-lab': tmpdir(), 'flux-screensaver': tmpdir() }, hub: toegang, hubPoort: poort, klok: echteKlok, startProces: n.start, openUrl: () => {}, poortOpen, tikMs: 20, rustMs: 300 });
    opruimen.push(() => s.stop());
    const u = await s.klaar;
    expect(u.map((x) => [x.app, x.hoe, x.klaar])).toEqual([['flux', 'al verbonden', true], ['td-lab', 'gestart', true]]);
    expect(n.gestart.map((x) => x.commando)).toEqual(['nep']);
    const app = n.gestart[0].app;
    await tot(() => app.waarden.palet === 1 && h.kern.beeld().focus === 'td-lab');
    expect(app.waarden.helder).toBe(0.2);
    expect(h.kern.beeld().focus).toBe('td-lab');
  });

  it('cockpitToegang: geen hub op die poort → duidelijke fout', async () => {
    const vrij = net.createServer();
    await new Promise((r) => vrij.listen(0, '127.0.0.1', () => r(undefined)));
    const p = /** @type {net.AddressInfo} */ (vrij.address()).port;
    await new Promise((r) => vrij.close(() => r(undefined)));
    await expect(cockpitToegang(`ws://localhost:${p}/cockpit`, { ms: 1000 })).rejects.toThrow(/kan niet verbinden met de hub op ws:\/\/localhost:\d+\/cockpit|geen beeld van de hub/);
  });
});

describe.skipIf(process.platform === 'win32')('echte processen en poorten', () => {
  it('startProces: omgeving komt aan, uitvoer komt binnen, code 0 bij een kort commando', async () => {
    const p = startProces({ commando: 'echo "hub=$VARVE_TEST_HUB"', cwd: tmpdir(), omgeving: { VARVE_TEST_HUB: 'ws://localhost:1/app' } });
    let uit = '';
    /** @type {any} */
    let einde = null;
    p.bij('uitvoer', (t) => { uit += t; });
    p.bij('einde', (e) => { einde = e; });
    await tot(() => einde);
    expect(einde.code).toBe(0);
    expect(uit).toMatch(/hub=ws:\/\/localhost:1\/app/);
  });

  it('startProces: wat een startscript op de achtergrond zette (zoals uurwerk/start.sh), stopt mee met de groep', async () => {
    const map = mkdtempSync(join(tmpdir(), 'starter-'));
    // Het script zet een lang lopend proces op de achtergrond en stopt zelf meteen met code 0.
    const p = startProces({ commando: `(node -e "setInterval(() => {}, 1000)" & echo $! > "${map}/pid") ; exit 0`, cwd: map, omgeving: {} });
    opruimen.push(() => p.stop('SIGKILL'));
    /** @type {any} */
    let einde = null;
    p.bij('einde', (e) => { einde = e; });
    await tot(() => einde && existsSync(join(map, 'pid')));
    expect(einde.code).toBe(0);
    const pid = Number(readFileSync(join(map, 'pid'), 'utf8'));
    const leeftPid = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(leeftPid()).toBe(true);
    expect(p.leeft()).toBe(true);                      // de groep leeft nog
    p.stop();
    await tot(() => !leeftPid());
    expect(leeftPid()).toBe(false);
    await tot(() => !p.leeft());
    expect(p.leeft()).toBe(false);
  });

  it('openInChrome: macOS open -a "Google Chrome", Linux xdg-open; een fout wordt een melding, geen crash', async () => {
    /** @type {any[]} */
    const aanroepen = [];
    const nep = (/** @type {number} */ code) => /** @type {any} */ ((/** @type {string} */ cmd, /** @type {string[]} */ a) => {
      aanroepen.push([cmd, ...a]);
      const p = Object.assign(new EventEmitter(), { unref() {} });
      setImmediate(() => p.emit('exit', code));
      return p;
    });
    await openInChrome('darwin', nep(0))('http://localhost:5174/?hub=ws://localhost:7700/app');
    await openInChrome('linux', nep(0))('http://x/');
    expect(aanroepen).toEqual([['open', '-a', 'Google Chrome', 'http://localhost:5174/?hub=ws://localhost:7700/app'], ['xdg-open', 'http://x/']]);
    await expect(openInChrome('linux', nep(3))('http://x/')).rejects.toThrow(/xdg-open stopte met code 3/);
  });

  it('poortOpen: true als er iets luistert, false als niet', async () => {
    const s = net.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', () => r(undefined)));
    const p = /** @type {net.AddressInfo} */ (s.address()).port;
    expect(await poortOpen(p)).toBe(true);
    await new Promise((r) => s.close(() => r(undefined)));
    expect(await poortOpen(p)).toBe(false);
  });
});
