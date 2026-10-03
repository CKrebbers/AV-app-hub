#!/usr/bin/env node
// @ts-check
// Nep-hub met conformiteitstoets: start een WebSocket-server die zich als de hub gedraagt en
// controleert of een app zich aan PROTOCOL.md houdt. Voor elke app-koppeling:
//   node tools/nep-hub.mjs --toets [--poort 7799]
//   en open daarna de app met ?hub=ws://localhost:7799/app
// Als bibliotheek: `const r = await toetsApp({ poort, start: async (url) => … })`.
import { WebSocketServer } from 'ws';
import { leesVanApp, isModeSysex } from '../src/protocol/berichten.js';
import { valideerManifest } from '../src/protocol/manifest.js';

/** @typedef {{ naam: string, ok: boolean, detail?: string }} Uitslag */

/**
 * @param {{ poort: number (0 = vrije poort), start?: (url: string) => Promise<unknown>|unknown, timeoutMs?: number, herverbindMs?: number }} o
 * @returns {Promise<{ ok: boolean, uitslagen: Uitslag[], app: string|null }>}
 */
export async function toetsApp({ poort, start, timeoutMs = 8000, herverbindMs = 8000 }) {
  const wss = new WebSocketServer({ port: poort, path: '/app' });
  await new Promise((r) => wss.once('listening', r));
  const echtePoort = /** @type {import('node:net').AddressInfo} */ (wss.address()).port; // poort 0 = vrije poort
  /** @type {Uitslag[]} */
  const uit = [];
  const noteer = (/** @type {string} */ naam, /** @type {boolean} */ ok, /** @type {string=} */ detail) => uit.push({ naam, ok, ...(detail ? { detail } : {}) });
  /** @type {import('ws').WebSocket[]} */
  const sockets = [];
  /** @type {{ t: number, b: any, s: number }[]} */
  const log = [];
  const fouten = [];
  wss.on('connection', (ws) => {
    const s = sockets.push(ws) - 1;
    ws.send(JSON.stringify({ t: 'welkom', hub: 'varve-hub', v: 1 }));
    ws.on('message', (d) => {
      const r = leesVanApp(String(d));
      if (!r.ok) fouten.push(r.fout);
      else if (!('onbekend' in r)) log.push({ t: Date.now(), b: r.bericht, s });
    });
  });
  const wachtOp = async (/** @type {() => any} */ fn, ms = timeoutMs) => {
    const eind = Date.now() + ms;
    while (Date.now() < eind) { const x = fn(); if (x) return x; await new Promise((r) => setTimeout(r, 25)); }
    return null;
  };
  const url = `ws://localhost:${echtePoort}/app`;
  try {
    await start?.(url);
    const hallo = await wachtOp(() => log.find((x) => x.b.t === 'hallo'));
    noteer('stuurt hallo met app en inst', !!hallo, hallo ? `app=${hallo.b.app}` : `binnen ${timeoutMs} ms niets`);
    const man = await wachtOp(() => log.find((x) => x.b.t === 'manifest'));
    const v = man ? valideerManifest(man.b.manifest) : null;
    noteer('stuurt een geldig manifest', !!v?.ok, v && !v.ok ? v.fouten.join('; ') : man ? undefined : 'geen manifest');
    const manifest = v?.ok ? v.manifest : null;
    if (manifest && manifest.params.some((p) => p.soort !== 'trigger')) {
      const nodig = manifest.params.filter((p) => p.soort !== 'trigger').map((p) => p.id);
      const staat = await wachtOp(() => log.find((x) => x.b.t === 'staat'));
      const gemeld = new Set(log.filter((x) => x.b.t === 'staat').flatMap((x) => Object.keys(x.b.waarden)));
      const mist = nodig.filter((id) => !gemeld.has(id));
      noteer('meldt de staat van alle parameters', !!staat && !mist.length, mist.length ? `ontbreekt: ${mist.join(', ')}` : undefined);
    }
    if (manifest) {
      const hb = manifest.hb_s * 1000;
      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, Math.max(2500, hb * 2.5)));
      const tijden = [t0, ...log.filter((x) => x.t >= t0 && x.s === 0).map((x) => x.t), Date.now()];
      const gat = Math.max(...tijden.slice(1).map((t, i) => t - tijden[i]));
      noteer(`hartslag minstens elke ${manifest.hb_s} s`, gat <= hb + 600, `grootste gat ${gat} ms`);
      const eerste = manifest.params.find((p) => p.soort === 'waarde');
      const trig = manifest.params.find((p) => p.soort === 'trigger');
      const s0 = sockets[0];
      if (eerste) s0.send(JSON.stringify({ t: 'zet', id: eerste.id, v: 0.25, bron: 'apc40' }));
      if (trig) { s0.send(JSON.stringify({ t: 'trig', id: trig.id, aan: true })); s0.send(JSON.stringify({ t: 'trig', id: trig.id, aan: false })); }
      s0.send(JSON.stringify({ t: 'focus', aan: true }));
      s0.send(JSON.stringify({ t: 'globaal', waarden: { 'macro.ruimte': 0.5, adem: 0.1, grondtoon: 'D' } }));
      s0.send(JSON.stringify({ t: 'iets-nieuws-uit-de-toekomst', x: 1 }));
      await new Promise((r) => setTimeout(r, 400));
      noteer('overleeft zet/trig/focus/globaal en onbekende berichten', s0.readyState === s0.OPEN);
      if (manifest.lease) {
        const leds = log.filter((x) => x.b.t === 'led');
        noteer('lease: stuurt geen mode-SysEx', !leds.some((x) => x.b.bytes.some(isModeSysex)));
      }
      const voor = sockets.length;
      s0.close();
      const terug = await wachtOp(() => sockets.length > voor && log.find((x) => x.s === voor && x.b.t === 'hallo'), herverbindMs);
      noteer('verbindt opnieuw na wegvallen', !!terug, terug ? undefined : `niet binnen ${herverbindMs} ms`);
    }
    noteer('geen ongeldige berichten', fouten.length === 0, fouten.slice(0, 3).join('; ') || undefined);
    return { ok: uit.every((u) => u.ok), uitslagen: uit, app: manifest?.app ?? null };
  } finally {
    for (const s of sockets) s.terminate();
    await new Promise((r) => wss.close(r));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf('--poort');
  const poort = i > 0 ? Number(process.argv[i + 1]) : 7799;
  console.log(`Nep-hub op ws://localhost:${poort}/app — open nu de app met ?hub=ws://localhost:${poort}/app`);
  const r = await toetsApp({ poort, timeoutMs: 120000 });
  for (const u of r.uitslagen) console.log(`${u.ok ? '✔' : '✗'} ${u.naam}${u.detail ? ` — ${u.detail}` : ''}`);
  console.log(r.ok ? `\n${r.app}: conform PROTOCOL.md` : '\nNIET conform');
  process.exit(r.ok ? 0 : 1);
}
