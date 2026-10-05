// @ts-check
// Native Instruments Maschine MK2 via USB-HID: rapporten ontleden en maken, en de virtuele MIDI-indeling die een
// lease-app ziet (docs/MASCHINE.md). Puur: geen I/O en geen klok (tijd komt als argument binnen).
//
// Waarom HID en niet MIDI: NI ondersteunt de MK2 niet meer (nov 2024) en de MIDI-modus (SHIFT+CONTROL) werkt alleen
// als NIHardwareAgent draait. De hub opent het toestel daarom zelf (src/ports/hid.js) en maakt er MIDI van.
//
// Bronnen (MIT): jayintheday/maschine-code PROTOCOL.md (op hardware getest, juli 2026), shaduzlabs/cabl
// src/devices/ni/MaschineMK2.cpp, Ardour libs/surfaces/maschine2/m2_dev_mk2.*. VID:PID staan in config.json.
//
//   in  0x01  knoppen (48 bits), masterwiel (4 bit, rond), 8 eindeloze knoppen (0..999, rond)        25 bytes
//   in  0x20  16 pads, 12-bit druk; ook in rust ±750 frames/s                                         33..65 bytes
//   uit 0x80  pad-RGB (16 × R,G,B)                                                                     49 bytes
//   uit 0x81  groepknoppen A–H (2 zones × R,G,B) + 8 transportlampjes                                  57 bytes
//   uit 0x82  31 enkelkleurige knoplampjes                                                              32 bytes
//   uit 0xE0/0xE1  scherm links/rechts, 256×64 1-bit, 8 stukken van 9 + 256 bytes                      265 bytes
import { PALET, rgb } from './apc40mk2.js';

/**
 * @typedef {{ dev: 'maschine-mk2', el: string|null, kind: 'druk'|'los'|'waarde'|'delta'|'onbekend', v?: number, raw?: number, delta?: number, bytes?: number[] }} Gebeurtenis
 * @typedef {{ drempel: number, los: number, bevestig: number, stijging_vol: number, max: number, aftertouch_hz: number }} PadInstellingen
 * @typedef {{ fase: 'uit'|'wacht'|'aan', vorig: number, voor: number, teller: number, at: number, atMs: number }} PadStaat
 * @typedef {{ knoppen: boolean[], wiel: number|null, encoders: (number|null)[], acc: number[] }} KnopStaat
 */

export const NAAM = 'Maschine MK2';
export const RAPPORT = Object.freeze({ knoppen: 0x01, pads: 0x20, padLeds: 0x80, groepLeds: 0x81, knopLeds: 0x82, scherm: 0xe0 });
/** De eindeloze knoppen tellen 0..999 en lopen dan rond (maschine-code, op hardware bevestigd). */
export const ENCODER_ROND = 1000;
/** Het masterwiel is een 4-bit teller. */
export const WIEL_ROND = 16;
export const SCHERM = Object.freeze({ breed: 256, hoog: 64, bytes: 2048, stukken: 8, perStuk: 256 });

/** Standaardinstellingen (config.json → apparaten.maschine-mk2 wint; de proef meet ze). */
export const STANDAARD = Object.freeze({
  pads: Object.freeze({ drempel: 200, los: 100, bevestig: 2, stijging_vol: 1500, max: 4095, aftertouch_hz: 30 }),
  encoder_drempel: 12,
  led_max: 255,
});

// ── de virtuele MIDI-indeling (docs/MASCHINE.md) ─────────────────────────────

/** Pads: noten 36–51 op kanaal 0 (pad 1 = linksonder = 36, zoals de opdruk en de MIDI-modus van NI). */
export const PAD_NOOT = 36;
/** Knoppen: noot = bitnummer in rapport 0x01, op kanaal 1. */
export const KNOP_KANAAL = 1;
/** 8 eindeloze knoppen: CC 16–23 kanaal 0, relatief (tweecomplement). Masterwiel: CC 24. */
export const ENCODER_CC = 16;
export const WIEL_CC = 24;

