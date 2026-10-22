// @ts-check
// §19 + §7: de APC-device-knoppen volgen het parameter-alfabet. Knop N = de parameter met alfabet-plek N; een lege
// plek doet niets (ring uit). Apps zonder alfabet houden de oude regel (hint "knop", manifestvolgorde).
import { describe, it, expect } from 'vitest';
import { maakIndeling, toewijzingen, ALFABET_PAGINA } from '../src/core/indeling.js';
import { valideerManifest } from '../src/protocol/manifest.js';
import { opzet, meldAan, draai, tik, van, leeg, FL } from './kern-hulp.js';

/** @param {any} m */
const man = (m) => { const r = valideerManifest(m); if (!r.ok) throw new Error(r.fouten.join('; ')); return r.manifest; };
/** @param {string} id @param {object} [extra] */
const w = (id, extra = {}) => ({ id, naam: id, soort: 'waarde', ...extra });

/** Een app met vijf van de acht plekken, in een andere volgorde dan het alfabet, plus gewone parameters. */
export const ALFABET_APP = {
  v: 1, app: 'gram', naam: 'Gram', kleur: '#2e5bff',
  params: [
    w('spoor', { rol: 'alfabet.ruimte' }),
    w('tint', { rol: 'alfabet.kleur' }),
    w('licht', { hint: 'fader' }),
    w('zoom', { rol: 'alfabet.schaal', hint: 'fader' }),
    { id: 'modus', naam: 'Modus', soort: 'keuze', keuzes: ['a', 'b', 'c'], rol: 'alfabet.vervorming' },
    w('snel', { rol: 'alfabet.beweging' }),
    w('extra', { hint: 'knop' }),
    { id: 'flits', naam: 'Flits', soort: 'trigger', rol: 'moment.flits' },
  ],
};

describe('§19 indeling: device-knop N = alfabet-plek N', () => {
  it('de eerste device-pagina is het alfabet, op plek; lege plekken blijven leeg', () => {
    const ind = maakIndeling(man(ALFABET_APP));
    expect(ind.paginaNamen[0]).toBe(ALFABET_PAGINA);
    const dk = ind.paginas[0];
    expect(dk.dk1).toMatchObject({ id: 'zoom', rol: 'ring' });
    expect(dk.dk2).toBeUndefined();
    expect(dk.dk3).toMatchObject({ id: 'snel' });
    expect(dk.dk4).toMatchObject({ id: 'modus', rol: 'ring' });
    expect(dk.dk5).toMatchObject({ id: 'tint' });
    expect(dk.dk6).toBeUndefined();
    expect(dk.dk7).toBeUndefined();
    expect(dk.dk8).toMatchObject({ id: 'spoor' });
  });

  it('alfabet-parameters staan niet ook op een fader, track-knop of in het grid; hint "knop" komt op de volgende pagina', () => {
    const ind = maakIndeling(man(ALFABET_APP));
    expect(ind.vast.fader1.id).toBe('licht');
    expect(ind.vast.fader2).toBeUndefined();
    expect(Object.values(ind.vast).some((t) => t.id === 'modus' || t.id === 'zoom')).toBe(false);
    expect(ind.paginas).toHaveLength(2);
    expect(ind.paginaNamen).toEqual(['alfabet', 'meer']);
    expect(ind.paginas[1].dk1.id).toBe('extra');
    expect(ind.niet).toEqual([]);
  });

  it('alleen het alfabet: precies één device-pagina', () => {
    const ind = maakIndeling(man({ v: 1, app: 'x', naam: 'X', params: [w('a', { rol: 'alfabet.variatie' })] }));
    expect(ind.paginas).toHaveLength(1);
    expect(ind.paginas[0].dk7.id).toBe('a');
  });

  it('een app zonder alfabet: precies de oude indeling (hint "knop" in manifestvolgorde)', () => {
    const ind = maakIndeling(man(FL));
    expect(ind.paginaNamen).toEqual(['']);
    expect(ind.paginas[0].dk1.id).toBe('ruimte');
    const zonderRol = maakIndeling(man({ v: 1, app: 'x', naam: 'X', params: [w('a', { hint: 'knop', rol: 'macro.kleur' }), w('b', { hint: 'knop' })] }));
    expect(zonderRol.paginas[0].dk1.id).toBe('a');
    expect(zonderRol.paginas[0].dk2.id).toBe('b');
  });

  it('een kaart (maps/<app>.json) gaat nog steeds voor: de parameter verhuist, zijn alfabet-plek wordt leeg', () => {
    const ind = maakIndeling(man(ALFABET_APP), { fader8: { id: 'tint' } });
    expect(ind.vast.fader8.id).toBe('tint');
    expect(toewijzingen(ind, 0).dk5).toBeUndefined();
    expect(toewijzingen(ind, 0).dk3).toMatchObject({ id: 'snel' });
  });
});

describe('§19 in de kern: draaien aan de device-knoppen', () => {
  it('dk3 zet beweging, dk5 kleur; dk2 (leeg) doet niets en zijn ring is uit', () => {
    const { kern, opp } = opzet();
    const v = meldAan(kern, ALFABET_APP);
    kern.focus('gram');
    leeg(v);
    draai(kern, 'dk3', 0.7);
    draai(kern, 'dk5', 0.2);
    draai(kern, 'dk2', 0.9);
    const zet = van(v, 'zet');
    expect(zet.find((b) => b.id === 'snel')).toMatchObject({ v: expect.closeTo(0.7, 1), bron: 'apc40' });
    expect(zet.find((b) => b.id === 'tint')).toMatchObject({ v: expect.closeTo(0.2, 1) });
    expect(zet.length).toBe(2);
    expect(opp.leds.get('dk2')).toEqual({ waarde: 0 });
    expect(opp.leds.get('dk6')).toEqual({ waarde: 0 });
    expect(opp.leds.get('dk3')).toMatchObject({ waarde: expect.closeTo(0.7, 1) });
  });

  it('Device ► bladert naar de volgende pagina (hint "knop"), ◄ terug naar het alfabet', () => {
    const { kern } = opzet();
    const v = meldAan(kern, ALFABET_APP);
    kern.focus('gram');
    tik(kern, 'devR');
    leeg(v);
    draai(kern, 'dk1', 0.5);
    expect(van(v, 'zet').at(-1)?.id).toBe('extra');
    tik(kern, 'devL');
    leeg(v);
    draai(kern, 'dk1', 0.6);
    expect(van(v, 'zet').at(-1)?.id).toBe('zoom');
    expect(kern.beeld().apps.find((a) => a.app === 'gram')?.paginas).toEqual(['alfabet', 'meer']);
  });
});
