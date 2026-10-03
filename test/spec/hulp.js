// @ts-check
// Testbank voor de specificatietests (zwarte doos, alleen vanuit PROTOCOL.md en het kern-contract).
//
// - Een nep-APC40 die elk MIDI-bericht verwerkt dat het echte apparaat zou bereiken (via oppervlak.teken()
//   én via oppervlak.stuur()). Tests kijken dus naar wat Clay op de hardware ZIET, niet naar interne staat.
// - Nep-apps die via een echte Verbinding met de kern praten (berichten gaan door leesVanApp, zoals in de hub).
// - Invoer altijd als echte MIDI-bytes, ontleed met dezelfde code als de hub (apc40mk2.ontleed, lpd8.maakOntleder).
// - Tijd via NepKlok; `tijd(ms)` laat levende apps ondertussen hartslagen sturen.
//
// De kern wordt geladen uit src/core/kern.js (of uit $VARVE_KERN). Bestaat hij nog niet, dan is `Kern` null
// en slaan de specificatietests zich over met een duidelijke melding.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NepKlok } from '../../src/core/klok.js';
import { LedBeeld } from '../../src/core/leds.js';
import * as APC from '../../src/devices/apc40mk2.js';
import * as LPD8 from '../../src/devices/lpd8.js';
import { leesVanApp } from '../../src/protocol/berichten.js';

// ── kern laden ────────────────────────────────────────────────────────────────────────────────────

const STANDAARD_KERN = fileURLToPath(new URL('../../src/core/kern.js', import.meta.url));
const KERN_PAD = process.env.VARVE_KERN ? resolve(process.env.VARVE_KERN) : STANDAARD_KERN;

/** @type {any} */
let K = null;
if (existsSync(KERN_PAD)) {
  K = process.env.VARVE_KERN
    ? (await import(/* @vite-ignore */ pathToFileURL(KERN_PAD).href)).Kern
    : (await import('../../src/core/kern.js')).Kern;
}
/** De kern-klasse, of null zolang src/core/kern.js er niet is. */
export const Kern = K;
/** Achtervoegsel voor describe-namen: maakt in de uitvoer zichtbaar waarom alles overgeslagen wordt. */
export const MELDING = Kern ? '' : ' [OVERGESLAGEN: src/core/kern.js bestaat nog niet]';

// ── config ────────────────────────────────────────────────────────────────────────────────────────

/** Inhoud van config.json, zoals de hub hem leest. */
export const CONFIG = (() => {
  const c = JSON.parse(readFileSync(fileURLToPath(new URL('../../config.json', import.meta.url)), 'utf8'));
  delete c._doc;
  return Object.freeze(c);
})();

/** Paletindex van een app zoals de hub hem moet tonen. @param {string} hex */
export const appKleur = (hex) => APC.dichtsteKleur(hex);
/** Kleur uit config.json voor een bekende app. @param {string} app */
export const configKleur = (app) => APC.dichtsteKleur(CONFIG.apps[app].kleur);
/** Helderheid van een paletindex (som van r+g+b), om "gedimd" te herkennen. @param {number} i */
export const helderheid = (i) => APC.rgb(APC.PALET[i] ?? '#000000').reduce((a, b) => a + b, 0);

// ── nep-APC40: wat er fysiek op het apparaat staat ───────────────────────────────────────────────

const RGB_NOTEN = new Set(APC.CONTROLS.filter((c) => c.led === 'rgb').map((c) => c.n));
/** @param {number} ch */
const animSoort = (ch) => (ch <= 5 ? 'oneshot' : ch <= 10 ? 'puls' : 'knipper');

/**
 * @typedef {{ basis: number, anim: null | 'oneshot' | 'puls' | 'knipper', animKleur: number | null }} RgbStaat
 */

