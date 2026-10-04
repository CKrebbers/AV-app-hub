// Ringknoppen in modus 0x42: een ring-CC zet ook de interne waarde van de knop. De kern moet de knop
// daarom gelijk houden met wat de app kent, ook als het LED-model van het oppervlak "geen verschil" ziet.
import { describe, it, expect } from 'vitest';
import { opzet, opzetApc, meldAan, stuurApp, druk, los, draai, van, leeg, CONFIG, FL, DJ } from './kern-hulp.js';

/** 9 waarden zonder hint: 8 faders + tk1 (w9, standaard 0). */
const TK = { v: 1, app: 'tk-app', naam: 'TK', params: Array.from({ length: 9 }, (_, i) => ({ id: `w${i + 1}`, naam: `W${i + 1}`, soort: 'waarde' })) };

describe('kern: ringknoppen blijven gelijk met de app (modus 0x42)', () => {
  it('gedraaid terwijl de hubtoets is ingedrukt: ring (en knop) terug naar de app-waarde, geen sprong daarna', async () => {
    const { kern, knop, sync, draaiKnop, tikOp } = await opzetApc();
    const fl = meldAan(kern, FL); // dk1 = ruimte 0.4 → 51
    sync();
    expect(knop.get(16)).toBe(51);
    druk(kern, 'bank');
    draaiKnop('dk1', 114);
    los(kern, 'bank');
    sync();
    expect(knop.get(16)).toBe(51);
    leeg(fl);
    tikOp('dk1');
    expect(van(fl, 'zet')).toEqual([{ t: 'zet', id: 'ruimte', v: 52 / 127, bron: 'apc40' }]);
    kern.stop();
  });

  it('ongebonden knop bij app A gedraaid; focus naar B: B springt niet', async () => {
    const { kern, sync, draaiKnop, tikOp } = await opzetApc();
    meldAan(kern, FL); // tk1 ongebonden
    const tk = meldAan(kern, TK); // tk1 = w9 = 0
    sync();
    draaiKnop('tk1', 102);
    kern.focus('tk-app');
    leeg(tk);
    tikOp('tk1');
    expect(van(tk, 'zet')).toEqual([{ t: 'zet', id: 'w9', v: 1 / 127, bron: 'apc40' }]);
    kern.stop();
  });

  it('lease-app: zijn knopstanden komen terug na een focusrondje (geen ring op 0)', async () => {
    const { kern, sync, draaiKnop, tikOp } = await opzetApc();
    const dj = meldAan(kern, DJ);
    meldAan(kern, FL);
    sync();
    draaiKnop('dk1', 76); // EQ op 0.6
    kern.focus('formula-lab');
    sync();
    kern.focus('varve-dj');
    leeg(dj);
    tikOp('dk1');
    expect(van(dj, 'midi').map((m) => m.bytes)).toEqual([[0xb0, 16, 77]]);
    kern.stop();
  });

  it('lease-app met focus, hubtoets in en een knop gedraaid: knop terug naar de stand van de app', async () => {
    const { kern, knop, sync, draaiKnop } = await opzetApc();
    meldAan(kern, DJ);
    sync();
    draaiKnop('dk2', 40);
    druk(kern, 'bank');
    draaiKnop('dk2', 90);
    los(kern, 'bank');
    sync();
    expect(knop.get(17)).toBe(40);
    kern.stop();
  });

  it('ring met overname draait gewoon mee: geen geforceerde extra berichten', () => {
    const { kern, opp } = opzet();
    meldAan(kern, FL);
    opp.gestuurd.length = 0;
    for (const v of [0.41, 0.45, 0.5]) draai(kern, 'dk1', v);
    expect(opp.gestuurd).toEqual([]);
  });
});

describe('kern: fader of ring op een schakelaar/keuze via config.kaarten', () => {
  it('fader1 → mute: blijft na het kwantiseren gevangen en schakelt heen en weer', () => {
    const { kern } = opzet({ ...CONFIG, kaarten: { 'formula-lab': { fader1: { id: 'mute' } } } });
    const fl = meldAan(kern, FL);
    leeg(fl);
    draai(kern, 'fader1', 0.01);
    draai(kern, 'fader1', 0.3);
    draai(kern, 'fader1', 0.6);
    draai(kern, 'fader1', 0.9);
    draai(kern, 'fader1', 0.2);
    // Alleen als de stand echt verandert gaat er een zet (PROTOCOL §14: geen dubbele zets bij een schakelaar).
    expect(van(fl, 'zet').map((b) => [b.id, b.v])).toEqual([['mute', 1], ['mute', 0]]);
    expect(kern.beeld().pickup.fader1.gevangen).toBe(true);
  });

  it('dk1 → palet (keuze): de knop springt niet terug naar de gekwantiseerde stand', async () => {
    const { kern, knop, sync, draaiKnop } = await opzetApc({ ...CONFIG, kaarten: { 'formula-lab': { dk1: { id: 'palet' } } } });
    const fl = meldAan(kern, FL);
    sync();
    leeg(fl);
    draaiKnop('dk1', 20); // palet 0 (van 3)
    draaiKnop('dk1', 30);
    sync();
    expect(knop.get(16)).toBe(30);
    draaiKnop('dk1', 70); // optie 1
    expect(van(fl, 'zet').map((b) => b.v)).toEqual([0.5]); // optie 0 stond er al (PROTOCOL §14)
    kern.stop();
  });
});

describe('kern: stap-pad voor een keuze met meer dan 5 opties', () => {
  it('pad5-1 stapt door alle 8 opties', () => {
    const { kern } = opzet();
    const man = { v: 1, app: 'stap', naam: 'Stap', params: [{ id: 'k', naam: 'K', soort: 'keuze', keuzes: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] }] };
    const v = meldAan(kern, man);
    leeg(v);
    for (let i = 0; i < 8; i++) { druk(kern, 'pad5-1'); los(kern, 'pad5-1'); }
    expect(van(v, 'zet').map((b) => Math.round(b.v * 7))).toEqual([1, 2, 3, 4, 5, 6, 7, 0]);
    stuurApp(kern, v, { t: 'hb' });
  });
});
