// @ts-check
// Twee oefen-apps voor de oefenruimte: Zon en Zee. Ze praten het gewone app-protocol (PROTOCOL.md §3–4),
// precies zoals formula-lab of waterschaal, zodat je oefent met het echte gedrag van de hub: focus,
// pickup, rollen, slew, snapshots en paniek. Geen DOM hier: ook in Node te gebruiken (tests geven `ws` mee).

/** @typedef {import('../../src/protocol/types.js').Manifest} Manifest */

export const ZON = 'oefen-zon';
export const ZEE = 'oefen-zee';

/** @type {Record<string, Manifest>} */
export const MANIFESTEN = {
  [ZON]: {
    v: 1, app: ZON, naam: 'Zon', kleur: '#ff9f1c', truth: 'app', hb_s: 1,
    params: [
      { id: 'gloed', naam: 'Gloed', soort: 'waarde', standaard: 0.5, hint: 'fader', rol: 'macro.helderheid' },
      { id: 'grootte', naam: 'Grootte', soort: 'waarde', standaard: 0.5, hint: 'fader', rol: 'macro.intensiteit' },
      { id: 'draai', naam: 'Draai', soort: 'waarde', standaard: 0, hint: 'knop', rol: 'macro.beweging' },
      { id: 'tint', naam: 'Tint', soort: 'keuze', keuzes: ['geel', 'oranje', 'rood'], standaard: 0.5, hint: 'kolom', rol: 'macro.kleur' },
      { id: 'stralen', naam: 'Stralen', soort: 'schakelaar', standaard: 1, hint: 'pad' },
      { id: 'flits', naam: 'Flits', soort: 'trigger', hint: 'pad' },
      { id: 'paniek', naam: 'Paniek', soort: 'trigger' },
    ],
  },
  [ZEE]: {
    v: 1, app: ZEE, naam: 'Zee', kleur: '#2e9bff', truth: 'app', hb_s: 1,
    params: [
      { id: 'golf', naam: 'Golf', soort: 'waarde', standaard: 0.4, hint: 'fader', rol: 'macro.beweging' },
      { id: 'diepte', naam: 'Diepte', soort: 'waarde', standaard: 0.5, hint: 'fader', rol: 'macro.helderheid' },
      { id: 'galm', naam: 'Galm', soort: 'waarde', standaard: 0.3, hint: 'knop', rol: 'macro.ruimte', slew_s: 3 },
      { id: 'schuim', naam: 'Schuim', soort: 'waarde', standaard: 0.2, hint: 'knop' },
      { id: 'meeuw', naam: 'Meeuw', soort: 'trigger', hint: 'pad' },
      { id: 'paniek', naam: 'Paniek', soort: 'trigger' },
    ],
  },
};

/** Beginwaarden van een manifest (alle niet-triggers). @param {Manifest} m */
export const beginWaarden = (m) => Object.fromEntries(m.params.filter((p) => p.soort !== 'trigger').map((p) => [p.id, p.standaard ?? 0]));

const WACHT_MS = [500, 1000, 2000, 5000];
/** Na close-code 4001 (deze app is al open in een andere tab) of 4003 (token nodig): rustig aan (PROTOCOL §11, §13). */
const RUSTIG_MS = 30000;
/** Pas zo lang na het verbinden telt de verbinding als stabiel en begint de wachttijd weer van voren. */
const STABIEL_MS = 5000;

/**
 * Eén oefen-app aan de hub. Houdt zijn eigen waarden bij (truth "app"), meldt alles wat binnenkomt
 * via `bij(fn)`, en herverbindt vanzelf.
 */
export class OefenApp {
  /**
   * @param {{ manifest: Manifest, url: string, WebSocket?: any, inst?: string }} o
   */
  constructor({ manifest, url, WebSocket: WS = globalThis.WebSocket, inst }) {
    this.manifest = manifest;
    this.app = manifest.app;
    this.url = url;
    this.WS = WS;
    this.inst = inst ?? Math.random().toString(36).slice(2, 10);
    /** @type {Record<string, number>} */
    this.waarden = beginWaarden(manifest);
    /** @type {Record<string, boolean>} triggers die nu ingedrukt zijn */
    this.triggers = {};
    this.focus = false;
    /** @type {Record<string, any>} */
    this.globaal = {};
    this.verbonden = false;
    /** @type {Set<(b: any) => void>} */
    this.luisteraars = new Set();
    /** @type {any} */ this.ws = null;
    /** @type {any} */ this.hbTimer = null;
    /** @type {any} */ this.opnieuw = null;
    /** @type {any} */ this.stabiel = null;
    this.poging = 0;
    this.laatsteHb = 0;
    /** Waarom de verbinding weg is: null, 'vervangen' (4001: open in een andere tab) of 'token' (4003). @type {string|null} */
    this.reden = null;
    this.gestopt = false;
  }