/** Model van de hardware: verwerkt MIDI-bytes zoals de APC40 mkII ze tekent (protocol v1.2). */
export class NepApc {
  constructor() {
    /** @type {Map<number, RgbStaat>} note → staat */
    this.rgbStaat = new Map();
    /** @type {Map<string, number>} `${ch}:${note}` → velocity (strip-knoppen en losse knoppen) */
    this.noten = new Map();
    /** @type {Map<number, number>} cc → ruwe ringwaarde 0..127 */
    this.ringen = new Map();
    /** @type {number[][]} alle SysEx die het apparaat bereikte */
    this.sysex = [];
    /** @type {number[][]} alle berichten, in volgorde */
    this.log = [];
  }
  /** @param {number[]} b */
  verwerk(b) {
    this.log.push([...b]);
    if (b[0] === 0xf0) { this.sysex.push([...b]); return; }
    const st = b[0] & 0xf0, ch = b[0] & 0x0f;
    if (st === 0x90 || st === 0x80) {
      const n = b[1], vel = st === 0x80 ? 0 : b[2];
      if (RGB_NOTEN.has(n)) {
        const nu = this.rgbStaat.get(n) ?? { basis: 0, anim: null, animKleur: null };
        if (vel === 0) this.rgbStaat.set(n, { basis: 0, anim: null, animKleur: null });
        else if (ch === 0) this.rgbStaat.set(n, { basis: vel, anim: null, animKleur: null });
        else this.rgbStaat.set(n, { basis: nu.basis, anim: animSoort(ch), animKleur: vel });
      } else this.noten.set(`${ch}:${n}`, vel);
    } else if (st === 0xb0 && ch === 0) this.ringen.set(b[1], b[2]);
  }
  /** Zichtbare staat van een rgb-control (pad of scène). @param {string} id */
  rgb(id) {
    const c = ctrl(id);
    if (c.led !== 'rgb') throw new Error(`${id} heeft geen rgb-LED`);
    const s = this.rgbStaat.get(c.n) ?? { basis: 0, anim: null, animKleur: null };
    const kleur = s.anim ? /** @type {number} */ (s.animKleur) : s.basis;
    return { ...s, kleur, aan: kleur > 0 };
  }
  /** Velocity van een knop-LED (rec/solo/act/sel/stop/ab of los). @param {string} id */
  noot(id) { const c = ctrl(id); return this.noten.get(`${c.ch}:${c.n}`) ?? 0; }
  /** Clip-stop-LED: 'uit' | 'aan' | 'knipper'. @param {string} id */
  clipstop(id) { const v = this.noot(id); return v === 2 ? 'knipper' : v ? 'aan' : 'uit'; }
  /** Ringwaarde 0..1 van dk/tk, of null als er nooit iets naartoe ging. @param {string} id */
  ring(id) { const c = ctrl(id); const r = this.ringen.get(c.n); return r === undefined ? null : r / 127; }
  /** Alle 40 grid-pads met hun zichtbare staat. */
  grid() {
    /** @type {Record<string, ReturnType<NepApc['rgb']>>} */
    const uit = {};
    for (let r = 1; r <= 5; r++) for (let k = 1; k <= 8; k++) uit[APC.padId(r, k)] = this.rgb(APC.padId(r, k));
    return uit;
  }
  /** Ids van grid-pads die branden. */
  brandend() { return Object.entries(this.grid()).filter(([, s]) => s.aan).map(([id]) => id); }
}

/** @param {string} id */
function ctrl(id) {
  const c = APC.OP_ID.get(id);
  if (!c) throw new Error(`onbekende control ${id}`);
  return c;
}

/**
 * Nep-oppervlak met dezelfde vorm als ApcSessie (zet/teken/stuur/vergeet), met een echt LedBeeld
 * ertussen: wat de kern met zet() klaarzet, bereikt het apparaat pas bij teken(), en alleen als het verschilt.
 */
export function maakOppervlak() {
  const apc = new NepApc();
  const leds = new LedBeeld({ controls: APC.CONTROLS, berichten: APC.ledBerichten });
  leds.zwart();
  leds.wijzigingen(); // ApcSessie.init() heeft alles al zwart getekend
  const o = {
    apc, leds,
    /** @type {[string, import('../../src/devices/apc40mk2.js').LedStaat][]} */
    zetten: [],
    /** @type {number[][]} */
    gestuurd: [],
    tekeningen: 0,
    vergeten: 0,
    /** @param {string} id @param {import('../../src/devices/apc40mk2.js').LedStaat} s */
    zet(id, s) { o.zetten.push([id, s]); leds.zet(id, s); },
    teken() { const w = leds.wijzigingen(); for (const b of w) apc.verwerk(b); o.tekeningen++; return w.length; },
    /** @param {number[]} b */
    stuur(b) { o.gestuurd.push([...b]); apc.verwerk(b); },
    vergeet() { o.vergeten++; leds.vergeet(); },
  };
  return o;
}

