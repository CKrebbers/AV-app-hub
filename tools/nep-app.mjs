#!/usr/bin/env node
// @ts-check
// Nep-app: een app die het protocol netjes volgt. Voor tests van de hub, voor demo's,
// en als voorbeeld voor elke echte koppeling (PROTOCOL.md §3).
//   node tools/nep-app.mjs [--url ws://localhost:7700/app] [--app nep-app]
import WebSocket from 'ws';
import { leesNaarApp, nieuweInst } from '../src/protocol/berichten.js';
import { Zender } from '../src/core/zender.js';

/** @typedef {import('../src/protocol/types.js').Manifest} Manifest */

/** @param {string} app @returns {Manifest} */
export const voorbeeldManifest = (app = 'nep-app') => ({
  v: 1, app, naam: 'Nep-app', kleur: '#3fbf5f', truth: 'app', hb_s: 1, lease: false,
  scenes: ['Rust', 'Storm'],
  params: [
    { id: 'helder', naam: 'Helderheid', soort: 'waarde', standaard: 0.5, hint: 'fader', rol: 'macro.helderheid' },
    { id: 'ruimte', naam: 'Ruimte', soort: 'waarde', standaard: 0.3, hint: 'knop', rol: 'macro.ruimte', slew_s: 2 },
    { id: 'aan', naam: 'Aan', soort: 'schakelaar', standaard: 1, hint: 'pad' },
    { id: 'flits', naam: 'Flits', soort: 'trigger', hint: 'pad' },
    { id: 'palet', naam: 'Palet', soort: 'keuze', keuzes: ['warm', 'koel', 'mono'], hint: 'kolom' },
    { id: 'paniek', naam: 'Paniek', soort: 'trigger' },
  ],
});

export class NepApp extends Zender {
  /** @param {{ url: string, manifest?: Manifest, inst?: string, herverbind?: boolean }} o */
  constructor({ url, manifest = voorbeeldManifest(), inst = nieuweInst(), herverbind = true }) {
    super();
    this.url = url;
    this.manifest = manifest;
    this.inst = inst;
    this.herverbind = herverbind;
    /** @type {Record<string, number>} */
    this.waarden = Object.fromEntries(manifest.params.filter((p) => p.soort !== 'trigger').map((p) => [p.id, p.standaard ?? 0]));
    /** @type {any[]} */
    this.ontvangen = [];
    /** @type {WebSocket|null} */
    this.ws = null;
    this.wacht = 500;
    this.gestopt = false;
    this.hb = null;
  }
  start() { this.gestopt = false; this.#verbind(); return this; }
  stop() { this.gestopt = true; if (this.hb) clearInterval(this.hb); this.ws?.close(); }
  /** De app verandert zelf iets (muis). @param {string} id @param {number} v */
  zelfZetten(id, v) { this.waarden[id] = v; this.#stuur({ t: 'zet', id, v }); }
  /** @param {object} b */
  #stuur(b) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(b)); }
  #verbind() {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.on('open', () => {
      this.wacht = 500;
      this.#stuur({ t: 'hallo', app: this.manifest.app, inst: this.inst, v: 1 });
      this.#stuur({ t: 'manifest', manifest: this.manifest });
      this.#stuur({ t: 'staat', waarden: this.waarden });
      this.hb = setInterval(() => this.#stuur({ t: 'hb' }), this.manifest.hb_s * 1000 * 0.8);
      this.meld('open');
    });
    ws.on('message', (data) => {
      const r = leesNaarApp(String(data));
      if (!r.ok || 'onbekend' in r) return;
      const b = r.bericht;
      this.ontvangen.push(b);
      if (b.t === 'zet') this.waarden[b.id] = b.v;
      this.meld('bericht', b);
    });
    ws.on('close', () => {
      if (this.hb) clearInterval(this.hb);
      this.meld('dicht');
      if (this.gestopt || !this.herverbind) return;
      setTimeout(() => this.#verbind(), this.wacht);
      this.wacht = Math.min(5000, this.wacht * 2);
    });
    ws.on('error', () => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (/** @type {string} */ n, /** @type {string} */ s) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : s; };
  const app = new NepApp({ url: arg('--url', 'ws://localhost:7700/app'), manifest: voorbeeldManifest(arg('--app', 'nep-app')) }).start();
  app.bij('open', () => console.log('verbonden'));
  app.bij('dicht', () => console.log('verbinding weg, opnieuw proberen…'));
  app.bij('bericht', (/** @type {any} */ b) => console.log(JSON.stringify(b)));
}
