// @ts-check
// Golf 2, cockpit: de virtuele APC en de waardeweergave volgen de echte apparaten.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { weergave } from '../ui/led.js';
import { toonWaarde } from '../ui/opmaak.js';
import { PALET } from '../src/devices/apc40mk2.js';
import { leesParamsH, sedimentManifest } from '../tools/genereer-manifesten.mjs';

describe('virtuele APC: Clip Stop knippert', () => {
  it('op 1/8 noot, net als de hardware (protocol 0x34: "Blinking rate will sync to TEMPO at 1/8")', () => {
    const stop = weergave({ id: 'stop1', led: 'clipstop' }, { knipper: true }, PALET, 120);
    const rgb18 = weergave({ id: 'pad1-1', led: 'rgb' }, { kleur: 5, anim: { soort: 'knipper', snelheid: 2 } }, PALET, 120);
    expect(stop.anim).toBe('knipper');
    expect(stop.duur).toBeCloseTo(0.25, 6); // 1/8 noot bij 120 bpm
    expect(stop.duur).toBeCloseTo(rgb18.duur, 6);
    expect(weergave({ id: 'stop1', led: 'clipstop' }, { knipper: true }, PALET, 60).duur).toBeCloseTo(0.5, 6);
  });
});

describe('cockpit toont waarden zoals de app (skew)', () => {
  it('toonWaarde volgt JUCE setSkewForCentre als het manifest een centre geeft', () => {
    const cutoff = { soort: /** @type {const} */ ('waarde'), min: 30, max: 18000, centre: 1000, eenheid: 'Hz' };
    expect(toonWaarde(cutoff, 0.5)).toBe('1000 Hz');
    expect(toonWaarde(cutoff, 0)).toBe('30 Hz');
    expect(toonWaarde(cutoff, 1)).toBe('18000 Hz');
    // zonder centre (of met een onbruikbare) blijft het lineair
    expect(toonWaarde({ soort: 'waarde', min: 20, max: 2000, eenheid: 'Hz' }, 0.5)).toBe('1010 Hz');
    expect(toonWaarde({ soort: 'waarde', min: 20, max: 2000, centre: -1, eenheid: 'Hz' }, 0.5)).toBe('1010 Hz');
  });

  it('gegenereerd Sediment-manifest: standaardwaarden tonen wat Sediment toont', () => {
    const tekst = `specs {{
    { "cutoff", "Cutoff", "Cutoff", 30.0f, 18000.0f, 1400.0f, 1000.0f, Unit::Hz, Group::Filter },
    { "rate", "Motion Rate", "Rate", 0.01f, 4.0f, 0.07f, 0.2f, Unit::Hz, Group::Filter },
    { "attack", "Attack", "Attack", 0.005f, 20.0f, 2.0f, 1.5f, Unit::Seconds, Group::Envelope },
    { "echoMix", "Echo Mix", "Mix", 0.0f, 1.0f, 0.18f, -1.0f, Unit::Percent, Group::Echo },
}};`;
    const m = sedimentManifest(leesParamsH(tekst), { naam: 'Sediment' });
    const toon = (/** @type {string} */ id) => { const p = m.params.find((x) => x.id === id); return toonWaarde(p, p.standaard); };
    expect(toon('cutoff')).toBe('1400 Hz');
    expect(toon('rate')).toBe('0.07 Hz');
    expect(toon('attack')).toBe('2.0 s');
    expect(toon('echo_mix')).toBe('18 %');
    expect(m.params.find((x) => x.id === 'echo_mix')).not.toHaveProperty('centre');
  });

  it('apps/sediment.json: alle standaardwaarden kloppen met Params.h', () => {
    const m = JSON.parse(readFileSync(new URL('../apps/sediment.json', import.meta.url), 'utf8'));
    /** @type {Record<string, string>} */
    const verwacht = {
      cutoff: '1400 Hz', rate: '0.07 Hz', attack: '2.0 s', decay: '4.0 s', release: '7.0 s',
      echo_time: '520 ms', space_decay: '9.0 s',
    };
    for (const [id, tekst] of Object.entries(verwacht)) {
      const p = m.params.find((/** @type {any} */ x) => x.id === id);
      expect(toonWaarde(p, p.standaard), id).toBe(tekst);
    }
  });
});