/** De 48 knoppen in de volgorde van de bits in rapport 0x01 (= hun noot op kanaal 1). */
export const KNOPPEN = Object.freeze([
  'f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8',
  'control', 'step', 'browse', 'sampling', 'browseL', 'browseR', 'all', 'auto',
  'volume', 'swing', 'tempo', 'navL', 'navR', 'enter', 'noteRepeat', 'wiel',
  'groepA', 'groepB', 'groepC', 'groepD', 'groepE', 'groepF', 'groepG', 'groepH',
  'restart', 'stapL', 'stapR', 'grid', 'play', 'rec', 'erase', 'shift',
  'scene', 'pattern', 'padMode', 'navigate', 'duplicate', 'select', 'solo', 'mute',
]);
/** Wat er op de knop staat, voor de proef en de docs. */
export const KNOP_LABEL = Object.freeze({
  f1: 'F1 (boven het linkerscherm)', f8: 'F8 (boven het rechterscherm)', control: 'CONTROL', step: 'STEP', browse: 'BROWSE', sampling: 'SAMPLING',
  browseL: '◄ (links boven, naast BROWSE)', browseR: '► (links boven)', all: 'ALL', auto: 'AUTO',
  volume: 'VOLUME', swing: 'SWING', tempo: 'TEMPO', navL: '◄ (bij het masterwiel)', navR: '► (bij het masterwiel)', enter: 'ENTER',
  noteRepeat: 'NOTE REPEAT', wiel: 'het masterwiel indrukken',
  restart: 'RESTART', stapL: '◄ (transport)', stapR: '► (transport)', grid: 'GRID', play: 'PLAY', rec: 'REC', erase: 'ERASE', shift: 'SHIFT',
  scene: 'SCENE', pattern: 'PATTERN', padMode: 'PAD MODE', navigate: 'NAVIGATE', duplicate: 'DUPLICATE', select: 'SELECT', solo: 'SOLO', mute: 'MUTE',
});
export const KNOP_NR = new Map(KNOPPEN.map((k, i) => [k, i]));
export const GROEPEN = Object.freeze(KNOPPEN.slice(24, 32));

/** Waar het lampje van een knop zit: rapport 0x82 (plek), 0x81 transport (plek), groep (RGB, 0x81) of geen. */
const KNOP_LED_82 = Object.freeze({
  control: 0, step: 1, browse: 2, sampling: 3, browseL: 4, browseR: 5, all: 6, auto: 7,
  f1: 8, f2: 9, f3: 10, f4: 11, f5: 12, f6: 13, f7: 14, f8: 15,
  scene: 16, pattern: 17, padMode: 18, navigate: 19, duplicate: 20, select: 21, solo: 22, mute: 23,
  volume: 24, swing: 25, tempo: 26, navL: 27, navR: 28, enter: 29, noteRepeat: 30,
});
const TRANSPORT = Object.freeze(['restart', 'stapL', 'stapR', 'grid', 'play', 'rec', 'erase', 'shift']);

/**
 * Pad-plek in de rapporten 0x20 en 0x80 (0..15, rij voor rij vanaf LINKSBOVEN) → padnummer zoals opgedrukt
 * (1 = linksonder, 16 = rechtsboven). Plek 0 = pad 13. Te bevestigen in de proef (oriëntatie).
 * @param {number} plek
 */
export const padVanPlek = (plek) => 13 - (plek & 12) + (plek & 3);
/** @param {number} pad 1..16 */
export const plekVanPad = (pad) => (3 - Math.floor((pad - 1) / 4)) * 4 + ((pad - 1) % 4);
/** @param {number} pad 1..16 */
export const padNoot = (pad) => PAD_NOOT + pad - 1;

const tweecomplement = (/** @type {number} */ d) => (Math.max(-63, Math.min(63, d)) + 128) % 128;
/** Relatieve CC-waarde → stappen (1..63 = +n, 127..65 = −1..−63). @param {number} raw */
export const relatief = (raw) => (raw >= 64 ? raw - 128 : raw);

/**
 * Kleinste stap tussen twee standen van een teller die rondloopt (positief = rechtsom).
 * @param {number} vorig @param {number} nu @param {number} rond
 */
export function rondDelta(vorig, nu, rond) {
  let d = (((nu - vorig) % rond) + rond) % rond;
  if (d > rond / 2) d -= rond;
  return d;
}

