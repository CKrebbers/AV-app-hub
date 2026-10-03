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
 * Valt de verbinding weg (hub gestopt of gecrasht), dan lost `weg` op met een fout; herhaal breekt daarop af
 * in plaats van de rest van de avond de leegte in te sturen.
 * @returns {Promise<Doel & { apps: Set<string>, snapshots: number[], weg: Promise<Error>, sluit: () => Promise<void> }>}
 */
export async function doelVanCockpit(adres) {
  const url = cockpitUrl(adres);
  const { ws, beeld } = await open(url);
  let zelfDicht = false;
  /** @type {(e: Error) => void} */
  let meldWeg = () => {};
  /** @type {Promise<Error>} */
  const weg = new Promise((r) => { meldWeg = r; });
  ws.on('close', (/** @type {number} */ code) => { if (!zelfDicht) meldWeg(new Error(`verbinding met ${url} verbroken (code ${code})`)); });
  ws.on('error', (/** @type {any} */ e) => { if (!zelfDicht) meldWeg(new Error(`verbinding met ${url} verbroken (${e?.code ?? e?.message ?? e})`)); });
  const stuur = (/** @type {object} */ b) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(b));
    else if (!zelfDicht) meldWeg(new Error(`verbinding met ${url} is dicht`));
  };
  return {
    apps: new Set(beeld.apps.map((/** @type {any} */ a) => a.app)),
    snapshots: Array.isArray(beeld.snapshots) ? beeld.snapshots : [],
    weg,
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
      zelfDicht = true;
      if (ws.readyState === WebSocket.CLOSED) return r();
      ws.once('close', () => r());
      ws.close();
      /** @type {any} */ (setTimeout(() => { ws.terminate(); r(); }, 1000)).unref?.();
    }),
  };
}
