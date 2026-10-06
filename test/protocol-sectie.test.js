// Het protocol voor de sectie (PROTOCOL §18): manifestveld `levert`, `globaal` van een app naar de hub, en de
// conformiteitstoets met een nep-app die de sectie levert.
import { describe, it, expect } from 'vitest';
import { valideerManifest, GROEPEN } from '../src/protocol/manifest.js';
import { leesVanApp, leesNaarApp, VAN_APP, GLOBAAL_VAN_APP, SECTIE_STAPPEN } from '../src/protocol/berichten.js';
import { voorbeeldManifest } from '../tools/nep-app.mjs';

describe('manifest: levert', () => {
  it('een app kondigt aan dat hij de sectie levert, met of zonder lease', () => {
    expect(GROEPEN).toEqual(['sectie']);
    expect(valideerManifest({ v: 1, app: 'varve-dj', naam: 'Varve DJ', lease: true, levert: ['sectie'] })).toMatchObject({ ok: true, manifest: { lease: true, levert: ['sectie'] } });
    expect(valideerManifest({ v: 1, app: 'x', naam: 'X', params: [], levert: ['sectie'] })).toMatchObject({ ok: true, manifest: { lease: false, levert: ['sectie'] } });
  });
  it('een groep die deze hub niet kent valt weg, dubbel telt één keer (grondregel 5)', () => {
    const r = valideerManifest({ v: 1, app: 'x', naam: 'X', params: [], levert: ['sectie', 'weer', 'sectie'] });
    expect(r.ok && r.manifest.levert).toEqual(['sectie']);
  });
  it('levert is een lijst namen, hooguit 8', () => {
    expect(valideerManifest({ v: 1, app: 'x', naam: 'X', params: [], levert: 'sectie' })).toMatchObject({ ok: false, fouten: [expect.stringMatching(/levert moet een lijst/)] });
    expect(valideerManifest({ v: 1, app: 'x', naam: 'X', params: [], levert: ['Sectie A'] }).ok).toBe(false);
    expect(valideerManifest({ v: 1, app: 'x', naam: 'X', params: [], levert: Array(9).fill('sectie') }).ok).toBe(false);
    expect(valideerManifest({ v: 1, app: 'x', naam: 'X', params: [], levert: [] }).ok).toBe(true);
  });
  it('zonder levert verandert er niets aan een manifest', () => {
    const r = valideerManifest(voorbeeldManifest());
    expect(r.ok && 'levert' in r.manifest).toBe(false);
  });
});

describe('berichten: globaal van een app', () => {
  it('globaal hoort bij de berichten van een app', () => {
    expect(VAN_APP).toContain('globaal');
    expect(GLOBAAL_VAN_APP).toEqual({ 'sectie.energie': 'waarde', 'sectie.label': 'tekst', 'sectie.nieuw': 'trigger' });
  });
  it('energie geklemd op 0..1, label als tekst, nieuw als true; false en onbekende sleutels vallen weg', () => {
    expect(leesVanApp({ t: 'globaal', waarden: { 'sectie.energie': 1.4, 'sectie.label': 'drop', 'sectie.nieuw': true, 'macro.ruimte': 0.3, toekomst: 1 } }))
      .toEqual({ ok: true, bericht: { t: 'globaal', waarden: { 'sectie.energie': 1, 'sectie.label': 'drop', 'sectie.nieuw': true } } });
    expect(leesVanApp({ t: 'globaal', waarden: { 'sectie.energie': -0.2, 'sectie.nieuw': false } }))
      .toEqual({ ok: true, bericht: { t: 'globaal', waarden: { 'sectie.energie': 0 } } });
    expect(leesVanApp('{"t":"globaal","waarden":{}}')).toEqual({ ok: true, bericht: { t: 'globaal', waarden: {} } });
  });
  it('een bekende sleutel met een verkeerd type is een fout in gewone taal; zonder waarden ook', () => {
    expect(leesVanApp({ t: 'globaal', waarden: { 'sectie.nieuw': 1 } })).toMatchObject({ ok: false, fout: expect.stringMatching(/sectie\.nieuw.*true/) });
    expect(leesVanApp({ t: 'globaal', waarden: { 'sectie.energie': 'veel' } })).toMatchObject({ ok: false, fout: expect.stringMatching(/sectie\.energie.*0\.\.1/) });
    expect(leesVanApp({ t: 'globaal', waarden: { 'sectie.label': 'x'.repeat(33) } })).toMatchObject({ ok: false, fout: expect.stringMatching(/sectie\.label.*32/) });
    expect(leesVanApp({ t: 'globaal', waarden: { 'sectie.label': '' } }).ok).toBe(false);
    expect(leesVanApp({ t: 'globaal', waarden: { 'sectie.label': 'drop\n' } }).ok).toBe(false);
    expect(leesVanApp({ t: 'globaal' })).toMatchObject({ ok: false, fout: expect.stringMatching(/waarden/) });
    expect(leesVanApp({ t: 'globaal', waarden: [0.5] }).ok).toBe(false);
  });
  it('namen van het object-prototype (constructor, __proto__, toString) zijn gewoon onbekende sleutels', () => {
    expect(leesVanApp('{"t":"globaal","waarden":{"constructor":1,"__proto__":{"x":1},"toString":true}}'))
      .toEqual({ ok: true, bericht: { t: 'globaal', waarden: {} } });
  });
  it('wat de hub stuurt: sectie.nieuw is een teller 0..1 in stappen van 1/16, energie 0..1, label tekst', () => {
    expect(SECTIE_STAPPEN).toBe(16);
    expect(leesNaarApp({ t: 'globaal', waarden: { 'sectie.nieuw': 3 / 16, 'sectie.energie': 0.8, 'sectie.label': 'drop', bpm: 120, grondtoon: 'D' } }).ok).toBe(true);
    expect(leesNaarApp({ t: 'globaal', waarden: { 'sectie.nieuw': true } }).ok).toBe(false);
    expect(leesNaarApp({ t: 'globaal', waarden: { 'sectie.nieuw': 1 } }).ok).toBe(false);
    expect(leesNaarApp({ t: 'globaal', waarden: { 'sectie.energie': 2 } }).ok).toBe(false);
    expect(leesNaarApp({ t: 'globaal', waarden: { 'sectie.label': 3 } }).ok).toBe(false);
  });
});
