// @ts-check
// WebSocket naar de hub (/cockpit) die zichzelf herstelt: 0,5 → 1 → 2 → 5 s (max), zoals apps (PROTOCOL.md §3).
// WebSocket en timers zijn injecteerbaar, zodat dit zonder browser te toetsen is.

export const WACHTTIJDEN = Object.freeze([500, 1000, 2000, 5000]);
/** Zo lang mag openen duren; daarna opnieuw (een weggevallen wifi blijft anders minutenlang 'verbinden'). */
export const VERBIND_TIJD = 4000;

/**
 * @typedef {'verbinden'|'verbonden'|'weg'} Status
 * @typedef {{ status: Status, poging: number, opnieuwOver?: number }} StatusInfo
 */

export class Verbinding {
  /**
   * @param {{ url: string, WS?: any, wacht?: (fn: () => void, ms: number) => any, stop?: (h: any) => void,
   *           bijBericht?: (b: any) => void, bijStatus?: (s: StatusInfo) => void, verbindTijd?: number }} o
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
    /** @type {any} */ this.verbindTimer = null;
    this.verbindTijd = o.verbindTijd ?? VERBIND_TIJD;
    this.gestopt = false;
    /** @type {Status} */ this.status = 'verbinden';
  }

  start() { this.gestopt = false; this.#open(); return this; }

  stop() {
    this.gestopt = true;
    if (this.timer) this.stopTimer(this.timer);
    this.timer = null;
    this.#stopVerbindTimer();
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
    if (this.verbindTijd > 0) {
      this.verbindTimer = this.wacht(() => {
        this.verbindTimer = null;
        if (this.ws !== ws || ws.readyState !== 0) return;
        this.ws = null; // eerst loskoppelen: een late onclose van deze socket telt niet meer
        try { ws.close(); } catch { /* al dicht */ }
        this.#later();
      }, this.verbindTijd);
    }
    ws.onopen = () => { this.#stopVerbindTimer(); if (this.ws !== ws) return; this.poging = 0; this.#meld('verbonden'); };
    ws.onmessage = (/** @type {{ data: unknown }} */ e) => {
      let b;
      try { b = JSON.parse(String(e.data)); } catch { return; } // onleesbaar: negeren
      if (b && typeof b === 'object' && !Array.isArray(b)) this.bijBericht(b);
    };
    ws.onclose = () => { if (this.ws === ws) { this.#stopVerbindTimer(); this.ws = null; this.#later(); } };
    ws.onerror = () => { /* onclose volgt */ };
  }

  #stopVerbindTimer() {
    if (this.verbindTimer) this.stopTimer(this.verbindTimer);
    this.verbindTimer = null;
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