// ── manifesten ────────────────────────────────────────────────────────────────────────────────────

/** Bouwstenen voor parameters. */
export const P = {
  /** @param {string} id @param {object} [x] */
  fader: (id, x = {}) => ({ id, naam: id, soort: 'waarde', hint: 'fader', ...x }),
  /** @param {string} id @param {object} [x] */
  knop: (id, x = {}) => ({ id, naam: id, soort: 'waarde', hint: 'knop', ...x }),
  /** @param {string} id @param {object} [x] */
  waarde: (id, x = {}) => ({ id, naam: id, soort: 'waarde', ...x }),
  /** @param {string} id @param {object} [x] */
  trigger: (id, x = {}) => ({ id, naam: id, soort: 'trigger', ...x }),
  /** @param {string} id @param {object} [x] */
  schakelaar: (id, x = {}) => ({ id, naam: id, soort: 'schakelaar', ...x }),
  /** @param {string} id @param {string[]} keuzes @param {object} [x] */
  keuze: (id, keuzes, x = {}) => ({ id, naam: id, soort: 'keuze', keuzes, hint: 'kolom', ...x }),
};

/** @param {string} app @param {object[]} params @param {object} [x] */
export const manifest = (app, params, x = {}) => ({ v: 1, app, naam: CONFIG.apps[app]?.naam ?? app, params, ...x });
/** Lease-manifest (Varve DJ, av-kern). @param {string} app @param {object} [x] */
export const leaseManifest = (app, x = {}) => ({ v: 1, app, naam: CONFIG.apps[app]?.naam ?? app, lease: true, params: [], ...x });

// ── nep-app ───────────────────────────────────────────────────────────────────────────────────────

let instTeller = 0;

/** Een app die via een Verbinding met de kern praat en alles vastlegt wat hij ontvangt. */
export class NepApp {
  /** @param {Bank} bank @param {any} manifest @param {Record<string, number>} waarden */
  constructor(bank, manifest, waarden) {
    this.bank = bank;
    this.manifest = manifest;
    this.id = manifest.app;
    this.waarden = { ...waarden };
    this.inst = `inst-${++instTeller}`;
    /** @type {any[]} */
    this.ontvangen = [];
    this.levend = true;
    this.verbonden = false;
    /** @type {any} */
    this.v = null;
  }
  /** Nieuwe verbinding + hallo, manifest, staat (de volgorde uit PROTOCOL.md §3). @param {{ inst?: string, manifest?: boolean }} [o] */
  verbind(o = {}) {
    if (o.inst) this.inst = o.inst;
    const app = this;
    this.v = { app: null, stuur(/** @type {any} */ b) { app.ontvangen.push(structuredClone(b)); }, sluit() { app.verbonden = false; } };
    this.bank.kern.verbind(this.v);
    this.verbonden = true;
    this.levend = true;
    this.zeg({ t: 'hallo', app: this.id, inst: this.inst, v: 1 });
    if (o.manifest !== false) {
      this.zeg({ t: 'manifest', manifest: this.manifest });
      if (Object.keys(this.waarden).length) this.zeg({ t: 'staat', waarden: this.waarden });
    }
    return this;
  }
  /** Bericht van de app naar de hub, gecontroleerd zoals de transportlaag dat doet. @param {unknown} ruw */
  zeg(ruw) {
    const r = leesVanApp(ruw);
    if (!r.ok || !('bericht' in r)) throw new Error(`nep-app stuurde iets ongeldigs: ${JSON.stringify(ruw)}`);
    this.bank.kern.ontvang(this.v, r.bericht);
  }
  /** De app veranderde zelf een waarde (muis, automatie). @param {string} id @param {number} v */
  zet(id, v) { this.waarden[id] = v; this.zeg({ t: 'zet', id, v }); }
  hb() { this.zeg({ t: 'hb' }); }
  /** LED-berichten (alleen lease). @param {number[][]} bytes */
  led(bytes) { this.zeg({ t: 'led', bytes }); }
  /** Verbinding valt weg. */
  verbreek() { this.bank.kern.verbreek(this.v); this.verbonden = false; this.levend = false; }
  /** Stopt met hartslagen (vastgelopen tab), verbinding blijft open. */
  zwijg() { this.levend = false; }
  wis() { this.ontvangen = []; }
  /** @param {string} t */
  van(t) { return this.ontvangen.filter((b) => b.t === t); }
  /** Alle zet-berichten van de hub, optioneel voor één parameter. @param {string} [id] */
  zetten(id) { return this.van('zet').filter((b) => id === undefined || b.id === id); }
  /** @param {string} id */
  laatsteZet(id) { return this.zetten(id).at(-1); }
  /** @param {string} [id] */
  trigs(id) { return this.van('trig').filter((b) => id === undefined || b.id === id); }
  midi() { return this.van('midi'); }
  globaal() { return this.van('globaal'); }
  /** Laatste focus-melding (true/false) of undefined. */
  focus() { return this.van('focus').at(-1)?.aan; }
  /** Wat de cockpit over deze app ziet. */
  beeld() { return this.bank.kern.beeld().apps.find((/** @type {any} */ a) => a.app === this.id); }
}

