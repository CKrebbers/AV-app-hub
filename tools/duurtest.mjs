#!/usr/bin/env node
// @ts-check
// Duurtest: een hele avond in een paar minuten (docs/DUURTEST.md).
//
//   node --expose-gc tools/duurtest.mjs [--minuten 3] [--seed 7] [--nep-minuten N] [--stap 50] [--meet-s 2]
//                                       [--opname doorlopend|wisselend] [--uit tools/uitvoer] [--stil] [--bewaar]
//
// De echte hub (startHub: apparaten, kern, server, opname, geheugen; drivers via startDrivers zoals de hub dat
// doet) draait met een nep-APC40 mkII en een nep-LPD8 (src/ports/nep.js), een NepKlok die in stappen vooruit
// gezet wordt (tientallen keren sneller dan echt), nep-apps (tools/nep-app.mjs, met de echte manifesten uit
// test/fixtures/manifesten) en cockpits over echte WebSockets. Een seed bepaalt wat er gebeurt en wanneer
// (in nep-tijd): draaien aan faders en knoppen, focus wisselen, snapshots, paniek, opname, apps die wegvallen
// en terugkomen, een tweede tab, cockpits die komen, gaan en traag lezen, een app die rommel stuurt, een
// controller die eruit getrokken wordt en een uurwerk-brug die even weg is.
//
// Gemeten: heap na gc, event-loop-vertraging, open handles en klok-timers, de grootte van alle structuren die
// kunnen groeien, berichten per seconde, en invarianten (paniek, slews, staat, opruimen). Rapport op stdout en
// als JSON in --uit. Exitcode 1 bij een lek of een geschonden invariant, 2 bij een verkeerde optie of als de
// duurtest zelf crasht.
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import WebSocket from 'ws';
import { startHub } from '../src/hub.js';
import { startDrivers } from '../src/drivers/index.js';
import { NepSysteem } from '../src/ports/nep.js';
import { NepKlok } from '../src/core/klok.js';
import { laadConfig } from '../src/config.js';
import { PANIEK_MS, LANG_MS } from '../src/core/kern.js';
import { MAX_BERICHT } from '../src/transports/server.js';
import * as APC from '../src/devices/apc40mk2.js';
import * as LPD8 from '../src/devices/lpd8.js';
import { MAX_PARAMS } from '../src/protocol/manifest.js';
import { GEBAREN, SAMENVATTING } from '../src/opname/opnemer.js';
import { NepApp, voorbeeldManifest } from './nep-app.mjs';
import { isHoofdmodule } from './repetitie-proces.mjs';

const HUB_MAP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(HUB_MAP, 'test/fixtures/manifesten');
const echt = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const rond = (/** @type {number} */ x, n = 2) => Math.round(x * 10 ** n) / 10 ** n;
const MB = 1024 * 1024;
/** Resolutie van monitorEventLoopDelay (ms). Die meet de tijd tussen twee tikken; de vertraging is wat erboven komt. */
const ELD_RESOLUTIE = 5;
/** Vertraging in ms uit een waarde van monitorEventLoopDelay (ns). @param {number} ns */
const vertraging = (ns) => rond(Math.max(0, ns / 1e6 - ELD_RESOLUTIE));

// ── toeval en agenda ─────────────────────────────────────────────────────────

/**
 * Reproduceerbaar toeval (mulberry32): dezelfde seed geeft dezelfde avond.
 * @param {number} seed
 */
export function maakToeval(seed) {
  let s = (seed >>> 0) || 1;
  const getal = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    getal,
    /** @param {number} a @param {number} b */ tussen: (a, b) => a + (b - a) * getal(),
    /** @param {number} a @param {number} b */ geheel: (a, b) => a + Math.floor((b - a + 1) * getal()),
    /** @template T @param {readonly T[]} l @returns {T} */ kies: (l) => l[Math.floor(getal() * l.length)],
    /** @param {number} p */ kans: (p) => getal() < p,
    /** Wachttijd tot het volgende voorval bij gemiddeld één per `ms` (exponentieel). @param {number} ms */
    wacht: (ms) => -Math.log(1 - getal()) * ms,
  };
}

/** Wat er in nep-tijd moet gebeuren, op volgorde (bij gelijke tijd: in volgorde van plannen). */
export class Agenda {
  constructor() { /** @type {{ t: number, n: number, fn: () => void }[]} */ this.rij = []; this.n = 0; }
  /** @param {number} t @param {() => void} fn */
  plan(t, fn) {
    const x = { t, n: this.n++, fn };
    let lo = 0, hi = this.rij.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (this.rij[m].t <= t) lo = m + 1; else hi = m; }
    this.rij.splice(lo, 0, x);
  }
  /** Eerstvolgende tijd, of Infinity. */
  get volgende() { return this.rij.length ? this.rij[0].t : Infinity; }
  /** Haal het eerste item eraf. */
  neem() { return this.rij.shift(); }
  get lengte() { return this.rij.length; }
  leeg() { this.rij = []; }
}

// ── statistiek ───────────────────────────────────────────────────────────────

/** @param {number[]} l */
const minimum = (l) => (l.length ? Math.min(...l) : NaN);
/** @param {number[]} l */
const maximum = (l) => (l.length ? Math.max(...l) : NaN);

