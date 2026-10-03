import { describe, it, expect } from 'vitest';
import { opzet, meldAan, lpdKnop, lpdDruk, lpdLos, van, leeg, FL, MS, DJ } from './kern-hulp.js';

describe('kern: LPD8 (globale laag)', () => {
  it('K3 → macro.ruimte naar elke app met die rol; slew_s verloopt in stappen; globaal alleen gewijzigde sleutel', () => {
    const { kern, klok } = opzet();
    const fl = meldAan(kern, FL);
    const ms = meldAan(kern, MS);
    const dj = meldAan(kern, DJ);
    leeg(fl, ms, dj);
    lpdKnop(kern, 3, 0.3); // pickup: doel = ruimte van formula-lab (0.4), nog niet gekruist
    expect(van(ms, 'zet').length + van(fl, 'zet').length + van(fl, 'globaal').length).toBe(0);
    lpdKnop(kern, 3, 0.8); // kruist 0.4: overgenomen
    const v = 102 / 127;
    // zonder slew: meteen
    expect(van(ms, 'zet')).toEqual([{ t: 'zet', id: 'galm', v, bron: 'lpd8' }]);
    // iedereen krijgt globaal met alleen de gewijzigde sleutel (ook de lease-app)
    for (const x of [fl, ms, dj]) expect(van(x, 'globaal')).toEqual([{ t: 'globaal', waarden: { 'macro.ruimte': v } }]);
    // met slew_s 4: nog niets, daarna stappen van ~33 ms
    expect(van(fl, 'zet')).toEqual([]);
    klok.loop(2000);
    const stappen = van(fl, 'zet');
    expect(stappen.length).toBeGreaterThan(50);
    expect(stappen.every((b) => b.id === 'ruimte' && b.bron === 'lpd8')).toBe(true);
    expect(stappen.at(-1).v).toBeCloseTo(0.4 + (v - 0.4) * (1980 / 4000), 2);
    for (let i = 1; i < stappen.length; i++) expect(stappen[i].v).toBeGreaterThan(stappen[i - 1].v);
    klok.loop(2100);
    expect(van(fl, 'zet').at(-1).v).toBe(v);
    const n = van(fl, 'zet').length;
    klok.loop(1000);
    expect(van(fl, 'zet')).toHaveLength(n);
    expect(kern.beeld().globaal['macro.ruimte']).toBe(v);
  });

  it('pickup per LPD8-knop ook bij de eerste aanraking: K3 ver van galm geeft geen zet en geen sprong', () => {
    const { kern } = opzet();
    const ms = meldAan(kern, { ...MS, params: MS.params.map((p) => (p.id === 'galm' ? { ...p, standaard: 0.2 } : p)) });
    leeg(ms);
    lpdKnop(kern, 3, 0.9);
    lpdKnop(kern, 3, 0.85);
    expect(van(ms, 'zet')).toEqual([]);
    expect(van(ms, 'globaal').filter((b) => 'macro.ruimte' in b.waarden)).toEqual([]);
    lpdKnop(kern, 3, 0.21); // binnen 0.02 van 0.2: gevangen
    expect(van(ms, 'zet')).toEqual([{ t: 'zet', id: 'galm', v: 27 / 127, bron: 'lpd8' }]);
    // zonder app met die rol: doel 0.5
    lpdKnop(kern, 1, 0.1);
    expect(van(ms, 'globaal').filter((b) => 'macro.intensiteit' in b.waarden)).toEqual([]);
    lpdKnop(kern, 1, 0.6);
    expect(van(ms, 'globaal').filter((b) => 'macro.intensiteit' in b.waarden)).toHaveLength(1);
  });

  it('LPD8 valt weg terwijl P1 is ingedrukt: geen paniek; een lopende paniek eindigt', () => {
    const { kern, klok } = opzet();
    const ms = meldAan(kern, MS);
    leeg(ms);
    lpdDruk(kern, 1);
    kern.apparaatWeg('lpd8');
    klok.loop(1500);
    expect(van(ms, 'trig')).toEqual([]);
    lpdDruk(kern, 1);
    klok.loop(1100);
    expect(van(ms, 'trig')).toEqual([{ t: 'trig', id: 'paniek', aan: true }]);
    kern.apparaatWeg('lpd8');
    expect(van(ms, 'trig').at(-1)).toEqual({ t: 'trig', id: 'paniek', aan: false });
    expect(kern.beeld().globaal.paniek).toBe(0);
  });

  it('pickup per LPD8-knop: K7 (adem-periode, start 0.5) springt niet', () => {
    const { kern } = opzet();
    const fl = meldAan(kern, FL);
    leeg(fl);
    lpdKnop(kern, 7, 0.1);
    lpdKnop(kern, 7, 0.3);
    expect(van(fl, 'globaal').filter((b) => 'klok.adem_periode' in b.waarden)).toEqual([]);
    lpdKnop(kern, 7, 0.7);
    expect(van(fl, 'globaal').filter((b) => 'klok.adem_periode' in b.waarden)).toEqual([{ t: 'globaal', waarden: { 'klok.adem_periode': 89 / 127 } }]);
  });

  it('adem: fase ~10x/s als globaal; K7 verandert de periode zonder sprong; P3 zet de fase op 0', () => {
    const { kern, klok } = opzet();
    const fl = meldAan(kern, FL);
    klok.loop(2500);
    const adem = van(fl, 'globaal').filter((b) => 'adem' in b.waarden && Object.keys(b.waarden).length === 1);
    expect(adem).toHaveLength(25);
    expect(adem.at(-1).waarden.adem).toBeCloseTo(0.25, 3); // 10 s per ademhaling
    lpdKnop(kern, 7, 0.5);
    lpdKnop(kern, 7, 0); // 4 s per ademhaling
    leeg(fl);
    klok.loop(1000);
    expect(van(fl, 'globaal').at(-1).waarden.adem).toBeCloseTo(0.5, 2);
    leeg(fl);
    lpdDruk(kern, 3); lpdLos(kern, 3);
    expect(van(fl, 'globaal')).toEqual([{ t: 'globaal', waarden: { adem: 0 } }]);
    klok.loop(100);
    expect(van(fl, 'globaal').at(-1).waarden.adem).toBeCloseTo(0.025, 3);
  });

  it('P1 1 s vasthouden → paniek naar wie hem heeft + globaal; kort drukken doet niets', () => {
    const { kern, klok } = opzet();
    const fl = meldAan(kern, FL);
    const ms = meldAan(kern, MS);
    const dj = meldAan(kern, DJ);
    leeg(fl, ms, dj);
    lpdDruk(kern, 1); klok.loop(500); lpdLos(kern, 1); klok.loop(2000);
    expect(van(fl, 'trig')).toEqual([]);
    lpdDruk(kern, 1);
    klok.loop(999);
    expect(van(fl, 'trig')).toEqual([]);
    klok.loop(1);
    expect(van(fl, 'trig')).toEqual([{ t: 'trig', id: 'paniek', aan: true }]);
    expect(van(ms, 'trig')).toEqual([{ t: 'trig', id: 'paniek', aan: true }]);
    expect(van(dj, 'trig')).toEqual([]);
    expect(van(dj, 'globaal').filter((b) => 'paniek' in b.waarden)).toEqual([{ t: 'globaal', waarden: { paniek: 1 } }]);
    lpdLos(kern, 1);
    expect(van(fl, 'trig').at(-1)).toEqual({ t: 'trig', id: 'paniek', aan: false });
    expect(kern.beeld().globaal.paniek).toBe(0);
  });

  it('P2 tap tempo → globaal bpm', () => {
    const { kern, klok } = opzet();
    const fl = meldAan(kern, FL);
    leeg(fl);
    lpdDruk(kern, 2); klok.loop(500); lpdDruk(kern, 2);
    expect(van(fl, 'globaal').at(-1)).toEqual({ t: 'globaal', waarden: { bpm: 120 } });
    klok.loop(400); lpdDruk(kern, 2);
    expect(van(fl, 'globaal').at(-1).waarden.bpm).toBeCloseTo(133.3, 1);
    klok.loop(3000); lpdDruk(kern, 2); // na een pauze opnieuw beginnen: nog geen nieuw tempo
    expect(van(fl, 'globaal').filter((b) => 'bpm' in b.waarden)).toHaveLength(2);
  });

  it('P4 opname aan/uit; P5 kort = laden, lang = bewaren', () => {
    const { kern, klok, opname } = opzet();
    const fl = meldAan(kern, FL, { staat: { in1: 0.2 } });
    lpdDruk(kern, 4); lpdLos(kern, 4); lpdDruk(kern, 4);
    expect(opname).toEqual([true, false]);
    lpdDruk(kern, 5); klok.loop(700); lpdLos(kern, 5); // bewaar 1
    expect(kern.beeld().snapshots).toEqual([1]);
    stuurApp2(kern, fl, 0.9);
    leeg(fl);
    lpdDruk(kern, 5); klok.loop(100); lpdLos(kern, 5); // laad 1
    expect(van(fl, 'zet')).toEqual([{ t: 'zet', id: 'in1', v: 0.2, bron: 'snapshot' }]);
  });
});

function stuurApp2(kern, v, w) { kern.ontvang(v, { t: 'zet', id: 'in1', v: w }); }
