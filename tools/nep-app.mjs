#!/usr/bin/env node
// @ts-check
// Nep-app: een app die het protocol netjes volgt. Voor tests van de hub, voor demo's,
// en als voorbeeld voor elke echte koppeling (PROTOCOL.md §3).
//   node tools/nep-app.mjs [--url ws://localhost:7700/app] [--app nep-app] [--speelt]
//   --speelt: een lease-app die de Xboard49 en de Maschine MK2 speelt (PROTOCOL §17): pads lichten op, een scherm
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

/**
 * Een lease-app die de speelapparaten speelt (PROTOCOL §17): de Xboard49 en de Maschine MK2. Geen parameters.
 * @param {string} app @returns {Manifest}
 */
export const speelManifest = (app = 'nep-speler') => ({
  v: 1, app, naam: 'Nep-speler', kleur: '#ff7a1a', truth: 'app', hb_s: 1, lease: true, rings: 'host',
  speelt: ['xboard49', 'maschine-mk2'], scenes: [], params: [],
});

/** Een scherm van de Maschine: een rand en een diagonaal (2048 bytes, rij voor rij, hoogste bit = links), base64. */
export function nepScherm() {
  const b = new Uint8Array(2048);
  const zet = (/** @type {number} */ x, /** @type {number} */ y) => { b[32 * y + (x >> 3)] |= 0x80 >> (x & 7); };
  for (let x = 0; x < 256; x++) { zet(x, 0); zet(x, 63); zet(x, Math.floor(x / 4)); }
  for (let y = 0; y < 64; y++) { zet(0, y); zet(255, y); }
  return Buffer.from(b).toString('base64');
}

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
      if (this.manifest.speelt?.includes('maschine-mk2')) this.#stuur({ t: 'scherm', dev: 'maschine-mk2', nr: 0, data: nepScherm() });
      this.meld('open');
    });
    ws.on('message', (data) => {
      const r = leesNaarApp(String(data));
      if (!r.ok || 'onbekend' in r) return;
      const b = r.bericht;
      this.ontvangen.push(b);
      if (b.t === 'zet') this.waarden[b.id] = b.v;
      // Speelapparaten (§17): een pad van de Maschine licht groen op zolang hij in is (LED terug als noot, kanaal 0).
      if (b.t === 'midi' && b.dev === 'maschine-mk2' && this.manifest.speelt?.includes('maschine-mk2')) {
        const [st, n, v] = b.bytes;
        if ((st === 0x90 || st === 0x80) && n >= 36 && n <= 51) this.#stuur({ t: 'led', dev: 'maschine-mk2', bytes: [[0x90, n, st === 0x90 && v > 0 ? 21 : 0]] });
      }
      this.meld('bericht', b);
    });
    ws.on('close', (code) => {
      if (this.hb) clearInterval(this.hb);
      this.meld('dicht', code);
      if (this.gestopt || !this.herverbind) return;
      // 4001 = een andere instantie van deze app is al verbonden (PROTOCOL.md §10): rustig opnieuw proberen.
      const wacht = code === 4001 ? 30000 : this.wacht;
      setTimeout(() => this.#verbind(), wacht);
      this.wacht = Math.min(5000, this.wacht * 2);
    });
    ws.on('error', () => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (/** @type {string} */ n, /** @type {string} */ s) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : s; };
  // --speelt: een lease-app die de Xboard49 en de Maschine MK2 speelt (§17) in plaats van een manifest-app.
  const naam = arg('--app', process.argv.includes('--speelt') ? 'nep-speler' : 'nep-app');
  const manifest = process.argv.includes('--speelt') ? speelManifest(naam) : voorbeeldManifest(naam);
  const app = new NepApp({ url: arg('--url', 'ws://localhost:7700/app'), manifest }).start();
  app.bij('open', () => console.log('verbonden'));
  app.bij('dicht', () => console.log('verbinding weg, opnieuw proberen…'));
  app.bij('bericht', (/** @type {any} */ b) => console.log(JSON.stringify(b)));
}