/** Mediaan van een lijst getallen. @param {number[]} l */
const mediaan = (l) => { if (!l.length) return NaN; const s = [...l].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/**
 * Groeit een reeks (een meting per tijdstip) zonder te krimpen? Vergelijkt het tweede kwart met het laatste
 * kwart (het eerste kwart is opwarmen): de mediaan moet met de helft stijgen én met minstens `minAbs`.
 * Een mediaan, geen maximum: een wachtrij die net op het moment van meten een volle portie heeft (een piek), of
 * een structuur die schommelt (slews), groeit niet; een structuur die gestaag oploopt, duwt de mediaan mee.
 * @param {number[]} reeks @param {{ minAbs?: number, minMetingen?: number }} [o]
 */
export function groeit(reeks, { minAbs = 50, minMetingen = 8 } = {}) {
  if (reeks.length < minMetingen) return null;
  const k = Math.floor(reeks.length / 4);
  const tweede = mediaan(reeks.slice(k, 2 * k)), laatste = mediaan(reeks.slice(-k));
  return { tweede, laatste, groeit: laatste > 1.5 * tweede && laatste - tweede >= minAbs };
}

/**
 * Lekt de heap? Na het opwarmen (eerste 20%) het minimum van het eerste en laatste derde vergelijken: een lek
 * duwt ook het minimum (na gc) omhoog, ruis en pieken niet.
 * @param {number[]} heap bytes, na gc @param {{ drempelMB?: number, drempelDeel?: number }} [o]
 */
export function heapOordeel(heap, { drempelMB = 6, drempelDeel = 0.15 } = {}) {
  const rest = heap.slice(Math.floor(heap.length * 0.2));
  if (rest.length < 6) return null;
  const d = Math.floor(rest.length / 3);
  const begin = minimum(rest.slice(0, d)), eind = minimum(rest.slice(-d));
  const groeiMB = (eind - begin) / MB;
  return { beginMB: rond(begin / MB), eindMB: rond(eind / MB), groeiMB: rond(groeiMB), lek: groeiMB > Math.max(drempelMB, (begin / MB) * drempelDeel) };
}

/** Open handles van het proces, per soort (Timeout, TCPSocketWrap, …). */
export function handles() {
  /** @type {Record<string, number>} */
  const uit = {};
  for (const h of process.getActiveResourcesInfo()) uit[h] = (uit[h] ?? 0) + 1;
  return uit;
}

/** Iets dat luisteraars bijhoudt zoals src/core/zender.js. @param {any} z */
const luisteraars = (z) => { let n = 0; for (const s of z?.l?.values?.() ?? []) n += s.size; return n; };

/**
 * Alles wat in de hub kan groeien, als getallen. Per app en per driver opgeteld.
 * @param {{ hub: any, drivers: any[], klok: NepKlok }} o
 */
export function structuren({ hub, drivers, klok }) {
  const k = hub.kern;
  let waarden = 0, kaart = 0, pickups = 0, vast = 0, knoppen = 0, maxWaarden = 0;
  for (const a of k.apps.values()) {
    const n = Object.keys(a.waarden).length;
    waarden += n; maxWaarden = Math.max(maxWaarden, n);
    kaart += a.kaart.size; pickups += a.pickups.size; vast += a.vast.size; knoppen += a.knoppen.size;
  }
  /** @type {Record<string, number>} */
  const d = { 'driver.verstuurd': 0, 'driver.maps': 0, 'driver.timers': 0, 'driver.pending': 0 };
  for (const x of drivers) {
    const dr = x.driver;
    d['driver.verstuurd'] += dr.verstuurd?.length ?? 0;
    for (const m of ['laatste', 'opDraad', 'zelfGezet', 'ingedrukt', 'klinkt', 'rem', 'bekend', 'params']) d['driver.maps'] += dr[m]?.size ?? 0;
    d['driver.maps'] += dr.teruggelezen?.length ?? 0;
    d['driver.timers'] += (dr.sceneTimers?.size ?? 0) + (dr.meldTimers?.length ?? 0);
    d['driver.pending'] += dr.posts?.size ?? 0;
  }
  const op = hub.opnemer;
  const huidig = op?.huidig;
  let naarSleutels = 0;
  for (const x of Object.values(huidig?.naar ?? {})) naarSleutels += 1 + Object.keys(/** @type {object} */ (x)).length;
  let bestandKB = 0;
  try { if (huidig?.map) bestandKB = Math.round(statSync(join(huidig.map, GEBAREN)).size / 1024); } catch { /* nog niet gespoeld */ }
  const apc = hub.apparaten.apc, lpd8 = hub.apparaten.lpd8;
  return {
    'kern.apps': k.apps.size,
    'kern.verbindingen': k.verbindingen.size,
    'kern.slews': k.slews.size,
    'kern.routes': k.routes.size,
    'kern.padDruk': k.padDruk.size,
    'kern.lpdPickups': k.lpdPickups.size,
    'kern.appPaniekTot': k.appPaniekTot.size,
    'kern.leaseRij': k.leaseRij.size,
    'kern.snapshots': k.snapshots.size,
    'kern.bewaard': k.bewaard.size + k.bewaardInst.size,
    'kern.fysiek': k.fysiek.size,
    'kern.getoond': k.getoond.size,
    'kern.taps': k.taps.length,
    'kern.luisteraars': luisteraars(k),
    'app.waarden': waarden,
    'app.waardenMax': maxWaarden,
    'app.kaart': kaart,
    'app.pickups': pickups,
    'app.vast': vast,
    'app.knoppen': knoppen,
    'apc.wachtrij': apc.rij.lengte,
    'apc.wachtenden': apc.rij.wachtenden.length,
    'apc.leds': apc.leds.staat.size + apc.leds.verstuurd.size,
    'lpd8.wachtrij': lpd8.rij.lengte,
    'lpd8.programmas': lpd8.programmas.size,
    'apparaten.luisteraars': luisteraars(apc) + luisteraars(lpd8),
    'opname.lopend': (op?.lopend.size ?? 0) + (op?.uitlopend.size ?? 0),
    'opname.bufferKB': Math.round((huidig?.schrijver.tekens ?? 0) / 1024),
    'opname.naarSleutels': naarSleutels,
    'opname.invoerSleutels': Object.keys(huidig?.invoer ?? {}).length,
    'opname.bestandKB': bestandKB,
    'opname.luisteraars': luisteraars(op),
    ...d,
    'klok.timers': klok.timers.size,
  };
}

/**
 * Structuren met een vaste bovengrens (alles wat erboven komt is een fout, los van de trend).
 * De rest wordt op groei gecontroleerd (zie groeit()).
 */
const GRENZEN = /** @type {Record<string, number>} */ ({
  // padDruk: de LPD8-pads P5–P8 (kort of lang, beslist bij loslaten); taps: de kern middelt over de laatste 5
  // tikken. Beide staan in src/core/kern.js zonder export.
  'kern.snapshots': 99, 'kern.routes': APC.CONTROLS.length, 'kern.padDruk': 4,
  'kern.lpdPickups': LPD8.standaardProfiel('mk2').knoppen.length, 'kern.taps': 5,
  'kern.fysiek': APC.CONTROLS.length + 8, 'kern.getoond': APC.MET_LED.length, 'app.waardenMax': MAX_PARAMS,
  // LED-kaart van een lease-app: per adres (40 RGB-pads + 16 kanalen × 128 noten en CC's); er zijn er hooguit twee.
  'app.kaart': 2 * (40 + 2 * 16 * 128),
  'apc.wachtenden': 0, 'driver.verstuurd': 3 * 256, 'opname.lopend': 4, 'opname.bufferKB': 16 * 1024,
  // Per invoerbron één teller: APC, LPD8 en hun virtuele tweelingen uit de cockpit.
  'opname.invoerSleutels': 4,
});
/**
 * Mag groeien. Het opnamebestand op schijf: een opname van de hele avond. De tellers per app in de opname (voor de
 * samenvatting): één erbij voor elke app-naam die tijdens de opname een bericht kreeg; de duurtest laat steeds nieuwe
 * half afgebouwde apps komen (proef-1, proef-2, …), een echte avond heeft er een handvol. Staat in het rapport.
 */
const MAG_GROEIEN = new Set(['opname.bestandKB', 'opname.naarSleutels']);

// ── nep-apps, cockpits en rommel ─────────────────────────────────────────────

/** @typedef {{ naarApp: number, app: number, cockpit: number, cockpitBytes: number, apc: number, lpd8: number, rommel: number, fetch: number }} Teller */

/** Nep-app voor de duurtest: hartslag op de nep-klok, telt wat binnenkomt en bewaart het niet (dat zou zelf lekken). */
class DuurApp extends NepApp {
  /** @param {{ url: string, manifest: any, staat?: Record<string, number>, teller: Teller, nu?: () => number }} o */
  constructor({ url, manifest, staat = {}, teller, nu = () => 0 }) {
    super({ url, manifest: structuredClone(manifest), herverbind: false });
    Object.assign(this.waarden, staat);
    this.teller = teller;
    /** Wanneer (nep-tijd) deze verbinding openging, en wanneer hij het laatst "paniek uit" hoorde (trig of globaal). */
    this.verbondenOp = -Infinity;
    this.uitOp = { trig: -Infinity, globaal: -Infinity };
    /** De laatste paar paniek-berichten (nep-tijd), voor het rapport als er iets niet klopt. @type {string[]} */
    this.paniekLog = [];
    const logPaniek = (/** @type {string} */ x) => { this.paniekLog.push(`${Math.round(nu() / 100) / 10} s ${x}`); if (this.paniekLog.length > 6) this.paniekLog.shift(); };
    this.stil = false;
    this.leds = 0;
    this.bij('open', () => {
      // NepApp stuurt zijn hartslag op de echte klok; hier volgt hij de nep-klok (hartslag()).
      if (this.hb) clearInterval(this.hb);
      this.hb = null;
      this.verbondenOp = nu();
      logPaniek('verbonden');
      if (this.manifest.lease) this.#ledBurst(24);
    });
    this.bij('bericht', (/** @type {any} */ b) => {
      teller.app++;
      this.ontvangen.length = 0;
      if (b.t === 'trig' && b.id === 'paniek') { if (!b.aan) this.uitOp.trig = nu(); logPaniek(`trig ${b.aan}`); }
      if (b.t === 'globaal' && typeof b.waarden?.paniek === 'number') { if (b.waarden.paniek === 0) this.uitOp.globaal = nu(); logPaniek(`globaal ${b.waarden.paniek}`); }
      // De echte Waterschaal: paniek = volume naar 0, en dat meldt hij terug.
      if (this.manifest.app === 'waterschaal' && b.t === 'trig' && b.id === 'paniek' && b.aan) this.zelfZetten('volume', 0);
      if (!this.manifest.lease) return;
      // Een lease-app (Varve DJ) tekent zelf: elke toets een LED terug, bij focus een hele rij.
      if (b.t === 'midi' && (b.bytes[0] & 0xf0) === 0x90) this.#stuurLed([[0x90 | (this.leds % 16), b.bytes[1], (this.leds++ * 7) % 128]]);
      if (b.t === 'midi' && b.bytes[0] === 0xb0 && b.bytes[1] === 14 && 'master' in this.waarden) this.zelfZetten('master', b.bytes[2] / 127);
      if (b.t === 'focus' && b.aan) this.#ledBurst(40);
    });
  }
  /** @param {number} n */
  #ledBurst(n) { this.#stuurLed(Array.from({ length: n }, (_, i) => [0x90, i % 40, (this.leds++ * 13) % 128])); }
  /** @param {number[][]} bytes */
  #stuurLed(bytes) { if (this.open) this.ws?.send(JSON.stringify({ t: 'led', bytes })); }
  get open() { return this.ws?.readyState === WebSocket.OPEN; }
  hartslag() { if (!this.stil && this.open) this.ws?.send('{"t":"hb"}'); }
}

/** Een cockpit (zoals ui/): ontvangt beeld, leds en invoer; bewaart alleen het laatste beeld. */
class DuurCockpit {
  /** @param {string} url @param {Teller} teller */
  constructor(url, teller) {
    this.ws = new WebSocket(url);
    /** @type {string|null} */
    this.laatsteBeeld = null;
    this.traag = false;
    /** Triggers die deze cockpit nu ingedrukt houdt (app\0id). @type {Set<string>} */
    this.triggers = new Set();
    /** Virtuele toetsen die deze cockpit nu ingedrukt houdt. @type {Set<string>} */
    this.toetsen = new Set();
    this.ws.on('message', (d) => {
      teller.cockpit++;
      const t = String(d);
      teller.cockpitBytes += t.length;
      if (t.startsWith('{"apps"')) this.laatsteBeeld = t;
    });
    this.ws.on('error', () => {});
  }
  get open() { return this.ws.readyState === WebSocket.OPEN; }
  /** @param {object} b */
  stuur(b) { if (this.open) this.ws.send(JSON.stringify(b)); }
  /** Een trage tablet: even niets lezen (de hub moet dan overslaan en later inhalen). */
  pauze() { this.traag = true; this.ws.pause(); }
  verder() { this.traag = false; this.ws.resume(); }
  /** @param {string} app @param {string} id @param {boolean} aan */
  trigger(app, id, aan) {
    const k = `${app}\u0000${id}`;
    if (aan) this.triggers.add(k); else if (!this.triggers.delete(k)) return;
    this.stuur({ t: 'zet', app, id, v: aan ? 1 : 0 });
  }
  /**
   * Weg, zoals een pagina die sluit (ui/cockpit.js laat dan zijn triggers los). Virtueel ingedrukte toetsen niet:
   * die laat de hub zelf los als de cockpit wegvalt (PROTOCOL §10).
   */
  sluit() {
    if (this.traag) this.verder();
    for (const k of this.triggers) { const [app, id] = k.split('\u0000'); this.stuur({ t: 'zet', app, id, v: 0 }); }
    this.triggers.clear();
    this.ws.close();
  }
}

/**
 * Een app die rommel stuurt: kapotte JSON, binaire data, berichten vóór hallo, ongeldige manifesten, onbekende
 * parameters, LED-SysEx, hartslagvloed, te grote berichten, en af en toe een half afgebouwde app met een
 * steeds andere naam.
 */
class Rommel {
  /** @param {string} url @param {Teller} teller */
  constructor(url, teller) {
    this.url = url;
    this.teller = teller;
    /** @type {WebSocket|null} */
    this.ws = null;
    this.gehallood = false;
    this.n = 0;
  }
  verbind() {
    this.ws?.terminate();
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.gehallood = false;
    ws.on('error', () => {});
    ws.on('message', () => { this.teller.app++; });
    ws.on('close', () => { if (this.ws === ws) this.ws = null; });
  }
  /** @param {string|Buffer} x */
  #stuur(x) { if (this.ws?.readyState === WebSocket.OPEN) { this.ws.send(x); this.teller.rommel++; } }
  /**
   * Eén rommelactie (soort 0..15) met al getrokken toeval x, y (0..1): zo verbruikt een actie altijd evenveel
   * toeval, ook als de socket net dicht was.
   * @param {number} soort @param {number} x @param {number} y
   */
  doe(soort, x, y) {
    if (!this.ws) { this.verbind(); return; }
    const n = this.n++;
    switch (soort) {
      case 0: return this.#stuur('kapot{');
      case 1: return this.#stuur(Buffer.from([1, 2, 3, n % 256]));
      case 2: return this.#stuur(['[]', 'null', '42', '"tekst"', '{}'][Math.floor(x * 5)]);
      case 3: return this.#stuur(JSON.stringify({ t: `onbekend-${n % 5}`, x: n }));
      case 4: return this.#stuur(JSON.stringify({ t: 'hallo', app: 'ROMMEL!!', inst: 'x' }));
      case 5:
        this.gehallood = true;
        return this.#stuur(JSON.stringify({ t: 'hallo', app: 'rommel', inst: 'rommel-1', v: 1 }));
      case 6: return this.#stuur(JSON.stringify({ t: 'manifest', manifest: { v: 2, app: 'rommel', params: 'nee' } }));
      case 7: return this.#stuur(JSON.stringify({ t: 'manifest', manifest: { ...voorbeeldManifest('iemand-anders') } }));
      case 8: return this.#stuur(JSON.stringify({ t: 'zet', id: `onzin-${n}`, v: x }));
      case 9: return this.#stuur(JSON.stringify({ t: 'staat', waarden: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`ruis-${n}-${i}`, (x + i * y) % 1])) }));
      case 10: return this.#stuur(JSON.stringify({ t: 'led', bytes: [[0xf0, 0x47, 0, 0x29, 0x60, 0, 4, 0x41, 0, 0, 0, 0xf7], [0x90, 5, 3, 0xf7], [0xfa]] }));
      case 11: for (let i = 0; i < 50; i++) this.#stuur('{"t":"hb"}'); return;
      case 12: return this.#stuur('x'.repeat(MAX_BERICHT + 1024));   // de server sluit (te groot)
      case 13: this.ws.terminate(); this.ws = null; return;
      case 14: {
        // Een manifest dat steeds andere parameters heeft (een app in ontwikkeling).
        const params = Array.from({ length: 6 }, (_, i) => ({ id: `p${n}-${i}`, naam: `P${i}`, soort: 'waarde' }));
        if (!this.gehallood) return;
        return this.#stuur(JSON.stringify({ t: 'manifest', manifest: { v: 1, app: 'rommel', naam: 'Rommel', params } }));
      }
      default: return this.#stuur(JSON.stringify({ t: 'zet', id: 'paniek', v: Number.NaN }));
    }
  }
  sluit() { this.ws?.close(); this.ws = null; }
}

/** Een half afgebouwde app die zich met een steeds andere naam aanmeldt en geen manifest stuurt. */
function halfAfgebouwd(/** @type {string} */ url, /** @type {number} */ n) {
  const ws = new WebSocket(url);
  ws.on('error', () => {});
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hallo', app: `proef-${n}`, inst: `p${n}`, v: 1 })));
  return ws;
}

/** De uurwerk-brug zonder uurwerk: een nep-fetch voor de http-driver die aan en uit kan. @param {Teller} teller */
function nepUurwerk(teller) {
  const brug = {
    aan: true,
    /** @param {string} url @param {any} [init] */
    fetch(url, init) {
      teller.fetch++;
      if (init?.signal?.aborted) return Promise.reject(new Error('afgebroken'));
      if (!brug.aan) return Promise.reject(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
      const pad = new URL(url).pathname;
      const tekst = pad === '/' ? 'uurwerk-brug, tabs: 1' : pad === '/verb' ? '{"ok":true}' : '{"fout":"nep-brug kan niet teruglezen"}';
      return Promise.resolve({ ok: pad !== '/verb/toon', status: pad === '/verb/toon' ? 404 : 200, text: async () => tekst });
    },
  };
  return brug;
}

/** @param {string} id */
const ctrl = (id) => /** @type {import('../src/devices/apc40mk2.js').Control} */ (APC.OP_ID.get(id));
const LPD8_PROFIEL = LPD8.standaardProfiel('mk2');
const FADERS = [...Array.from({ length: 8 }, (_, i) => `fader${i + 1}`), 'master', 'xf'];
const KNOPPEN = [...Array.from({ length: 8 }, (_, i) => `dk${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `tk${i + 1}`)];
/**
 * De hub ziet een virtuele toets en dezelfde fysieke toets als één toets. Echt twee keer indrukken zonder loslaten
 * kan met één hand niet; daarom drukt de cockpit virtueel alleen op de onderste twee rijen pads (en LPD8 P7, P8),
 * de "hand" op de APC op de rest (en LPD8 P5, P6). Zie docs/DUURTEST.md (open punt: cockpit + hardware tegelijk).
 */
const VIRTUEEL = new Set(APC.CONTROLS.filter((c) => /^pad[12]-/.test(c.id)).map((c) => c.id));
const TOETSEN = APC.CONTROLS.filter((c) => c.t === 'note' && !VIRTUEEL.has(c.id) && c.id !== 'bank' && c.id !== 'shift' && c.id !== 'stopall').map((c) => c.id);
const TOETSEN_VIRTUEEL = [...VIRTUEEL];

// ── de duurtest ──────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   echtMs?: number, nepMs?: number, seed?: number, stapMs?: number, meetElkeMs?: number,
 *   log?: (s: string) => void, heap?: boolean, bewaar?: boolean, drempelMB?: number,
 *   opname?: 'doorlopend'|'wisselend', signaal?: AbortSignal,
 * }} Opties
 *   echtMs: zo lang (echte tijd) spelen; nepMs: of tot de nep-klok zo ver is (wat het eerst komt; minstens één).
 *   heap: het heap-oordeel meetellen en gc() gebruiken (alleen zinvol bij een run van minuten). bewaar: tijdelijke
 *   map laten staan. opname: 'doorlopend' = één opname van het begin tot de afbouw (zoals een echte avond),
 *   'wisselend' = LPD8 P4 gemiddeld elke 150 s nep (aan, uit, aan, …). signaal: afbreken (Ctrl-C): de avond stopt,
 *   de afbouw en het rapport komen er nog.
 */

/**
 * Speel een avond en meet. Geeft het rapport (zie docs/DUURTEST.md); `rapport.ok` is false bij een lek of een
 * geschonden invariant.
 * @param {Opties} o
 */
export async function draaiDuurtest({ echtMs = Infinity, nepMs = Infinity, seed = 7, stapMs = 50, meetElkeMs = 2000, log = () => {}, heap = true, bewaar = false, drempelMB = 6, opname = 'doorlopend', signaal } = {}) {
  if (echtMs === Infinity && nepMs === Infinity) throw new Error('geef echtMs of nepMs');
  for (const [naam, x] of Object.entries({ echtMs, nepMs, stapMs, meetElkeMs })) if (!(x > 0)) throw new Error(`${naam} moet een getal groter dan 0 zijn (nu ${x})`);
  if (!Number.isInteger(seed) || seed < 0) throw new Error(`seed moet een geheel getal ≥ 0 zijn (nu ${seed})`);
  if (opname !== 'doorlopend' && opname !== 'wisselend') throw new Error(`opname is 'doorlopend' of 'wisselend' (nu ${opname})`);
  const t = maakToeval(seed);
  // Zonder heap-oordeel ook geen gc(): niet twee keer per meting een volledige gc, en geen V8-vlaggen veranderen
  // in een proces dat al draait (vitest).
  const gc = heap ? zoekGc() : null;
  const map = mkdtempSync(join(tmpdir(), 'varve-duurtest-'));
  const klok = new NepKlok();
  const agenda = new Agenda();
  /** @type {Teller} */
  const teller = { naarApp: 0, app: 0, cockpit: 0, cockpitBytes: 0, apc: 0, lpd8: 0, rommel: 0, fetch: 0 };
  /** @type {Record<string, number>} */
  const acties = {};
  const tel = (/** @type {string} */ naam) => { acties[naam] = (acties[naam] ?? 0) + 1; };
  /** @type {{ wat: string, nepS: number, detail: string }[]} */
  const schendingen = [];
  const schend = (/** @type {string} */ wat, /** @type {string} */ detail) => {
    if (schendingen.length < 200) schendingen.push({ wat, nepS: rond(klok.nu() / 1000, 1), detail });
    log(`  ✗ ${wat}: ${detail}`);
  };
  /** @type {string[]} */
  const meldingen = [];
  let meldingTotaal = 0;
  const hubLog = (/** @type {unknown[]} */ ...x) => { meldingTotaal++; meldingen.push(x.map(String).join(' ').slice(0, 200)); if (meldingen.length > 30) meldingen.shift(); };
  const handlesVooraf = handles();

  /** @type {any} */ let hub = null;
  /** @type {any} */ let actieveDrivers = null;
  let hubGestopt = false;
  /** Drivers en hub stoppen (één keer); de nep-klok loopt mee, zodat de afsluit-timers aflopen. */
  const stopHub = async () => {
    if (hubGestopt || !hub) return;
    hubGestopt = true;
    actieveDrivers?.stop();
    let klaar = false;
    const stop = hub.stop().finally(() => { klaar = true; });
    while (!klaar) { klok.loop(stapMs); await echt(1); }
    await stop;
  };
  /** @type {any} */ let eld = null;
  /** @type {any} */ let eldTotaal = null;
  // Alles na het aanmaken van de tijdelijke map in één try/finally: gaat de opbouw, de avond of de afbouw mis,
  // dan worden drivers en hub toch gestopt en verdwijnt de map (tenzij --bewaar).
  try {
    // ── hub ────────────────────────────────────────────────────────────────────
    const systeem = new NepSysteem();
    let apc = systeem.voegToe('APC40 mkII');
    const voegLpd8 = () => {
      const p = systeem.voegToe('LPD8 mk2');
      p.antwoord = (b) => { if (b[1] === 0x7e) agenda.plan(klok.nu() + 5, () => p.injecteer([0xf0, 0x7e, 0, 6, 2, 0x47, 0x4c, 0, 0xf7])); };
      return p;
    };
    let lpd8 = voegLpd8();
    // De avondmap altijd binnen de tijdelijke map, ook als config.json een absoluut pad heeft (een extern volume,
    // docs/OPNAME.md): de duurtest schrijft nooit in het echte avondarchief. Verder is config.json de bron.
    const config = { ...laadConfig(), avondmap: '~/avonden' };
    const T0 = Date.UTC(2026, 9, 4, 19, 0, 0);
    hub = await startHub({
      config, systeem, klok, poort: 0, drivers: false, log: hubLog,
      geheugen: join(map, 'staat.json'),
      opname: { thuis: map, git: null, datum: () => new Date(T0 + klok.nu()) },
    });
    const uurwerk = nepUurwerk(teller);
    actieveDrivers = startDrivers({ kern: hub.kern, klok, systeem, fetch: uurwerk.fetch, config, log: hubLog });
    const drivers = actieveDrivers.drivers;
    const driverApps = new Set(drivers.map((d) => d.driver.manifest.app));
    const kern = hub.kern;
    kern.bij('naarApp', () => { teller.naarApp++; });
    const appUrl = hub.adres.replace('http', 'ws') + '/app';
    const cockpitUrl = hub.adres.replace('http', 'ws') + '/cockpit';

    /** Laat de nep-tijd lopen tot `tot`, met de agenda op tijd. @param {number} tot */
    const loopTot = (tot) => {
      while (agenda.volgende <= tot) {
        const x = /** @type {{ t: number, fn: () => void }} */ (agenda.neem());
        if (x.t > klok.nu()) klok.loop(x.t - klok.nu());
        try { x.fn(); } catch (e) { schend('scenario liep zonder uitzondering', String(/** @type {any} */ (e)?.stack ?? e).slice(0, 400)); }
      }
      if (tot > klok.nu()) klok.loop(tot - klok.nu());
    };
    /** Nep-tijd laten lopen en de sockets bij laten blijven. @param {number} ms */
    const speel = async (ms) => {
      const eind = klok.nu() + ms;
      while (klok.nu() < eind) { loopTot(Math.min(eind, klok.nu() + stapMs)); await echt(0); }
    };
    /** Wacht (echt) tot fn waar is, terwijl de nep-tijd loopt. @param {() => boolean} fn */
    const totDat = async (fn, maxNepMs = 5000) => { for (let i = 0; i < maxNepMs / stapMs && !fn(); i++) await speel(stapMs); return fn(); };

    await totDat(() => hub.apparaten.apc.verbonden && hub.apparaten.lpd8.model === 'mk2', 10000);
    await speel(4000);   // drivers starten na 3 s
    const basis = { timers: klok.timers.size, luisteraars: luisteraars(kern), handles: handles() };

    // ── deelnemers ─────────────────────────────────────────────────────────────
    /** @type {Record<string, { manifest: any, staat: Record<string, number> }>} */
    const fixtures = Object.fromEntries(readdirSync(FIXTURES).filter((f) => f.endsWith('.json')).sort()
      .map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(FIXTURES, f), 'utf8'))]));
    fixtures['nep-app'] = { manifest: voorbeeldManifest('nep-app'), staat: {} };
    fixtures['nep-geheugen'] = { manifest: { ...voorbeeldManifest('nep-geheugen'), naam: 'Nep (hub onthoudt)', truth: 'hub' }, staat: {} };
    /** @type {Map<string, DuurApp>} */
    const apps = new Map();
    /** apps die even niet terug mogen komen (lang weg, tweede tab) */
    const bezet = new Set();
    /** @param {string} id @param {boolean} [nieuweInst] */
    const startApp = (id, nieuweInst = true) => {
      const oud = apps.get(id);
      if (oud && !nieuweInst) { if (!oud.open && oud.ws?.readyState !== WebSocket.CONNECTING) oud.start(); return oud; }
      oud?.stop();
      const a = new DuurApp({ url: appUrl, manifest: fixtures[id].manifest, staat: fixtures[id].staat, teller, nu: () => klok.nu() });
      apps.set(id, a.start());
      return a;
    };
    for (const id of Object.keys(fixtures)) { startApp(id); await totDat(() => !!kern.apps.get(fixtures[id].manifest.app)?.manifest, 3000); }

    /** @type {DuurCockpit[]} */
    const cockpits = [];
    for (let i = 0; i < 2; i++) cockpits.push(new DuurCockpit(cockpitUrl, teller));
    const rommel = new Rommel(appUrl, teller);
    rommel.verbind();
    /** @type {WebSocket[]} */
    const halve = [];

    // ── scenario ───────────────────────────────────────────────────────────────
    /** De stand van elke fader/knop (zoals de hand hem liet). */
    /** @type {Map<string, number>} */
    const stand = new Map();
    let spelen = true;
    /** Plan iets terugkerends: gemiddeld één keer per `ms` nep-tijd. @param {number} ms @param {() => void} fn */
    const elke = (ms, fn) => {
      const volgende = () => agenda.plan(klok.nu() + t.wacht(ms), () => { if (!spelen) return; fn(); volgende(); });
      volgende();
    };
    const na = (/** @type {number} */ ms, /** @type {() => void} */ fn) => agenda.plan(klok.nu() + ms, fn);
    const apcIn = (/** @type {number[]} */ b) => { teller.apc++; apc.injecteer(b); };
    const lpdIn = (/** @type {number[]} */ b) => { teller.lpd8++; lpd8.injecteer(b); };
    /** Hoeveel "vingers" er op een fysieke toets staan: alleen de eerste druk en de laatste los gaan de draad op. */
    /** @type {Map<string, number>} */
    const vingers = new Map();
    const noot = (/** @type {string} */ id, /** @type {boolean} */ aan) => {
      const n = vingers.get(id) ?? 0;
      if (aan) { vingers.set(id, n + 1); if (n > 0) return; }
      else if (n > 1) { vingers.set(id, n - 1); return; }
      else if (n === 1) vingers.delete(id);
      else return;
      const c = ctrl(id);
      apcIn([(aan ? 0x90 : 0x80) | c.ch, c.n, aan ? 127 : 0]);
    };
    /** Fader of knop met de hand van de huidige stand naar `doel`, in stapjes van ~15 ms. @param {string} id @param {number} doel */
    const schuif = (id, doel) => {
      const c = ctrl(id);
      const van = stand.get(id) ?? 0;
      const a = Math.round(van * 127), b = Math.round(doel * 127), s = b >= a ? 1 : -1;
      let i = 0;
      for (let x = a; x !== b + s; x += s * t.geheel(1, 4)) {
        const w = Math.max(0, Math.min(127, s > 0 ? Math.min(x, b) : Math.max(x, b)));
        na(15 * i++, () => apcIn([0xb0 | c.ch, c.n, w]));
        if (w === b) break;
      }
      stand.set(id, doel);
    };
    const lpdKnop = (/** @type {number} */ k, /** @type {number} */ doel) => {
      const n = LPD8_PROFIEL.knoppen[k - 1].n;
      const sl = `lpd8:k${k}`;
      const a = Math.round((stand.get(sl) ?? 0) * 127), b = Math.round(doel * 127), s = b >= a ? 1 : -1;
      let i = 0;
      for (let x = a; ; x += s * 3) {
        const w = s > 0 ? Math.min(x, b) : Math.max(x, b);
        na(12 * i++, () => lpdIn([0xb0, n, w]));
        if (w === b) break;
      }
      stand.set(sl, doel);
    };
    const lpdPad = (/** @type {number} */ p, /** @type {boolean} */ aan) => { const n = LPD8_PROFIEL.pads[p - 1].n; lpdIn(aan ? [0x99, n, 100] : [0x89, n, 0]); };
    const tikLpd = (/** @type {number} */ p, ms = 80) => { lpdPad(p, true); na(ms, () => lpdPad(p, false)); };
    let stopAllVast = 0;
    let paniekVast = false;
    /** hoe vaak P1 al losgelaten is (een controle na de naloop telt alleen als er intussen geen nieuwe paniek was) */
    let paniekLos = 0;
    let apcWeg = false, lpdWeg = false;

    // Bediening van de APC (manifest-indeling van de app met focus, of een lease-app).
    elke(250, () => { tel('apc.fader'); schuif(t.kies(FADERS), t.getal()); });
    elke(300, () => { tel('apc.knop'); schuif(t.kies(KNOPPEN), t.getal()); });
    elke(500, () => { tel('apc.toets'); const id = t.kies(TOETSEN); noot(id, true); na(t.tussen(40, 600), () => noot(id, false)); });
    elke(8000, () => {
      tel('focus.apc');
      noot('bank', true);
      na(40, () => noot(`sel${t.geheel(1, 8)}`, true));
      na(100, () => { for (let i = 1; i <= 8; i++) noot(`sel${i}`, false); });
      na(160, () => noot('bank', false));
    });
    elke(25000, () => {
      const bewaar = t.kans(0.4), nr = t.geheel(1, 5);
      tel(bewaar ? 'snapshot.apc.bewaar' : 'snapshot.apc.laad');
      if (bewaar) noot('shift', true);
      na(20, () => noot('bank', true));
      na(60, () => noot(`scene${nr}`, true));
      na(120, () => { noot(`scene${nr}`, false); noot('bank', false); });
      if (bewaar) na(160, () => noot('shift', false));
    });
    elke(40000, () => {
      tel('stopall');
      stopAllVast++;
      noot('stopall', true);
      na(t.tussen(150, 3000), () => { noot('stopall', false); stopAllVast--; });
    });

    // De LPD8: macro's, tap, adem, opname, snapshots, paniek.
    elke(1500, () => { tel('lpd8.knop'); lpdKnop(t.geheel(1, 8), t.getal()); });
    elke(30000, () => { tel('lpd8.tap'); const n = t.geheel(3, 6), ms = t.tussen(350, 700); for (let i = 0; i < n; i++) na(i * ms, () => tikLpd(2, 40)); });
    elke(60000, () => { tel('lpd8.adem'); tikLpd(3); });
    elke(15000, () => {
      const lang = t.kans(0.3);
      tel(lang ? 'snapshot.lpd8.bewaar' : 'snapshot.lpd8.laad');
      tikLpd(t.geheel(5, 6), lang ? LANG_MS + 200 : 120);
    });
    // Opname: één van het begin tot de afbouw (doorlopend, zoals een echte avond), of aan en uit (wisselend). Ook
    // doorlopend blijft dit gepland (en doet dan niets): zo trekt de avond hetzelfde toeval, welke soort ook.
    elke(150000, () => { if (opname !== 'wisselend') return; tel('opname'); tikLpd(4); });
    elke(90000, () => {
      // Pas als de hub de LPD8 (weer) heeft: wat je indrukt op een LPD8 die de hub nog niet opende, hoort niemand.
      if (paniekVast || lpdWeg || !hub.apparaten.lpd8.verbonden) return;
      tel('paniek');
      paniekVast = true;
      const duur = t.kans(0.25) ? t.tussen(200, PANIEK_MS - 100) : t.tussen(PANIEK_MS + 300, 5000);
      lpdPad(1, true);
      if (duur > PANIEK_MS + 200) na(PANIEK_MS + 150, () => controleerPaniekAan());
      na(duur, () => {
        const ging = kern.paniekActief;   // P1 korter dan PANIEK_MS: er was geen paniek, er hoeft niets uit
        lpdPad(1, false);
        paniekVast = false;
        const nr = ++paniekLos, losOp = klok.nu();
        na(kern.paniekNaloopMs + 1000, () => { if (nr === paniekLos) controleerPaniekUit(losOp, ging); });
      });
    });

    const controleerPaniekAan = () => {
      if (!paniekVast || lpdWeg) return;
      if (!kern.paniekActief || kern.globaal.paniek !== 1) schend('paniek loopt als P1 vastgehouden wordt', `paniekActief ${kern.paniekActief}, globaal.paniek ${kern.globaal.paniek}`);
    };
    /** @param {number} losOp nep-tijd waarop P1 losgelaten werd @param {boolean} ging liep de paniek toen? */
    const controleerPaniekUit = (losOp, ging) => {
      if (paniekVast) return;   // intussen weer ingedrukt
      if (kern.paniekActief || (kern.globaal.paniek ?? 0) !== 0 || kern.p1Timer !== null) schend('na loslaten is de paniek voorbij', `paniekActief ${kern.paniekActief}, globaal.paniek ${kern.globaal.paniek}, p1Timer ${kern.p1Timer}`);
      if (kern.paniekTot !== -Infinity && kern.paniekTot > klok.nu()) schend('na de naloop verplaatst een app het pickup-doel weer', `paniekTot ${kern.paniekTot} > nu ${klok.nu()}`);
      if (stopAllVast) return;
      for (const [app, tot] of kern.appPaniekTot) if (tot === Infinity) schend('Stop All los = naloop', `${app}: appPaniekTot Infinity`);
      if (!ging) return;
      // Elke app die bij het loslaten verbonden was, hoorde daarna "paniek uit": een app met een paniek-trigger een
      // trig aan:false, de rest globaal paniek 0. (Wat daarna nog komt, een Stop All of een cockpit-trigger, telt hier
      // niet; wie na het loslaten (opnieuw) verbond, krijgt de stand in globaal bij zijn hallo.)
      for (const [id, a] of apps) {
        if (!a.open || a.verbondenOp > losOp - 1000) continue;
        const trigger = a.manifest.params?.some((/** @type {any} */ p) => p.id === 'paniek' && p.soort === 'trigger');
        if ((trigger ? a.uitOp.trig : a.uitOp.globaal) < losOp) {
          schend('elke app hoorde paniek uit', `${id}: geen ${trigger ? 'trig paniek aan:false' : 'globaal paniek 0'} na het loslaten op ${rond(losOp / 1000, 1)} s (${a.paniekLog.join(' · ')})`);
        }
      }
    };

    // Cockpits: komen, gaan, traag lezen, en bedienen.
    /** Virtuele toetsen: tot wanneer bezet (vastgehouden = Infinity; na loslaten nog even). @type {Map<string, number>} */
    const virtueelBezet = new Map();
    /** Een cockpit gaat weg: wat hij virtueel vasthield, laat de hub los; daarna is de toets weer vrij. @param {DuurCockpit} c */
    const cockpitWeg = (c) => {
      for (const id of c.toetsen) virtueelBezet.set(id, klok.nu() + 1000);
      c.toetsen.clear();
      c.sluit();
    };
    /** Alle (app, parameter) uit de manifesten, om vanuit de cockpit te zetten. */
    const parameters = Object.values(fixtures).flatMap((f) => f.manifest.params.map((/** @type {any} */ p) => ({ app: f.manifest.app, id: p.id, trigger: p.soort === 'trigger' })));
    elke(20000, () => {
      if (cockpits.length < 2 || (cockpits.length < 5 && t.kans(0.5))) { tel('cockpit.erbij'); cockpits.push(new DuurCockpit(cockpitUrl, teller)); return; }
      tel('cockpit.weg');
      cockpitWeg(cockpits.splice(t.geheel(0, cockpits.length - 1), 1)[0]);
    });
    elke(30000, () => {
      const c = t.kies(cockpits);
      if (!c || c.traag) return;
      tel('cockpit.traag');
      c.pauze();
      na(t.tussen(2000, 12000), () => c.verder());
    });
    const focusKeuzes = [...Object.values(fixtures).map((f) => f.manifest.app), null];
    elke(400, () => {
      // Eerst al het toeval trekken, dan pas kijken of de cockpit open is: zo hangt de avond niet af van hoe snel
      // een socket opengaat (dezelfde seed = dezelfde avond).
      const c = t.kies(cockpits), soort = t.geheel(0, 9), x = t.getal(), y = t.getal(), z = t.getal(), dt = t.tussen(50, 900);
      if (!c?.open) return;
      if (soort <= 4) {
        tel('cockpit.zet');
        const p = parameters[Math.floor(x * parameters.length)];
        // Een trigger is een knop in de cockpit: indrukken en (zolang de cockpit verbonden is) weer los.
        if (!p.trigger) c.stuur({ t: 'zet', app: p.app, id: p.id, v: y });
        else { c.trigger(p.app, p.id, true); na(dt, () => c.trigger(p.app, p.id, false)); }
      }
      else if (soort === 5) { tel('cockpit.focus'); c.stuur({ t: 'focus', app: focusKeuzes[Math.floor(x * focusKeuzes.length)] }); }
      else if (soort === 6) { tel('cockpit.snapshot'); c.stuur({ t: 'snapshot', nr: y < 0.8 ? 1 + Math.floor(x * 8) : 1 + Math.floor(x * 99), actie: z < 0.3 ? 'bewaar' : 'laad' }); }
      else {
        // Virtuele APC/LPD8: meestal netjes los, soms blijft de toets hangen tot de cockpit weggaat (dan laat de hub
        // hem los). Een toets die een andere cockpit vasthoudt (of net losliet, de berichten van twee sockets kunnen
        // elkaar inhalen) slaat hij over.
        const lpd = soort === 9;
        const id = lpd ? `lpd8:p${7 + Math.floor(x * 2)}` : TOETSEN_VIRTUEEL[Math.floor(x * TOETSEN_VIRTUEEL.length)];
        if ((virtueelBezet.get(id) ?? -Infinity) > klok.nu()) return;
        tel('cockpit.virtueel');
        const c0 = lpd ? null : ctrl(id);
        const n = lpd ? LPD8_PROFIEL.pads[Number(id.slice(-1)) - 1].n : /** @type {any} */ (c0).n;
        const kanaal = lpd ? 9 : /** @type {any} */ (c0).ch;
        const dev = lpd ? 'lpd8' : 'apc40';
        c.stuur({ t: 'virtueel', dev, bytes: [0x90 | kanaal, n, 100] });
        virtueelBezet.set(id, Infinity);
        c.toetsen.add(id);
        if (y < 0.9) {
          na(dt, () => {
            if (!c.toetsen.delete(id)) return;   // de cockpit is al weg: de hub liet de toets los
            c.stuur({ t: 'virtueel', dev, bytes: [0x80 | kanaal, n, 0] });
            virtueelBezet.set(id, klok.nu() + 1000);
          });
        }
      }
    });

    // Apps: netwerkhapering, herstart, stil, lang weg, een tweede tab.
    const gewoneApps = Object.keys(fixtures);
    elke(20000, () => {
      const id = t.kies(gewoneApps);
      const a = apps.get(id);
      if (!a || bezet.has(id)) return;
      const soort = t.geheel(0, 4);
      bezet.add(id);
      if (soort === 0) { tel('app.hapering'); a.stop(); na(t.tussen(200, 3000), () => { startApp(id, false); bezet.delete(id); }); }
      else if (soort === 1) { tel('app.herstart'); a.stop(); na(t.tussen(1000, 8000), () => { startApp(id, true); bezet.delete(id); }); }
      else if (soort === 2) { tel('app.stil'); a.stil = true; na(t.tussen(4000, 15000), () => { a.stil = false; bezet.delete(id); }); }
      else if (soort === 3) { tel('app.langweg'); a.stop(); na(t.tussen(20000, 60000), () => { startApp(id, t.kans(0.5)); bezet.delete(id); }); }
      else {
        tel('app.tweedetab');
        const tab = new DuurApp({ url: appUrl, manifest: fixtures[id].manifest, staat: fixtures[id].staat, teller, nu: () => klok.nu() }).start();
        const hb = () => { if (!tab.gestopt) { tab.hartslag(); na(500, hb); } };
        na(500, hb);
        na(t.tussen(5000, 20000), () => { tab.stop(); na(500, () => { startApp(id, false); bezet.delete(id); }); });
      }
    });
    // Hartslag van alle apps op de nep-klok.
    const hartslag = () => { for (const a of apps.values()) a.hartslag(); na(500, hartslag); };
    na(500, hartslag);

    // Rommel, en af en toe een half afgebouwde app met een steeds andere naam.
    elke(1500, () => { tel('rommel'); rommel.doe(t.geheel(0, 15), t.getal(), t.getal()); });
    let halfN = 0;
    elke(45000, () => {
      tel('app.halfafgebouwd');
      const ws = halfAfgebouwd(appUrl, halfN++);
      halve.push(ws);
      na(t.tussen(1000, 20000), () => { ws.close(); halve.splice(halve.indexOf(ws), 1); });
    });

    // Controllers eruit en erin; de uurwerk-brug even weg. Altijd langer dan één hotplug-ronde: een snellere replug
    // ziet de hub niet (zie docs/DUURTEST.md, open punten).
    const minWeg = (config.hotplug_ms ?? 2000) + 500;
    elke(300000, () => {
      if (apcWeg) return;
      tel('apc.eruit');
      apcWeg = true;
      systeem.verwijder('APC40 mkII');
      na(t.tussen(minWeg, 10000), () => { apc = systeem.voegToe('APC40 mkII'); apcWeg = false; });
    });
    elke(400000, () => {
      if (lpdWeg || paniekVast) return;
      tel('lpd8.eruit');
      lpdWeg = true;
      systeem.verwijder('LPD8 mk2');
      na(t.tussen(minWeg, 10000), () => { lpd8 = voegLpd8(); lpdWeg = false; });
    });
    elke(200000, () => { tel('uurwerk.weg'); uurwerk.aan = false; na(t.tussen(5000, 40000), () => { uurwerk.aan = true; }); });

    // Slews: geen enkele blijft hangen (na zijn eindtijd hooguit een paar tikken).
    const controleerSlews = () => {
      for (const x of kern.slews.values()) {
        const eind = x.slew.start + x.slew.duurMs;
        if (klok.nu() - eind > 1000) schend('geen slew blijft lopen', `${x.app}.${x.id}: ${rond((klok.nu() - eind) / 1000, 1)} s over zijn eindtijd`);
        if (x.slew.duurMs > 120000) schend('slew_s ≤ 120', `${x.app}.${x.id}: ${x.slew.duurMs} ms`);
      }
    };
    elke(5000, controleerSlews);
    // De NepPoort onthoudt alles wat de hub stuurde (handig in tests): hier tellen en weggooien.
    let naarApparaten = 0;
    const leegPoorten = () => { for (const p of systeem.apparaten.values()) { naarApparaten += p.verstuurd.length; p.verstuurd.length = 0; } na(1000, leegPoorten); };
    na(1000, leegPoorten);

    if (opname === 'doorlopend') {
      tel('opname');
      tikLpd(4);
      await totDat(() => !!hub.opnemer?.huidig?.map, 5000);
      if (!kern.opname || !hub.opnemer?.huidig) schend('de opname loopt de hele avond', 'LPD8 P4 zette de opname niet aan');
    }

    // ── spelen en meten ────────────────────────────────────────────────────────
    eld = monitorEventLoopDelay({ resolution: ELD_RESOLUTIE });
    eldTotaal = monitorEventLoopDelay({ resolution: ELD_RESOLUTIE });
    eld.enable();
    eldTotaal.enable();
    /** @type {any[]} */
    const metingen = [];
    const start = performance.now();
    const nep0 = klok.nu();
    const tellerOp = () => ({ ...teller });
    let vorigeTeller = tellerOp(), vorigeEcht = start, vorigeNep = klok.nu();
    const meet = () => {
      let gcMs = null;
      if (gc) { const g0 = performance.now(); gc(); gc(); gcMs = rond(performance.now() - g0, 1); }
      const nu = performance.now();
      const m = process.memoryUsage();
      const tl = tellerOp();
      const dEcht = (nu - vorigeEcht) / 1000, dNep = (klok.nu() - vorigeNep) / 1000;
      const perS = Object.fromEntries(['naarApp', 'app', 'cockpit', 'apc', 'lpd8'].map((k) => [k, rond((tl[/** @type {keyof Teller} */ (k)] - vorigeTeller[/** @type {keyof Teller} */ (k)]) / Math.max(dEcht, 1e-3), 0)]));
      const meting = {
        echtS: rond((nu - start) / 1000, 1), nepS: rond((klok.nu() - nep0) / 1000, 1),
        tempo: rond(dNep / Math.max(dEcht, 1e-3), 1),
        heapMB: rond(m.heapUsed / MB), rssMB: rond(m.rss / MB), externMB: rond(m.external / MB), gcMs,
        eld: { p50: vertraging(eld.percentile(50)), p99: vertraging(eld.percentile(99)), max: vertraging(eld.max) },
        handles: handles(), perEchteS: perS,
        cockpits: cockpits.length, cockpitAchterstand: cockpits.reduce((n, c) => n + c.ws.bufferedAmount, 0),
        agenda: agenda.lengte,
        s: structuren({ hub, drivers, klok }),
        heapBytes: m.heapUsed,
      };
      eld.reset();
      metingen.push(meting);
      vorigeTeller = tl; vorigeEcht = nu; vorigeNep = klok.nu();
      log(`  ${String(meting.echtS).padStart(6)} s echt · ${(meting.nepS / 60).toFixed(1).padStart(6)} min nep · ×${meting.tempo} · heap ${meting.heapMB} MB · eld p99 ${meting.eld.p99} ms · apps ${meting.s['kern.apps']} · slews ${meting.s['kern.slews']} · cockpits ${meting.cockpits} · naar apps ${perS.naarApp}/s`);
    };

    log(`duurtest: seed ${seed}, ${echtMs !== Infinity ? `${rond(echtMs / 60000, 1)} min echt` : ''}${nepMs !== Infinity ? ` tot ${rond(nepMs / 60000, 1)} min nep` : ''}, stap ${stapMs} ms nep, gc ${gc ? 'ja' : 'nee (start met node --expose-gc)'}`);
    meet();
    let volgendeMeting = performance.now() + meetElkeMs;
    /** @type {unknown} */
    let crash = null;
    try {
      while (performance.now() - start < echtMs && klok.nu() - nep0 < nepMs && !signaal?.aborted) {
        loopTot(klok.nu() + stapMs);
        await echt(0);
        if (performance.now() >= volgendeMeting) { meet(); volgendeMeting = performance.now() + meetElkeMs; }
      }
    } catch (e) { crash = e; schend('de avond liep zonder uitzondering', String(/** @type {any} */ (e)?.stack ?? e).slice(0, 400)); }
    meet();

    // ── afbouw: rust, staat vergelijken, alles weg, invarianten ─────────────────
    /** Alle clients dicht (ook als de afbouw halverwege misgaat). */
    const allesDicht = () => {
      for (const a of apps.values()) a.stop();
      for (const c of cockpits) c.sluit();
      cockpits.length = 0;
      rommel.sluit();
      for (const ws of halve) ws.close();
      halve.length = 0;
    };
    /** @type {Record<string, number>} */
    let naClients = {};
    /** @type {Record<string, number>} */
    let handlesNaClients = {};
    /** @type {null|{ waar: string, nepMin: number, gebarenKB: number|null, samenvattingKB: number|null, invoerSleutels: number, naarApps: number }} */
    let opnameUitslag = null;
    try {
      spelen = false;
      log('afbouw: alles loslaten, wachten op rust, staat vergelijken');
      // Wat er nog gepland stond (loslaten, terugkomen) eerst afmaken; daarna niets nieuws meer.
      await speel(Math.max(0, Math.min(65000, (agenda.rij.at(-1)?.t ?? klok.nu()) - klok.nu())));
      agenda.leeg();
      if (apcWeg) { apc = systeem.voegToe('APC40 mkII'); apcWeg = false; }
      if (lpdWeg) { lpd8 = voegLpd8(); lpdWeg = false; }
      uurwerk.aan = true;
      if (paniekVast) { lpdPad(1, false); paniekVast = false; }
      if (stopAllVast) { noot('stopall', false); stopAllVast = 0; }
      for (const c of cockpits) if (c.traag) c.verder();
      for (const [id, a] of apps) { a.stil = false; if (!a.open) startApp(id, false); }
      bezet.clear();
      // Rust: geen invoer meer, alle slews uitgelopen (slew_s ≤ 8 in deze manifesten), hartslag gewoon door.
      const hbRust = () => { if (!spelen) { for (const a of apps.values()) a.hartslag(); agenda.plan(klok.nu() + 500, hbRust); } };
      hbRust();
      na(1000, leegPoorten);
      await speel(15000);
      await totDat(() => kern.slews.size === 0, 130000);
      await speel(1000);
      await echt(200);
      for (let i = 0; i < 20; i++) await speel(stapMs);

      // De staat klopt: wat elke verbonden app denkt = wat de kern denkt = wat de cockpit laatst zag.
      if (kern.slews.size || kern.slewTimer !== null) schend('na rust lopen er geen slews meer', `${kern.slews.size} slews, timer ${kern.slewTimer}`);
      for (const [id, a] of apps) {
        const st = kern.apps.get(a.manifest.app);
        if (!a.open || !st?.manifest || st.manifest.lease) continue;
        for (const p of st.manifest.params) {
          if (p.soort === 'trigger') continue;
          const hubW = st.waarden[p.id], appW = a.waarden[p.id];
          if (typeof hubW !== 'number' || typeof appW !== 'number' || Math.abs(hubW - appW) > 1e-6) schend('app en hub zijn het eens over de staat', `${id}.${p.id}: hub ${hubW}, app ${appW}`);
        }
      }
      for (const a of kern.apps.values()) {
        if (!a.manifest) continue;
        const ids = new Set(a.manifest.params.filter((/** @type {any} */ p) => p.soort !== 'trigger').map((/** @type {any} */ p) => p.id));
        const vreemd = Object.keys(a.waarden).filter((k) => !ids.has(k));
        if (vreemd.length) schend('een app bewaart alleen waarden van zijn eigen parameters', `${a.app}: ${vreemd.length} vreemde (${vreemd.slice(0, 3).join(', ')}…)`);
      }
      const beeldNu = kern.beeld();
      for (const [i, c] of cockpits.entries()) {
        if (!c.open || !c.laatsteBeeld) { schend('elke cockpit heeft een beeld', `cockpit ${i}: ${c.open ? 'geen beeld' : 'niet open'}`); continue; }
        const b = JSON.parse(c.laatsteBeeld);
        if (b.focus !== beeldNu.focus) schend('de cockpit ziet de focus van de kern', `cockpit ${i}: ${b.focus} ≠ ${beeldNu.focus}`);
        for (const a of beeldNu.apps) {
          const cw = b.apps.find((/** @type {any} */ x) => x.app === a.app);
          if (!cw) { schend('de cockpit kent alle apps', `cockpit ${i} mist ${a.app}`); continue; }
          if (cw.status !== a.status) schend('de cockpit ziet de status van de kern', `cockpit ${i}: ${a.app} ${cw.status} ≠ ${a.status}`);
          for (const [k, v] of Object.entries(a.waarden)) if (Math.abs((cw.waarden[k] ?? NaN) - /** @type {number} */ (v)) > 1e-9) { schend('de cockpit ziet de waarden van de kern', `cockpit ${i}: ${a.app}.${k} ${cw.waarden[k]} ≠ ${v}`); break; }
        }
      }

      // Een opname van de hele avond: pas nu stoppen (P4), en hij sluit netjes af (eindstaat, samenvatting).
      if (opname === 'doorlopend') {
        const sessie = hub.opnemer?.huidig;
        if (!kern.opname || !sessie) schend('de opname loopt de hele avond', 'in de afbouw liep er geen opname meer');
        else {
          log('afbouw: de opname van de hele avond stoppen');
          const invoerSleutels = Object.keys(sessie.invoer).length;
          const naarApps = Object.keys(sessie.naar).length;
          tikLpd(4);
          await totDat(() => !hub.opnemer.huidig && hub.opnemer.lopend.size === 0, 30000);   // lopend: tot de samenvatting geschreven is
          const kb = (/** @type {string} */ f) => { try { return rond(statSync(join(sessie.map ?? '', f)).size / 1024, 1); } catch { return null; } };
          opnameUitslag = { waar: relative(map, sessie.map ?? map), nepMin: rond((klok.nu() - sessie.t0) / 60000, 1), gebarenKB: kb(GEBAREN), samenvattingKB: kb(SAMENVATTING), invoerSleutels, naarApps };
          if (hub.opnemer.huidig || hub.opnemer.lopend.size) schend('een opname van de hele avond sluit af', 'na 30 s nep nog niet dicht');
          else if (!opnameUitslag.samenvattingKB || !opnameUitslag.gebarenKB) schend('een opname van de hele avond sluit af', `geen ${opnameUitslag.gebarenKB ? SAMENVATTING : GEBAREN} in ${sessie.map}`);
        }
      }

      // Alle clients weg: per-client structuren leeg.
      log('afbouw: alle apps, cockpits en de rommel weg');
      allesDicht();
      await speel(12000);   // > weg_s: iedereen 'weg'
      for (let i = 0; i < 50 && kern.verbindingen.size > drivers.length; i++) { await echt(20); await speel(stapMs); }
      await speel(2000);
      naClients = structuren({ hub, drivers, klok });
      if (kern.verbindingen.size !== drivers.length) schend('zonder clients zijn alleen de drivers verbonden', `${kern.verbindingen.size} verbindingen, ${drivers.length} drivers`);
      for (const [naam, v] of /** @type {[string, number][]} */ ([['kern.routes', naClients['kern.routes']], ['kern.padDruk', naClients['kern.padDruk']], ['app.vast', naClients['app.vast']], ['kern.leaseRij', naClients['kern.leaseRij']], ['kern.slews', naClients['kern.slews']]])) {
        if (v !== 0) schend('zonder clients en zonder invoer zijn de per-client structuren leeg', `${naam} = ${v}`);
      }
      for (const a of kern.apps.values()) {
        if (driverApps.has(a.app)) continue;
        if (a.status !== 'weg') schend('zonder clients is elke app weg', `${a.app}: ${a.status}`);
        if (!a.manifest) schend('een app die nooit een manifest stuurde, wordt vergeten als hij weg is', `${a.app} (status ${a.status})`);
      }
      if (naClients['kern.luisteraars'] !== basis.luisteraars) schend('luisteraars op de kern stapelen niet op', `${naClients['kern.luisteraars']} nu, ${basis.luisteraars} bij de start`);
      if (naClients['klok.timers'] !== basis.timers) schend('geen timers die blijven staan', `${naClients['klok.timers']} klok-timers, ${basis.timers} bij de start`);
      handlesNaClients = await stilleHandles(basis.handles);
      for (const soort of ['TCPSocketWrap', 'TCPWRAP']) {
        if ((handlesNaClients[soort] ?? 0) > (basis.handles[soort] ?? 0)) schend('alle sockets dicht als de clients weg zijn', `${soort}: ${handlesNaClients[soort]} (bij de start ${basis.handles[soort] ?? 0})`);
      }
    } catch (e) {
      crash ??= e;
      schend('de afbouw liep zonder uitzondering', String(/** @type {any} */ (e)?.stack ?? e).slice(0, 400));
      spelen = false;
      agenda.leeg();
      allesDicht();
    }

    // Hub stoppen: daarna mag er niets meer op de klok staan.
    await stopHub();
    eld.disable();
    eldTotaal.disable();
    if (klok.timers.size) schend('na stoppen staat er niets meer op de klok', `${klok.timers.size} timers`);
    const handlesNaStop = await stilleHandles(handlesVooraf);
    const echtS = (performance.now() - start) / 1000;
    const nepS = (klok.nu() - nep0) / 1000;

    // ── oordeel ────────────────────────────────────────────────────────────────
    /** @type {{ wat: string, detail: string }[]} */
    const lekken = [];
    const reeksen = /** @type {Record<string, number[]>} */ ({});
    for (const m of metingen) for (const [k, v] of Object.entries(m.s)) (reeksen[k] ??= []).push(/** @type {number} */ (v));
    /** @type {Record<string, { begin: number, max: number, eind: number, naClients: number, grens?: number }>} */
    const groottes = {};
    for (const [k, r] of Object.entries(reeksen)) {
      groottes[k] = { begin: r[0], max: maximum(r), eind: r[r.length - 1], naClients: /** @type {any} */ (naClients)[k], ...(k in GRENZEN ? { grens: GRENZEN[k] } : {}) };
      if (k in GRENZEN && maximum(r) > GRENZEN[k]) lekken.push({ wat: k, detail: `${maximum(r)} > grens ${GRENZEN[k]}` });
      const g = k in GRENZEN || MAG_GROEIEN.has(k) ? null : groeit(r);
      if (g?.groeit) lekken.push({ wat: k, detail: `groeit: mediaan ${g.tweede} in het tweede kwart, ${g.laatste} in het laatste` });
    }
    const handleReeks = /** @type {Record<string, number[]>} */ ({});
    for (const m of metingen) for (const soort of new Set([...Object.keys(m.handles), ...Object.keys(handleReeks)])) (handleReeks[soort] ??= []).push(m.handles[soort] ?? 0);
    for (const [soort, r] of Object.entries(handleReeks)) { const g = groeit(r, { minAbs: 20 }); if (g?.groeit) lekken.push({ wat: `handles.${soort}`, detail: `groeit: ${g.tweede} → ${g.laatste}` }); }
    const heapR = heapOordeel(metingen.map((m) => m.heapBytes), { drempelMB });
    if (heap && gc && heapR?.lek) lekken.push({ wat: 'heap', detail: `minimum na gc ${heapR.beginMB} → ${heapR.eindMB} MB (+${heapR.groeiMB} MB)` });

    const totaal = { ...teller, naarApparaten };
    const rapport = {
      versie: 1,
      gemaakt: new Date().toISOString(),
      seed, stapMs, node: process.version, opname, drivers: drivers.length,
      echtS: rond(echtS, 1), nepS: rond(nepS, 1), tempo: rond(nepS / echtS, 1),
      afgebroken: !!signaal?.aborted,
      ok: !crash && !lekken.length && !schendingen.length,
      lekken, schendingen,
      acties,
      berichten: {
        totaal,
        perEchteS: Object.fromEntries(Object.entries(totaal).map(([k, v]) => [k, rond(v / echtS, 0)])),
        perNepS: Object.fromEntries(Object.entries(totaal).map(([k, v]) => [k, rond(v / nepS, 1)])),
      },
      heap: {
        metGc: !!gc, oordeelMeegeteld: heap && !!gc, ...(heapR ?? {}),
        minMB: rond(minimum(metingen.map((m) => m.heapMB))), maxMB: rond(maximum(metingen.map((m) => m.heapMB))),
        rssMaxMB: rond(maximum(metingen.map((m) => m.rssMB))),
      },
      eventLoop: { p50: vertraging(eldTotaal.percentile(50)), p99: vertraging(eldTotaal.percentile(99)), max: vertraging(eldTotaal.max), gcMsMax: rond(maximum(metingen.map((m) => m.gcMs ?? 0)), 1) },
      handles: { vooraf: handlesVooraf, bijStart: basis.handles, naClients: handlesNaClients, naStop: handlesNaStop },
      timers: { bijStart: basis.timers, naClients: naClients['klok.timers'], naStop: klok.timers.size },
      groottes,
      opnameUitslag,
      hubMeldingen: { aantal: meldingTotaal, laatste: meldingen },
      metingen: metingen.map(({ heapBytes, ...m }) => m),
    };
    if (bewaar) /** @type {any} */ (rapport).map = map;
    if (crash) throw Object.assign(new Error(`duurtest gecrasht: ${/** @type {any} */ (crash)?.message ?? crash}`), { rapport });
    return rapport;
  } finally {
    eld?.disable();
    eldTotaal?.disable();
    try { await stopHub(); } catch (e) { log(`hub stoppen mislukt: ${/** @type {any} */ (e)?.message ?? e}`); }
    if (!bewaar) rmSync(map, { recursive: true, force: true });
  }
}

/** gc() als die er is: --expose-gc, of (zonder) via V8 zelf aangezet. @returns {(() => void)|null} */
function zoekGc() {
  if (typeof globalThis.gc === 'function') return /** @type {() => void} */ (globalThis.gc);
  try { setFlagsFromString('--expose-gc'); return runInNewContext('gc'); } catch { return null; }
}

/** Wacht (kort, echt) tot sockets en timers van gesloten verbindingen weg zijn. @param {Record<string, number>} doel */
async function stilleHandles(doel) {
  let h = handles();
  for (let i = 0; i < 40; i++) {
    if (['TCPSocketWrap', 'TCPWRAP'].every((s) => (h[s] ?? 0) <= (doel[s] ?? 0))) break;
    await echt(50);
    h = handles();
  }
  return h;
}

// ── rapport ──────────────────────────────────────────────────────────────────

/** Het rapport als leesbare tekst. @param {Awaited<ReturnType<typeof draaiDuurtest>>} r */
export function rapportTekst(r) {
  const regels = [];
  const g = r.groottes;
  regels.push(`Duurtest seed ${r.seed}: ${r.echtS} s echt = ${rond(r.nepS / 60, 1)} min nep (×${r.tempo}), opname ${r.opname}, Node ${r.node}`);
  if (r.afgebroken) regels.push('AFGEBROKEN (Ctrl-C): de avond is eerder gestopt; afbouw en metingen tot dan zijn wel gedaan');
  regels.push(r.ok ? 'UITSLAG: goed — geen lek, geen geschonden invariant' : `UITSLAG: FOUT — ${r.lekken.length} lek(ken), ${r.schendingen.length} geschonden invariant(en)`);
  for (const l of r.lekken) regels.push(`  lek: ${l.wat} — ${l.detail}`);
  for (const s of r.schendingen.slice(0, 20)) regels.push(`  invariant: ${s.wat} (${s.nepS} s nep) — ${s.detail}`);
  regels.push('');
  regels.push(`Heap (na gc: ${r.heap.metGc ? 'ja' : 'nee'}): ${r.heap.minMB}–${r.heap.maxMB} MB, rss max ${r.heap.rssMaxMB} MB${'groeiMB' in r.heap ? `; minimum begin ${r.heap.beginMB} → eind ${r.heap.eindMB} MB (${r.heap.groeiMB >= 0 ? '+' : ''}${r.heap.groeiMB} MB)` : ''}${r.heap.oordeelMeegeteld ? '' : ' (heap-oordeel niet meegeteld)'}`);
  regels.push(`Event-loop-vertraging: p50 ${r.eventLoop.p50} ms, p99 ${r.eventLoop.p99} ms, max ${r.eventLoop.max} ms (eigen gc() hooguit ${r.eventLoop.gcMsMax} ms)`);
  const b = r.berichten;
  regels.push(`Berichten per echte s: naar apps ${b.perEchteS.naarApp} (kern), bij apps ${b.perEchteS.app}, bij cockpits ${b.perEchteS.cockpit} (${rond(b.totaal.cockpitBytes / MB, 1)} MB in totaal), naar APC/LPD8 ${b.perEchteS.naarApparaten}`);
  regels.push(`Berichten per nep-s:   naar apps ${b.perNepS.naarApp}, invoer APC ${b.perNepS.apc} + LPD8 ${b.perNepS.lpd8}, rommel ${b.totaal.rommel} in totaal, fetch ${b.totaal.fetch}`);
  const o = r.opnameUitslag;
  if (o) regels.push(`Opname van de hele avond: ${o.nepMin} min nep, ${o.gebarenKB} kB ${GEBAREN}, ${o.samenvattingKB} kB ${SAMENVATTING}; tellers voor ${o.naarApps} apps en ${o.invoerSleutels} invoerbronnen`);
  regels.push(`Klok-timers: ${r.timers.bijStart} bij de start, ${r.timers.naClients} zonder clients, ${r.timers.naStop} na stoppen`);
  const hs = (/** @type {Record<string, number>} */ h) => Object.entries(h).map(([k, v]) => `${k} ${v}`).join(', ');
  regels.push(`Handles: bij de start ${hs(r.handles.bijStart)}; zonder clients ${hs(r.handles.naClients)}; na stoppen ${hs(r.handles.naStop) || 'geen'}`);
  regels.push('');
  regels.push('Structuur                 begin     max    eind  zonder clients');
  for (const [k, v] of Object.entries(g)) regels.push(`${k.padEnd(24)}${String(v.begin).padStart(6)}${String(v.max).padStart(8)}${String(v.eind).padStart(8)}${String(v.naClients ?? '').padStart(10)}${v.grens !== undefined ? `  (grens ${v.grens})` : ''}`);
  regels.push('');
  regels.push(`Acties: ${Object.entries(r.acties).sort().map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const laatste = r.hubMeldingen.laatste.slice(-5);
  regels.push(`Hub-meldingen: ${r.hubMeldingen.aantal}${laatste.length ? `; de laatste ${laatste.length} (alle 30 laatste in de JSON):` : ''}`);
  for (const m of laatste) regels.push(`  ${m}`);
  return regels.join('\n');
}

// ── opdrachtregel ────────────────────────────────────────────────────────────

export const VOORBEELD = 'node --expose-gc tools/duurtest.mjs --minuten 3 --seed 7';
/** Opties met een waarde: naam → soort. */
const MET_WAARDE = /** @type {Record<string, 'getal'|'seed'|'opname'|'map'>} */ ({
  '--minuten': 'getal', '--nep-minuten': 'getal', '--seed': 'seed', '--stap': 'getal', '--meet-s': 'getal', '--opname': 'opname', '--uit': 'map',
});
const SCHAKELAARS = new Set(['--stil', '--bewaar']);

/**
 * De opdrachtregel lezen. Een onbekende optie, een ontbrekende waarde of een getal dat geen getal (of ≤ 0) is, geeft
 * een fout in plaats van een stille standaard: bij een duurtest is een vals "goed" (0 rondes gespeeld) het ergste.
 * @param {string[]} args
 * @returns {{ fout: string } | { fout: null, opties: Opties, uit: string|null, stil: boolean }}
 */
export function leesOpties(args) {
  /** @type {Record<string, string>} */
  const w = {};
  const aan = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (SCHAKELAARS.has(a)) { aan.add(a); continue; }
    const soort = MET_WAARDE[a];
    if (!soort) return { fout: a.startsWith('-') ? `onbekende optie ${a}` : `onverwacht "${a}" (opties beginnen met --)` };
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) return { fout: `${a} mist een waarde` };
    if (soort === 'getal' && !(Number.isFinite(Number(v)) && Number(v) > 0)) return { fout: `${a} moet een getal groter dan 0 zijn, niet "${v}"` };
    if (soort === 'seed' && !/^\d+$/.test(v)) return { fout: `--seed moet een geheel getal ≥ 0 zijn, niet "${v}"` };
    if (soort === 'opname' && v !== 'doorlopend' && v !== 'wisselend') return { fout: `--opname is doorlopend of wisselend, niet "${v}"` };
    w[a] = v;
    i++;
  }
  const nepMin = w['--nep-minuten'] === undefined ? undefined : Number(w['--nep-minuten']);
  const minuten = w['--minuten'] === undefined ? (nepMin === undefined ? 3 : undefined) : Number(w['--minuten']);
  return {
    fout: null,
    opties: {
      echtMs: minuten === undefined ? Infinity : minuten * 60000,
      nepMs: nepMin === undefined ? Infinity : nepMin * 60000,
      seed: w['--seed'] === undefined ? 7 : Number(w['--seed']),
      stapMs: w['--stap'] === undefined ? 50 : Number(w['--stap']),
      meetElkeMs: (w['--meet-s'] === undefined ? 2 : Number(w['--meet-s'])) * 1000,
      opname: /** @type {'doorlopend'|'wisselend'} */ (w['--opname'] ?? 'doorlopend'),
      bewaar: aan.has('--bewaar'),
    },
    uit: w['--uit'] ?? null,
    stil: aan.has('--stil'),
  };
}

if (isHoofdmodule(import.meta.url)) {
  const l = leesOpties(process.argv.slice(2));
  if (l.fout !== null) {
    console.error(`duurtest: ${l.fout}.\nVoorbeeld: ${VOORBEELD}\nOpties: ${[...Object.keys(MET_WAARDE), ...SCHAKELAARS].join(', ')} (zie docs/DUURTEST.md)`);
    process.exit(2);
  }
  const uit = resolve(l.uit ?? join(HUB_MAP, 'tools/uitvoer'));
  // Ctrl-C: de avond stopt, de afbouw ruimt op en het rapport (tot dan) komt er nog. Nog eens Ctrl-C: meteen weg.
  const afbreken = new AbortController();
  process.once('SIGINT', () => {
    console.error('\nduurtest: Ctrl-C — de avond stopt; afbouw en rapport volgen (nog eens Ctrl-C = meteen stoppen, zonder opruimen)');
    afbreken.abort();
    process.once('SIGINT', () => process.exit(130));
  });
  /** @param {Awaited<ReturnType<typeof draaiDuurtest>>} r */
  const schrijf = (r) => {
    mkdirSync(uit, { recursive: true });
    const stempel = r.gemaakt.replace(/[:T]/g, '-').replace(/\..*$/, '');
    const bestand = join(uit, `duurtest-${stempel}-seed${r.seed}.json`);
    writeFileSync(bestand, JSON.stringify(r, null, 1) + '\n');
    console.log(`\n${rapportTekst(r)}\n\nRapport: ${bestand}`);
  };
  try {
    const r = await draaiDuurtest({ ...l.opties, signaal: afbreken.signal, log: l.stil ? () => {} : (s) => console.log(s) });
    schrijf(r);
    process.exit(r.ok ? 0 : 1);
  } catch (e) {
    console.error('duurtest gecrasht:', e);
    const r = /** @type {any} */ (e)?.rapport;
    if (r) schrijf(r);
    process.exit(2);
  }
}
