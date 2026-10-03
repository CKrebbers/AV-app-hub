import { describe, it, expect } from 'vitest';
import { opzet, meldAan, stuurApp, nepVerbinding, druk, los, tik, draai, van, leeg, FL, MS } from './kern-hulp.js';

describe('kern: snapshots', () => {
  it('bewaren en laden via de cockpit: zet met bron snapshot, pickup weer wachten', () => {
    const { kern, opp } = opzet();
    const fl = meldAan(kern, FL, { staat: { in1: 0.2, palet: 0 } });
    const ms = meldAan(kern, MS, { staat: { galm: 0.3 } });
    kern.cockpit({ t: 'snapshot', nr: 3, actie: 'bewaar' });
    draai(kern, 'fader1', 0.2);
    draai(kern, 'fader1', 0.7);
    stuurApp(kern, ms, { t: 'zet', id: 'galm', v: 0.6 });
    leeg(fl, ms);
    kern.cockpit({ t: 'snapshot', nr: 3, actie: 'laad' });
    expect(van(fl, 'zet')).toEqual([{ t: 'zet', id: 'in1', v: 0.2, bron: 'snapshot' }]);
    expect(van(ms, 'zet')).toEqual([{ t: 'zet', id: 'galm', v: 0.3, bron: 'snapshot' }]);
    expect(opp.leds.get('stop1')).toEqual({ knipper: true });
    kern.cockpit({ t: 'snapshot', nr: 4, actie: 'laad' }); // bestaat niet: niets
    expect(van(fl, 'zet')).toHaveLength(1);
  });

  it('hubtoets + scene laadt, met shift erbij bewaart; bewaarde scènes wit in de overlay', () => {
    const { kern, opp } = opzet();
    const fl = meldAan(kern, FL, { staat: { in2: 0.1 } });
    druk(kern, 'bank');
    expect(opp.leds.get('scene2')).toEqual({});
    druk(kern, 'shift'); tik(kern, 'scene2'); los(kern, 'shift');
    expect(opp.leds.get('scene2')).toEqual({ kleur: 3 });
    los(kern, 'bank');
    expect(van(fl, 'scene')).toEqual([]);
    stuurApp(kern, fl, { t: 'zet', id: 'in2', v: 0.9 });
    leeg(fl);
    druk(kern, 'bank'); tik(kern, 'scene2'); los(kern, 'bank');
    expect(van(fl, 'zet')).toEqual([{ t: 'zet', id: 'in2', v: 0.1, bron: 'snapshot' }]);
    expect(van(fl, 'scene')).toEqual([]);
  });
});

