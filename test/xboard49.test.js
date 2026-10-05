// Het Xboard49-profiel (src/devices/xboard49.js): puur, zonder keyboard.
import { describe, it, expect } from 'vitest';
import * as XB from '../src/devices/xboard49.js';

const ontleed = XB.maakOntleder(XB.standaardProfiel());

describe('Xboard49: herkennen', () => {
  it('het naampatroon komt uit config.json (apparaten.xboard49.naam); zonder sleutel doet hij niet mee', () => {
    const p = XB.patroon({ apparaten: { xboard49: { naam: 'xboard' } } });
    expect(p.test('E-MU Xboard49')).toBe(true);
    expect(p.test('APC40 mkII')).toBe(false);
    expect(XB.patroon({ apparaten: {} })).toBe(null);
    expect(XB.patroon({ apparaten: { xboard49: { naam: '  ' } } })).toBe(null);
  });
});

describe('Xboard49: invoer ontleden', () => {
  it('noten met velocity, ook note-on met velocity 0 als loslaten', () => {
    expect(ontleed([0x90, 60, 100])).toEqual({ dev: 'xboard49', el: 'noot', kind: 'druk', noot: 60, ch: 0, v: 100 / 127, raw: 100 });
    expect(ontleed([0x90, 60, 0])).toMatchObject({ el: 'noot', kind: 'los', noot: 60 });
    expect(ontleed([0x83, 61, 64])).toMatchObject({ el: 'noot', kind: 'los', ch: 3 });
  });
  it('kanaal-aftertouch, polyfone aftertouch, pitchbend (midden = 8192), programma', () => {
    expect(ontleed([0xd0, 90])).toMatchObject({ el: 'aftertouch', kind: 'waarde', raw: 90 });
    expect(ontleed([0xa0, 60, 30])).toMatchObject({ el: 'polydruk', noot: 60, raw: 30 });
    expect(ontleed([0xe0, 0, 64])).toMatchObject({ el: 'buiging', raw: 8192 });
    expect(ontleed([0xe0, 127, 127])).toMatchObject({ el: 'buiging', v: 1 });
    expect(ontleed([0xc0, 5])).toMatchObject({ el: 'programma', kind: 'keuze', raw: 5 });
  });
  it('vaste CC\'s: modulatie, pedaal (druk vanaf 64), bank select, paniek (120/123)', () => {
    expect(ontleed([0xb0, 1, 127])).toMatchObject({ el: 'mod', v: 1 });
    expect(ontleed([0xb0, 64, 127])).toMatchObject({ el: 'sustain', kind: 'druk' });
    expect(ontleed([0xb0, 64, 10])).toMatchObject({ el: 'sustain', kind: 'los' });
    expect(ontleed([0xb0, 0, 1])).toMatchObject({ el: 'bank', cc: 0 });
    expect(ontleed([0xb0, 32, 2])).toMatchObject({ el: 'bank', cc: 32 });
    expect(ontleed([0xbf, 123, 0])).toMatchObject({ el: 'paniek', kind: 'paniek', ch: 15, cc: 123 });
    expect(ontleed([0xb0, 120, 0])).toMatchObject({ el: 'paniek', cc: 120 });
  });
  it('de 16 knoppen: tot de proef ze leert de gok van Ardour (21–28, 31–38)', () => {
    expect(ontleed([0xb0, 21, 10])).toMatchObject({ el: 'k1', kind: 'waarde', raw: 10 });
    expect(ontleed([0xb0, 28, 10])).toMatchObject({ el: 'k8' });
    expect(ontleed([0xb0, 31, 10])).toMatchObject({ el: 'k9' });
    expect(ontleed([0xb0, 38, 10])).toMatchObject({ el: 'k16' });
    expect(ontleed([0xb0, 50, 10])).toMatchObject({ el: null, kind: 'onbekend' });
  });
  it('een geleerd profiel (met kanaal) gaat voor', () => {
    const o = XB.maakOntleder({ bron: 'geleerd', knoppen: [{ n: 102, ch: 0 }, { n: 102, ch: 1 }] });
    expect(o([0xb0, 102, 5])).toMatchObject({ el: 'k1' });
    expect(o([0xb1, 102, 5])).toMatchObject({ el: 'k2' });
    expect(o([0xb0, 21, 5]).el).toBe(null);
  });
  it('NRPN-berichten herkennen we als nrpn (een knop in NRPN-modus)', () => {
    expect(ontleed([0xb0, 99, 1])).toMatchObject({ el: 'nrpn', cc: 99 });
    expect(ontleed([0xb0, 6, 64])).toMatchObject({ el: 'nrpn', cc: 6 });
  });
  it('de schuif: SysEx Master Volume F0 7F <dev> 04 01 ll mm F7 (14 bit)', () => {
    expect(ontleed([0xf0, 0x7f, 0x7f, 0x04, 0x01, 0, 0, 0xf7])).toMatchObject({ el: 'schuif', kind: 'waarde', v: 0, raw: 0 });
    expect(ontleed([0xf0, 0x7f, 0x00, 0x04, 0x01, 0x7f, 0x7f, 0xf7])).toMatchObject({ el: 'schuif', v: 1 });
    expect(ontleed([0xf0, 0x7f, 0x7f, 0x04, 0x01, 0, 0x40, 0xf7]).raw).toBe(8192);
    expect(XB.isMasterVolume([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7])).toBe(false);
    expect(ontleed([0xf0, 0x7e, 0x7f, 0x06, 0x02, 0xf7]).kind).toBe('onbekend');
  });
});

describe('Xboard49: knoppen leren', () => {
  it('een CC wordt een knop; noten en de vaste CC\'s niet; een NRPN-kiezer zegt nrpn', () => {
    expect(XB.knopUitBericht([0xb2, 74, 3])).toEqual({ n: 74, ch: 2 });
    expect(XB.knopUitBericht([0x90, 60, 3])).toBe(null);
    for (const cc of [0, 1, 32, 64, 120, 123]) expect(XB.knopUitBericht([0xb0, cc, 3])).toBe(null);
    expect(XB.knopUitBericht([0xb0, 99, 3])).toEqual({ n: 99, ch: 0, nrpn: true });
  });
});
