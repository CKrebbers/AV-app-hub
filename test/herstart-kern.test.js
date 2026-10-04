// Herstart van de hub, in de kern zelf (exporteer/importeer, puur): slots en focus over een herstart heen.
// De echte processen staan in test/herstart.test.js; hier de randgevallen.
import { describe, it, expect } from 'vitest';
import { opzet, meldAan, druk, los, van, FL, MS, DJ, CONFIG } from './kern-hulp.js';

/** Sessie 1 → geheugen (zoals van schijf) → sessie 2. @param {(k: any) => void} voor */
function naHerstart(voor) {
  const een = opzet();
  voor(een.kern);
  const data = JSON.parse(JSON.stringify(een.kern.exporteer()));
  const twee = opzet();
  expect(twee.kern.importeer(data)).toMatchObject({ ok: true, overgeslagen: 0 });
  return { data, ...twee };
}

const slot = (/** @type {any} */ kern, /** @type {string} */ app) => kern.beeld().apps.find((/** @type {any} */ a) => a.app === app)?.slot;

describe('slots en focus over een herstart van de hub', () => {
  it('exporteer bewaart de slots en de focus; een leeg geheugen blijft zonder die velden', () => {
    const { kern } = opzet();
    expect(kern.exporteer()).toEqual({ v: 1, snapshots: {}, waarden: {}, inst: {} });
    meldAan(kern, FL); meldAan(kern, MS);
    kern.focus('medisynth');
    expect(kern.exporteer()).toMatchObject({ slots: ['formula-lab', 'medisynth'], focus: 'medisynth' });
  });

  it('een app die terugkomt krijgt zijn eigen slot, ook als hij later komt dan een ander; een nieuwe app neemt geen bewaard slot', () => {
    const { kern, opp } = naHerstart((k) => { meldAan(k, FL); meldAan(k, MS); meldAan(k, DJ); });
    meldAan(kern, DJ);
    meldAan(kern, { v: 1, app: 'nieuw', naam: 'Nieuw', params: [] });
    meldAan(kern, FL);
    expect([slot(kern, 'formula-lab'), slot(kern, 'varve-dj'), slot(kern, 'nieuw')]).toEqual([1, 3, 4]);
    // Bank: slot 2 (medisynth, nog niet terug) blijft uit; slot 3 brandt in de kleur van Varve DJ.
    druk(kern, 'bank');
    expect(opp.leds.get('pad5-2') ?? {}).toEqual({});
    expect(opp.leds.get('pad5-3')?.kleur).toBe(kern.apps.get('varve-dj').kleur);
    los(kern, 'bank');
  });

  it('de focus gaat terug naar de app die hem had, ook als een andere eerder terugkwam', () => {
    const { kern } = naHerstart((k) => { meldAan(k, FL); meldAan(k, MS); k.focus('medisynth'); });
    const fl = meldAan(kern, FL);
    expect(kern.beeld().focus).toBe('formula-lab');      // tijdelijk: de APC doet meteen iets
    const ms = meldAan(kern, MS);
    expect(kern.beeld().focus).toBe('medisynth');
    expect(van(fl, 'focus').at(-1)).toEqual({ t: 'focus', aan: false });
    expect(van(ms, 'focus').at(-1)).toEqual({ t: 'focus', aan: true });
    expect(kern.exporteer().focus).toBe('medisynth');
  });

  it('koos Clay intussen zelf een focus (cockpit of Bank + Track Select), dan pakt de oude focus-app hem niet terug', () => {
    const { kern } = naHerstart((k) => { meldAan(k, FL); meldAan(k, MS); k.focus('medisynth'); });
    meldAan(kern, FL);
    // Zolang medisynth weg is, blijft hij in het geheugen de focus-app (nog een herstart: dan weer terug).
    expect(kern.exporteer().focus).toBe('medisynth');
    kern.cockpit({ t: 'focus', app: 'formula-lab' });
    expect(kern.exporteer().focus).toBe('formula-lab');
    meldAan(kern, MS);
    expect(kern.beeld().focus).toBe('formula-lab');
  });

  it('ongeldige slots en focus vallen weg (geteld); slots verschuiven niet als er al apps verbonden zijn', () => {
    const { kern } = opzet();
    const r = kern.importeer({ v: 1, slots: ['formula-lab', 'Fout!', 'formula-lab', 7, null, 'medisynth'], focus: 'X Y' });
    expect(r).toEqual({ ok: true, overgeslagen: 4 });
    expect(kern.exporteer().slots).toEqual(['formula-lab', null, null, null, null, 'medisynth']);
    expect(kern.exporteer().focus).toBeUndefined();
    meldAan(kern, MS);
    meldAan(kern, DJ);                                    // vult het eerste gat
    expect([slot(kern, 'medisynth'), slot(kern, 'varve-dj')]).toEqual([6, 2]);
    expect(kern.importeer({ v: 1, slots: ['varve-dj'] }).ok).toBe(true);
    expect(slot(kern, 'varve-dj')).toBe(2);
    expect(kern.exporteer().slots).toEqual(['formula-lab', 'varve-dj', null, null, null, 'medisynth']);
  });

  it('zijn alle 8 slots bezet door apps die nog niet terug zijn, dan neemt een nieuwe app er een (zoals bij een weggevallen app)', () => {
    const acht = Array.from({ length: 8 }, (_, i) => `app-${i + 1}`);
    const { kern } = opzet({ ...CONFIG });
    kern.importeer({ v: 1, slots: acht, focus: 'app-1' });
    meldAan(kern, FL);
    expect(slot(kern, 'formula-lab')).toBe(2);           // niet slot 1: die app had de focus vóór de herstart
  });
});
