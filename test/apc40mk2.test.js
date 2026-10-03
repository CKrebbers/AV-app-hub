import { describe, it, expect } from 'vitest';
import * as A from '../src/devices/apc40mk2.js';

/** Het bericht dat de APC zelf zou sturen voor een control. */
const invoer = (c, waarde = 127) => (c.t === 'note' ? [0x90 | c.ch, c.n, 127] : [0xb0 | c.ch, c.n, waarde]);

describe('APC40 mkII control-map', () => {
  it('heeft 148 controls met unieke ids en unieke MIDI-adressen', () => {
    expect(A.CONTROLS).toHaveLength(148);
    expect(new Set(A.CONTROLS.map((c) => c.id)).size).toBe(148);
    expect(new Set(A.CONTROLS.map((c) => `${c.t}:${c.n}:${c.ch}`)).size).toBe(148);
  });
  it('ontleedt het bericht van elke control terug naar dezelfde control', () => {
    for (const c of A.CONTROLS) expect(A.ontleed(invoer(c)).el, c.id).toBe(c.id);
  });
  it('volgt protocol v1.2 voor de pijlen (av-kern had links/rechts omgedraaid)', () => {
    expect(A.ontleed([0x90, 0x60, 127]).el).toBe('right');
    expect(A.ontleed([0x90, 0x61, 127]).el).toBe('left');
    expect(A.ontleed([0x90, 0x5e, 127]).el).toBe('up');
    expect(A.ontleed([0x90, 0x5f, 127]).el).toBe('down');
  });
  it('grid: rij 1 is onder (note 0), rij 5 boven (note 32-39)', () => {
    expect(A.OP_ID.get('pad1-1').n).toBe(0);
    expect(A.OP_ID.get('pad5-1').n).toBe(32);
    expect(A.OP_ID.get('pad5-8').n).toBe(39);
    expect(A.padId(3, 4)).toBe('pad3-4');
  });
  it('strip-knoppen dragen de track in het kanaal', () => {
    expect(A.ontleed([0x92, 51, 127]).el).toBe('sel3');
    expect(A.ontleed([0xb7, 7, 64])).toMatchObject({ el: 'fader8', kind: 'waarde', raw: 64 });
  });
  it('druk, los en note-on met velocity 0', () => {
    expect(A.ontleed([0x90, 98, 127]).kind).toBe('druk');
    expect(A.ontleed([0x80, 98, 127]).kind).toBe('los');
    expect(A.ontleed([0x90, 98, 0]).kind).toBe('los');
  });
  it('tempo en cue zijn relatief (two\'s complement)', () => {
    expect(A.ontleed([0xb0, 13, 1])).toMatchObject({ el: 'tempo', kind: 'delta', delta: 1 });
    expect(A.ontleed([0xb0, 13, 127]).delta).toBe(-1);
    expect(A.ontleed([0xb0, 47, 64]).delta).toBe(-64);
    expect(A.ontleed([0xb0, 47, 63]).delta).toBe(63);
  });
  it('knoppen en faders geven 0..1', () => {
    expect(A.ontleed([0xb0, 48, 127])).toMatchObject({ el: 'tk1', v: 1 });
    expect(A.ontleed([0xb0, 16, 0])).toMatchObject({ el: 'dk1', v: 0 });
  });
  it('footswitch is druk/los', () => {
    expect(A.ontleed([0xb0, 64, 127])).toMatchObject({ el: 'voet', kind: 'druk' });
    expect(A.ontleed([0xb0, 64, 0])).toMatchObject({ el: 'voet', kind: 'los' });
  });
  it('herkent SysEx: intro-antwoord, identiteit, en onbekend', () => {
    expect(A.ontleed([0xf0, 0x47, 0x7f, 0x29, 0x61, 0x00, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xf7]).kind).toBe('intro-antwoord');
    expect(A.ontleed([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x29, 0xf7]).kind).toBe('identiteit');
    expect(A.ontleed([0xf0, 0x01, 0xf7]).kind).toBe('onbekend');
    expect(A.ontleed([0x90, 120, 127])).toMatchObject({ el: null, kind: 'druk', bytes: [0x90, 120, 127] });
  });
  it('intro zet modus 0x42 standaard', () => {
    expect(A.intro()).toEqual([0xf0, 0x47, 0x7f, 0x29, 0x60, 0x00, 0x04, 0x42, 0, 0, 0, 0xf7]);
    expect(A.intro(A.MODUS.ableton)[7]).toBe(0x41);
  });
});