// ── testbank ──────────────────────────────────────────────────────────────────────────────────────

const LPD8_ONTLEDER = LPD8.maakOntleder(LPD8.standaardProfiel('mk2'));
const LPD8_PROFIEL = LPD8.standaardProfiel('mk2');
/** @param {number} v */
const ruw = (v) => Math.max(0, Math.min(127, Math.round(v * 127)));

/** Eén opstelling: nep-klok, nep-oppervlak, kern, events, apps en een virtuele APC40 + LPD8. */
export class Bank {
  /** @param {{ config?: object }} [o] */
  constructor(o = {}) {
    if (!Kern) throw new Error('src/core/kern.js bestaat nog niet');
    this.klok = new NepKlok();
    this.config = { ...structuredClone(CONFIG), ...(o.config ?? {}) };
    this.opp = maakOppervlak();
    this.apc = this.opp.apc;
    this.kern = new Kern({ klok: this.klok, config: this.config, oppervlak: this.opp });
    /** @type {NepApp[]} */
    this.apps = [];
    this.ev = { beeld: /** @type {number[]} */ ([]), leds: /** @type {any[]} */ ([]), invoer: /** @type {any[]} */ ([]), opname: /** @type {boolean[]} */ ([]), naarApp: /** @type {any[]} */ ([]) };
    this.kern.bij('beeld', () => this.ev.beeld.push(this.klok.nu()));
    this.kern.bij('leds', (/** @type {any} */ x) => this.ev.leds.push(structuredClone(x)));
    this.kern.bij('invoer', (/** @type {any} */ g) => this.ev.invoer.push(g));
    this.kern.bij('opname', (/** @type {boolean} */ aan) => this.ev.opname.push(aan));
    this.kern.bij('naarApp', (/** @type {string} */ app, /** @type {any} */ b) => this.ev.naarApp.push([app, structuredClone(b), this.klok.nu()]));
    this.laatsteHb = 0;
  }
  /** Verbind een nieuwe app (hallo, manifest, staat). @param {any} m @param {Record<string, number>} [waarden] */
  app(m, waarden = {}) {
    const a = new NepApp(this, m, waarden);
    this.apps.push(a);
    a.verbind();
    return a;
  }
  /** Laat tijd verstrijken in stappen van 50 ms; levende apps sturen elke 500 ms een hartslag. @param {number} ms */
  tijd(ms) {
    let rest = ms;
    while (rest > 0) {
      const s = Math.min(50, rest);
      this.klok.loop(s);
      rest -= s;
      if (this.klok.nu() - this.laatsteHb >= 500) {
        this.laatsteHb = this.klok.nu();
        for (const a of this.apps) if (a.levend && a.verbonden) a.hb();
      }
    }
  }
  /** Even wachten (50 ms), zodat timers/debounces van de kern lopen. */
  even() { this.tijd(50); }
  /** Wis wat alle apps tot nu toe ontvingen. */
  wisApps() { for (const a of this.apps) a.wis(); }

