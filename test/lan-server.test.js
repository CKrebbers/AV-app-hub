// De server met --lan (docs/NETWERK.md): van buiten de eigen machine alleen met token; lokaal blijft alles
// zonder token werken; Origin- en Host-controle blijven gelden. "Van buiten" is hier echt: de test verbindt
// via het eigen LAN-adres (niet 127.0.0.1), dus de server ziet een niet-loopback remoteAddress.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer, isLokaalAdres, tokenKlopt, TOKEN_COOKIE, CLOSE_TOKEN } from '../src/transports/server.js';
import { lanAdressen, lanOrigins } from '../src/lan.js';
import { NepApp, voorbeeldManifest } from '../tools/nep-app.mjs';
import { NepKern, wachtOp } from './nepkern.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const TOKEN = 'dit-is-het-goede-token-0123456789';
const LAN = lanAdressen()[0];

/** @type {string} */ let uiMap;
/** @type {NepKern} */ let kern;
/** @type {Awaited<ReturnType<typeof startServer>>} */ let srv;
/** @type {(() => void)[]} */ let opruimen;

/** @param {string} host @param {string} pad @param {Record<string, string>} [headers] */
function haal(host, pad, headers = {}) {
  return new Promise((goed, fout) => {
    const req = http.request({ host, port: srv.poort, path: pad, headers }, (res) => {
      let lijf = '';
      res.on('data', (d) => { lijf += d; });
      res.on('end', () => goed({ status: res.statusCode, koekje: res.headers['set-cookie'], lijf }));
    });
    req.on('error', fout);
    req.end();
  });
}

/** WebSocket die bijhoudt wat er gebeurt. @param {string} url @param {object} [opties] */
function client(url, opties = {}) {
  const ws = new WebSocket(url, opties);
  const c = { ws, berichten: /** @type {any[]} */ ([]), code: /** @type {number|null} */ (null), status: /** @type {number|null} */ (null), open: false };
  ws.on('open', () => { c.open = true; });
  ws.on('message', (d) => { try { c.berichten.push(JSON.parse(String(d))); } catch { /* geen json */ } });
  ws.on('close', (code) => { c.code = code; });
  ws.on('error', () => {});
  ws.on('unexpected-response', (_req, res) => { c.status = res.statusCode; ws.terminate(); });
  opruimen.push(() => ws.terminate());
  return c;
}

/** Een vrije poort (de origins noemen de poort, dus die moet vooraf bekend zijn). @returns {Promise<number>} */
function vrijePoort() {
  return new Promise((goed) => {
    const s = net.createServer().listen(0, '0.0.0.0', () => { const p = /** @type {net.AddressInfo} */ (s.address()).port; s.close(() => goed(p)); });
  });
}

const ws = (/** @type {string} */ host, /** @type {string} */ pad) => `ws://${host}:${srv.poort}${pad}`;

