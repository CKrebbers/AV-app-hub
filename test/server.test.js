import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer, originToegestaan, veiligPad, leesVanCockpit, CockpitUitzender, MAX_BERICHT } from '../src/transports/server.js';
import { NepApp, voorbeeldManifest } from '../tools/nep-app.mjs';
import { NepKern, wachtOp } from './nepkern.js';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(HUB, 'src');

/** @type {string} */ let uiMap;
/** @type {NepKern} */ let kern;
/** @type {Awaited<ReturnType<typeof startServer>>} */ let srv;
/** @type {{ dev: string, bytes: number[] }[]} */ let virtueel;
/** @type {(() => void)[]} */ let opruimen;

const wsUrl = (pad) => srv.adres.replace(/^http/, 'ws') + pad;

/** Een ws-client die alles wat binnenkomt bewaart. */
function client(pad, opties = {}) {
  const ws = new WebSocket(wsUrl(pad), opties);
  const berichten = [];
  const c = { ws, berichten, code: /** @type {number|null} */ (null), fout: /** @type {Error|null} */ (null), status: /** @type {number|null} */ (null) };
  ws.on('message', (d) => { try { berichten.push(JSON.parse(String(d))); } catch { berichten.push(String(d)); } });
  ws.on('close', (code) => { c.code = code; });
  ws.on('error', (e) => { c.fout = e; });
  ws.on('unexpected-response', (_req, res) => { c.status = res.statusCode; ws.terminate?.(); });
  opruimen.push(() => ws.terminate());
  return c;
}
const open = (c) => new Promise((goed, fout) => { if (c.ws.readyState === WebSocket.OPEN) goed(c); c.ws.once('open', () => goed(c)); c.ws.once('error', fout); });
const stuur = (c, b) => c.ws.send(typeof b === 'string' ? b : JSON.stringify(b));
const vind = (c, t) => c.berichten.find((b) => b.t === t);
const alle = (c, t) => c.berichten.filter((b) => b.t === t);

/** Rauwe HTTP-GET zonder padnormalisatie. */
function haal(pad, methode = 'GET') {
  const u = new URL(srv.adres);
  return new Promise((goed, fout) => {
    const req = http.request({ host: u.hostname, port: u.port, path: pad, method: methode }, (res) => {
      let lijf = '';
      res.on('data', (d) => { lijf += d; });
      res.on('end', () => goed({ status: res.statusCode, type: res.headers['content-type'], lijf }));
    });
    req.on('error', fout);
    req.end();
  });
}

beforeEach(async () => {
  uiMap = mkdtempSync(join(tmpdir(), 'varve-ui-'));
  writeFileSync(join(uiMap, 'index.html'), '<!doctype html><title>Cockpit</title>');
  mkdirSync(join(uiMap, 'css'));
  writeFileSync(join(uiMap, 'css', 'stijl.css'), 'body{}');
  writeFileSync(join(uiMap, 'app.js'), 'export {}');
  kern = new NepKern();
  virtueel = [];
  opruimen = [];
  srv = await startServer({ poort: 0, kern, uiMap, srcMap: SRC, opVirtueel: (dev, bytes) => virtueel.push({ dev, bytes }), origins: ['https://cockpit.example'] });
});

afterEach(async () => {
  for (const f of opruimen) { try { f(); } catch { /* al dicht */ } }
  await srv.stop();
  rmSync(uiMap, { recursive: true, force: true });
});

describe('server: opstarten', () => {
  it('luistert standaard alleen op 127.0.0.1', () => {
    expect(srv.adres).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(srv.poort).toBeGreaterThan(0);
  });
  it('stop() is herhaalbaar en meldt kern-events af', async () => {
    expect(kern.luisteraars('beeld')).toBe(1);
    expect(kern.luisteraars('leds')).toBe(1);
    expect(kern.luisteraars('invoer')).toBe(1);
    await srv.stop();
    await srv.stop();
    expect(kern.luisteraars('beeld')).toBe(0);
    expect(kern.luisteraars('leds')).toBe(0);
    expect(kern.luisteraars('invoer')).toBe(0);
  });
  it('bezette poort → startServer weigert netjes', async () => {
    await expect(startServer({ poort: srv.poort, kern: new NepKern(), uiMap, srcMap: SRC })).rejects.toThrow();
  });
});

