// Het Maschine MK2-profiel (src/devices/maschine-mk2.js): puur, zonder toestel.
import { describe, it, expect } from 'vitest';
import * as MS from '../src/devices/maschine-mk2.js';
import { PALET, rgb } from '../src/devices/apc40mk2.js';
import { padFrame, knopFrame, rustFrame } from './nep-speelapparaten.js';

const INST = { ...MS.STANDAARD.pads };
const leegKnoppen = () => ({ knoppen: new Set(), wiel: 0, encoders: Array(8).fill(0) });

describe('Maschine MK2: pads en hun plek', () => {
  it('plek 0 (linksboven in het rapport) is pad 13, plek 15 is pad 4, pad 1 is linksonder (plek 12)', () => {
    expect(MS.padVanPlek(0)).toBe(13);
    expect(MS.padVanPlek(3)).toBe(16);
    expect(MS.padVanPlek(12)).toBe(1);
    expect(MS.padVanPlek(15)).toBe(4);
    for (let plek = 0; plek < 16; plek++) expect(MS.plekVanPad(MS.padVanPlek(plek))).toBe(plek);
    expect(new Set(Array.from({ length: 16 }, (_, p) => MS.padVanPlek(p))).size).toBe(16);
  });
  it('pads zijn noten 36–51 (pad 1 = 36), knoppen noot = bitnummer op kanaal 1', () => {
    expect(MS.padNoot(1)).toBe(36);
    expect(MS.padNoot(16)).toBe(51);
    expect(MS.KNOPPEN).toHaveLength(48);
    expect(MS.KNOP_NR.get('f1')).toBe(0);
    expect(MS.KNOP_NR.get('wiel')).toBe(23);
    expect(MS.KNOP_NR.get('groepA')).toBe(24);
    expect(MS.KNOP_NR.get('shift')).toBe(39);
    expect(MS.KNOP_NR.get('mute')).toBe(47);
  });
  it('rondDelta: de kleinste stap over het rondlopen heen', () => {
    expect(MS.rondDelta(998, 2, 1000)).toBe(4);
    expect(MS.rondDelta(2, 998, 1000)).toBe(-4);
    expect(MS.rondDelta(15, 0, 16)).toBe(1);
    expect(MS.rondDelta(0, 15, 16)).toBe(-1);
    expect(MS.rondDelta(500, 500, 1000)).toBe(0);
  });
});

