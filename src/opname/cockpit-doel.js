// @ts-check
// Doel voor `varve-hub herhaal`: een draaiende hub, bespeeld via zijn cockpit-WebSocket (PROTOCOL.md §8).
// Invoer gaat als {t:"virtueel"} — de hub behandelt dat precies alsof het van USB kwam (opVirtueel →
// kern.invoer). De eindstaat komt uit het `beeld` dat een verse cockpitverbinding meteen krijgt.
import WebSocket from 'ws';
import { eindstaatUitBeeld } from './staat.js';

/** @typedef {import('./herhaal.js').Doel} Doel */

/** Hub-adres → cockpit-URL (http://…, ws://… of host:poort). @param {string} adres */
export function cockpitUrl(adres) {
  let u = adres.trim();
  if (!/^[a-z]+:\/\//i.test(u)) u = `ws://${u}`;
  u = u.replace(/^http/i, 'ws').replace(/\/+$/, '');
  return u.endsWith('/cockpit') ? u : `${u}/cockpit`;
}

/**
 * Open een cockpitverbinding en wacht op het eerste beeld.
 * @param {string} url @param {number} [maxMs]
 * @returns {Promise<{ ws: WebSocket, beeld: any }>}
 */
function open(url, maxMs = 3000) {
  return new Promise((goed, fout) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => { ws.terminate(); fout(new Error(`geen antwoord van de hub op ${url} binnen ${maxMs} ms`)); }, maxMs);
    ws.on('error', (/** @type {any} */ e) => { clearTimeout(t); fout(new Error(`kan de hub niet bereiken op ${url} (${/** @type {any} */ (e).code ?? e.message}) — draait "varve-hub start"?`)); });
    ws.on('message', (/** @type {unknown} */ d) => {
      let b;
      try { b = JSON.parse(String(d)); } catch { return; }
      if (b?.t === 'beeld') { clearTimeout(t); ws.removeAllListeners('message'); ws.on('error', () => {}); goed({ ws, beeld: b }); }
    });
  });
}

/**
 * @param {string} adres
 * @returns {Promise<Doel & { apps: Set<string>, sluit: () => Promise<void> }>}
 */
export async function doelVanCockpit(adres) {
  const url = cockpitUrl(adres);
  const { ws, beeld } = await open(url);
  const stuur = (/** @type {object} */ b) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(b)); };
  return {
    apps: new Set(beeld.apps.map((/** @type {any} */ a) => a.app)),
    invoer: (dev, bytes) => stuur({ t: 'virtueel', dev, bytes }),
    cockpit: (b) => stuur(b),
    async eindstaat() {
      // Een verse verbinding krijgt meteen het volledige, actuele beeld (geen throttle). herhaal wacht eerst
      // de naloop af, zodat de hub alle afgespeelde invoer al verwerkt heeft.
      const vers = await open(url);
      vers.ws.close();
      return eindstaatUitBeeld(vers.beeld);
    },
    sluit: () => new Promise((r) => {
      if (ws.readyState === WebSocket.CLOSED) return r();
      ws.once('close', () => r());
      ws.close();
      /** @type {any} */ (setTimeout(() => { ws.terminate(); r(); }, 1000)).unref?.();
    }),
  };
}