// ── invoer: rapporten ontleden (staatloos; dit is wat de golden test vastlegt) ──

/**
 * Rapport 0x01 → welke knoppen in zijn, de stand van het masterwiel en van de 8 knoppen. Null als het geen 0x01 is
 * of te kort.
 * @param {ArrayLike<number>} f
 * @returns {{ ingedrukt: string[], knoppen: boolean[], wiel: number, encoders: number[] } | null}
 */
export function ontleedKnoppen(f) {
  if (!f || f[0] !== RAPPORT.knoppen || f.length < 25) return null;
  const knoppen = KNOPPEN.map((_, i) => (f[1 + (i >> 3)] & (1 << (i & 7))) !== 0);
  const encoders = Array.from({ length: 8 }, (_, k) => f[9 + 2 * k] | (f[10 + 2 * k] << 8));
  return { ingedrukt: KNOPPEN.filter((_, i) => knoppen[i]), knoppen, wiel: f[8] & 0x0f, encoders };
}

/**
 * Rapport 0x20 → 16 drukwaarden (0..4095) per plek. De hoge nibble van elk tweede byte is het plek-nummer (in rust
 * gezien: 00 10 20 … f0); we lezen op plek, zoals Ardour.
 * @param {ArrayLike<number>} f
 * @returns {number[]|null}
 */
export function ontleedPads(f) {
  if (!f || f[0] !== RAPPORT.pads || f.length < 33) return null;
  return Array.from({ length: 16 }, (_, s) => ((f[2 + 2 * s] & 0x0f) << 8) | f[1 + 2 * s]);
}

/** Vanaf deze druk heet een pad in het logboek 'aangeraakt' (alleen voor het lezen; de slag beslist padsStap). */
export const AANRAAK = 64;

/**
 * Eén HID-rapport, staatloos gelezen: voor het logboek en de golden test. Bij pads ook welke pad (zoals opgedrukt)
 * aangeraakt is: zo legt een opname van Clay's toestel ook de oriëntatie vast.
 * @param {ArrayLike<number>} f
 */
export function ontleedRapport(f) {
  const k = ontleedKnoppen(f);
  if (k) return { dev: 'maschine-mk2', el: null, kind: 'knoppen', ingedrukt: k.ingedrukt, wiel: k.wiel, encoders: k.encoders };
  const p = ontleedPads(f);
  if (p) {
    /** @type {Record<string, number>} */
    const aangeraakt = {};
    p.forEach((d, plek) => { if (d >= AANRAAK) aangeraakt[`pad${padVanPlek(plek)}`] = d; });
    return { dev: 'maschine-mk2', el: null, kind: 'pads', drukken: p, aangeraakt };
  }
  return { dev: 'maschine-mk2', el: null, kind: 'onbekend', rapport: f?.[0] ?? null, lengte: f?.length ?? 0 };
}

/**
 * Eén virtueel MIDI-bericht (wat een lease-app krijgt) → gebeurtenis met een naam. Staatloos.
 * @param {number[]} b
 * @returns {Gebeurtenis & { noot?: number }}
 */
export function ontleedMidi(b) {
  const st = b[0] & 0xf0, ch = b[0] & 0x0f;
  if ((st === 0x90 || st === 0x80) && ch === 0 && b[1] >= PAD_NOOT && b[1] < PAD_NOOT + 16) {
    const druk = st === 0x90 && b[2] > 0;
    return { dev: 'maschine-mk2', el: `pad${b[1] - PAD_NOOT + 1}`, kind: druk ? 'druk' : 'los', v: druk ? b[2] / 127 : 0, raw: b[2] };
  }
  if (st === 0xa0 && ch === 0 && b[1] >= PAD_NOOT && b[1] < PAD_NOOT + 16) {
    return { dev: 'maschine-mk2', el: `pad${b[1] - PAD_NOOT + 1}`, kind: 'waarde', v: b[2] / 127, raw: b[2] };
  }
  if ((st === 0x90 || st === 0x80) && ch === KNOP_KANAAL && b[1] < KNOPPEN.length) {
    const druk = st === 0x90 && b[2] > 0;
    return { dev: 'maschine-mk2', el: KNOPPEN[b[1]], kind: druk ? 'druk' : 'los', v: druk ? 1 : 0, raw: b[2] };
  }
  if (st === 0xb0 && ch === 0 && b[1] >= ENCODER_CC && b[1] <= WIEL_CC) {
    const el = b[1] === WIEL_CC ? 'masterwiel' : `enc${b[1] - ENCODER_CC + 1}`;
    return { dev: 'maschine-mk2', el, kind: 'delta', delta: relatief(b[2]), raw: b[2] };
  }
  return { dev: 'maschine-mk2', el: null, kind: 'onbekend', bytes: [...b] };
}

