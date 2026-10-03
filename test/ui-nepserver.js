#!/usr/bin/env node
// @ts-check
// Nep-server voor de cockpit: serveert de pagina zoals de echte hub (PROTOCOL.md §8) —
//   /                 → ui/index.html
//   /ui/…             → ui/
//   /src/devices/…    → src/devices/
//   /src/protocol/…   → src/protocol/
// — en een WebSocket op /cockpit die alles opslaat wat de cockpit stuurt.
//
// Als bibliotheek (tests):  const s = await startNepServer(); s.stuur({t:'beeld',…}); s.ontvangen …
// Los, als demo zonder hub:  node test/ui-nepserver.js [--poort 7700]
//   dan doet hij een beetje alsof hij de hub is: twee apps, LEDs, adem, en virtuele invoer komt terug als `invoer`.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
const MAPPEN = [['/ui/', 'ui'], ['/src/devices/', 'src/devices'], ['/src/protocol/', 'src/protocol']];

/** URL-pad → bestand, of null als het buiten de toegestane mappen valt. @param {string} pad */
export function bestandVoor(pad) {
  let p;
  try { p = decodeURIComponent(pad.split('?')[0]); } catch { return null; }
  if (p === '/' || p === '/index.html') return join(ROOT, 'ui', 'index.html');
  for (const [voor, map] of MAPPEN) {
    if (!p.startsWith(voor)) continue;
    const basis = join(ROOT, map);
    const vol = normalize(join(basis, p.slice(voor.length)));
    return vol.startsWith(basis + sep) ? vol : null;
  }
  return null;
}

/**
 * @param {{ poort?: number, host?: string }} [o]
 */
