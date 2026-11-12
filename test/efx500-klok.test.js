// @ts-check
// MIDI-klok → BPM (src/core/klokbron.js) en het EFX-500-profiel (src/devices/efx500.js), PROTOCOL §20.
import { describe, it, expect } from 'vitest';
import { KlokMeter, meetBpm, spreiding, PPQN } from '../src/core/klokbron.js';
import * as E from '../src/devices/efx500.js';

/** Tijdstippen van n tikken op een tempo, met optionele jitter (deterministisch). @param {number} bpm @param {number} n @param {number} [jitter] ms */
function tikken(bpm, n, jitter = 0, start = 1000) {
  const d = 60000 / (PPQN * bpm);
  return Array.from({ length: n }, (_, i) => start + i * d + (jitter ? Math.sin(i * 12.9898) * jitter : 0));
}

describe('KlokMeter', () => {
  it('120 BPM: na één tel (24 intervallen) precies 120', () => {
    const m = new KlokMeter();
    const gezien = tikken(120, 25).map((t) => m.tik(t)).filter((x) => x !== null);
    expect(gezien).toEqual([120]);
    expect(m.bpm).toBe(120);
  });
  it('minder dan één tel: nog geen tempo', () => {
    const m = new KlokMeter();
    for (const t of tikken(128, 24)) m.tik(t);
    expect(m.bpm).toBe(null);
  });
  it('jitter van ±2 ms per tik (USB, ALSA): stabiel binnen ±0,2 BPM, geen geflapper', () => {
    const m = new KlokMeter();
    /** @type {{ i: number, b: number }[]} */
    const uit = [];
    tikken(124, 24 * 32, 2).forEach((t, i) => { const b = m.tik(t); if (b !== null) uit.push({ i, b }); });
    expect(Math.abs(/** @type {number} */ (m.bpm) - 124)).toBeLessThanOrEqual(0.2);
    // Na een vol venster (96 intervallen) blijft het getoonde tempo binnen ±0,2 en springt het nooit heen en terug.
    const na = uit.filter((x) => x.i > 96).map((x) => x.b);
    for (const b of na) expect(Math.abs(b - 124)).toBeLessThanOrEqual(0.2);
    for (let k = 2; k < na.length; k++) expect(na[k]).not.toBe(na[k - 2]);
    expect(na.length).toBeLessThanOrEqual(2);
  });
  it('één late tik (een hapering) trekt het tempo niet scheef', () => {
    const t = tikken(120, 100);
    t[60] += 15;   // één tik 15 ms te laat
    const m = new KlokMeter();
    for (const x of t) m.tik(x);
    expect(m.bpm).toBe(120);
  });
  it('een tempowissel (TAP op de EFX) volgt binnen het venster', () => {
    const m = new KlokMeter();
    const a = tikken(120, 120);
    const b = tikken(90, 120, 0, a[a.length - 1] + 60000 / (PPQN * 90));
    for (const x of [...a, ...b]) m.tik(x);
    expect(m.bpm).toBe(90);
  });
  it('een gat > wegMs: opnieuw meten; loopt() zegt of hij nog tikt; het laatste tempo blijft bewaard', () => {
    const m = new KlokMeter({ wegMs: 2000 });
    const a = tikken(120, 30);
    for (const x of a) m.tik(x);
    const eind = a[a.length - 1];
    expect(m.loopt(eind + 1999)).toBe(true);
    expect(m.loopt(eind + 2001)).toBe(false);
    expect(m.tik(eind + 5000)).toBe(null);
    expect(m.intervallen).toEqual([]);
    expect(m.bpm).toBe(120);
  });
  it('40 en 250 BPM (het bereik van de EFX-500); onzin daarbuiten levert niets', () => {
    for (const bpm of [40, 250]) { const m = new KlokMeter(); for (const t of tikken(bpm, 30)) m.tik(t); expect(m.bpm).toBe(bpm); }
    expect(meetBpm([1])).toBe(null);          // 2500 BPM
    expect(meetBpm([500])).toBe(null);        // 5 BPM
  });
  it('spreiding voor de proef', () => {
    expect(spreiding([120, 120.1, 119.9])).toEqual({ min: 119.9, max: 120.1, verschil: 0.2 });
    expect(spreiding([])).toEqual({ min: null, max: null, verschil: null });
  });
});

describe('efx500: profiel', () => {
  it('patroon uit config.json, anders doet hij niet mee', () => {
    expect(E.patroon({})).toBe(null);
    expect(E.patroon({ apparaten: { efx500: { poort_patroon: 'efx|pioneer' } } })?.test('Pioneer EFX')).toBe(true);
  });
  it('klok, start, verder, stop; al het andere onbekend met de bytes (de knoppen: te meten)', () => {
    expect(E.ontleed([0xf8])).toEqual({ dev: 'efx500', el: 'klok', kind: 'tik' });
    expect(E.ontleed([0xfa])).toMatchObject({ el: 'transport', kind: 'start' });
    expect(E.ontleed([0xfb])).toMatchObject({ kind: 'verder' });
    expect(E.ontleed([0xfc])).toMatchObject({ kind: 'stop' });
    expect(E.ontleed([0xb0, 1, 2])).toEqual({ dev: 'efx500', el: null, kind: 'onbekend', bytes: [0xb0, 1, 2] });
  });
  it('instellingen met standaarden', () => {
    expect(E.instellingen({})).toEqual({ wegMs: 2000, venster: 96, stabiel: 0.2 });
    expect(E.instellingen({ apparaten: { efx500: { weg_ms: 3000, venster: 48, stabiel_bpm: 0.5 } } })).toEqual({ wegMs: 3000, venster: 48, stabiel: 0.5 });
    expect(E.instellingen({ apparaten: { efx500: { weg_ms: 'lang' } } }).wegMs).toBe(2000);
  });
});