// ── invoer: van rapporten naar virtuele MIDI (met staat, puur) ───────────────

/** @returns {KnopStaat} */
export const nieuweKnopStaat = () => ({ knoppen: KNOPPEN.map(() => false), wiel: null, encoders: Array(8).fill(null), acc: Array(8).fill(0) });

/**
 * Rapport 0x01 → virtuele MIDI: knoppen als noot aan/uit op kanaal 1, eindeloze knoppen als relatieve CC 16–23
 * (pas na `drempel` tellen in één richting, dan alles wat er opgespaard is: rustende knoppen trillen een paar tellen
 * heen en weer, dat valt weg), masterwiel als relatieve CC 24. Het eerste rapport na aansluiten zet alleen de
 * beginstand van wiel en knoppen (die tellers hebben geen nulpunt); knoppen beginnen als 'los'.
 * @param {KnopStaat} staat @param {ArrayLike<number>} f @param {{ encoder_drempel: number }} inst
 * @returns {{ staat: KnopStaat, midi: number[][] }}
 */
export function knoppenStap(staat, f, inst) {
  const k = ontleedKnoppen(f);
  if (!k) return { staat, midi: [] };
  /** @type {number[][]} */
  const midi = [];
  const knoppen = [...staat.knoppen];
  k.knoppen.forEach((aan, i) => {
    if (aan === knoppen[i]) return;
    knoppen[i] = aan;
    midi.push(aan ? [0x90 | KNOP_KANAAL, i, 127] : [0x80 | KNOP_KANAAL, i, 0]);
  });
  if (staat.wiel !== null) {
    const d = rondDelta(staat.wiel, k.wiel, WIEL_ROND);
    if (d) midi.push([0xb0, WIEL_CC, tweecomplement(d)]);
  }
  const drempel = Math.max(1, inst.encoder_drempel);
  const acc = [...staat.acc];
  k.encoders.forEach((w, i) => {
    const vorig = staat.encoders[i];
    if (vorig === null || vorig === w) return;
    acc[i] += rondDelta(vorig, w, ENCODER_ROND);
    if (Math.abs(acc[i]) < drempel) return;
    midi.push([0xb0, ENCODER_CC + i, tweecomplement(acc[i])]);
    acc[i] = 0;
  });
  return { staat: { knoppen, wiel: k.wiel, encoders: k.encoders, acc }, midi };
}

/** @returns {PadStaat[]} */
export const nieuwePadStaten = () => Array.from({ length: 16 }, () => ({ fase: /** @type {'uit'} */ ('uit'), vorig: 0, voor: 0, teller: 0, at: -1, atMs: 0 }));

/**
 * Rapport 0x20 → virtuele MIDI voor de 16 pads. Een pad gaat 'aan' als hij `bevestig` frames achter elkaar op of
 * boven `drempel` staat (één los frame is een hapering, geen slag); de velocity komt uit de drukstijging van het
 * laatste frame onder de drempel tot dat moment (`stijging_vol` = 127). Losgelaten onder `los` (hysterese).
 * Daartussen polyfone aftertouch, hooguit `aftertouch_hz` keer per seconde per pad en alleen bij verandering.
 * @param {PadStaat[]} staten @param {ArrayLike<number>} f @param {number} nu ms @param {PadInstellingen} inst
 * @returns {{ staten: PadStaat[], midi: number[][] }}
 */