export async function startNepServer({ poort = 0, host = '127.0.0.1' } = {}) {
  /** @type {any[]} */
  const ontvangen = [];
  /** @type {Set<import('ws').WebSocket>} */
  const klanten = new Set();
  /** @type {Set<(b: any) => void>} */
  const luisteraars = new Set();

  const http = createServer(async (req, res) => {
    const f = bestandVoor(req.url ?? '/');
    if (!f) { res.writeHead(404, { 'content-type': 'text/plain' }).end('niet gevonden'); return; }
    try {
      const data = await readFile(f);
      res.writeHead(200, { 'content-type': TYPES[/** @type {keyof typeof TYPES} */ (extname(f))] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(data);
    } catch { res.writeHead(404, { 'content-type': 'text/plain' }).end('niet gevonden'); }
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, sock, kop) => {
    if ((req.url ?? '').split('?')[0] !== '/cockpit') { sock.destroy(); return; }
    wss.handleUpgrade(req, sock, kop, (ws) => {
      klanten.add(ws);
      ws.on('close', () => klanten.delete(ws));
      ws.on('message', (d) => {
        let b;
        try { b = JSON.parse(String(d)); } catch { return; }
        ontvangen.push(b);
        for (const fn of luisteraars) fn(b);
      });
      for (const fn of verbindLuisteraars) fn(ws);
    });
  });
  /** @type {Set<(ws: import('ws').WebSocket) => void>} */
  const verbindLuisteraars = new Set();
  await new Promise((r) => http.listen(poort, host, () => r(undefined)));
  const adres = /** @type {import('node:net').AddressInfo} */ (http.address());
  const url = `http://${host}:${adres.port}/`;

  return {
    url, poort: adres.port, ontvangen, klanten,
    /** Naar alle cockpits. @param {object} b */
    stuur(b) { const s = JSON.stringify(b); for (const ws of klanten) if (ws.readyState === ws.OPEN) ws.send(s); },
    /** @param {(b: any) => void} fn */
    bijBericht(fn) { luisteraars.add(fn); return () => luisteraars.delete(fn); },
    /** @param {(ws: import('ws').WebSocket) => void} fn */
    bijVerbinding(fn) { verbindLuisteraars.add(fn); return () => verbindLuisteraars.delete(fn); },
    /** Wacht tot fn() iets teruggeeft. @template T @param {() => T} fn @param {number} [ms] @returns {Promise<T>} */
    async wachtOp(fn, ms = 3000) {
      const eind = Date.now() + ms;
      for (;;) {
        const x = fn();
        if (x) return x;
        if (Date.now() > eind) throw new Error('wachtOp: verlopen');
        await new Promise((r) => setTimeout(r, 15));
      }
    },
    /** Verbreek alle cockpits (om herverbinden te toetsen). */
    verbreekAlle() { for (const ws of klanten) ws.terminate(); },
    /** Aantal verbonden cockpits. */
    get aantalKlanten() { return klanten.size; },
    async sluit() {
      for (const ws of klanten) ws.terminate();
      await new Promise((r) => wss.close(() => r(undefined)));
      await new Promise((r) => http.close(() => r(undefined)));
    },
  };
}

// ── demo: los starten ───────────────────────────────────────────────────────

async function demo() {
  const APC = await import('../src/devices/apc40mk2.js');
  const LPD = await import('../src/devices/lpd8.js');
  const { ROLLEN } = await import('../src/protocol/manifest.js');
  const lpdOntleed = LPD.maakOntleder(LPD.standaardProfiel('mk2'));
  const i = process.argv.indexOf('--poort');
  const s = await startNepServer({ poort: i > 0 ? Number(process.argv[i + 1]) : 7700 });
  const apps = [
    { app: 'formula-lab', naam: 'Formula Lab', kleur: '#3fbf5f', status: 'actief', focus: true, lease: false,
      params: [
        { id: 'in1', naam: 'In 1', soort: 'waarde', standaard: 0, hint: 'fader', groep: 'handen' },
        { id: 'in2', naam: 'In 2', soort: 'waarde', standaard: 0.3, hint: 'fader', groep: 'handen' },
        { id: 'freq', naam: 'Frequentie', soort: 'waarde', standaard: 0.5, min: 20, max: 2000, eenheid: 'Hz', groep: 'klank' },
        { id: 'palet', naam: 'Palet', soort: 'keuze', keuzes: ['warm', 'koel', 'mono'], standaard: 0, groep: 'beeld' },
        { id: 'spiegel', naam: 'Spiegel', soort: 'schakelaar', standaard: 0, groep: 'beeld' },
        { id: 'take', naam: 'Take', soort: 'trigger', standaard: 0, groep: 'beeld' },
      ],
      waarden: { in1: 0.2, in2: 0.3, freq: 0.5, palet: 0, spiegel: 0 } },
    { app: 'varve-dj', naam: 'Varve DJ', kleur: '#ff7f00', status: 'stil', focus: false, lease: true, params: [], waarden: {} },
    { app: 'medisynth', naam: 'medisynth', kleur: '#8e66ff', status: 'weg', focus: false, lease: false, params: [], waarden: {} },
  ];
  const globaal = { 'macro.intensiteit': 0.6, 'macro.helderheid': 0.4, 'macro.ruimte': 0.5, 'macro.beweging': 0.2, 'macro.kleur': 0.7, 'macro.dichtheid': 0.3, 'klok.adem_periode': 0.5, 'macro.balans': 0.5, adem: 0, bpm: 92, grondtoon: 'D' };
  const t0 = Date.now();
  const beeld = () => {
    globaal.adem = ((Date.now() - t0) / 1000 / (4 + 12 * globaal['klok.adem_periode'])) % 1;
    const focus = apps.find((a) => a.focus)?.app ?? null;
    return { t: 'beeld', apps, focus, globaal, apparaten: { apc40: false, lpd8: false } };
  };
  const leds = () => {
    /** @type {Record<string, any>} */
    const staat = {};
    apps.forEach((a, k) => {
      const kleur = APC.dichtsteKleur(a.kleur);
      staat[APC.padId(5, k + 1)] = a.status === 'weg' ? { kleur: 0 } : a.focus ? { kleur, anim: { soort: 'puls', snelheid: 4 } } : a.status === 'stil' ? { kleur, anim: { soort: 'knipper', snelheid: 3 } } : { kleur };
      staat[`sel${k + 1}`] = { aan: a.focus };
    });
    for (let c = 1; c <= 8; c++) staat[APC.padId(1, c)] = { kleur: 41 + c };
    staat.scene1 = { kleur: 21, anim: { soort: 'knipper', snelheid: 2, kleur2: 5 } };
    staat.stop3 = { knipper: true }; staat.ab1 = { stand: 1 }; staat.ab2 = { stand: 2 };
    for (let k = 1; k <= 8; k++) { staat[`dk${k}`] = { waarde: k / 8 }; staat[`tk${k}`] = { waarde: (8 - k) / 8 }; }
    return staat;
  };
  s.bijVerbinding((ws) => {
    ws.send(JSON.stringify(beeld()));
    ws.send(JSON.stringify({ t: 'leds', dev: 'apc40', staat: leds() }));
  });
  s.bijBericht((b) => {
    if (b.t === 'virtueel') {
      const g = b.dev === 'lpd8' ? lpdOntleed(b.bytes) : APC.ontleed(b.bytes);
      s.stuur({ t: 'invoer', g });
      if (g.dev === 'lpd8' && g.kind === 'waarde' && g.el) /** @type {Record<string, any>} */ (globaal)[ROLLEN[Number(g.el.slice(1)) - 1]] = g.v;
      if (g.el?.startsWith('fader') && g.kind === 'waarde') {
        const fa = apps.find((a) => a.focus);
        const p = fa?.params.filter((x) => x.soort === 'waarde')[Number(g.el.slice(5)) - 1];
        if (fa && p) /** @type {any} */ (fa.waarden)[p.id] = g.v;
      }
    } else if (b.t === 'focus') {
      for (const a of apps) a.focus = a.app === b.app;
      s.stuur({ t: 'leds', dev: 'apc40', staat: leds() });
    } else if (b.t === 'zet') {
      const a = apps.find((x) => x.app === b.app);
      if (a) /** @type {any} */ (a.waarden)[b.id] = b.v;
    }
    console.log('cockpit →', JSON.stringify(b));
  });
  setInterval(() => s.stuur(beeld()), 100);
  console.log(`Nep-hub (demo) op ${s.url} — open die in je browser.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) demo();