describe('Maschine MK2: rapporten lezen (staatloos)', () => {
  it('0x01: knoppen, masterwiel (4 bit) en de 8 knoppen (16 bit, little-endian)', () => {
    const f = knopFrame({ knoppen: new Set(['f1', 'shift', 'mute', 'wiel']), wiel: 9, encoders: [0, 1, 255, 256, 999, 500, 7, 998] });
    const k = MS.ontleedKnoppen(f);
    expect(k.ingedrukt).toEqual(['f1', 'wiel', 'shift', 'mute']);
    expect(k.wiel).toBe(9);
    expect(k.encoders).toEqual([0, 1, 255, 256, 999, 500, 7, 998]);
    expect(MS.ontleedKnoppen([0x01, 0, 0])).toBe(null);
    expect(MS.ontleedKnoppen(rustFrame())).toBe(null);
  });
  it('0x20: 16 drukwaarden (12 bit), de plek-nibble telt niet mee', () => {
    const d = Array.from({ length: 16 }, (_, s) => s * 250);
    expect(MS.ontleedPads(padFrame(d))).toEqual(d);
    const f = padFrame(d);
    expect(f[2 + 2 * 5] >> 4).toBe(5);
    expect(MS.ontleedPads(f.slice(0, 32))).toBe(null);
  });
  it('ontleedRapport geeft knoppen, pads of onbekend', () => {
    expect(MS.ontleedRapport(rustFrame())).toMatchObject({ kind: 'pads', aangeraakt: {} });
    // welke pad (zoals opgedrukt) aangeraakt is: zo legt een opname ook de oriëntatie vast
    expect(MS.ontleedRapport(padFrame([2000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 70])).aangeraakt).toEqual({ pad13: 2000, pad4: 70 });
    expect(MS.ontleedRapport(knopFrame(leegKnoppen()))).toMatchObject({ kind: 'knoppen', ingedrukt: [], wiel: 0 });
    expect(MS.ontleedRapport([0x77, 1, 2])).toEqual({ dev: 'maschine-mk2', el: null, kind: 'onbekend', rapport: 0x77, lengte: 3 });
  });
  it('ontleedMidi: de virtuele MIDI krijgt een naam', () => {
    expect(MS.ontleedMidi([0x90, 36, 100])).toEqual({ dev: 'maschine-mk2', el: 'pad1', kind: 'druk', v: 100 / 127, raw: 100 });
    expect(MS.ontleedMidi([0x80, 51, 0])).toMatchObject({ el: 'pad16', kind: 'los' });
    expect(MS.ontleedMidi([0xa0, 40, 64])).toMatchObject({ el: 'pad5', kind: 'waarde', raw: 64 });
    expect(MS.ontleedMidi([0x91, 39, 127])).toMatchObject({ el: 'shift', kind: 'druk' });
    expect(MS.ontleedMidi([0x81, 0, 0])).toMatchObject({ el: 'f1', kind: 'los' });
    expect(MS.ontleedMidi([0xb0, 16, 5])).toMatchObject({ el: 'enc1', kind: 'delta', delta: 5 });
    expect(MS.ontleedMidi([0xb0, 23, 120])).toMatchObject({ el: 'enc8', delta: -8 });
    expect(MS.ontleedMidi([0xb0, 24, 127])).toMatchObject({ el: 'masterwiel', delta: -1 });
    expect(MS.ontleedMidi([0xb5, 7, 1]).kind).toBe('onbekend');
  });
});

describe('Maschine MK2: knoppen, draaiknoppen en masterwiel → virtuele MIDI', () => {
  const inst = { encoder_drempel: 12 };
  /** Speel een reeks knoppenstanden af. */
  function speel(standen) {
    let staat = MS.nieuweKnopStaat();
    const midi = [];
    for (const s of standen) { const r = MS.knoppenStap(staat, knopFrame(s), inst); staat = r.staat; midi.push(...r.midi); }
    return midi;
  }
  it('knop in = noot aan op kanaal 1, los = noot uit; ook de allereerste druk na aansluiten', () => {
    expect(speel([{ ...leegKnoppen(), knoppen: new Set(['play']) }, leegKnoppen()])).toEqual([[0x91, 36, 127], [0x81, 36, 0]]);
  });
  it('masterwiel: ±1 als relatieve CC 24, ook over 15 → 0; het eerste rapport is alleen de beginstand', () => {
    const s = (w) => ({ ...leegKnoppen(), wiel: w });
    expect(speel([s(14), s(15), s(0), s(15)])).toEqual([[0xb0, 24, 1], [0xb0, 24, 1], [0xb0, 24, 127]]);
  });
  it('draaiknoppen: pas na de drempel, dan alles wat er opgespaard is (tweecomplement), ook over 999 → 0', () => {
    const e = (w) => ({ ...leegKnoppen(), encoders: [w, 0, 0, 0, 0, 0, 0, 0] });
    expect(speel([e(990), e(994), e(998), e(2)])).toEqual([[0xb0, 16, 12]]);
    expect(speel([e(10), e(6), e(2), e(998)])).toEqual([[0xb0, 16, 128 - 12]]);
  });
  it('een rustende knop die heen en weer trilt, stuurt niets', () => {
    const e = (w) => ({ ...leegKnoppen(), encoders: [0, 0, 0, w, 0, 0, 0, 0] });
    expect(speel([e(500), e(502), e(498), e(503), e(497), e(501), e(499)])).toEqual([]);
  });
  it('grote sprongen worden begrensd op ±63', () => {
    const e = (w) => ({ ...leegKnoppen(), encoders: [0, 0, 0, 0, 0, 0, 0, w] });
    expect(speel([e(0), e(300)])).toEqual([[0xb0, 23, 63]]);
  });
});