describe('server: HTTP', () => {
  it('GET / geeft de cockpit (ui/index.html)', async () => {
    const r = await haal('/');
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/text\/html/);
    expect(r.lijf).toContain('Cockpit');
  });
  it('GET /ui/<pad> serveert statische bestanden met de juiste MIME', async () => {
    expect(await haal('/ui/css/stijl.css')).toMatchObject({ status: 200, type: expect.stringMatching(/text\/css/), lijf: 'body{}' });
    expect(await haal('/ui/app.js')).toMatchObject({ status: 200, type: expect.stringMatching(/text\/javascript/) });
    expect(await haal('/ui/')).toMatchObject({ status: 200, lijf: expect.stringContaining('Cockpit') });
    expect((await haal('/ui/bestaat-niet.js')).status).toBe(404);
  });
  it('HEAD werkt zonder lijf', async () => {
    expect(await haal('/ui/app.js', 'HEAD')).toMatchObject({ status: 200, lijf: '' });
  });
  it('GET /src/devices en /src/protocol: alleen die twee mappen', async () => {
    const apc = await haal('/src/devices/apc40mk2.js');
    expect(apc.status).toBe(200);
    expect(apc.type).toMatch(/text\/javascript/);
    expect(apc.lijf).toContain('CONTROLS');
    expect((await haal('/src/protocol/berichten.js')).status).toBe(200);
    expect((await haal('/src/core/klok.js')).status).toBe(404);
    expect((await haal('/src/transports/server.js')).status).toBe(404);
    expect((await haal('/src/devices/bestaat-niet.js')).status).toBe(404);
    expect((await haal('/src/devices/')).status).toBe(404);
  });
  it('geen pad-traversal', async () => {
    for (const pad of [
      '/ui/../../package.json', '/ui/%2e%2e/%2e%2e/package.json', '/ui/..%2f..%2fpackage.json',
      '/ui/%2e%2e%5c%2e%2e%5cpackage.json', '/ui/%00index.html', '/src/devices/../config.js',
      '/src/devices/..%2fconfig.js', '/src/devices/%2e%2e%2fcore%2fklok.js', '/src/protocol/../../package.json',
      '/ui//etc/passwd', '/ui/%2fetc%2fpasswd',
    ]) {
      const r = await haal(pad);
      expect([400, 404], pad).toContain(r.status);
      expect(r.lijf, pad).not.toContain('varve-hub');
      expect(r.lijf, pad).not.toContain('root:');
    }
    expect((await haal('/ui/%E0%A4%A')).status).toBe(400);
  });
  it('GET /api/beeld geeft kern.beeld() als JSON', async () => {
    kern.huidigBeeld.focus = 'nep-app';
    const r = await haal('/api/beeld');
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/application\/json/);
    expect(JSON.parse(r.lijf)).toMatchObject({ focus: 'nep-app', globaal: { grondtoon: 'D' } });
  });
  it('rest is 404, ook andere methodes', async () => {
    expect((await haal('/onzin')).status).toBe(404);
    expect((await haal('/package.json')).status).toBe(404);
    expect((await haal('/api/beeld', 'POST')).status).toBe(404);
  });
  it('kern.beeld() die faalt → 500, server leeft door', async () => {
    const fout = vi.spyOn(console, 'error').mockImplementation(() => {});
    kern.faal.add('beeld');
    expect((await haal('/api/beeld')).status).toBe(500);
    kern.faal.delete('beeld');
    expect((await haal('/api/beeld')).status).toBe(200);
    fout.mockRestore();
  });
});

