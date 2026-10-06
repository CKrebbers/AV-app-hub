// @ts-nocheck
// Golf 10: een app levert de sectie aan de globale laag (PROTOCOL §18). De kern neemt `globaal` alleen aan van een app
// met `levert: ["sectie"]`, stuurt het in één `globaal` naar iedereen, telt `sectie.nieuw` zelf (mod 16, /16), kiest de
// bron (de eerste die niet weg is) en bevriest de waarden als die wegvalt.
import { describe, it, expect } from 'vitest';
import { opzet, meldAan, stuurApp, nepVerbinding, van, leeg, FL, MS } from './kern-hulp.js';

const DJ = { v: 1, app: 'varve-dj', naam: 'Varve DJ', lease: true, params: [], levert: ['sectie'] };
const SED = { v: 1, app: 'sediment', naam: 'Sediment', params: [{ id: 'dichtheid', naam: 'Dichtheid', soort: 'waarde' }], levert: ['sectie'] };
const STAP = 1 / 16;

/** De globaal-berichten met een sectie-sleutel die een verbinding ontving, alleen die sleutels. */
const secties = (v) => van(v, 'globaal')
  .map((b) => Object.fromEntries(Object.entries(b.waarden).filter(([k]) => k.startsWith('sectie.'))))
  .filter((w) => Object.keys(w).length);
const stuur = (kern, v, waarden) => stuurApp(kern, v, { t: 'globaal', waarden });
/** Opnieuw verbinden met dezelfde (of een nieuwe) inst, zoals na een hapering (of een herstart van de app). */
function terug(kern, manifest, inst = 'i1') {
  const v = nepVerbinding();
  kern.verbind(v);
  stuurApp(kern, v, { t: 'hallo', app: manifest.app, inst, v: 1 });
  stuurApp(kern, v, { t: 'manifest', manifest });
  return v;
}

