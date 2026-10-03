import { describe, it, expect } from 'vitest';
import { dichtsteKleur } from '../src/devices/apc40mk2.js';
import { opzet, meldAan, stuurApp, druk, los, tik, draai, van, leeg, FL, MS, CONFIG } from './kern-hulp.js';

const GROEN = dichtsteKleur('#3fbf5f');
const VIOLET = dichtsteKleur('#8b5cff');

describe('kern: focus, slots en hubtoets', () => {
  it('eerste app krijgt focus; slots in volgorde van hallo; welkom bij verbinden', () => {
    const { kern } = opzet();
    const fl = meldAan(kern, FL);
    const ms = meldAan(kern, MS);
    expect(fl.ontvangen[0]).toEqual({ t: 'welkom', hub: 'varve-hub', v: 1 });
    expect(van(fl, 'focus')).toEqual([{ t: 'focus', aan: true }]);
    expect(van(ms, 'focus')).toEqual([]);
    expect(van(fl, 'globaal')[0].waarden).toMatchObject({ grondtoon: 'D', bpm: 120 });
    const b = kern.beeld();
    expect(b.focus).toBe('formula-lab');
    expect(b.apps.map((a) => [a.app, a.slot, a.focus, a.status])).toEqual([['formula-lab', 1, true, 'actief'], ['medisynth', 2, false, 'actief']]);
    expect(fl.app).toBe('formula-lab');
  });

  it('hubtoets: bovenste rij toont slots in app-kleur; sel wisselt focus; niets gaat naar een app', () => {
    const { kern, opp, klok } = opzet();
    const fl = meldAan(kern, FL);
    const ms = meldAan(kern, MS);
    leeg(fl, ms);
    druk(kern, 'bank');
    expect(opp.leds.get('pad5-1')).toEqual({ kleur: GROEN, anim: { soort: 'puls' } });
    expect(opp.leds.get('pad5-2')).toEqual({ kleur: VIOLET });
    expect(opp.leds.get('pad5-3')).toEqual({});
    expect(opp.leds.get('sel1')).toEqual({ aan: true });

    // fader, pad en scene terwijl de hubtoets is ingedrukt: niets naar de app
    draai(kern, 'fader1', 0.5);
    tik(kern, 'pad5-2');
    expect(van(fl, 'zet').length + van(fl, 'trig').length + van(fl, 'scene').length).toBe(0);

    tik(kern, 'sel2');
    expect(kern.focusApp).toBe('medisynth');
    expect(van(fl, 'focus')).toEqual([{ t: 'focus', aan: false }]);
    expect(van(ms, 'focus')).toEqual([{ t: 'focus', aan: true }]);
    expect(opp.leds.get('pad5-2')).toEqual({ kleur: VIOLET, anim: { soort: 'puls' } });
    expect(opp.leds.get('pad5-1')).toEqual({ kleur: GROEN });

    // stil = knipperen, weg = uit (formula-lab zwijgt; medisynth blijft hartslag sturen)
    for (let t = 0; t < 3500; t += 500) { klok.loop(500); stuurApp(kern, ms, { t: 'hb' }); }
    expect(opp.leds.get('pad5-1')).toEqual({ kleur: GROEN, anim: { soort: 'knipper' } });
    kern.verbreek(fl);
    expect(opp.leds.get('pad5-1')).toEqual({});

    // loslaten: focus-app (medisynth, geen grid-indeling) opnieuw tekenen
    los(kern, 'bank');
    expect(opp.leds.get('pad5-2')).toEqual({});
    expect(van(ms, 'midi')).toEqual([]);
  });

  it('hubtoets + sel naar een leeg slot doet niets', () => {
    const { kern } = opzet();
    meldAan(kern, FL);
    druk(kern, 'bank'); tik(kern, 'sel5'); los(kern, 'bank');
    expect(kern.focusApp).toBe('formula-lab');
  });
});

