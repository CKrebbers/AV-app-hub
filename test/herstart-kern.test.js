// Herstart van de hub, in de kern zelf (puur): slots en focus over een herstart midden in de set
// (slotsEnFocus/herstelSlotsEnFocus, via het loopbestand), en níet over een nette stop (het geheugen, exporteer/importeer).
// De echte processen staan in test/herstart.test.js; hier de randgevallen.
import { describe, it, expect } from 'vitest';
import { FOCUS_TERUG_MS } from '../src/core/kern.js';
import { opzet, meldAan, druk, los, van, FL, MS, DJ, CONFIG } from './kern-hulp.js';

/**
 * Sessie 1 → loopbestand en geheugen (zoals van schijf) → sessie 2, die weet dat de vorige omviel.
 * @param {(k: any) => void} voor
 */
function naHerstart(voor) {
  const een = opzet();
  voor(een.kern);
  const data = JSON.parse(JSON.stringify(een.kern.exporteer()));
  const indeling = JSON.parse(JSON.stringify(een.kern.slotsEnFocus()));
  const twee = opzet();
  expect(twee.kern.importeer(data)).toMatchObject({ ok: true, overgeslagen: 0 });
  expect(twee.kern.herstelSlotsEnFocus(indeling)).toEqual({ ok: true, overgeslagen: 0 });
  return { data, indeling, ...twee };
}

/** Sessie 1 → alleen het geheugen (de hub stopte netjes) → sessie 2: een nieuwe avond. @param {(k: any) => void} voor */
function naNetteStop(voor) {
  const een = opzet();
  voor(een.kern);
  const twee = opzet();
  expect(twee.kern.importeer(JSON.parse(JSON.stringify(een.kern.exporteer())))).toMatchObject({ ok: true, overgeslagen: 0 });
  return twee;
}

const slot = (/** @type {any} */ kern, /** @type {string} */ app) => kern.beeld().apps.find((/** @type {any} */ a) => a.app === app)?.slot;

describe('slots en focus over een herstart van de hub', () => {
  it('slotsEnFocus geeft de slots en de focus; het geheugen (exporteer) heeft ze niet', () => {
    const { kern } = opzet();
    expect(kern.slotsEnFocus()).toEqual({ slots: [], focus: null });
    meldAan(kern, FL); meldAan(kern, MS);
    kern.focus('medisynth');
    expect(kern.slotsEnFocus()).toEqual({ slots: ['formula-lab', 'medisynth'], focus: 'medisynth' });
    expect(kern.exporteer()).toEqual({ v: 1, snapshots: {}, waarden: {}, inst: {} });
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
    expect(kern.slotsEnFocus().focus).toBe('medisynth');
  });

  it('koos Clay intussen zelf een focus (cockpit of Bank + Track Select), dan pakt de oude focus-app hem niet terug', () => {
    const { kern } = naHerstart((k) => { meldAan(k, FL); meldAan(k, MS); k.focus('medisynth'); });
    meldAan(kern, FL);
    // Zolang medisynth weg is, blijft hij in het loopbestand de focus-app (nog een herstart: dan weer terug).
    expect(kern.slotsEnFocus().focus).toBe('medisynth');
    kern.cockpit({ t: 'focus', app: 'formula-lab' });
    expect(kern.slotsEnFocus().focus).toBe('formula-lab');
    meldAan(kern, MS);
    expect(kern.beeld().focus).toBe('formula-lab');
  });

  it(`komt de oude focus-app pas na ${FOCUS_TERUG_MS / 1000} s terug, dan blijft de focus waar hij is`, () => {
    const { kern, klok } = naHerstart((k) => { meldAan(k, FL); meldAan(k, MS); k.focus('medisynth'); });
    meldAan(kern, FL);
    klok.loop(FOCUS_TERUG_MS + 1000);
    expect(kern.slotsEnFocus().focus).toBe('formula-lab');
    meldAan(kern, MS);
    expect(kern.beeld().focus).toBe('formula-lab');
    expect(slot(kern, 'medisynth')).toBe(2);              // zijn slot heeft hij wel nog
  });

  it('ongeldige slots en focus vallen weg (geteld); slots verschuiven niet als er al apps verbonden zijn', () => {
    const { kern } = opzet();
    const r = kern.herstelSlotsEnFocus({ slots: ['formula-lab', 'Fout!', 'formula-lab', 7, null, 'medisynth'], focus: 'X Y' });
    expect(r).toEqual({ ok: true, overgeslagen: 4 });
    expect(kern.slotsEnFocus()).toEqual({ slots: ['formula-lab', null, null, null, null, 'medisynth'], focus: null });
    meldAan(kern, MS);
    meldAan(kern, DJ);                                    // vult het eerste gat
    expect([slot(kern, 'medisynth'), slot(kern, 'varve-dj')]).toEqual([6, 2]);
    expect(kern.herstelSlotsEnFocus({ slots: ['varve-dj'] })).toEqual({ ok: false, overgeslagen: 0 });
    expect(slot(kern, 'varve-dj')).toBe(2);
    expect(kern.slotsEnFocus().slots).toEqual(['formula-lab', 'varve-dj', null, null, null, 'medisynth']);
  });

  it('zijn alle 8 slots bezet door apps die nog niet terug zijn, dan neemt een nieuwe app er een (zoals bij een weggevallen app)', () => {
    const acht = Array.from({ length: 8 }, (_, i) => `app-${i + 1}`);
    const { kern } = opzet({ ...CONFIG });
    kern.herstelSlotsEnFocus({ slots: acht, focus: 'app-1' });
    meldAan(kern, FL);
    expect(slot(kern, 'formula-lab')).toBe(2);           // niet slot 1: die app had de focus vóór de herstart
  });
});

describe('na een nette stop: een nieuwe avond', () => {
  it('een andere set begint weer bij slot 1, en een oude focus-app pakt later de focus niet af', () => {
    // Avond 1: formula-lab en medisynth, focus op medisynth; netjes gestopt.
    const { kern } = naNetteStop((k) => { meldAan(k, FL); meldAan(k, MS); k.focus('medisynth'); });
    // Avond 2: Varve DJ krijgt slot 1 (niet 3), en heeft de focus.
    meldAan(kern, DJ);
    expect(slot(kern, 'varve-dj')).toBe(1);
    expect(kern.beeld().focus).toBe('varve-dj');
    // Later die avond komt medisynth binnen: de focus blijft bij Varve DJ.
    meldAan(kern, MS);
    expect(kern.beeld().focus).toBe('varve-dj');
    expect(slot(kern, 'medisynth')).toBe(2);
  });

  it('een geheugen met slots en focus erin (van een eerdere versie van deze tak) wordt gewoon gelezen; die tellen niet', () => {
    const { kern } = opzet();
    expect(kern.importeer({ v: 1, snapshots: {}, waarden: {}, inst: {}, slots: ['medisynth'], focus: 'medisynth' })).toEqual({ ok: true, overgeslagen: 0 });
    meldAan(kern, DJ);
    expect(slot(kern, 'varve-dj')).toBe(1);
    meldAan(kern, MS);
    expect(kern.beeld().focus).toBe('varve-dj');
  });
});
