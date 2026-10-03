// @ts-check
// Hoe de starter de kern ziet en bedient. Twee smaken met dezelfde vorm:
// - kernToegang(kern): de hub draait in hetzelfde proces (`varve-hub start <set>`).
// - cockpitToegang(url): de hub draaide al (poort bezet); de starter praat dan als cockpit met die hub
//   (PROTOCOL.md §8: beeld binnen; focus en zet terug). Zo start een set ook naast een lopende hub.
import WebSocket from 'ws';
import { echteKlok } from '../core/klok.js';

/**
 * @typedef {{ app: string, status: string, params?: { id: string, soort: string }[], focus?: boolean }} BeeldApp
 * @typedef {{ apps: BeeldApp[], focus: string|null }} Beeld
 * @typedef {{
 *   beeld: () => Beeld,
 *   zet: (app: string, id: string, v: number) => void,
 *   focus: (app: string) => void,
 *   sluit: () => void,
 * }} KernToegang
 */

/** @param {import('../core/kern.js').Kern} kern @returns {KernToegang} */
export function kernToegang(kern) {
  return {
    beeld: () => kern.beeld(),
    // Via de cockpit-ingang: precies wat een hand in de cockpit zou doen (trigger → trig, anders zet).
    zet: (app, id, v) => kern.cockpit({ t: 'zet', app, id, v }),
    focus: (app) => { kern.focus(app); },
    sluit: () => {},
  };
}

/**
 * Verbind als cockpit met een hub die al draait. Lost op zodra het eerste `beeld` binnen is.
 * Valt de verbinding daarna weg (die hub stopt), dan zegt hij dat en wordt het beeld leeg: de starter meldt de
 * apps dan als "niet bij de hub", en zet/focus gaan nergens heen.
 * @param {string} url bv. ws://localhost:7700/cockpit
 * @param {{ ms?: number, WS?: typeof WebSocket, klok?: import('../core/klok.js').Klok, log?: (regel: string) => void }} [o]
 * @returns {Promise<KernToegang>}
 */
export function cockpitToegang(url, { ms = 3000, WS = WebSocket, klok = echteKlok, log = () => {} } = {}) {
  return new Promise((goed, fout) => {
    const ws = new WS(url);
    /** @type {Beeld} */
    let beeld = { apps: [], focus: null };
    let open = false;
    let zelfDicht = false;
    const t = klok.zet(() => { ws.terminate(); fout(new Error(`geen beeld van de hub op ${url} binnen ${ms} ms`)); }, ms);
    const stuur = (/** @type {object} */ b) => { if (ws.readyState === WS.OPEN) ws.send(JSON.stringify(b)); };
    ws.on('message', (d) => {
      let b;
      try { b = JSON.parse(String(d)); } catch { return; }
      if (b?.t !== 'beeld') return;
      beeld = b;
      if (open) return;
      open = true;
      klok.wis(t);
      goed({
        beeld: () => beeld,
        zet: (app, id, v) => stuur({ t: 'zet', app, id, v }),
        focus: (app) => stuur({ t: 'focus', app }),
        sluit: () => { zelfDicht = true; ws.close(); },
      });
    });
    ws.on('close', () => {
      if (!open || zelfDicht) return;
      beeld = { apps: [], focus: null };
      log(`verbinding met de hub op ${url} verbroken — de set kan niets meer zetten (draait die hub nog?)`);
    });
    ws.on('error', (e) => { if (open) return; klok.wis(t); fout(new Error(`kan niet verbinden met de hub op ${url}: ${e.message}`)); });
  });
}
