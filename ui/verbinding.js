// @ts-check
// WebSocket naar de hub (/cockpit) die zichzelf herstelt: 0,5 → 1 → 2 → 5 s (max), zoals apps (PROTOCOL.md §3).
// WebSocket en timers zijn injecteerbaar, zodat dit zonder browser te toetsen is.

export const WACHTTIJDEN = Object.freeze([500, 1000, 2000, 5000]);

/**
 * @typedef {'verbinden'|'verbonden'|'weg'} Status
 * @typedef {{ status: Status, poging: number, opnieuwOver?: number }} StatusInfo
 */

export class Verbinding {
  /**
   * @param {{ url: string, WS?: any, wacht?: (fn: () => void, ms: number) => any, stop?: (h: any) => void,
   *           bijBericht?: (b: any) => void, bijStatus?: (s: StatusInfo) => void }} o
   */
  constructor(o) {
    this.url = o.url;
    this.WS = o.WS ?? globalThis.WebSocket;
    this.wacht = o.wacht ?? ((fn, ms) => setTimeout(fn, ms));
    this.stopTimer = o.stop ?? ((h) => clearTimeout(h));
    this.bijBericht = o.bijBericht ?? (() => {});
    this.bijStatus = o.bijStatus ?? (() => {});
    /** @type {any} */ this.ws = null;
    this.poging = 0;
    /** @type {any} */ this.timer = null;
    this.gestopt = false;
    /** @type {Status} */ this.status = 'verbinden';
  }

  start() { this.gestopt = false; this.#open(); return this; }

  stop() {
    this.gestopt = true;
    if (this.timer) this.stopTimer(this.timer);
    this.timer = null;
    try { this.ws?.close(); } catch { /* al dicht */ }
  }

  get open() { return !!this.ws && this.ws.readyState === 1; }

  /** Stuur een bericht. Geeft false als er geen verbinding is (dan gaat het verloren — net als een losse kabel). @param {object} bericht */
  stuur(bericht) {
    if (!this.open) return false;
    this.ws.send(JSON.stringify(bericht));
    return true;
  }

  #open() {
    this.timer = null;
    this.#meld('verbinden');
    let ws;
    try { ws = new this.WS(this.url); } catch { this.#later(); return; }
    this.ws = ws;
    ws.onopen = () => { this.poging = 0; this.#meld('verbonden'); };
    ws.onmessage = (/** @type {{ data: unknown }} */ e) => {
      let b;
      try { b = JSON.parse(String(e.data)); } catch { return; } // onleesbaar: negeren
      if (b && typeof b === 'object' && !Array.isArray(b)) this.bijBericht(b);
    };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.#later(); } };
    ws.onerror = () => { /* onclose volgt */ };
  }

  #later() {
    if (this.gestopt) return;
    const ms = WACHTTIJDEN[Math.min(this.poging, WACHTTIJDEN.length - 1)];
    this.poging++;
    this.#meld('weg', ms);
    this.timer = this.wacht(() => this.#open(), ms);
  }

  /** @param {Status} status @param {number} [opnieuwOver] */
  #meld(status, opnieuwOver) {
    this.status = status;
    this.bijStatus({ status, poging: this.poging, ...(opnieuwOver !== undefined ? { opnieuwOver } : {}) });
  }
}

/** Het /cockpit-adres op dezelfde host als de pagina; `?hub=ws://…` overschrijft. @param {Location} loc */
export function cockpitUrl(loc) {
  const q = new URLSearchParams(loc.search).get('hub');
  if (q) return q;
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}/cockpit`;
}