  /** @param {(b: any) => void} fn bericht van de hub (na verwerking), of {t:'_status'} @returns {() => void} */
  bij(fn) { this.luisteraars.add(fn); return () => this.luisteraars.delete(fn); }

  /** @param {any} b */
  #meld(b) { for (const f of this.luisteraars) { try { f(b); } catch (e) { console.error(e); } } }

  start() {
    if (this.gestopt) return;
    const ws = new this.WS(this.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      // De wachttijd pas terug naar het begin na een tijdje stabiel: anders blijft hij bij een weigering
      // direct na het openen (4001) eeuwig op 0,5 s hangen.
      clearTimeout(this.stabiel);
      this.stabiel = setTimeout(() => { this.poging = 0; this.reden = null; }, STABIEL_MS);
      this.#stuur({ t: 'hallo', app: this.app, inst: this.inst, v: 1 });
      this.#stuur({ t: 'manifest', manifest: this.manifest });
      this.#stuur({ t: 'staat', waarden: { ...this.waarden } });
      this.verbonden = true;
      this.laatsteHb = Date.now();
      this.hbTimer = setInterval(() => this.#hartslag(), 1000);
      this.#meld({ t: '_status', verbonden: true });
    };
    ws.onmessage = (/** @type {{ data: any }} */ e) => {
      if (this.ws !== ws) return;
      let b;
      try { b = JSON.parse(String(e.data)); } catch { return; }
      this.#ontvang(b);
    };
    ws.onclose = (/** @type {{ code?: number }} */ e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.hbTimer);
      clearTimeout(this.stabiel);
      const was = this.verbonden;
      this.verbonden = false;
      this.focus = false;
      this.triggers = {};                        // een trigger die nog "aan" stond, krijgt zijn "uit" nooit meer
      const code = e?.code;
      this.reden = code === 4001 ? 'vervangen' : code === 4003 ? 'token' : null;
      if (was || this.reden) this.#meld({ t: '_status', verbonden: false, reden: this.reden });
      if (this.gestopt) return;
      const ms = this.reden ? RUSTIG_MS : WACHT_MS[Math.min(this.poging++, WACHT_MS.length - 1)];
      this.opnieuw = setTimeout(() => this.start(), ms);
    };
    ws.onerror = () => {};
  }

  /** Hartslag: elke seconde, ook als de browser de interval-timer van een verborgen tab afknijpt
   *  (dan houden de berichten van de hub, ~10 per seconde, hem levend via #ontvang). */
  #hartslag() {
    if (Date.now() - this.laatsteHb < 900) return;
    if (this.#stuur({ t: 'hb' })) this.laatsteHb = Date.now();
  }

  stop() {
    this.gestopt = true;
    clearInterval(this.hbTimer);
    clearTimeout(this.stabiel);
    clearTimeout(this.opnieuw);
    try { this.ws?.close(); } catch { /* al dicht */ }
    this.ws = null;
  }

  /** @param {object} b */
  #stuur(b) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(b)); return true; }
    return false;
  }

  /** De app verandert zelf een waarde (zoals met de muis in de app): de hub hoort het via `zet`. @param {string} id @param {number} v */
  zelfZetten(id, v) {
    this.waarden[id] = v;
    this.#stuur({ t: 'zet', id, v });
    this.#meld({ t: '_zelf', id, v });
  }

  /** @param {any} b */
  #ontvang(b) {
    this.#hartslag();
    switch (b?.t) {
      case 'zet':
        if (typeof b.id === 'string' && typeof b.v === 'number' && b.id in this.waarden) this.waarden[b.id] = Math.max(0, Math.min(1, b.v));
        break;
      case 'trig': if (typeof b.id === 'string') this.triggers[b.id] = !!b.aan; break;
      case 'focus': this.focus = !!b.aan; break;
      case 'globaal': if (b.waarden && typeof b.waarden === 'object') Object.assign(this.globaal, b.waarden); break;
      default: break;
    }
    this.#meld(b);
  }
}
