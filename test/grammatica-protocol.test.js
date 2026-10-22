// @ts-check
// §19 Grammatica: het parameter-alfabet en de momenten in het manifest, en de regel dat een alfabet-rol ook op de
// LPD8-macro met hetzelfde woord reageert (alfabet.kleur ↔ macro.kleur = K5).
import { describe, it, expect } from 'vitest';
import { valideerManifest, ALFABET, MOMENTEN, alfabetPlek, momentPlek, macroVan, rolWoord, ROLLEN } from '../src/protocol/manifest.js';
import { opzet, meldAan, lpdKnop, van, leeg, MS } from './kern-hulp.js';

/** @param {any[]} params */
const man = (params) => ({ v: 1, app: 'gram', naam: 'Gram', params });

describe('§19 het alfabet in het protocol', () => {
  it('acht alfabet-plekken en acht momenten, in de volgorde van SYSTEEM §3.3/§3.4', () => {
    expect(ALFABET.map(rolWoord)).toEqual(['schaal', 'dichtheid', 'beweging', 'vervorming', 'kleur', 'helderheid', 'variatie', 'ruimte']);
    expect(MOMENTEN.map(rolWoord)).toEqual(['flits', 'stoot', 'omkeren', 'bevriezen', 'zaad', 'terug', 'wis', 'halvetijd']);
    expect(alfabetPlek('alfabet.schaal')).toBe(1);
    expect(alfabetPlek('alfabet.ruimte')).toBe(8);
    expect(alfabetPlek('macro.ruimte')).toBe(0);
    expect(momentPlek('moment.halvetijd')).toBe(8);
  });

  it('een geldig alfabet-manifest wordt aangenomen; de rollen blijven staan', () => {
    const r = valideerManifest(man([
      { id: 'zoom', naam: 'Zoom', soort: 'waarde', rol: 'alfabet.schaal' },
      { id: 'palet', naam: 'Palet', soort: 'keuze', keuzes: ['a', 'b'], rol: 'alfabet.kleur' },
      { id: 'flits', naam: 'Flits', soort: 'trigger', rol: 'moment.flits' },
    ]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.params.map((p) => p.rol)).toEqual(['alfabet.schaal', 'alfabet.kleur', 'moment.flits']);
  });

  it('een onbekende alfabet- of moment-rol is een fout, met de lijst erbij', () => {
    const r = valideerManifest(man([{ id: 'x', naam: 'X', soort: 'waarde', rol: 'alfabet.snelheid' }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fouten[0]).toMatch(/onbekende rol alfabet\.snelheid.*schaal, dichtheid/);
    const m = valideerManifest(man([{ id: 'x', naam: 'X', soort: 'trigger', rol: 'moment.boem' }]));
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.fouten[0]).toMatch(/onbekende rol moment\.boem.*flits/);
  });

  it('twee parameters met dezelfde alfabet-rol (of hetzelfde moment) in één app is een fout', () => {
    const r = valideerManifest(man([
      { id: 'a', naam: 'A', soort: 'waarde', rol: 'alfabet.beweging' },
      { id: 'b', naam: 'B', soort: 'waarde', rol: 'alfabet.beweging' },
    ]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fouten.join()).toMatch(/alfabet\.beweging staat al op a/);
    const m = valideerManifest(man([
      { id: 'a', naam: 'A', soort: 'trigger', rol: 'moment.wis' },
      { id: 'b', naam: 'B', soort: 'trigger', rol: 'moment.wis' },
    ]));
    expect(m.ok).toBe(false);
  });

  it('alfabet niet op een trigger, een moment alleen op een trigger', () => {
    expect(valideerManifest(man([{ id: 'a', naam: 'A', soort: 'trigger', rol: 'alfabet.kleur' }])).ok).toBe(false);
    expect(valideerManifest(man([{ id: 'a', naam: 'A', soort: 'waarde', rol: 'moment.flits' }])).ok).toBe(false);
  });

  it('druk: alleen op een trigger, en het moet een waarde van dezelfde app zijn', () => {
    const goed = valideerManifest(man([
      { id: 'flits', naam: 'Flits', soort: 'trigger', rol: 'moment.flits', druk: 'flits_diep' },
      { id: 'flits_diep', naam: 'Flits diep', soort: 'waarde' },
    ]));
    expect(goed.ok).toBe(true);
    expect(valideerManifest(man([{ id: 'f', naam: 'F', soort: 'trigger', druk: 'weg' }])).ok).toBe(false);
    expect(valideerManifest(man([
      { id: 'f', naam: 'F', soort: 'trigger', druk: 'g' }, { id: 'g', naam: 'G', soort: 'schakelaar' },
    ])).ok).toBe(false);
    expect(valideerManifest(man([{ id: 'w', naam: 'W', soort: 'waarde', druk: 'w' }])).ok).toBe(false);
  });

  it('macroVan: een alfabet-rol hoort bij de macro met hetzelfde woord, als die bestaat', () => {
    expect(macroVan('alfabet.kleur')).toBe('macro.kleur');
    expect(macroVan('alfabet.dichtheid')).toBe('macro.dichtheid');
    expect(macroVan('alfabet.beweging')).toBe('macro.beweging');
    expect(macroVan('alfabet.helderheid')).toBe('macro.helderheid');
    expect(macroVan('alfabet.ruimte')).toBe('macro.ruimte');
    expect(macroVan('alfabet.schaal')).toBe(null);
    expect(macroVan('alfabet.vervorming')).toBe(null);
    expect(macroVan('alfabet.variatie')).toBe(null);
    expect(macroVan('macro.ruimte')).toBe('macro.ruimte');
    expect(macroVan('moment.flits')).toBe(null);
    expect(macroVan(undefined)).toBe(null);
    // De vijf die samenvallen, en geen andere.
    expect(ALFABET.filter((r) => macroVan(r)).length).toBe(5);
    for (const r of ALFABET) if (macroVan(r)) expect(ROLLEN).toContain(macroVan(r));
  });
});

describe('§19 een alfabet-rol reageert ook op zijn LPD8-macro', () => {
  const ALF = {
    v: 1, app: 'gram', naam: 'Gram',
    params: [
      { id: 'tint', naam: 'Tint', soort: 'waarde', rol: 'alfabet.kleur', standaard: 0.3 },
      { id: 'zoom', naam: 'Zoom', soort: 'waarde', rol: 'alfabet.schaal', standaard: 0.3 },
    ],
  };

  it('K5 (macro.kleur) zet alfabet.kleur, net als een parameter met macro.kleur', () => {
    const { kern } = opzet();
    const w = meldAan(kern, ALF);
    leeg(w);
    lpdKnop(kern, 5, 0);
    lpdKnop(kern, 5, 0.9); // kruist 0,3: gevangen
    expect(van(w, 'zet').filter((b) => b.id === 'tint').at(-1)).toMatchObject({ v: expect.closeTo(0.9, 2), bron: 'lpd8' });
    expect(van(w, 'zet').some((b) => b.id === 'zoom')).toBe(false);
  });

  it('pickup-doel van K5 komt van de alfabet-parameter (eerste app met die rol): niets springt', () => {
    const { kern } = opzet();
    const w = meldAan(kern, ALF);
    leeg(w);
    lpdKnop(kern, 5, 0.1);
    lpdKnop(kern, 5, 0.2); // nog onder 0,3: wacht
    expect(van(w, 'zet').length).toBe(0);
  });

  it('bestaande apps met macro.ruimte en een nieuwe met alfabet.ruimte bewegen samen op K3', () => {
    const { kern } = opzet();
    const m = meldAan(kern, MS);
    const w = meldAan(kern, { v: 1, app: 'gram', naam: 'Gram', params: [{ id: 'spoor', naam: 'Spoor', soort: 'waarde', rol: 'alfabet.ruimte' }] });
    leeg(m, w);
    lpdKnop(kern, 3, 0);
    lpdKnop(kern, 3, 0.6);
    expect(van(m, 'zet').filter((b) => b.id === 'galm').at(-1)?.bron).toBe('lpd8');
    expect(van(w, 'zet').filter((b) => b.id === 'spoor').at(-1)?.bron).toBe('lpd8');
  });
});