describe('server: Origin', () => {
  it('originToegestaan', () => {
    expect(originToegestaan(undefined)).toBe(true);
    for (const o of ['http://localhost:7700', 'http://localhost', 'https://localhost:5173', 'http://127.0.0.1:8777', 'https://127.0.0.1'])
      expect(originToegestaan(o), o).toBe(true);
    for (const o of ['https://evil.example', 'http://localhost.evil.example', 'http://127.0.0.1.nip.io', 'null', '', 'file://', 'ws://localhost:7700', 'http://user@localhost', 'http://192.168.1.5:7700', 'http://[::1]:7700'])
      expect(originToegestaan(o), o).toBe(false);
    expect(originToegestaan('https://cockpit.example', ['https://cockpit.example'])).toBe(true);
    expect(originToegestaan('https://cockpit.example:444', ['https://cockpit.example'])).toBe(false);
  });
  it('weigert /app en /cockpit van een vreemde website met 403', async () => {
    for (const pad of ['/app', '/cockpit']) {
      const c = client(pad, { origin: 'https://evil.example' });
      await wachtOp(() => c.status || c.fout);
      expect(c.status, pad).toBe(403);
    }
    expect(kern.van('verbind')).toHaveLength(0);
  });
  it('laat localhost, 127.0.0.1, geen Origin en `origins` toe', async () => {
    for (const origin of ['http://localhost:7700', 'http://127.0.0.1:5173', undefined, 'https://cockpit.example']) {
      const c = client('/app', origin ? { origin } : {});
      await open(c);
      await wachtOp(() => vind(c, 'welkom'));
    }
    expect(kern.van('verbind')).toHaveLength(4);
  });
  it('onbekend WS-pad → 404', async () => {
    const c = client('/iets');
    await wachtOp(() => c.status || c.fout);
    expect(c.status).toBe(404);
  });
});