export function padsStap(staten, f, nu, inst) {
  const drukken = ontleedPads(f);
  if (!drukken) return { staten, midi: [] };
  /** @type {number[][]} */
  const midi = [];
  const atMs = 1000 / Math.max(1, inst.aftertouch_hz);
  const uit = staten.map((s0, plek) => {
    const s = { ...s0 };
    const p = drukken[plek];
    const noot = padNoot(padVanPlek(plek));
    if (s.fase === 'uit') {
      if (p >= inst.drempel) { s.fase = 'wacht'; s.teller = 1; s.voor = s.vorig; }
    } else if (s.fase === 'wacht') {
      if (p >= inst.drempel) s.teller++;
      else s.fase = 'uit';
    } else if (p < inst.los) {
      s.fase = 'uit';
      midi.push([0x80, noot, 0]);
    } else {
      const at = Math.max(0, Math.min(127, Math.round((p / inst.max) * 127)));
      if (at !== s.at && nu - s.atMs >= atMs) { midi.push([0xa0, noot, at]); s.at = at; s.atMs = nu; }
    }
    if (s.fase === 'wacht' && s.teller >= Math.max(1, inst.bevestig)) {
      s.fase = 'aan';
      const vel = Math.max(1, Math.min(127, Math.round((127 * (p - s.voor)) / Math.max(1, inst.stijging_vol))));
      midi.push([0x90, noot, vel]);
      s.at = -1;
      s.atMs = nu;
    }
    s.vorig = p;
    return s;
  });
  return { staten: uit, midi };
}

/** Staat er een pad (bijna) in? Dan hoort het frame in het (uitgedunde) logboek. @param {PadStaat[]} staten @param {number} los */
export const padsBezig = (staten, los) => staten.some((s) => s.fase !== 'uit' || s.vorig >= los);

// ── uitvoer: lampjes en schermen ─────────────────────────────────────────────

/** APC-paletindex → R,G,B (0..255). Zo hebben een pad op de APC en een pad op de Maschine dezelfde kleur. @param {number} i */
export const paletRgb = (i) => rgb(PALET[Math.max(0, Math.min(127, Math.round(i)))] ?? '#000000');

/**
 * Het LED-beeld van de Maschine. Wijzigt via virtuele MIDI (noot aan/uit, wat de lease-app stuurt) en geeft alleen
 * de rapporten terug die veranderden sinds de vorige keer (`vergeet()` = volgende keer alles).
 */