describe.skipIf(!LAN)(`server met token (LAN-adres ${LAN ?? 'ontbreekt'})`, () => {
  beforeEach(async () => {
    uiMap = mkdtempSync(join(tmpdir(), 'varve-lan-ui-'));
    writeFileSync(join(uiMap, 'index.html'), '<!doctype html><title>Cockpit</title>');
    kern = new NepKern();
    opruimen = [];
    const poort = await vrijePoort();
    srv = await startServer({ poort, host: '0.0.0.0', kern, uiMap, srcMap: SRC, token: TOKEN, origins: lanOrigins(['studio', 'studio.local'], poort) });
  });
  afterEach(async () => {
    for (const f of opruimen) { try { f(); } catch { /* dicht */ } }
    await srv.stop();
    rmSync(uiMap, { recursive: true, force: true });
  });

  it('meldt dat het token vereist is', () => expect(srv.tokenVereist).toBe(true));

  describe('HTTP', () => {
    it('lokaal: zonder token, zoals altijd', async () => {
      expect((await haal('127.0.0.1', '/')).status).toBe(200);
      expect((await haal('127.0.0.1', '/api/beeld')).status).toBe(200);
    });
    it('van buiten zonder token: 401, ook voor /api/beeld en de scripts', async () => {
      for (const pad of ['/', '/api/beeld', '/src/protocol/berichten.js']) {
        const r = /** @type {any} */ (await haal(LAN, pad));
        expect(r.status, pad).toBe(401);
        expect(r.lijf).toMatch(/token nodig/);
        expect(r.lijf).not.toContain(TOKEN);
      }
    });
    it('van buiten met een verkeerd token: 401', async () => {
      expect((await haal(LAN, '/?token=fout')).status).toBe(401);
      expect((await haal(LAN, `/?token=${TOKEN}x`)).status).toBe(401);
      expect((await haal(LAN, '/', { cookie: `${TOKEN_COOKIE}=fout` })).status).toBe(401);
    });
    it('van buiten met ?token=: 200 en een HttpOnly-cookie, waarmee de rest van de pagina laadt', async () => {
      const r = /** @type {any} */ (await haal(LAN, `/?token=${TOKEN}`));
      expect(r.status).toBe(200);
      const koekje = String(r.koekje);
      expect(koekje).toContain(`${TOKEN_COOKIE}=${TOKEN}`);
      expect(koekje).toMatch(/HttpOnly/);
      expect(koekje).toMatch(/SameSite=Strict/);
      const verder = /** @type {any} */ (await haal(LAN, '/src/protocol/berichten.js', { cookie: `ander=1; ${TOKEN_COOKIE}=${TOKEN}` }));
      expect(verder.status).toBe(200);
      expect(verder.koekje).toBeUndefined();
    });
    it('de Host-controle blijft: een vreemde naam met het goede token is 403', async () => {
      expect((await haal(LAN, `/?token=${TOKEN}`, { host: 'aanvaller.example' })).status).toBe(403);
    });
    it('de eigen LAN-namen zijn toegestane hosts (cockpit via studio.local)', async () => {
      expect((await haal(LAN, `/?token=${TOKEN}`, { host: `studio.local:${srv.poort}` })).status).toBe(200);
    });
  });

  describe('/cockpit', () => {
    it('lokaal zonder token: open', async () => {
      const c = client(ws('127.0.0.1', '/cockpit'));
      await wachtOp(() => c.berichten.find((b) => b.t === 'beeld'));
    });
    it('van buiten zonder token: 401 bij de upgrade', async () => {
      const c = client(ws(LAN, '/cockpit'));
      expect(await wachtOp(() => c.status)).toBe(401);
      expect(c.open).toBe(false);
    });
    it('van buiten met ?token= of met het cookie: open', async () => {
      const a = client(ws(LAN, `/cockpit?token=${TOKEN}`));
      const b = client(ws(LAN, '/cockpit'), { headers: { cookie: `${TOKEN_COOKIE}=${TOKEN}` } });
      await wachtOp(() => a.berichten.find((x) => x.t === 'beeld'));
      await wachtOp(() => b.berichten.find((x) => x.t === 'beeld'));
    });
    it('tablet via studio.local: Origin en Host zijn de eigen LAN-naam → toegestaan', async () => {
      const c = client(ws(LAN, '/cockpit'), { headers: { cookie: `${TOKEN_COOKIE}=${TOKEN}`, host: `studio.local:${srv.poort}` }, origin: `http://studio.local:${srv.poort}` });
      await wachtOp(() => c.berichten.find((x) => x.t === 'beeld'));
    });
    it('de Origin-controle blijft: een vreemde site met het goede token is 403', async () => {
      const c = client(ws(LAN, `/cockpit?token=${TOKEN}`), { origin: 'http://aanvaller.example' });
      expect(await wachtOp(() => c.status)).toBe(403);
    });
  });

  describe('/app', () => {
    it('lokaal zonder token: NepApp verbindt zoals altijd', async () => {
      const app = new NepApp({ url: ws('127.0.0.1', '/app'), manifest: voorbeeldManifest('lokaal'), herverbind: false }).start();
      opruimen.push(() => app.stop());
      await wachtOp(() => kern.ontvangen('manifest').length === 1);
    });
    it('van buiten met ?token= in de URL (zo stuurt flux het mee)', async () => {
      const app = new NepApp({ url: ws(LAN, `/app?token=${TOKEN}`), manifest: voorbeeldManifest('flux-1'), herverbind: false }).start();
      opruimen.push(() => app.stop());
      await wachtOp(() => kern.ontvangen('staat').length === 1);
      expect(kern.ontvangen('hallo')[0].app).toBe('flux-1');
    });
    it('van buiten met token in hallo: door, en het token bereikt de kern niet', async () => {
      const c = client(ws(LAN, '/app'));
      await wachtOp(() => c.open);
      expect(kern.van('verbind')).toHaveLength(0);              // nog niets bij de kern vóór het token
      c.ws.send(JSON.stringify({ t: 'hallo', app: 'tablet-app', inst: 'a1', v: 1, token: TOKEN }));
      const hallo = await wachtOp(() => kern.ontvangen('hallo')[0]);
      expect(hallo).toEqual({ t: 'hallo', app: 'tablet-app', inst: 'a1', v: 1 });
      expect(kern.van('verbind')).toHaveLength(1);
      expect(c.berichten.filter((b) => b.t === 'welkom')).toHaveLength(1);
    });
    it('van buiten zonder of met verkeerd token: fout + close-code 4003, de kern ziet niets', async () => {
      for (const extra of [{}, { token: 'verkeerd-token-0123456789' }]) {
        const c = client(ws(LAN, '/app'));
        await wachtOp(() => c.open);
        c.ws.send(JSON.stringify({ t: 'zet', id: 'x', v: 1 }));        // vóór hallo: gewoon de bestaande fout
        c.ws.send(JSON.stringify({ t: 'hallo', app: 'indringer', inst: 'x', v: 1, ...extra }));
        expect(await wachtOp(() => c.code)).toBe(CLOSE_TOKEN);
        expect(c.berichten.map((b) => b.t)).toEqual(['welkom', 'fout', 'fout']);
        expect(c.berichten[2].reden).toMatch(/token nodig/);
      }
      expect(kern.aanroepen.map((a) => a.naam).filter((n) => n !== 'beeld')).toEqual([]);
    });
    it('na een afgewezen hallo telt niets meer, ook niet een tweede hallo met het goede token', async () => {
      const c = client(ws(LAN, '/app'));
      await wachtOp(() => c.open);
      c.ws.send(JSON.stringify({ t: 'hallo', app: 'raden', inst: 'a', v: 1, token: 'fout-fout-fout-fout' }));
      c.ws.send(JSON.stringify({ t: 'hallo', app: 'raden', inst: 'a', v: 1, token: TOKEN }));
      expect(await wachtOp(() => c.code)).toBe(CLOSE_TOKEN);
      expect(kern.van('verbind')).toHaveLength(0);
      expect(kern.ontvangen('hallo')).toHaveLength(0);
    });
    it('een verkeerd token in de URL mag nog in hallo goedgemaakt worden', async () => {
      const c = client(ws(LAN, '/app?token=fout'));
      await wachtOp(() => c.open);
      c.ws.send(JSON.stringify({ t: 'hallo', app: 'tweede-kans', inst: 'b', v: 1, token: TOKEN }));
      await wachtOp(() => kern.ontvangen('hallo')[0]);
    });
  });
});