describe('LED-berichten', () => {
  const c = (id) => A.OP_ID.get(id);
  it('rgb: vaste kleur, uit, en animatie op het juiste kanaal', () => {
    expect(A.ledBerichten(c('pad1-1'), { kleur: 5 })).toEqual([[0x90, 0, 5]]);
    expect(A.ledBerichten(c('pad1-1'), {})).toEqual([[0x80, 0, 0]]);
    expect(A.ledBerichten(c('scene2'), { kleur: 21, anim: { soort: 'puls', snelheid: 3 } })).toEqual([[0x99, 83, 21]]);
    expect(A.ledBerichten(c('pad5-8'), { kleur: 21, anim: { soort: 'knipper', snelheid: 0, kleur2: 5 } })).toEqual([[0x90, 39, 21], [0x9b, 39, 5]]);
    expect(A.ledBerichten(c('pad1-2'), { kleur: 9, anim: { soort: 'oneshot', snelheid: 4 } })).toEqual([[0x95, 1, 9]]);
  });
  it('eenkleurig op het tracekanaal, clipstop kan knipperen, A|B heeft twee kleuren', () => {
    expect(A.ledBerichten(c('sel4'), { aan: true })).toEqual([[0x93, 51, 127]]);
    expect(A.ledBerichten(c('sel4'), { aan: false })).toEqual([[0x83, 51, 0]]);
    expect(A.ledBerichten(c('stop2'), { knipper: true })).toEqual([[0x91, 52, 2]]);
    expect(A.ledBerichten(c('ab1'), { stand: 1 })).toEqual([[0x90, 66, 1]]);
    expect(A.ledBerichten(c('play'), { aan: true })).toEqual([[0x90, 91, 127]]);
  });
  it('ring schrijft de knopwaarde', () => {
    expect(A.ledBerichten(c('tk8'), { waarde: 1 })).toEqual([[0xb0, 55, 127]]);
    expect(A.ledBerichten(c('dk1'), { waarde: 0.5 })).toEqual([[0xb0, 16, 64]]);
  });
  it('controls zonder LED geven niets', () => {
    expect(A.ledBerichten(c('shift'), { aan: true })).toEqual([]);
    expect(A.ledBerichten(c('fader1'), {})).toEqual([]);
  });
  it('ringtypes voor alle 16 ringknoppen op CC 24-31 en 56-63', () => {
    const r = A.ringTypeBerichten(A.RING.volume);
    expect(r).toHaveLength(16);
    expect(r.map((b) => b[1]).sort((a, b) => a - b)).toEqual([24, 25, 26, 27, 28, 29, 30, 31, 56, 57, 58, 59, 60, 61, 62, 63]);
    expect(r.every((b) => b[2] === 2)).toBe(true);
  });
  it('125 controls hebben een LED', () => expect(A.MET_LED).toHaveLength(125));
});

describe('palet', () => {
  it('heeft 128 kleuren uit het protocol', () => {
    expect(A.PALET).toHaveLength(128);
    expect(A.PALET[0]).toBe('#000000');
    expect(A.PALET[5]).toBe('#ff0000');
    expect(A.PALET[21]).toBe('#00ff00');
    expect(A.PALET[45]).toBe('#0000ff');
    expect(A.PALET[120]).toBe('#a00000');
    expect(A.PALET[127]).toBe('#4b1502');
  });
  it('vindt de dichtstbijzijnde kleur, nooit "uit"', () => {
    expect(A.dichtsteKleur('#ff0000')).toBe(5);
    expect(A.dichtsteKleur('#0000ff')).toBe(45);
    expect(A.dichtsteKleur('#000000')).toBeGreaterThan(0);
  });
});