export class MaschineLeds {
  /** @param {{ led_max?: number }} [o] led_max: helderste waarde op de draad (255; de proef meet of 127 het maximum is) */
  constructor(o = {}) {
    this.max = Math.max(1, Math.min(255, o.led_max ?? STANDAARD.led_max));
    this.r80 = new Array(49).fill(0); this.r80[0] = RAPPORT.padLeds;
    this.r81 = new Array(57).fill(0); this.r81[0] = RAPPORT.groepLeds;
    this.r82 = new Array(32).fill(0); this.r82[0] = RAPPORT.knopLeds;
    /** @type {Map<number, string>} */
    this.verstuurd = new Map();
  }
  /** @param {number} x 0..255 */
  #schaal(x) { return Math.round((x * this.max) / 255); }
  /**
   * Eén virtueel MIDI-bericht van een app. Pads (kanaal 0, noot 36–51) en groepknoppen (kanaal 1, noot 24–31):
   * velocity = APC-paletindex. Andere knoppen (kanaal 1): velocity = helderheid 0..127. Noot uit = lampje uit.
   * Geeft false voor alles wat geen lampje is.
   * @param {number[]} m
   */
  midi(m) {
    if (!Array.isArray(m) || m.length !== 3) return false;
    const st = m[0] & 0xf0, ch = m[0] & 0x0f;
    if (st !== 0x90 && st !== 0x80) return false;
    const v = st === 0x80 ? 0 : Math.max(0, Math.min(127, m[2] | 0));
    if (ch === 0 && m[1] >= PAD_NOOT && m[1] < PAD_NOOT + 16) { this.zetPad(m[1] - PAD_NOOT + 1, paletRgb(v)); return true; }
    if (ch !== KNOP_KANAAL) return false;
    const knop = KNOPPEN[m[1]];
    if (!knop) return false;
    if (GROEPEN.includes(knop)) { const c = paletRgb(v); this.zetGroep(knop, c, c); return true; }
    return this.zetKnop(knop, Math.round((v * 255) / 127));
  }
  /** @param {number} pad 1..16 @param {[number, number, number]} c R,G,B 0..255 */
  zetPad(pad, [r, g, b]) {
    const o = 1 + 3 * plekVanPad(pad);
    this.r80[o] = this.#schaal(r); this.r80[o + 1] = this.#schaal(g); this.r80[o + 2] = this.#schaal(b);
  }
  /** Een groepknop heeft twee lampjes (zones). @param {string} knop groepA..groepH @param {[number, number, number]} c1 @param {[number, number, number]} c2 */
  zetGroep(knop, c1, c2) {
    const o = 1 + 6 * GROEPEN.indexOf(knop);
    [...c1, ...c2].forEach((x, i) => { this.r81[o + i] = this.#schaal(x); });
  }
  /** @param {string} knop @param {number} helder 0..255 */
  zetKnop(knop, helder) {
    const w = this.#schaal(Math.max(0, Math.min(255, helder)));
    if (knop in KNOP_LED_82) { this.r82[1 + /** @type {Record<string, number>} */ (KNOP_LED_82)[knop]] = w; return true; }
    const t = TRANSPORT.indexOf(knop);
    if (t >= 0) { this.r81[49 + t] = w; return true; }
    return false; // het masterwiel heeft geen lampje
  }
  /** Alles uit (in het model). */
  uit() { for (const r of [this.r80, this.r81, this.r82]) r.fill(0, 1); }
  /** De volgende `rapporten()` stuurt alles. */
  vergeet() { this.verstuurd.clear(); }
  /** Rapporten die veranderden sinds de vorige keer (en markeer ze als verstuurd). */
  rapporten() {
    /** @type {number[][]} */
    const uit = [];
    for (const r of [this.r80, this.r81, this.r82]) {
      const k = r.join(',');
      if (this.verstuurd.get(r[0]) === k) continue;
      this.verstuurd.set(r[0], k);
      uit.push([...r]);
    }
    return uit;
  }
}

/**
 * Een scherm (0 = links, 1 = rechts) → 8 HID-rapporten van 265 bytes. `data`: 2048 bytes, rij voor rij van boven,
 * 32 bytes per rij, het hoogste bit is de meest linkse pixel, 1 = aan (maschine-code, op hardware bevestigd).
 * @param {0|1} nr @param {ArrayLike<number>} data
 * @returns {number[][]}
 */
export function schermRapporten(nr, data) {
  return Array.from({ length: SCHERM.stukken }, (_, stuk) => {
    const kop = [RAPPORT.scherm | nr, 0x00, 0x00, stuk * 8, 0x00, 0x20, 0x00, 0x08, 0x00];
    const uit = new Array(kop.length + SCHERM.perStuk);
    kop.forEach((x, i) => { uit[i] = x; });
    for (let i = 0; i < SCHERM.perStuk; i++) uit[kop.length + i] = (data[stuk * SCHERM.perStuk + i] ?? 0) & 0xff;
    return uit;
  });
}

/** Een leeg scherm (alles uit). */
export const leegScherm = () => new Uint8Array(SCHERM.bytes);
/** Zet pixel (x, y) aan in een schermbuffer. @param {Uint8Array} buf @param {number} x @param {number} y */
export function zetPixel(buf, x, y) {
  if (x < 0 || y < 0 || x >= SCHERM.breed || y >= SCHERM.hoog) return;
  buf[32 * y + (x >> 3)] |= 0x80 >> (x & 7);
}

/**
 * Testbeelden voor de proef: 'schaak' (blokken van 8×8 met een rand) en 'strepen' (horizontale strepen van 4 rijen).
 * @param {'schaak'|'strepen'} soort
 */
export function testbeeld(soort) {
  const b = leegScherm();
  for (let y = 0; y < SCHERM.hoog; y++) {
    for (let x = 0; x < SCHERM.breed; x++) {
      const rand = x === 0 || y === 0 || x === SCHERM.breed - 1 || y === SCHERM.hoog - 1;
      const aan = soort === 'schaak' ? (((x >> 3) + (y >> 3)) & 1) === 0 : ((y >> 2) & 1) === 0;
      if (rand || aan) zetPixel(b, x, y);
    }
  }
  return b;
}