describe('Maschine MK2: pads → noten, velocity, aftertouch', () => {
  /** @param {[number, number][]} frames [tijd, druk op plek 0] */
  function speel(frames, inst = INST) {
    let staten = MS.nieuwePadStaten();
    const midi = [];
    for (const [t, p] of frames) {
      const r = MS.padsStap(staten, padFrame([p]), t, inst);
      staten = r.staten;
      midi.push(...r.midi.map((m) => [t, ...m]));
    }
    return midi;
  }
  it('een slag: noot aan na twee frames boven de drempel, velocity uit de stijging, uit onder de loslaatdrempel', () => {
    const m = speel([[0, 0], [1, 400], [2, 1200], [3, 1500], [4, 150], [5, 90]]);
    expect(m).toEqual([[2, 0x90, 48, Math.round((127 * 1200) / 1500)], [5, 0x80, 48, 0]]);
  });
  it('één frame boven de drempel is een hapering: geen noot', () => {
    expect(speel([[0, 0], [1, 900], [2, 0], [3, 0]])).toEqual([]);
  });
  it('tussen los en drempel blijft een pad aan (hysterese) en gaat een pad niet aan', () => {
    expect(speel([[0, 0], [1, 150], [2, 190], [3, 150]])).toEqual([]);
    const m = speel([[0, 0], [1, 300], [2, 300], [3, 150], [4, 120], [5, 99]]);
    expect(m.map((x) => x[1])).toEqual([0x90, 0x80]);
    expect(m[1][0]).toBe(5);
  });
  it('velocity: zacht is klein, hard is 127, nooit 0', () => {
    expect(speel([[0, 190], [1, 200], [2, 200]])[0][3]).toBe(1);
    expect(speel([[0, 0], [1, 3000], [2, 4095]])[0][3]).toBe(127);
  });
  it('aftertouch: alleen bij verandering, hooguit aftertouch_hz keer per seconde per pad', () => {
    const m = speel([[0, 0], [1, 2000], [2, 2000], [10, 3000], [40, 3000], [50, 3000], [100, 3000], [140, 4095], [141, 4095], [200, 50]]);
    expect(m).toEqual([
      [2, 0x90, 48, 127],
      [40, 0xa0, 48, Math.round((3000 / 4095) * 127)],
      [140, 0xa0, 48, 127],
      [200, 0x80, 48, 0],
    ]);
  });
  it('padsBezig: alleen frames waarin iets gebeurt horen in het logboek', () => {
    expect(MS.padsBezig(MS.nieuwePadStaten(), 100)).toBe(false);
    const r = MS.padsStap(MS.nieuwePadStaten(), padFrame([0, 0, 500]), 0, INST);
    expect(MS.padsBezig(r.staten, 100)).toBe(true);
  });
  it('elke pad op zijn eigen noot', () => {
    let staten = MS.nieuwePadStaten();
    const noten = [];
    for (let plek = 0; plek < 16; plek++) {
      for (const p of [0, 900, 900, 0]) {
        const r = MS.padsStap(staten, padFrame(Array.from({ length: 16 }, (_, s) => (s === plek ? p : 0))), 0, INST);
        staten = r.staten;
        noten.push(...r.midi.filter((x) => x[0] === 0x90).map((x) => x[1]));
      }
    }
    expect(noten).toEqual(Array.from({ length: 16 }, (_, plek) => 35 + MS.padVanPlek(plek)));
  });
});