describe('kern: verbindingen, hartslag en truth', () => {
  it('hartslag: stil na 3 s, weg na 10 s, terug bij een bericht', () => {
    const { kern, klok } = opzet();
    const fl = meldAan(kern, FL);
    const st = () => kern.beeld().apps[0].status;
    klok.loop(2900); expect(st()).toBe('actief');
    stuurApp(kern, fl, { t: 'hb' });
    klok.loop(2900); expect(st()).toBe('actief');
    klok.loop(200); expect(st()).toBe('stil');
    klok.loop(7000); expect(st()).toBe('weg');
    stuurApp(kern, fl, { t: 'hb' });
    expect(st()).toBe('actief');
  });

  it('verbreken: status weg, waarden bewaard, slot blijft; zelfde slot na herverbinden', () => {
    const { kern } = opzet();
    const fl = meldAan(kern, FL, { staat: { in1: 0.7 } });
    meldAan(kern, MS);
    kern.verbreek(fl);
    expect(kern.beeld().apps[0]).toMatchObject({ status: 'weg', slot: 1, waarden: { in1: 0.7 } });
    const fl2 = meldAan(kern, FL, { inst: 'i2' });
    expect(kern.beeld().apps[0]).toMatchObject({ status: 'actief', slot: 1, waarden: { in1: 0.7 } });
    expect(van(fl2, 'focus')).toEqual([{ t: 'focus', aan: true }]);
    // berichten over de oude verbinding tellen niet meer
    kern.ontvang(fl, { t: 'zet', id: 'in1', v: 0.1 });
    expect(kern.beeld().apps[0].waarden.in1).toBe(0.7);
  });

  it('truth hub: bij hallo de laatst bekende waarden opnieuw afspelen; staat van de app wint dan niet', () => {
    const { kern } = opzet();
    const man = { v: 1, app: 'uurwerk', naam: 'Uurwerk', truth: 'hub', params: [
      { id: 'onrust', naam: 'Onrust', soort: 'waarde' }, { id: 'licht', naam: 'Licht', soort: 'waarde', standaard: 0.3 }, { id: 'tik', naam: 'Tik', soort: 'trigger' },
    ] };
    const v1 = meldAan(kern, man);
    expect(van(v1, 'zet')).toEqual([]);
    kern.cockpit({ t: 'zet', app: 'uurwerk', id: 'onrust', v: 0.8 });
    kern.verbreek(v1);
    const v2 = nepVerbinding();
    kern.verbind(v2);
    stuurApp(kern, v2, { t: 'hallo', app: 'uurwerk', inst: 'nieuw', v: 1 });
    expect(van(v2, 'zet')).toEqual([{ t: 'zet', id: 'onrust', v: 0.8, bron: 'replay' }, { t: 'zet', id: 'licht', v: 0.3, bron: 'replay' }]);
    stuurApp(kern, v2, { t: 'manifest', manifest: man });
    stuurApp(kern, v2, { t: 'staat', waarden: { onrust: 0, licht: 0 } });
    expect(kern.beeld().apps[0].waarden).toEqual({ onrust: 0.8, licht: 0.3 });
    // truth app: staat wint wel
    const { kern: k2 } = opzet();
    const v3 = meldAan(k2, FL, { staat: { in1: 0.5 } });
    k2.verbreek(v3);
    meldAan(k2, FL, { inst: 'x', staat: { in1: 0.1 } });
    expect(k2.beeld().apps[0].waarden.in1).toBe(0.1);
  });

  it('herstart (nieuwe inst): pickup gaat opnieuw wachten', () => {
    const { kern, opp } = opzet();
    const fl = meldAan(kern, FL);
    draai(kern, 'fader1', 0);
    expect(opp.leds.get('stop1')).toEqual({});
    kern.verbreek(fl);
    meldAan(kern, FL, { inst: 'i2', staat: { in1: 0.6 } });
    expect(opp.leds.get('stop1')).toEqual({ knipper: true });
  });

  it('ongeldig manifest → fout, verbinding blijft bruikbaar; berichten vóór hallo → fout', () => {
    const { kern } = opzet();
    const v = nepVerbinding();
    kern.verbind(v);
    kern.ontvang(v, { t: 'hb' });
    expect(van(v, 'fout')).toHaveLength(1);
    stuurApp(kern, v, { t: 'hallo', app: 'formula-lab', inst: 'a', v: 1 });
    stuurApp(kern, v, { t: 'manifest', manifest: { v: 1, app: 'formula-lab', params: [] } });
    expect(van(v, 'fout')[1].reden).toMatch(/naam/);
    stuurApp(kern, v, { t: 'manifest', manifest: { ...FL, app: 'ander' } });
    expect(van(v, 'fout')[2].reden).toMatch(/hallo/);
    stuurApp(kern, v, { t: 'manifest', manifest: FL });
    expect(kern.beeld().apps[0].params).toHaveLength(FL.params.length);
  });

  it('cockpit: focus en zet (ook trigger)', () => {
    const { kern } = opzet();
    const fl = meldAan(kern, FL);
    const ms = meldAan(kern, MS);
    kern.cockpit({ t: 'focus', app: 'medisynth' });
    expect(kern.focusApp).toBe('medisynth');
    expect(kern.focus('bestaat-niet')).toBe(false);
    leeg(fl, ms);
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'in2', v: 2 });
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'take', v: 1 });
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'onbekend', v: 1 });
    expect(fl.ontvangen).toEqual([{ t: 'zet', id: 'in2', v: 1, bron: 'cockpit' }, { t: 'trig', id: 'take', aan: true }]);
  });
});

describe('kern: beeld', () => {
  it('beeld() volgt PROTOCOL §8', () => {
    const { kern } = opzet();
    meldAan(kern, FL);
    const b = kern.beeld();
    expect(Object.keys(b)).toEqual(expect.arrayContaining(['apps', 'focus', 'globaal', 'apparaten']));
    expect(b.apps[0]).toMatchObject({ app: 'formula-lab', naam: 'Formula Lab', kleur: '#3fbf5f', status: 'actief', focus: true, slot: 1, lease: false });
    expect(b.apps[0].waarden).toEqual({ in1: 0, in2: 0.5, palet: 0, ruimte: 0.4, mute: 0 });
    expect(b.globaal).toMatchObject({ grondtoon: 'D', bpm: 120 });
  });

  it('beeld is gedebounced: max 10x/s', () => {
    const { kern, klok, beelden } = opzet();
    meldAan(kern, FL);
    klok.loop(0);
    expect(beelden()).toBe(1);
    for (let i = 0; i < 50; i++) { draai(kern, 'dk1', i / 50); klok.loop(10); }
    // 500 ms aan wijzigingen → hooguit 5-6 meldingen
    expect(beelden()).toBeGreaterThanOrEqual(5);
    expect(beelden()).toBeLessThanOrEqual(7);
    const n = beelden();
    klok.loop(1000); // hooguit de laatste wijziging nog; adem-tikken geven geen beeld
    const m = beelden();
    expect(m - n).toBeLessThanOrEqual(1);
    klok.loop(1000);
    expect(beelden()).toBe(m);
  });

  it('stop() ruimt alle timers op', () => {
    const { kern, klok } = opzet();
    meldAan(kern, FL);
    meldAan(kern, MS);
    kern.invoer({ dev: 'lpd8', el: 'p1', kind: 'druk', v: 1 }, [0x90, 36, 100]);
    kern.stop();
    expect(klok.timers.size).toBe(0);
  });
});
