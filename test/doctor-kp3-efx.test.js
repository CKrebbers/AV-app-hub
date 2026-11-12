// doctor (src/doctor.js) toont de KP3+ en de EFX-500: gevonden of niet (achter een USB-MIDI-interface), de ingestelde
// CC's van de KP3+, en van de EFX even de klok (tikken, BPM). Niets wordt naar de apparaten gestuurd.
import { describe, it, expect } from 'vitest';
import { doctor } from '../src/doctor.js';
import { laadConfig } from '../src/config.js';
import { NepSysteem } from '../src/ports/nep.js';

const basis = laadConfig();
const config = { ...basis, apparaten: { ...basis.apparaten, kp3plus: { ...basis.apparaten.kp3plus, poort_patroon: 'interface midi 1' }, efx500: { ...basis.apparaten.efx500, poort_patroon: 'interface midi 2' } } };
/** @param {NepSysteem} midi @param {any} [c] */
const draai = (midi, c = config) => doctor({ config: c, laadMidi: async () => ({ systeem: midi }), laadHid: async () => ({ systeem: null, reden: 'x' }), niProgrammas: () => [], wachtMs: 200, hubDraait: async () => false });

describe('doctor: KP3+ en EFX-500', () => {
  it('niets aangesloten: allebei niet gevonden, met wat te doen; geen fout', async () => {
    const { tekst, data } = await draai(new NepSysteem(), basis);
    expect(tekst).toMatch(/✗ kp3plus \(KP3\+\): niet gevonden — geen MIDI-ingang past op "kp3\|kaoss".*apparaten\.kp3plus\.poort_patroon/);
    expect(tekst).toMatch(/✗ efx500 \(EFX-500\): niet gevonden/);
    expect(tekst).toMatch(/X CC 12 · Y CC 13 · aanraken CC 92 · kanaal elk · XY → alfabet\.vervorming \/ alfabet\.ruimte/);
    expect(data.kp3plus).toMatchObject({ naam: null, patroon: 'kp3|kaoss' });
    expect(data.efx500).toEqual({ naam: null, patroon: 'efx|pioneer' });
  }, 15000);

  it('zonder poort_patroon: doet niet mee', async () => {
    const { tekst } = await draai(new NepSysteem(), { ...basis, apparaten: { ...basis.apparaten, kp3plus: {}, efx500: {} } });
    expect(tekst).toMatch(/- kp3plus: niet in config\.json/);
    expect(tekst).toMatch(/- efx500: niet in config\.json/);
  }, 15000);

  it('gevonden achter de interface; van de EFX telt doctor de klok en meet het tempo (250 BPM: elke 10 ms een tik)', async () => {
    const midi = new NepSysteem();
    midi.voegToe('USB MIDI Interface MIDI 1', { uitgang: false });
    const efx = midi.voegToe('USB MIDI Interface MIDI 2', { uitgang: false });
    // Tikken op vaste tijdstippen (niet elke keer 10 ms ná de vorige: dan loopt het uit).
    const t0 = performance.now();
    let i = 0;
    const volgende = () => { if (i > 60) return; efx.injecteer([0xf8]); i++; setTimeout(volgende, Math.max(0, t0 + 50 + i * 10 - performance.now())); };
    setTimeout(volgende, 50);
    const { tekst, data } = await draai(midi);
    expect(tekst).toMatch(/✔ kp3plus \(KP3\+\): USB MIDI Interface MIDI 1/);
    expect(tekst).toMatch(/✔ efx500 \(EFX-500\): USB MIDI Interface MIDI 2/);
    expect(efx.opties).toEqual({ alleenIngang: true, metKlok: true });
    expect(efx.verstuurd).toEqual([]);
    expect(data.efx500.tikken).toBeGreaterThan(30);
    expect(data.efx500.bpm).toBeGreaterThan(235);
    expect(data.efx500.bpm).toBeLessThan(265);
    expect(tekst).toMatch(/kloktikken in .* s · \d+(\.\d)? BPM/);
  }, 15000);

  it('de EFX zonder klok (geen muziek op de ingang): zeg dat', async () => {
    const midi = new NepSysteem();
    midi.voegToe('USB MIDI Interface MIDI 2', { uitgang: false });
    const { tekst } = await draai(midi);
    expect(tekst).toMatch(/geen klok in .* s — staat er muziek op de ingang/);
  }, 15000);
});
