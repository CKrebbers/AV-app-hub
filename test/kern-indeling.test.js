import { describe, it, expect } from 'vitest';
import { maakIndeling, toewijzingen, controlsVoor } from '../src/core/indeling.js';
import { nieuwePickup, beweeg, zetDoel, volg, MARGE } from '../src/core/pickup.js';
import { maakSlew, slewWaarde, slewKlaar } from '../src/core/slew.js';
import { valideerManifest } from '../src/protocol/manifest.js';
import { FL } from './kern-hulp.js';

const man = (m) => { const r = valideerManifest(m); if (!r.ok) throw new Error(r.fouten.join('; ')); return r.manifest; };
const w = (id, extra = {}) => ({ id, naam: id, soort: 'waarde', ...extra });

describe('indeling (PROTOCOL §7)', () => {
  it('faders: hint fader eerst, dan overige waarden; track-knoppen de volgende 8', () => {
    const params = [w('a'), w('b', { hint: 'fader' }), w('k', { hint: 'knop' }), ...Array.from({ length: 12 }, (_, i) => w(`x${i}`))];
    const ind = maakIndeling(man({ v: 1, app: 'x', naam: 'X', params }));
    expect(ind.vast.fader1.id).toBe('b');
    expect(ind.vast.fader2.id).toBe('a');
    expect(ind.vast.fader8.id).toBe('x5');
    expect(ind.vast.tk1.id).toBe('x6');
    expect(ind.vast.tk6.id).toBe('x11');
    expect(ind.vast.tk7).toBeUndefined();
    expect(ind.paginas[0].dk1).toMatchObject({ id: 'k', rol: 'ring' });
    expect(ind.vast.fader1).toMatchObject({ rol: 'fader', takeover: 'pickup' });
    expect(ind.niet).toEqual([]);
  });

  it('meer dan 8 device-knoppen → pagina per groep', () => {
    const params = [
      ...Array.from({ length: 5 }, (_, i) => w(`a${i}`, { hint: 'knop', groep: 'klank' })),
      ...Array.from({ length: 10 }, (_, i) => w(`b${i}`, { hint: 'knop', groep: 'beeld' })),
    ];
    const ind = maakIndeling(man({ v: 1, app: 'x', naam: 'X', params }));
    expect(ind.paginas).toHaveLength(3);
    expect(ind.paginaNamen).toEqual(['klank', 'beeld', 'beeld 2']);
    expect(ind.paginas[0].dk5.id).toBe('a4');
    expect(ind.paginas[1].dk1.id).toBe('b0');
    expect(ind.paginas[2].dk2.id).toBe('b9');
    expect(toewijzingen(ind, 1).dk1.id).toBe('b0');
    expect(controlsVoor(ind, 2, 'b9')).toEqual(['dk2']);
  });

  it('grid: één kolom per keuze (optie 0 bovenaan), triggers/schakelaars per groep; scenes en paniek', () => {
    const ind = maakIndeling(man(FL));
    expect(ind.vast['pad5-1']).toMatchObject({ id: 'palet', rol: 'keuze', optie: 0, n: 3 });
    expect(ind.vast['pad3-1']).toMatchObject({ id: 'palet', optie: 2 });
    expect(ind.vast['pad2-1']).toBeUndefined();
    expect(ind.vast['pad5-2']).toMatchObject({ id: 'take', rol: 'trigger' });
    expect(ind.vast['pad4-2']).toMatchObject({ id: 'mute', rol: 'schakelaar' });
    expect(ind.scenes).toBe(3);
    expect(ind.paniek).toBe('paniek');
    expect(Object.values(ind.vast).some((t) => t.id === 'paniek')).toBe(false);

    const groepen = maakIndeling(man({ v: 1, app: 'x', naam: 'X', params: [
      ...Array.from({ length: 6 }, (_, i) => ({ id: `t${i}`, naam: 't', soort: 'trigger', groep: 'veld' })),
      { id: 's', naam: 's', soort: 'schakelaar', groep: 'ander' },
    ] }));
    expect(groepen.vast['pad1-1'].id).toBe('t4');
    expect(groepen.vast['pad5-2'].id).toBe('t5');
    expect(groepen.vast['pad5-3'].id).toBe('s');
  });

  it('kaart (maps/<app>.json) overschrijft de automatische plek', () => {
    const ind = maakIndeling(man(FL), { fader5: { id: 'ruimte', takeover: 'direct' }, 'pad1-8': { id: 'palet' }, onzin: { id: 'in1' } });
    expect(ind.vast.fader5).toMatchObject({ id: 'ruimte', rol: 'fader', takeover: 'direct' });
    expect(ind.paginas[0].dk1).toBeUndefined();
    expect(ind.vast['pad1-8']).toMatchObject({ id: 'palet', rol: 'stap', n: 3 });
    expect(ind.vast['pad5-1']).toBeUndefined();
    expect(ind.vast.fader1.id).toBe('in1');
  });
});

describe('pickup (crossing)', () => {
  it('springt niet: neemt pas over bij kruisen', () => {
    let p = nieuwePickup(0.5);
    let r = beweeg(p, 0.1); expect(r.uit).toBe(null); p = r.p;
    r = beweeg(p, 0.3); expect(r.uit).toBe(null); p = r.p;
    r = beweeg(p, 0.6); expect(r.uit).toBe(0.6); expect(r.p.gevangen).toBe(true); p = r.p;
    r = beweeg(p, 0.2); expect(r.uit).toBe(0.2);
  });
  it('neemt over binnen de marge en is meteen gevangen als de stand al dichtbij is', () => {
    expect(beweeg(nieuwePickup(0.5), 0.5 + MARGE / 2).uit).toBeCloseTo(0.51);
    expect(nieuwePickup(0.5, 0.49).gevangen).toBe(true);
    expect(nieuwePickup(0.5, 0.3).gevangen).toBe(false);
  });
  it('zetDoel: weer wachten, tenzij dichtbij; volg werkt de stand bij zonder over te nemen', () => {
    let p = beweeg(nieuwePickup(0.5), 0.5).p;
    expect(zetDoel(p, 0.9).gevangen).toBe(false);
    expect(zetDoel(p, 0.51).gevangen).toBe(true);
    p = volg(zetDoel(p, 0.9), 0.2);
    expect(p).toMatchObject({ fysiek: 0.2, gevangen: false });
    expect(beweeg(p, 0.95).uit).toBe(0.95);
  });
  it('direct en schaal', () => {
    expect(beweeg(nieuwePickup(0.5, null, 'direct'), 0.1).uit).toBe(0.1);
    let p = nieuwePickup(0.5, 0, 'schaal');
    let r = beweeg(p, 0.25); expect(r.uit).toBeCloseTo(0.625); p = r.p; // een kwart omhoog → een kwart van de rest
    r = beweeg(p, 1); expect(r.uit).toBeCloseTo(1); expect(r.p.gevangen).toBe(true);
  });
});

describe('slew', () => {
  it('verloopt lineair en is klaar na de duur', () => {
    const s = maakSlew(0, 1, 1000, 4);
    expect(slewWaarde(s, 1000)).toBe(0);
    expect(slewWaarde(s, 3000)).toBeCloseTo(0.5);
    expect(slewKlaar(s, 4999)).toBe(false);
    expect(slewWaarde(s, 6000)).toBe(1);
    expect(slewKlaar(s, 5000)).toBe(true);
    expect(slewWaarde(maakSlew(0.2, 0.7, 0, 0), 0)).toBe(0.7);
  });
});