describe('server zonder token', () => {
  /** @type {NepKern} */ let k;
  /** @type {Awaited<ReturnType<typeof startServer>>} */ let s;
  beforeEach(async () => { k = new NepKern(); s = await startServer({ poort: 0, kern: k, uiMap: SRC, srcMap: SRC }); });
  afterEach(() => s.stop());
  it('vereist niets (zoals vóór --lan) en zegt dat', () => expect(s.tokenVereist).toBe(false));
  it('een token in hallo wordt genegeerd en niet doorgegeven', async () => {
    const c = new WebSocket(s.adres.replace('http', 'ws') + '/app');
    await new Promise((r) => c.once('open', r));
    c.send(JSON.stringify({ t: 'hallo', app: 'x', inst: 'y', v: 1, token: 'wat-dan-ook' }));
    expect(await wachtOp(() => k.ontvangen('hallo')[0])).toEqual({ t: 'hallo', app: 'x', inst: 'y', v: 1 });
    c.terminate();
  });
});

describe('token-hulpjes', () => {
  it('weigert een te kort token bij het starten', async () => {
    await expect(startServer({ poort: 0, kern: new NepKern(), uiMap: SRC, srcMap: SRC, token: 'kort' })).rejects.toThrow(/16 tekens/);
  });
  it('loopback is lokaal, de rest niet', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLokaalAdres(a), a).toBe(true);
    for (const a of ['192.168.1.5', '::ffff:192.168.1.5', '10.0.0.1', 'fe80::1', '', undefined]) expect(isLokaalAdres(a), String(a)).toBe(false);
  });
  it('tokenKlopt: alleen exact hetzelfde, nooit leeg', () => {
    expect(tokenKlopt(TOKEN, TOKEN)).toBe(true);
    expect(tokenKlopt(TOKEN + 'x', TOKEN)).toBe(false);
    expect(tokenKlopt('', TOKEN)).toBe(false);
    expect(tokenKlopt(undefined, TOKEN)).toBe(false);
    expect(tokenKlopt(123, TOKEN)).toBe(false);
    expect(tokenKlopt('', '')).toBe(false);
  });
});