describe('Maschine MK2: lampjes en schermen maken', () => {
  it('pad-lampje: velocity = APC-paletindex → R,G,B op de plek van de pad in 0x80', () => {
    const L = new MS.MaschineLeds();
    expect(L.midi([0x90, MS.padNoot(13), 5])).toBe(true);
    const [r80] = L.rapporten();
    expect(r80).toHaveLength(49);
    expect(r80[0]).toBe(0x80);
    expect(r80.slice(1, 4)).toEqual(rgb(PALET[5]));
    expect(L.midi([0x80, MS.padNoot(13), 0])).toBe(true);
    expect(L.rapporten()[0].slice(1, 4)).toEqual([0, 0, 0]);
  });
  it('groepknop: paletkleur op beide zones (0x81); andere knoppen: helderheid (0x82), transport in 0x81', () => {
    const L = new MS.MaschineLeds();
    L.midi([0x91, MS.KNOP_NR.get('groepB'), 45]);
    L.midi([0x91, MS.KNOP_NR.get('control'), 127]);
    L.midi([0x91, MS.KNOP_NR.get('f8'), 64]);
    L.midi([0x91, MS.KNOP_NR.get('play'), 127]);
    const r = Object.fromEntries(L.rapporten().map((x) => [x[0], x]));
    expect(Object.keys(r).map(Number).sort()).toEqual([0x80, 0x81, 0x82]);
    expect(r[0x81]).toHaveLength(57);
    expect(r[0x81].slice(7, 13)).toEqual([...rgb(PALET[45]), ...rgb(PALET[45])]);
    expect(r[0x81][49 + 4]).toBe(255);
    expect(r[0x82]).toHaveLength(32);
    expect(r[0x82][1]).toBe(255);
    expect(r[0x82][1 + 15]).toBe(Math.round((64 * 255) / 127));
  });
  it('het masterwiel en CC hebben geen lampje', () => {
    const L = new MS.MaschineLeds();
    expect(L.midi([0x91, MS.KNOP_NR.get('wiel'), 127])).toBe(false);
    expect(L.midi([0xb0, 16, 1])).toBe(false);
    expect(L.midi([0x92, 36, 1])).toBe(false);
  });
  it('alleen wat veranderde gaat weer de draad op; vergeet() = alles', () => {
    const L = new MS.MaschineLeds();
    expect(L.rapporten()).toHaveLength(3);
    expect(L.rapporten()).toHaveLength(0);
    L.midi([0x90, 40, 21]);
    expect(L.rapporten().map((x) => x[0])).toEqual([0x80]);
    L.vergeet();
    expect(L.rapporten()).toHaveLength(3);
  });
  it('led_max schaalt (de proef meet of 127 het felste is)', () => {
    const L = new MS.MaschineLeds({ led_max: 127 });
    L.midi([0x91, MS.KNOP_NR.get('control'), 127]);
    L.zetPad(1, [255, 0, 128]);
    const r = Object.fromEntries(L.rapporten().map((x) => [x[0], x]));
    expect(r[0x82][1]).toBe(127);
    expect(r[0x80].slice(1 + 3 * MS.plekVanPad(1), 4 + 3 * MS.plekVanPad(1))).toEqual([127, 0, 64]);
  });
  it('scherm: 8 stukken van 9 + 256 bytes, kop met de beginrij', () => {
    const b = MS.leegScherm();
    MS.zetPixel(b, 0, 0);
    MS.zetPixel(b, 255, 63);
    MS.zetPixel(b, 9, 8);
    const r = MS.schermRapporten(1, b);
    expect(r).toHaveLength(8);
    expect(r.every((x) => x.length === 265)).toBe(true);
    expect(r[3].slice(0, 9)).toEqual([0xe1, 0, 0, 24, 0, 0x20, 0, 0x08, 0]);
    expect(r[0][9]).toBe(0x80);
    expect(r[1][9 + 1]).toBe(0x40);
    expect(r[7][264]).toBe(0x01);
    expect(MS.schermRapporten(0, b)[0][0]).toBe(0xe0);
  });
  it('testbeelden hebben een rand en verschillen', () => {
    const s = MS.testbeeld('schaak'), t = MS.testbeeld('strepen');
    expect(s).toHaveLength(2048);
    expect(s[0] & 0x80).toBe(0x80);
    expect(t[32 * 63 + 31] & 0x01).toBe(0x01);
    expect([...s]).not.toEqual([...t]);
  });
});
