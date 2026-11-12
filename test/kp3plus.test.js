// @ts-check
// De KP3+ als gebaar (src/devices/kp3plus.js, PROTOCOL §21): ontleden, het gebaar {x, y, aan}, en welke parameter
// een as stuurt. Alle CC-nummers hier zijn de gok uit de bronnen (12/13/92), niet gemeten: daarom configureerbaar.
import { describe, it, expect } from 'vitest';
import * as K from '../src/devices/kp3plus.js';

const inst = K.instellingen({});

describe('kp3plus: herkennen en instellingen', () => {
  it('doet alleen mee met een poort_patroon in config.json; een kapotte regex telt als tekst', () => {
    expect(K.patroon({})).toBe(null);
    expect(K.patroon({ apparaten: { kp3plus: { poort_patroon: '' } } })).toBe(null);
    expect(K.patroon({ apparaten: { kp3plus: { poort_patroon: 'kp3|kaoss' } } })?.test('KAOSS PAD MIDI 1')).toBe(true);
    expect(K.patroon({ apparaten: { kp3plus: { poort_patroon: 'UM-ONE(' } } })?.test('UM-ONE(x')).toBe(true);
  });
  it('standaard: X CC 12, Y CC 13, aanraken CC 92, elk kanaal, XY = vervorming/ruimte, geen hold', () => {
    expect(inst).toEqual({ kanaal: null, cc: { x: 12, y: 13, aanraak: 92, diepte: null, hold: null }, xy: { x: 'alfabet.vervorming', y: 'alfabet.ruimte' }, hold: false });
  });
  it('alles is te overschrijven; kanaal 1..16 zoals op het display; een CC null = niet toegewezen', () => {
    const i = K.instellingen({ apparaten: { kp3plus: { kanaal: 11, cc: { x: 70, y: 71, aanraak: null, diepte: 94, hold: 95 }, xy: { x: 'zoom', y: 'macro.ruimte' }, hold: true } } });
    expect(i).toEqual({ kanaal: 10, cc: { x: 70, y: 71, aanraak: null, diepte: 94, hold: 95 }, xy: { x: 'zoom', y: 'macro.ruimte' }, hold: true });
    expect(K.instellingen({ apparaten: { kp3plus: { kanaal: 0, cc: { x: 300 }, xy: { x: 'Foute Naam' } } } })).toMatchObject({ kanaal: null, cc: { x: 12 }, xy: { x: 'alfabet.vervorming' } });
  });
});

describe('kp3plus: ontleden', () => {
  const o = K.maakOntleder(inst);
  it('X, Y en aanraken', () => {
    expect(o([0xb0, 12, 127])).toEqual({ dev: 'kp3plus', el: 'x', kind: 'waarde', v: 1, raw: 127, ch: 0 });
    expect(o([0xba, 13, 0])).toEqual({ dev: 'kp3plus', el: 'y', kind: 'waarde', v: 0, raw: 0, ch: 10 });
    expect(o([0xb0, 92, 127])).toMatchObject({ el: 'aanraak', kind: 'druk' });
    expect(o([0xb0, 92, 0])).toMatchObject({ el: 'aanraak', kind: 'los' });
  });
  it('een programmageheugen (Program Change) wordt p<nr> (effectprogramma + 1)', () => {
    expect(o([0xc0, 4])).toEqual({ dev: 'kp3plus', el: 'p5', kind: 'druk', nr: 5, raw: 4, ch: 0 });
  });
  it('onbekende CC, noten en een ander kanaal dan gekozen: onbekend met de bytes (de proef ziet ze)', () => {
    expect(o([0xb0, 50, 3])).toEqual({ dev: 'kp3plus', el: null, kind: 'onbekend', bytes: [0xb0, 50, 3] });
    expect(o([0x90, 36, 100])).toMatchObject({ kind: 'onbekend' });
    const alleen11 = K.maakOntleder(K.instellingen({ apparaten: { kp3plus: { kanaal: 11 } } }));
    expect(alleen11([0xb0, 12, 64])).toMatchObject({ kind: 'onbekend' });
    expect(alleen11([0xba, 12, 64])).toMatchObject({ el: 'x' });
    expect(o([0xf8])).toEqual({ dev: 'kp3plus', el: 'klok', kind: 'tik' });
  });
  it('FX-depth en hold alleen als ze een CC hebben', () => {
    const met = K.maakOntleder(K.instellingen({ apparaten: { kp3plus: { cc: { diepte: 94, hold: 95 } } } }));
    expect(met([0xb0, 94, 127])).toMatchObject({ el: 'diepte', kind: 'waarde', v: 1 });
    expect(met([0xb0, 95, 127])).toMatchObject({ el: 'hold', kind: 'druk' });
    expect(o([0xb0, 94, 127])).toMatchObject({ kind: 'onbekend' });
  });
});

describe('kp3plus: het gebaar {x, y, aan}', () => {
  const o = K.maakOntleder(inst);
  /** @param {number[][]} reeks */
  const speel = (reeks) => {
    let staat = K.nieuwGebaar();
    const uit = [];
    for (const b of reeks) { const r = K.gebaarStap(staat, o(b)); staat = r.staat; if (r.gebaar) uit.push(r.gebaar); }
    return uit;
  };
  it('aanraken, bewegen, loslaten', () => {
    expect(speel([[0xb0, 92, 127], [0xb0, 12, 127], [0xb0, 13, 0], [0xb0, 92, 0]])).toEqual([
      { x: null, y: null, aan: true }, { x: 1, y: null, aan: true }, { x: 1, y: 0, aan: true }, { x: 1, y: 0, aan: false },
    ]);
  });
  it('bewegen zonder aanraak-CC telt als aanraken (een KP3+ zonder toegewezen touch-CC)', () => {
    expect(speel([[0xb0, 13, 64]])).toEqual([{ x: null, y: 64 / 127, aan: true }]);
  });
  it('dubbel aanraken of loslaten geeft geen nieuw gebaar; andere berichten ook niet', () => {
    expect(speel([[0xb0, 92, 127], [0xb0, 92, 127], [0xb0, 50, 1], [0xc0, 1], [0xb0, 92, 0], [0xb0, 92, 0]]).map((g) => g.aan)).toEqual([true, false]);
  });
});

describe('kp3plus: welke parameter een as stuurt', () => {
  const manifest = { params: [
    { id: 'vorm', soort: 'waarde', rol: 'alfabet.vervorming' },
    { id: 'galm', soort: 'waarde' },
    { id: 'flits', soort: 'trigger', rol: 'alfabet.ruimte' },
  ] };
  it('eerst op rol, dan op id; triggers tellen niet', () => {
    expect(K.asDoel(manifest, 'alfabet.vervorming')).toBe('vorm');
    expect(K.asDoel(manifest, 'galm')).toBe('galm');
    expect(K.asDoel(manifest, 'alfabet.ruimte')).toBe(null);
    expect(K.asDoel(null, 'galm')).toBe(null);
  });
  it('maps/<app>.json gaat voor het manifest, dat voor config.json; per as', () => {
    const std = { x: 'alfabet.vervorming', y: 'alfabet.ruimte' };
    expect(K.xyVoor(null, null, std)).toEqual(std);
    expect(K.xyVoor(null, { x: 'galm' }, std)).toEqual({ x: 'galm', y: 'alfabet.ruimte' });
    expect(K.xyVoor({ y: 'vorm' }, { x: 'galm', y: 'galm' }, std)).toEqual({ x: 'galm', y: 'vorm' });
    expect(K.xyVoor({ x: 'Niet Geldig' }, null, std)).toEqual(std);
  });
});