describe('§18 de sectie: een app levert aan de globale laag', () => {
  it('een nieuwe sectie gaat in één globaal naar iedereen (ook naar de bron zelf) en staat in beeld.globaal en beeld.bronnen', () => {
    const { kern, klok, beelden } = opzet();
    const dj = meldAan(kern, DJ);
    const fl = meldAan(kern, FL);
    leeg(dj, fl);
    klok.loop(200);
    const voor = beelden();
    stuur(kern, dj, { 'sectie.nieuw': true, 'sectie.energie': 0.8, 'sectie.label': 'drop' });
    for (const v of [dj, fl]) expect(secties(v)).toEqual([{ 'sectie.nieuw': STAP, 'sectie.energie': 0.8, 'sectie.label': 'drop' }]);
    expect(kern.beeld().globaal).toMatchObject({ 'sectie.nieuw': STAP, 'sectie.energie': 0.8, 'sectie.label': 'drop' });
    expect(kern.beeld().bronnen).toEqual({ sectie: 'varve-dj' });
    klok.loop(200);
    expect(beelden()).toBeGreaterThan(voor);
  });

  it('sectie.nieuw staat vanaf de start in globaal (0); energie en label ontbreken tot een bron ze stuurt', () => {
    const { kern } = opzet();
    const fl = meldAan(kern, FL);
    const eerste = van(fl, 'globaal')[0].waarden;
    expect(eerste['sectie.nieuw']).toBe(0);
    expect('sectie.energie' in eerste).toBe(false);
    expect('sectie.label' in eerste).toBe(false);
    expect(kern.beeld().bronnen).toEqual({ sectie: null });
    meldAan(kern, DJ);
    expect(kern.beeld().bronnen).toEqual({ sectie: 'varve-dj' });
    expect('sectie.energie' in kern.beeld().globaal).toBe(false);
  });

  it('alleen wat verandert gaat door; nieuw telt altijd; de teller loopt na 16 secties rond', () => {
    const { kern } = opzet();
    const dj = meldAan(kern, DJ);
    const fl = meldAan(kern, FL);
    stuur(kern, dj, { 'sectie.nieuw': true, 'sectie.energie': 0.8, 'sectie.label': 'drop' });
    leeg(fl);
    stuur(kern, dj, { 'sectie.energie': 0.8, 'sectie.label': 'drop' });
    expect(secties(fl)).toEqual([]);
    stuur(kern, dj, { 'sectie.energie': 0.6, 'sectie.label': 'drop' });
    expect(secties(fl)).toEqual([{ 'sectie.energie': 0.6 }]);
    leeg(fl);
    for (let i = 0; i < 15; i++) stuur(kern, dj, { 'sectie.nieuw': true });
    const tellers = secties(fl).map((w) => w['sectie.nieuw']);
    expect(tellers).toEqual([...Array.from({ length: 14 }, (_, i) => (i + 2) * STAP), 0]);
    expect(secties(fl).every((w) => Object.keys(w).length === 1)).toBe(true);
    for (const t of tellers) expect(t >= 0 && t < 1).toBe(true);
  });

  it('zonder levert, of vóór het manifest, negeert de hub de sectie', () => {
    const { kern } = opzet();
    const fl = meldAan(kern, FL);
    const ms = meldAan(kern, MS);
    leeg(ms);
    stuur(kern, fl, { 'sectie.nieuw': true, 'sectie.energie': 0.9 });
    expect(secties(ms)).toEqual([]);
    expect(kern.beeld().globaal['sectie.nieuw']).toBe(0);

    const dj = nepVerbinding();
    kern.verbind(dj);
    stuurApp(kern, dj, { t: 'hallo', app: 'varve-dj', inst: 'i1', v: 1 });
    stuur(kern, dj, { 'sectie.nieuw': true, 'sectie.energie': 0.9, 'sectie.label': 'drop' });
    stuurApp(kern, dj, { t: 'manifest', manifest: DJ });
    expect(secties(ms)).toEqual([]);
    expect(kern.beeld().globaal).not.toHaveProperty('sectie.energie');
    stuur(kern, dj, { 'sectie.energie': 0.4 });
    expect(secties(ms)).toEqual([{ 'sectie.energie': 0.4 }]);
  });

  it('wie (opnieuw) verbindt, krijgt de stand in zijn eerste globaal: dezelfde teller, dus geen klap', () => {
    const { kern } = opzet();
    const dj = meldAan(kern, DJ);
    const fl = meldAan(kern, FL);
    stuur(kern, dj, { 'sectie.nieuw': true, 'sectie.energie': 0.3, 'sectie.label': 'intro' });
    stuur(kern, dj, { 'sectie.nieuw': true, 'sectie.energie': 0.9, 'sectie.label': 'drop' });
    const ms = meldAan(kern, MS);
    expect(van(ms, 'globaal')[0].waarden).toMatchObject({ 'sectie.nieuw': 2 * STAP, 'sectie.energie': 0.9, 'sectie.label': 'drop' });

    const gezien = secties(fl).at(-1)['sectie.nieuw'];
    kern.verbreek(fl);
    const fl2 = terug(kern, FL);
    expect(van(fl2, 'globaal')[0].waarden['sectie.nieuw']).toBe(gezien);
    // Miste hij intussen een sectie, dan verschilt de teller: precies één klap bij terugkomen, met de juiste energie.
    kern.verbreek(fl2);
    stuur(kern, dj, { 'sectie.nieuw': true, 'sectie.energie': 0.2, 'sectie.label': 'break' });
    const fl3 = terug(kern, FL);
    expect(van(fl3, 'globaal')[0].waarden).toMatchObject({ 'sectie.nieuw': 3 * STAP, 'sectie.energie': 0.2, 'sectie.label': 'break' });
  });

  it('bron stil of weg: de waarden bevriezen (geen bericht, niet terug naar 0); terug zonder nieuw = geen klap', () => {
    const { kern, klok } = opzet();
    const dj = meldAan(kern, DJ);
    const fl = meldAan(kern, FL);
    stuur(kern, dj, { 'sectie.nieuw': true, 'sectie.energie': 0.8, 'sectie.label': 'drop' });
    leeg(fl);
    klok.loop(3500); // dj stil
    expect(kern.beeld().apps.find((a) => a.app === 'varve-dj').status).toBe('stil');
    expect(kern.beeld().bronnen).toEqual({ sectie: 'varve-dj' });
    kern.verbreek(dj); // weg
    expect(secties(fl)).toEqual([]);
    expect(kern.beeld().globaal).toMatchObject({ 'sectie.nieuw': STAP, 'sectie.energie': 0.8, 'sectie.label': 'drop' });
    expect(kern.beeld().bronnen).toEqual({ sectie: null });

    const dj2 = terug(kern, DJ);
    stuur(kern, dj2, { 'sectie.energie': 0.8, 'sectie.label': 'drop' });
    expect(secties(fl)).toEqual([]);
    expect(kern.beeld().bronnen).toEqual({ sectie: 'varve-dj' });
  });

  it('twee leveranciers: de eerste die niet weg is, is de bron; de tweede neemt over met zijn laatste waarden, zonder klap', () => {
    const { kern } = opzet();
    const dj = meldAan(kern, DJ);
    const sed = meldAan(kern, SED);
    const fl = meldAan(kern, FL);
    stuur(kern, dj, { 'sectie.nieuw': true, 'sectie.energie': 0.8, 'sectie.label': 'drop' });
    leeg(fl);
    stuur(kern, sed, { 'sectie.nieuw': true, 'sectie.energie': 0.3, 'sectie.label': 'break' });
    expect(secties(fl)).toEqual([]);

    kern.verbreek(dj);
    expect(secties(fl)).toEqual([{ 'sectie.energie': 0.3, 'sectie.label': 'break' }]);
    expect(kern.beeld().bronnen).toEqual({ sectie: 'sediment' });
    leeg(fl);
    stuur(kern, sed, { 'sectie.nieuw': true });
    expect(secties(fl)).toEqual([{ 'sectie.nieuw': 2 * STAP }]);

    // De eerste komt terug (zelfde inst): weer de bron, met wat hij het laatst stuurde.
    leeg(fl);
    const dj2 = terug(kern, DJ, 'i1');
    expect(kern.beeld().bronnen).toEqual({ sectie: 'varve-dj' });
    expect(secties(fl)).toEqual([{ 'sectie.energie': 0.8, 'sectie.label': 'drop' }]);

    // Weg, en terug als een herstarte app (nieuwe inst): geen bewaarde waarden, dus alles blijft staan tot hij stuurt.
    leeg(fl);
    kern.verbreek(dj2);
    expect(secties(fl)).toEqual([{ 'sectie.energie': 0.3, 'sectie.label': 'break' }]); // eerst weer sediment
    leeg(fl);
    const dj3 = terug(kern, DJ, 'i2');
    expect(kern.beeld().bronnen).toEqual({ sectie: 'varve-dj' });
    expect(secties(fl)).toEqual([]);
    stuur(kern, sed, { 'sectie.energie': 0.35 });
    expect(secties(fl)).toEqual([]); // dj3 is de bron
    stuur(kern, dj3, { 'sectie.energie': 0.1, 'sectie.label': 'intro' });
    expect(secties(fl)).toEqual([{ 'sectie.energie': 0.1, 'sectie.label': 'intro' }]);
  });

  it('een bron die stilvalt tot weg (geen hartslag) geeft het door; zijn volgende bericht maakt hem weer de bron', () => {
    const { kern, klok } = opzet();
    const dj = meldAan(kern, DJ);
    const sed = meldAan(kern, SED);
    const fl = meldAan(kern, FL);
    stuur(kern, dj, { 'sectie.energie': 0.8, 'sectie.label': 'drop' });
    stuur(kern, sed, { 'sectie.energie': 0.3, 'sectie.label': 'break' });
    for (let t = 0; t < 11; t++) { klok.loop(1000); stuurApp(kern, sed, { t: 'hb' }); stuurApp(kern, fl, { t: 'hb' }); }
    expect(kern.beeld().bronnen).toEqual({ sectie: 'sediment' });
    expect(kern.beeld().globaal['sectie.energie']).toBe(0.3);
    stuurApp(kern, dj, { t: 'hb' });
    expect(kern.beeld().bronnen).toEqual({ sectie: 'varve-dj' });
    expect(kern.beeld().globaal['sectie.energie']).toBe(0.8);
  });

  it('een nieuw manifest zonder levert: de app is geen bron meer en zijn sectie wordt genegeerd', () => {
    const { kern } = opzet();
    const dj = meldAan(kern, DJ);
    const sed = meldAan(kern, SED);
    const fl = meldAan(kern, FL);
    stuur(kern, dj, { 'sectie.energie': 0.8, 'sectie.label': 'drop' });
    stuur(kern, sed, { 'sectie.energie': 0.3, 'sectie.label': 'break' });
    leeg(fl);
    stuurApp(kern, dj, { t: 'manifest', manifest: { ...DJ, levert: undefined } });
    expect(kern.beeld().bronnen).toEqual({ sectie: 'sediment' });
    expect(secties(fl)).toEqual([{ 'sectie.energie': 0.3, 'sectie.label': 'break' }]);
    leeg(fl);
    stuur(kern, dj, { 'sectie.nieuw': true, 'sectie.energie': 1 });
    expect(secties(fl)).toEqual([]);
  });

  it('een gestopte kern negeert de sectie', () => {
    const { kern } = opzet();
    const fl = meldAan(kern, FL);
    const dj = meldAan(kern, DJ);
    kern.stop();
    leeg(fl);
    stuur(kern, dj, { 'sectie.nieuw': true, 'sectie.energie': 0.8 });
    expect(secties(fl)).toEqual([]);
  });
});
