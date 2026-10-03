import { describe, it, expect } from 'vitest';
import * as L from '../src/devices/lpd8.js';

const mk1Dump = (prog = 1) => {
  const b = [0xf0, 0x47, 0x7f, 0x75, 0x63, 0x00, 0x3a, prog, 0];
  for (let i = 0; i < 8; i++) b.push(36 + i, i, 1 + i, 0);
  for (let i = 0; i < 8; i++) b.push(1 + i, 0, 127);
  b.push(0xf7);
  return b;
};
const mk2Dump = (prog = 1) => {
  const b = [0xf0, 0x47, 0x7f, 0x4c, 0x03, 0x01, 0x29, prog, 0, 0, 0, 0];
  for (let i = 0; i < 8; i++) b.push(36 + i, 12 + i, i, 9, ...Array(12).fill(0));
  for (let i = 0; i < 8; i++) b.push(70 + i, 0, 0, 127);
  b.push(0xf7);
  return b;
};

describe('LPD8 model', () => {
  it('herkent mk1 en mk2 uit identiteit en Akai-SysEx', () => {
    expect(L.modelUit([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x75, 0x00, 0xf7])).toBe('mk1');
    expect(L.modelUit([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x4c, 0x00, 0xf7])).toBe('mk2');
    expect(L.modelUit(mk2Dump())).toBe('mk2');
    expect(L.modelUit([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x29, 0xf7])).toBe(null);
    expect(L.modelUit([0x90, 1, 2])).toBe(null);
  });
  it('vraagt programma\'s op met het juiste model-ID', () => {
    expect(L.vraagProgramma('mk1', 2)).toEqual([0xf0, 0x47, 0x7f, 0x75, 0x63, 0, 1, 2, 0xf7]);
    expect(L.vraagProgramma('mk2', 0)).toEqual([0xf0, 0x47, 0x7f, 0x4c, 0x03, 0, 1, 0, 0xf7]);
  });
});

describe('programma-dumps', () => {
  it('mk1: pads en knoppen', () => {
    const p = L.ontleedProgramma(mk1Dump(3));
    expect(p).toMatchObject({ model: 'mk1', prog: 3, kanaal: 0 });
    expect(p.pads[0]).toEqual({ note: 36, pc: 0, cc: 1, toggle: false });
    expect(p.knoppen[7]).toEqual({ cc: 8, min: 0, max: 127 });
  });
  it('mk2: pads en knoppen', () => {
    const p = L.ontleedProgramma(mk2Dump(1));
    expect(p).toMatchObject({ model: 'mk2', prog: 1 });
    expect(p.pads[7]).toMatchObject({ note: 43, cc: 19, pc: 7, kanaal: 9 });
    expect(p.knoppen[0]).toEqual({ cc: 70, kanaal: 0, min: 0, max: 127 });
  });
  it('onverwachte lengte: fout met ruwe bytes (zodat de proef het vastlegt)', () => {
    const kort = mk2Dump().slice(0, 100).concat(0xf7);
    expect(L.ontleedProgramma(kort)).toMatchObject({ model: 'mk2', fout: expect.stringContaining('lengte') });
  });
  it('profiel uit een programma', () => {
    const pr = L.profielUitProgramma(L.ontleedProgramma(mk2Dump()));
    expect(pr.pads[0]).toEqual({ t: 'note', n: 36 });
    expect(pr.knoppen[3]).toEqual({ n: 73 });
  });
});

describe('ontleder per profiel', () => {
  it('fabrieksprofiel mk2: noten 36-43, CC 70-77', () => {
    const o = L.maakOntleder(L.standaardProfiel('mk2'));
    expect(o([0x99, 36, 100])).toMatchObject({ el: 'p1', kind: 'druk' });
    expect(o([0x89, 43, 0])).toMatchObject({ el: 'p8', kind: 'los' });
    expect(o([0xb0, 77, 64])).toMatchObject({ el: 'k8', kind: 'waarde', raw: 64 });
    expect(o([0xb0, 20, 64]).el).toBe(null);
  });
  it('kanaal telt alleen als het profiel er een noemt', () => {
    const o = L.maakOntleder({ bron: 'test', pads: [{ t: 'note', n: 40, ch: 2 }], knoppen: [] });
    expect(o([0x92, 40, 1]).el).toBe('p1');
    expect(o([0x93, 40, 1]).el).toBe(null);
  });
  it('pads in CC- en PC-modus', () => {
    const o = L.maakOntleder({ bron: 'test', pads: [{ t: 'cc', n: 12 }, { t: 'pc', n: 1 }], knoppen: [] });
    expect(o([0xb0, 12, 127])).toMatchObject({ el: 'p1', kind: 'druk' });
    expect(o([0xb0, 12, 0])).toMatchObject({ el: 'p1', kind: 'los' });
    expect(o([0xc0, 1])).toMatchObject({ el: 'p2', kind: 'druk' });
  });
  it('leren: bron uit een bericht', () => {
    expect(L.bronUitBericht([0x99, 36, 90])).toEqual({ t: 'note', n: 36, ch: 9 });
    expect(L.bronUitBericht([0x99, 36, 0])).toBe(null);
    expect(L.bronUitBericht([0xb1, 70, 3])).toEqual({ t: 'cc', n: 70, ch: 1 });
  });
});
