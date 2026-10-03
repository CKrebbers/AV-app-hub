import { describe, it, expect } from 'vitest';
import { NepKlok } from '../src/core/klok.js';
import { Wachtrij } from '../src/core/wachtrij.js';
import { LedBeeld } from '../src/core/leds.js';
import { Logboek, leesLogboek } from '../src/core/logboek.js';
import { zoekNaam } from '../src/ports/poort.js';
import * as A from '../src/devices/apc40mk2.js';

describe('wachtrij', () => {
  it('stuurt 16 berichten per 4 ms', () => {
    const klok = new NepKlok(), uit = [];
    const w = new Wachtrij({ klok, stuur: (b) => uit.push([klok.nu(), b]) });
    for (let i = 0; i < 40; i++) w.zet([0x90, i, 1]);
    klok.loop(0); expect(uit).toHaveLength(16);
    klok.loop(4); expect(uit).toHaveLength(32);
    klok.loop(4); expect(uit).toHaveLength(40);
    expect(uit.map(([, b]) => b[1])).toEqual([...Array(40).keys()]);
  });
  it('leeg() belooft wanneer alles weg is, wis() gooit de rest weg', async () => {
    const klok = new NepKlok(), uit = [];
    const w = new Wachtrij({ klok, stuur: (b) => uit.push(b) });
    for (let i = 0; i < 20; i++) w.zet([i]);
    let klaar = false; w.leeg().then(() => { klaar = true; });
    klok.loop(0); await Promise.resolve(); expect(klaar).toBe(false);
    w.wis(); await Promise.resolve(); expect(klaar).toBe(true);
    expect(uit).toHaveLength(16);
  });
  it('spoel() stuurt alles meteen', () => {
    const klok = new NepKlok(), uit = [];
    const w = new Wachtrij({ klok, stuur: (b) => uit.push(b) });
    for (let i = 0; i < 50; i++) w.zet([i]);
    w.spoel(); expect(uit).toHaveLength(50);
  });
});

describe('LED-beeld', () => {
  const beeld = () => new LedBeeld({ controls: A.CONTROLS, berichten: A.ledBerichten });
  it('stuurt alleen wijzigingen', () => {
    const l = beeld();
    l.zet('pad1-1', { kleur: 5 });
    expect(l.wijzigingen()).toEqual([[0x90, 0, 5]]);
    expect(l.wijzigingen()).toEqual([]);
    l.zet('pad1-1', { kleur: 5 }); expect(l.wijzigingen()).toEqual([]);
    l.zet('pad1-1', { kleur: 6 }); expect(l.wijzigingen()).toEqual([[0x90, 0, 6]]);
  });
  it('vergeet() → volledige repaint', () => {
    const l = beeld(); l.zwart(); l.wijzigingen();
    l.vergeet();
    expect(l.wijzigingen()).toHaveLength(125);
  });
  it('weigert onbekende ids', () => expect(() => beeld().zet('pad9-9', {})).toThrow());
});

describe('logboek', () => {
  it('schrijft kop + regels en leest ze terug', () => {
    const klok = new NepKlok(), regels = [];
    const lb = new Logboek({ klok, schrijf: (r) => regels.push(r), kop: { soort: 'test' } });
    klok.loop(12.34); lb.midi('in', 'apc40', [0x90, 1, 127]);
    lb.regel('stap', { id: 'x' });
    const { kop, regels: r } = leesLogboek(regels.join('\n'));
    expect(kop).toEqual({ v: 1, soort: 'test' });
    expect(r[0]).toEqual([12.3, 'in', 'apc40', [0x90, 1, 127]]);
    expect(r[1]).toMatchObject({ e: 'stap', id: 'x' });
  });
});

describe('poortnamen', () => {
  it('vindt de APC op macOS en Linux, slaat virtuele poorten over', () => {
    expect(zoekNaam({ ingangen: ['IAC Driver Bus 1', 'APC40 mkII'], uitgangen: ['APC40 mkII'] }, /apc40/i)).toBe('APC40 mkII');
    expect(zoekNaam({ ingangen: ['APC40 mkII:APC40 mkII MIDI 1 24:0'], uitgangen: ['APC40 mkII:APC40 mkII MIDI 1 24:0'] }, /apc40/i)).toBe('APC40 mkII:APC40 mkII MIDI 1 24:0');
    expect(zoekNaam({ ingangen: ['VARVE-HUB APC40'], uitgangen: ['VARVE-HUB APC40'] }, /apc40/i)).toBe(null);
    expect(zoekNaam({ ingangen: ['LPD8'], uitgangen: [] }, /lpd8/i)).toBe(null);
  });
});