describe('server: /app', () => {
  it('nep-app: welkom, hallo/manifest/staat naar de kern, zet terug, sluiten → verbreek', async () => {
    const app = new NepApp({ url: wsUrl('/app'), herverbind: false }).start();
    opruimen.push(() => app.stop());
    await wachtOp(() => kern.ontvangen('staat').length);
    expect(app.ontvangen[0]).toEqual({ t: 'welkom', hub: 'varve-hub', v: 1 });
    expect(kern.van('verbind')).toHaveLength(1);
    expect(kern.ontvangen().map((b) => b.t).slice(0, 3)).toEqual(['hallo', 'manifest', 'staat']);
    expect(kern.ontvangen('hallo')[0]).toMatchObject({ app: 'nep-app', inst: app.inst, v: 1 });
    const v = kern.verbindingVan('nep-app');
    expect(v).not.toBeNull();
    expect(kern.van('verbind')[0].args[0]).toBe(v);
    // geen fout: manifest was geldig
    expect(app.ontvangen.filter((b) => b.t === 'fout')).toHaveLength(0);

    v.stuur({ t: 'zet', id: 'helder', v: 0.75, bron: 'apc40' });
    v.stuur({ t: 'focus', aan: true });
    await wachtOp(() => app.ontvangen.find((b) => b.t === 'focus'));
    expect(app.waarden.helder).toBe(0.75);

    app.zelfZetten('ruimte', 0.9);
    await wachtOp(() => kern.ontvangen('zet').length);
    expect(kern.ontvangen('zet')[0]).toEqual({ t: 'zet', id: 'ruimte', v: 0.9 });

    app.stop();
    await wachtOp(() => kern.van('verbreek').length);
    expect(kern.van('verbreek')[0].args[0]).toBe(v);
    // stuur na sluiten mag niets doen en niet gooien
    expect(() => v.stuur({ t: 'zet', id: 'helder', v: 0 })).not.toThrow();
  });

  it('eerste bericht moet hallo zijn; fouten krijgen {t:fout}; onbekend wordt genegeerd', async () => {
    const c = await open(client('/app'));
    await wachtOp(() => vind(c, 'welkom'));
    stuur(c, { t: 'staat', waarden: { a: 0.5 } });
    await wachtOp(() => vind(c, 'fout'));
    expect(vind(c, 'fout').reden).toMatch(/hallo/);
    expect(kern.van('ontvang')).toHaveLength(0);

    stuur(c, '{kapot');
    stuur(c, '[1,2]');
    stuur(c, { t: 'hallo', app: 'GEEN geldige id', inst: 'x' });
    stuur(c, { t: 'vreemd', iets: 1 });
    await wachtOp(() => alle(c, 'fout').length >= 4);
    expect(alle(c, 'fout').map((f) => f.reden)).toEqual(['eerst hallo sturen', 'geen geldige JSON', 'bericht is geen object', 'hallo: app ontbreekt of ongeldig']);

    stuur(c, { t: 'hallo', app: 'mijn-app', inst: 'abc', v: 1 });
    stuur(c, { t: 'zet', id: 'x', v: 7 });
    stuur(c, { t: 'hb' });
    await wachtOp(() => kern.ontvangen('hb').length);
    expect(kern.ontvangen().map((b) => b.t)).toEqual(['hallo', 'zet', 'hb']);
    expect(kern.ontvangen('zet')[0].v).toBe(1); // geklemd
    expect(alle(c, 'fout')).toHaveLength(4); // vreemd type gaf geen fout
    expect(kern.van('ontvang')[0].args[0].app).toBe('mijn-app');
  });

  it('ongeldig manifest → fout van de kern komt bij de app aan, verbinding blijft open', async () => {
    const c = await open(client('/app'));
    stuur(c, { t: 'hallo', app: 'x', inst: '1' });
    stuur(c, { t: 'manifest', manifest: { v: 2 } });
    await wachtOp(() => vind(c, 'fout'));
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('LED-berichten: mode-SysEx wordt al bij het lezen ingeslikt', async () => {
    const c = await open(client('/app'));
    stuur(c, { t: 'hallo', app: 'dj', inst: '1' });
    stuur(c, { t: 'led', bytes: [[0x90, 32, 5], [0xf0, 0x47, 0x7f, 0x29, 0x60, 0, 4, 0x41, 0, 0, 0, 0xf7]] });
    await wachtOp(() => kern.ontvangen('led').length);
    expect(kern.ontvangen('led')[0].bytes).toEqual([[0x90, 32, 5]]);
  });

  it('te groot bericht → socket dicht (1009), kern.verbreek, server leeft door', async () => {
    const c = await open(client('/app'));
    stuur(c, { t: 'hallo', app: 'groot', inst: '1' });
    stuur(c, { t: 'staat', waarden: { x: 0.5 }, vulsel: 'a'.repeat(MAX_BERICHT + 10) });
    await wachtOp(() => c.code !== null);
    expect(c.code).toBe(1009);
    await wachtOp(() => kern.van('verbreek').length);
    expect(kern.ontvangen('staat')).toHaveLength(0);
    const d = await open(client('/app'));
    await wachtOp(() => vind(d, 'welkom'));
  });

  it('net-onder-de-grens bericht komt gewoon door', async () => {
    const c = await open(client('/app'));
    stuur(c, { t: 'hallo', app: 'groot', inst: '1' });
    stuur(c, { t: 'staat', waarden: { x: 0.5 }, vulsel: 'a'.repeat(MAX_BERICHT - 1000) });
    await wachtOp(() => kern.ontvangen('staat').length);
  });

  it('binaire frames → fout, geen crash', async () => {
    const c = await open(client('/app'));
    c.ws.send(Buffer.from([1, 2, 3]));
    await wachtOp(() => vind(c, 'fout'));
    expect(kern.van('ontvang')).toHaveLength(0);
  });

  it('socket die halverwege wegvalt → verbreek precies één keer', async () => {
    const c = await open(client('/app'));
    stuur(c, { t: 'hallo', app: 'weg', inst: '1' });
    await wachtOp(() => kern.ontvangen('hallo').length);
    c.ws._socket.destroy();
    await wachtOp(() => kern.van('verbreek').length);
    await new Promise((r) => setTimeout(r, 50));
    expect(kern.van('verbreek')).toHaveLength(1);
  });

  it('kern die gooit laat de server niet vallen', async () => {
    const fout = vi.spyOn(console, 'error').mockImplementation(() => {});
    kern.faal.add('ontvang');
    kern.faal.add('verbind');
    kern.faal.add('verbreek');
    const c = await open(client('/app'));
    stuur(c, { t: 'hallo', app: 'a', inst: '1' });
    await wachtOp(() => kern.van('ontvang').length);
    c.ws.close();
    await wachtOp(() => kern.van('verbreek').length);
    kern.faal.clear();
    const d = await open(client('/app'));
    await wachtOp(() => vind(d, 'welkom'));
    expect(fout).toHaveBeenCalled();
    fout.mockRestore();
  });

  it('sluit() van de verbinding sluit de socket', async () => {
    const c = await open(client('/app'));
    await wachtOp(() => kern.van('verbind').length);
    kern.van('verbind')[0].args[0].sluit();
    await wachtOp(() => c.code !== null);
    expect(c.code).toBe(1000);
    await wachtOp(() => kern.van('verbreek').length);
  });

  it('twee nep-apps tegelijk krijgen elk hun eigen verbinding', async () => {
    const a = new NepApp({ url: wsUrl('/app'), manifest: voorbeeldManifest('app-a'), herverbind: false }).start();
    const b = new NepApp({ url: wsUrl('/app'), manifest: voorbeeldManifest('app-b'), herverbind: false }).start();
    opruimen.push(() => a.stop(), () => b.stop());
    await wachtOp(() => kern.verbindingVan('app-a') && kern.verbindingVan('app-b'));
    kern.verbindingVan('app-b').stuur({ t: 'scene', i: 1 });
    await wachtOp(() => b.ontvangen.find((x) => x.t === 'scene'));
    expect(a.ontvangen.find((x) => x.t === 'scene')).toBeUndefined();
  });
});

describe('server: /cockpit', () => {
  it('krijgt bij verbinden het volledige beeld', async () => {
    kern.huidigBeeld.apps = [{ app: 'nep-app', naam: 'Nep', status: 'actief' }];
    const c = await open(client('/cockpit'));
    await wachtOp(() => vind(c, 'beeld'));
    expect(c.berichten[0]).toMatchObject({ t: 'beeld', apps: [{ app: 'nep-app' }], globaal: { bpm: 120 } });
  });

  it('kern-events → beeld (vers), leds en invoer naar alle cockpits', async () => {
    const c1 = await open(client('/cockpit'));
    const c2 = await open(client('/cockpit'));
    await wachtOp(() => vind(c1, 'beeld') && vind(c2, 'beeld'));
    kern.huidigBeeld.focus = 'nieuw';
    kern.meld('beeld');
    kern.meld('leds', { dev: 'apc40', staat: { 'pad1-1': { kleur: 5, anim: 'vol' } } });
    const g = { dev: 'apc40', el: 'fader1', kind: 'waarde', v: 0.5, raw: 64 };
    kern.meld('invoer', g);
    for (const c of [c1, c2]) {
      await wachtOp(() => vind(c, 'invoer'));
      expect(alle(c, 'beeld')).toHaveLength(2);
      expect(alle(c, 'beeld')[1].focus).toBe('nieuw');
      expect(vind(c, 'leds')).toEqual({ t: 'leds', dev: 'apc40', staat: { 'pad1-1': { kleur: 5, anim: 'vol' } } });
      expect(vind(c, 'invoer')).toEqual({ t: 'invoer', g });
    }
  });

  it('virtueel → opVirtueel, met controle op dev en bytes', async () => {
    const c = await open(client('/cockpit'));
    await wachtOp(() => vind(c, 'beeld'));
    stuur(c, { t: 'virtueel', dev: 'apc40', bytes: [0x90, 103, 127] });
    stuur(c, { t: 'virtueel', dev: 'lpd8', bytes: [0xb0, 70, 12] });
    stuur(c, { t: 'virtueel', dev: 'nanokontrol', bytes: [0x90, 1, 1] });
    stuur(c, { t: 'virtueel', dev: 'apc40', bytes: [0x90, 300, 1] });
    stuur(c, { t: 'virtueel', dev: 'apc40', bytes: [0x90, 1.5, 1] });
    stuur(c, { t: 'virtueel', dev: 'apc40', bytes: [] });
    stuur(c, { t: 'virtueel', dev: 'apc40', bytes: 'abc' });
    await wachtOp(() => alle(c, 'fout').length >= 5);
    expect(virtueel).toEqual([{ dev: 'apc40', bytes: [0x90, 103, 127] }, { dev: 'lpd8', bytes: [0xb0, 70, 12] }]);
  });

  it('focus/zet/snapshot → kern.cockpit; onzin → fout of genegeerd', async () => {
    const c = await open(client('/cockpit'));
    await wachtOp(() => vind(c, 'beeld'));
    stuur(c, { t: 'focus', app: 'nep-app' });
    stuur(c, { t: 'focus', app: null });
    stuur(c, { t: 'zet', app: 'nep-app', id: 'helder', v: 1.4 });
    stuur(c, { t: 'snapshot', nr: 2, actie: 'bewaar' });
    stuur(c, { t: 'snapshot', nr: 0, actie: 'laad' });
    stuur(c, { t: 'snapshot', nr: 1, actie: 'wis' });
    stuur(c, { t: 'zet', app: 'nep-app', id: 'helder' });
    stuur(c, '{{{');
    stuur(c, { t: 'onbekend' });
    await wachtOp(() => alle(c, 'fout').length >= 4);
    await wachtOp(() => kern.van('cockpit').length >= 4);
    expect(kern.van('cockpit').map((a) => a.args[0])).toEqual([
      { t: 'focus', app: 'nep-app' },
      { t: 'focus', app: null },
      { t: 'zet', app: 'nep-app', id: 'helder', v: 1 },
      { t: 'snapshot', nr: 2, actie: 'bewaar' },
    ]);
  });

  it('cockpit die sluit wordt afgemeld; events gaan alleen nog naar de rest', async () => {
    const c1 = await open(client('/cockpit'));
    const c2 = await open(client('/cockpit'));
    await wachtOp(() => vind(c1, 'beeld') && vind(c2, 'beeld'));
    c1.ws.close();
    await wachtOp(() => c1.code !== null);
    await new Promise((r) => setTimeout(r, 20));
    const voor = kern.van('beeld').length;
    kern.meld('beeld');
    await wachtOp(() => alle(c2, 'beeld').length === 2);
    expect(kern.van('beeld').length - voor).toBe(1); // één keer berekend, alleen voor c2
  });

  it('zonder cockpits rekent de server geen beeld uit', () => {
    const voor = kern.van('beeld').length;
    kern.meld('beeld');
    kern.meld('leds', { dev: 'apc40', staat: {} });
    kern.meld('invoer', {});
    expect(kern.van('beeld').length).toBe(voor);
  });

  it('opVirtueel die gooit laat de server niet vallen', async () => {
    const fout = vi.spyOn(console, 'error').mockImplementation(() => {});
    const k2 = new NepKern();
    const s2 = await startServer({ poort: 0, kern: k2, uiMap, srcMap: SRC, opVirtueel: () => { throw new Error('stuk'); } });
    try {
      const ws = new WebSocket(s2.adres.replace(/^http/, 'ws') + '/cockpit');
      const ontvangen = [];
      ws.on('message', (d) => ontvangen.push(JSON.parse(String(d))));
      await new Promise((r) => ws.once('open', r));
      ws.send(JSON.stringify({ t: 'virtueel', dev: 'apc40', bytes: [0x90, 1, 127] }));
      ws.send(JSON.stringify({ t: 'focus', app: 'x' }));
      await wachtOp(() => k2.van('cockpit').length);
      expect(fout).toHaveBeenCalled();
      ws.terminate();
    } finally { await s2.stop(); fout.mockRestore(); }
  });
});

describe('leesVanCockpit', () => {
  it('controleert en normaliseert', () => {
    expect(leesVanCockpit('{"t":"virtueel","dev":"lpd8","bytes":[144,36,100]}')).toEqual({ ok: true, virtueel: { dev: 'lpd8', bytes: [144, 36, 100] } });
    expect(leesVanCockpit({ t: 'zet', app: 'a', id: 'b', v: -3 })).toEqual({ ok: true, kern: { t: 'zet', app: 'a', id: 'b', v: 0 } });
    expect(leesVanCockpit({ t: 'focus', app: '' }).ok).toBe(false);
    expect(leesVanCockpit({ t: 'nieuw' })).toEqual({ ok: true, onbekend: true });
    expect(leesVanCockpit(null).ok).toBe(false);
    expect(leesVanCockpit({ t: 'virtueel', dev: 'apc40', bytes: new Array(513).fill(0) }).ok).toBe(false);
  });
});

describe('veiligPad', () => {
  it('blijft binnen de basis', () => {
    expect(veiligPad('/a/b', 'c/d.js')).toBe('/a/b/c/d.js');
    expect(veiligPad('/a/b', '../c')).toBeNull();
    expect(veiligPad('/a/b', '/etc/passwd')).toBe('/a/b/etc/passwd');
    expect(veiligPad('/a/b', 'x/../../b2/y')).toBeNull();
    expect(veiligPad('/a/b', 'x\0y')).toBeNull();
  });
});

describe('CockpitUitzender: trage cockpit', () => {
  /** Nep-socket + handmatige timers. */
  function opzet() {
    const timers = [];
    let beeldNr = 0;
    const u = new CockpitUitzender({
      beeld: () => ({ apps: [], nr: ++beeldNr }), maxAchterstand: 100, inhaalMs: 10,
      zet: (fn) => { timers.push(fn); return fn; }, wis: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    });
    const sock = () => ({ readyState: WebSocket.OPEN, bufferedAmount: 0, uit: [], send(s) { this.uit.push(JSON.parse(s)); } });
    const draai = () => { const nu = timers.splice(0); for (const f of nu) f(); };
    return { u, sock, draai, timers };
  }

  it('slaat beeld/leds/invoer over bij achterstand en haalt in zodra hij bij is', () => {
    const { u, sock, draai, timers } = opzet();
    const snel = sock(), traag = sock();
    u.voegToe(snel); u.voegToe(traag);
    traag.bufferedAmount = 5000;
    u.beeld();
    u.leds({ dev: 'apc40', staat: { 'pad1-1': { kleur: 5 } } });
    u.leds({ dev: 'apc40', staat: { 'pad1-1': { kleur: 9 }, 'pad1-2': { kleur: 3 } } });
    u.invoer({ el: 'fader1' });
    u.beeld();
    expect(snel.uit.map((b) => b.t)).toEqual(['beeld', 'beeld', 'leds', 'leds', 'invoer', 'beeld']);
    expect(traag.uit.map((b) => b.t)).toEqual(['beeld']);
    expect(timers).toHaveLength(1); // één inhaal-timer per socket

    draai(); // nog steeds achter → opnieuw wachten
    expect(traag.uit).toHaveLength(1);
    expect(timers).toHaveLength(1);

    traag.bufferedAmount = 0;
    draai();
    expect(traag.uit.map((b) => b.t)).toEqual(['beeld', 'beeld', 'leds']);
    expect(traag.uit[1].nr).toBeGreaterThan(3); // het nieuwste beeld, niet een oud
    expect(traag.uit[2]).toEqual({ t: 'leds', dev: 'apc40', staat: { 'pad1-1': { kleur: 9 }, 'pad1-2': { kleur: 3 } } });
    expect(timers).toHaveLength(0);

    u.leds({ dev: 'apc40', staat: { 'pad2-1': { kleur: 1 } } });
    expect(traag.uit.at(-1)).toEqual({ t: 'leds', dev: 'apc40', staat: { 'pad2-1': { kleur: 1 } } });
  });

  it('volgorde van LEDs blijft goed: nieuwe leds wachten achter gemiste', () => {
    const { u, sock, draai } = opzet();
    const s = sock();
    u.voegToe(s);
    s.bufferedAmount = 1000;
    u.leds({ dev: 'apc40', staat: { a: { aan: true } } });
    s.bufferedAmount = 0;
    u.leds({ dev: 'apc40', staat: { a: { aan: false } } });
    expect(s.uit.map((b) => b.t)).toEqual(['beeld']);
    draai();
    expect(s.uit.at(-1)).toEqual({ t: 'leds', dev: 'apc40', staat: { a: { aan: false } } });
  });

  it('verwijderen ruimt de inhaal-timer op; gesloten sockets krijgen niets', () => {
    const { u, sock, timers } = opzet();
    const s = sock();
    u.voegToe(s);
    s.bufferedAmount = 1000;
    u.beeld();
    expect(timers).toHaveLength(1);
    u.verwijder(s);
    expect(timers).toHaveLength(0);
    expect(u.aantal).toBe(0);
    const d = sock();
    d.readyState = WebSocket.CLOSING;
    u.voegToe(d);
    u.beeld();
    expect(d.uit).toHaveLength(0);
  });

  it('een kapotte send of beeld() gooit niet door', () => {
    const fout = vi.spyOn(console, 'error').mockImplementation(() => {});
    const u = new CockpitUitzender({ beeld: () => { throw new Error('stuk'); } });
    const s = { readyState: WebSocket.OPEN, bufferedAmount: 0, send() { throw new Error('weg'); } };
    expect(() => u.voegToe(s)).not.toThrow();
    expect(() => u.beeld()).not.toThrow();
    expect(() => u.invoer({})).not.toThrow();
    const kring = {}; kring.zelf = kring;
    expect(() => u.leds({ dev: 'apc40', staat: kring })).not.toThrow();
    u.sluit();
    fout.mockRestore();
  });
});