  // APC40: echte bytes → ontleed → kern.invoer
  /** @param {number[]} bytes */
  midi(bytes) { this.kern.invoer(APC.ontleed(bytes), bytes); this.klok.loop(0); }
  /** @param {string} id */
  druk(id) { const c = ctrl(id); this.midi(c.t === 'cc' ? [0xb0 | c.ch, c.n, 127] : [0x90 | c.ch, c.n, 127]); }
  /** @param {string} id */
  los(id) { const c = ctrl(id); this.midi(c.t === 'cc' ? [0xb0 | c.ch, c.n, 0] : [0x80 | c.ch, c.n, 0]); }
  /** Druk en laat los. @param {string} id */
  tik(id) { this.druk(id); this.los(id); }
  /** Fader of draaiknop naar waarde v (0..1). @param {string} id @param {number} v */
  draai(id, v) { const c = ctrl(id); if (c.t !== 'cc') throw new Error(`${id} is geen cc`); this.midi([0xb0 | c.ch, c.n, ruw(v)]); }
  /** Fader 1..8 naar v. @param {number} i @param {number} v */
  fader(i, v) { this.draai(`fader${i}`, v); }
  /** Beweeg een fader/knop geleidelijk van a naar b (in stappen van 1/127). @param {string} id @param {number} a @param {number} b */
  schuif(id, a, b) {
    const ra = ruw(a), rb = ruw(b), stap = rb >= ra ? 1 : -1;
    for (let r = ra; r !== rb + stap; r += stap) this.draai(id, r / 127);
  }
  /** Houd de hubtoets ingedrukt tijdens fn. @param {() => void} fn */
  metHubtoets(fn) { const t = this.hubtoets(); this.druk(t); try { fn(); } finally { this.los(t); } }
  /** Control-id van de hubtoets volgens config. */
  hubtoets() { return this.config.hubtoets; }

  // LPD8 (mk2-fabrieksprofiel): knoppen CC 70-77, pads noot 36-43
  /** @param {number[]} bytes */
  lpdMidi(bytes) { this.kern.invoer(LPD8_ONTLEDER(bytes), bytes); this.klok.loop(0); }
  /** @param {number} k 1..8 @param {number} v 0..1 */
  lpdKnop(k, v) { this.lpdMidi([0xb0, LPD8_PROFIEL.knoppen[k - 1].n, ruw(v)]); }
  /** Draai een LPD8-knop geleidelijk van a naar b. @param {number} k @param {number} a @param {number} b */
  lpdSchuif(k, a, b) {
    const ra = ruw(a), rb = ruw(b), stap = rb >= ra ? 1 : -1;
    for (let r = ra; r !== rb + stap; r += stap) this.lpdKnop(k, r / 127);
  }
  /** @param {number} p 1..8 */
  lpdDruk(p) { this.lpdMidi([0x90, LPD8_PROFIEL.pads[p - 1].n, 100]); }
  /** @param {number} p 1..8 */
  lpdLos(p) { this.lpdMidi([0x80, LPD8_PROFIEL.pads[p - 1].n, 0]); }
  /** Pad indrukken, ms vasthouden (tijd loopt, apps blijven leven), loslaten. @param {number} p @param {number} ms */
  lpdHoud(p, ms) { this.lpdDruk(p); this.tijd(ms); this.lpdLos(p); }

  /** Eén app-beeld uit kern.beeld(). @param {string} app */
  appBeeld(app) { return this.kern.beeld().apps.find((/** @type {any} */ a) => a.app === app); }
  /** Alle globaal-berichten die app a ontving, samengevoegd tot de laatste stand. @param {NepApp} a */
  globaalStand(a) { return Object.assign({}, ...a.globaal().map((b) => b.waarden)); }
  stop() { this.kern.stop(); }
}

/** Waarde op de draad voor keuze i van n. @param {number} i @param {number} n */
export const keuzeWaarde = (i, n) => i / (n - 1);
/** Ruwe 7-bit afronding zoals een fysieke control hem stuurt. @param {number} v */
export const fysiek = (v) => ruw(v) / 127;