describe('kern: manifest-app met focus', () => {
  it('fader-pickup: springt niet, neemt over bij kruisen; clip-stop knippert zolang niet gevangen', () => {
    const { kern, opp } = opzet();
    const fl = meldAan(kern, FL, { staat: { in1: 0.5 } });
    expect(opp.leds.get('stop1')).toEqual({ knipper: true });
    leeg(fl);
    draai(kern, 'fader1', 0.1);
    draai(kern, 'fader1', 0.3);
    expect(van(fl, 'zet')).toEqual([]);
    draai(kern, 'fader1', 0.6);
    expect(van(fl, 'zet')).toEqual([{ t: 'zet', id: 'in1', v: 76 / 127, bron: 'apc40' }]);
    expect(opp.leds.get('stop1')).toEqual({});
    draai(kern, 'fader1', 0.2);
    expect(van(fl, 'zet').at(-1).v).toBeCloseTo(0.2, 2);
    expect(kern.beeld().pickup.fader1).toMatchObject({ id: 'in1', gevangen: true });
  });

  it('app zet → waarde, LED en pickup weer "wachten" (tenzij dichtbij)', () => {
    const { kern, opp } = opzet();
    const fl = meldAan(kern, FL);
    draai(kern, 'fader1', 0); // in1 = 0: meteen gevangen
    expect(opp.leds.get('stop1')).toEqual({});
    stuurApp(kern, fl, { t: 'zet', id: 'in1', v: 0.8 });
    expect(kern.beeld().apps[0].waarden.in1).toBe(0.8);
    expect(opp.leds.get('stop1')).toEqual({ knipper: true });
    leeg(fl);
    draai(kern, 'fader1', 0.4);
    expect(van(fl, 'zet')).toEqual([]);
    stuurApp(kern, fl, { t: 'zet', id: 'in1', v: 0.41 });
    expect(opp.leds.get('stop1')).toEqual({});
    stuurApp(kern, fl, { t: 'zet', id: 'ruimte', v: 0.9 });
    expect(opp.leds.get('dk1')).toEqual({ waarde: 0.9 });
  });

  it('ringen nemen bij focus de waarde over en volgen de knop direct', () => {
    const { kern, opp } = opzet();
    const fl = meldAan(kern, FL);
    expect(opp.leds.get('dk1')).toEqual({ waarde: 0.4 });
    leeg(fl);
    draai(kern, 'dk1', 0.9);
    expect(van(fl, 'zet')).toEqual([{ t: 'zet', id: 'ruimte', v: 114 / 127, bron: 'apc40' }]);
    expect(opp.leds.get('dk1')).toEqual({ waarde: 114 / 127 });
  });

  it('ringen_nemen_waarde_over:false → ook pickup op de ringknoppen', () => {
    const { kern, opp } = opzet({ ...CONFIG, ringen_nemen_waarde_over: false });
    const fl = meldAan(kern, FL);
    expect(opp.leds.get('dk1')).toEqual({ waarde: 0 });
    leeg(fl);
    draai(kern, 'dk1', 0.1);
    draai(kern, 'dk1', 0.2);
    expect(van(fl, 'zet')).toEqual([]);
    expect(opp.leds.get('dk1')).toEqual({ waarde: 25 / 127 });
    draai(kern, 'dk1', 0.5);
    expect(van(fl, 'zet')).toHaveLength(1);
  });

  it('keuze: kolom, gekozen rij vol, andere gedimd; drukken kiest', () => {
    const { kern, opp } = opzet();
    const fl = meldAan(kern, FL, { staat: { palet: 0.5 } });
    const dim = opp.leds.get('pad5-1').kleur;
    expect(dim).not.toBe(GROEN);
    expect(opp.leds.get('pad4-1')).toEqual({ kleur: GROEN });
    expect(opp.leds.get('pad3-1')).toEqual({ kleur: dim });
    expect(opp.leds.get('pad2-1')).toEqual({});
    leeg(fl);
    tik(kern, 'pad3-1');
    expect(van(fl, 'zet')).toEqual([{ t: 'zet', id: 'palet', v: 1, bron: 'apc40' }]);
    expect(opp.leds.get('pad3-1')).toEqual({ kleur: GROEN });
    expect(opp.leds.get('pad4-1')).toEqual({ kleur: dim });
  });

  it('trigger: druk → aan, los → uit, wit zolang ingedrukt; schakelaar wisselt', () => {
    const { kern, opp } = opzet();
    const fl = meldAan(kern, FL);
    leeg(fl);
    druk(kern, 'pad5-2');
    expect(opp.leds.get('pad5-2')).toEqual({ kleur: 3 });
    los(kern, 'pad5-2');
    expect(van(fl, 'trig')).toEqual([{ t: 'trig', id: 'take', aan: true }, { t: 'trig', id: 'take', aan: false }]);
    expect(opp.leds.get('pad5-2').kleur).not.toBe(3);
    tik(kern, 'pad4-2');
    expect(van(fl, 'zet')).toEqual([{ t: 'zet', id: 'mute', v: 1, bron: 'apc40' }]);
    expect(opp.leds.get('pad4-2')).toEqual({ kleur: GROEN });
  });

  it('trigger die ingedrukt is tijdens een focuswissel krijgt zijn "uit" toch', () => {
    const { kern } = opzet();
    const fl = meldAan(kern, FL);
    meldAan(kern, MS);
    druk(kern, 'pad5-2');
    kern.focus('medisynth');
    los(kern, 'pad5-2');
    expect(van(fl, 'trig')).toEqual([{ t: 'trig', id: 'take', aan: true }, { t: 'trig', id: 'take', aan: false }]);
  });

  it('scene → {t:scene, i}; stop all → trig paniek', () => {
    const { kern, opp } = opzet();
    const fl = meldAan(kern, FL);
    expect(opp.leds.get('scene3').kleur).toBeGreaterThan(0);
    expect(opp.leds.get('scene4')).toEqual({});
    leeg(fl);
    tik(kern, 'scene2');
    tik(kern, 'scene5');
    expect(van(fl, 'scene')).toEqual([{ t: 'scene', i: 1 }]);
    expect(opp.leds.get('scene2')).toEqual({ kleur: GROEN });
    tik(kern, 'stopall');
    expect(van(fl, 'trig')).toEqual([{ t: 'trig', id: 'paniek', aan: true }, { t: 'trig', id: 'paniek', aan: false }]);
  });

  it('device ◄/► bladert door pagina\'s', () => {
    const { kern, opp } = opzet();
    const params = [
      ...Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, naam: 'a', soort: 'waarde', hint: 'knop', groep: 'a', standaard: 0.1 })),
      ...Array.from({ length: 2 }, (_, i) => ({ id: `b${i}`, naam: 'b', soort: 'waarde', hint: 'knop', groep: 'b', standaard: 0.7 })),
    ];
    const v = meldAan(kern, { v: 1, app: 'pag', naam: 'Pag', params });
    expect(opp.leds.get('dk1')).toEqual({ waarde: 0.1 });
    expect(opp.leds.get('devR')).toEqual({ aan: true });
    expect(opp.leds.get('devL')).toEqual({});
    tik(kern, 'devR');
    expect(opp.leds.get('dk1')).toEqual({ waarde: 0.7 });
    expect(opp.leds.get('dk3')).toEqual({ waarde: 0 });
    expect(opp.leds.get('devL')).toEqual({ aan: true });
    draai(kern, 'dk2', 0.5);
    expect(van(v, 'zet').at(-1)).toMatchObject({ id: 'b1' });
  });

  it('meldt LED-wijzigingen als "leds" (alleen wat veranderde)', () => {
    const { kern, leds } = opzet();
    meldAan(kern, FL);
    leds.length = 0;
    tik(kern, 'pad4-2');
    expect(leds).toEqual([{ dev: 'apc40', staat: { 'pad4-2': { kleur: GROEN } } }]);
  });
});
