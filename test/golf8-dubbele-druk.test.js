// @ts-nocheck
// Golf 8: dezelfde toets twee keer ingedrukt zonder los (docs/DUURTEST.md open punt 2, PROTOCOL.md §11 "Triggers
// blijven nooit hangen"). De kern weet niet welke bron (APC, virtueel in een cockpit, een tweede cockpit) een toets
// indrukt: voor hem is een toets in of uit. Een tweede druk op een toets die al in is, gaat bij dezelfde bestemming
// nergens heen; is de bestemming intussen een andere (focuswissel, Bank), dan krijgt de eerste eerst zijn los. De
// eerste los laat de toets los; een los op een toets die al los is, gaat nergens heen. Zo blijft er nooit iets hangen.
import { describe, it, expect } from 'vitest';
import { opzet, meldAan, stuurApp, druk, los, tik, draai, lpdDruk, lpdLos, van, leeg, FL, MS, DJ, CONFIG } from './kern-hulp.js';
import { PANIEK_MS } from '../src/core/kern.js';
import * as APC from '../src/devices/apc40mk2.js';

const C = { ...CONFIG, paniek: { naloop_s: 5 } };
/** Zelfde indeling als Formula Lab (take op pad5-2, paniek op Stop All), andere app. */
const FL2 = { ...FL, app: 'medisynth', naam: 'MediSynth' };
const trig = (v, id) => van(v, 'trig').filter((b) => b.id === id);
const midi = (v) => van(v, 'midi').map((b) => b.bytes);
const noot = (id) => APC.OP_ID.get(id);

describe('dezelfde toets twee keer ingedrukt (golf 8, §11)', () => {
  it('reproductie uit de duurtest: Stop All op A (APC), focus B, Stop All (cockpit), twee keer los → A krijgt zijn los, geen eeuwige paniek', () => {
    const { kern, klok } = opzet(C);
    const a = meldAan(kern, FL);
    const b = meldAan(kern, MS);
    expect(kern.focusApp).toBe('formula-lab');
    druk(kern, 'stopall');                 // APC
    kern.focus('medisynth');                // cockpit
    druk(kern, 'stopall');                 // cockpit, virtueel
    expect(trig(a, 'paniek')).toEqual([{ t: 'trig', id: 'paniek', aan: true }, { t: 'trig', id: 'paniek', aan: false }]);
    expect(kern.appPaniekTot.get('formula-lab')).toBeLessThan(Infinity);
    expect(trig(b, 'paniek')).toEqual([{ t: 'trig', id: 'paniek', aan: true }]);
    los(kern, 'stopall');
    los(kern, 'stopall');
    expect(trig(a, 'paniek').at(-1)).toEqual({ t: 'trig', id: 'paniek', aan: false });
    expect(trig(a, 'paniek').length).toBe(2);
    expect(trig(b, 'paniek')).toEqual([{ t: 'trig', id: 'paniek', aan: true }, { t: 'trig', id: 'paniek', aan: false }]);
    for (const [app, tot] of kern.appPaniekTot) expect(tot, app).toBeLessThan(Infinity);
    klok.loop(kern.paniekNaloopMs + 1);
    for (const [app, tot] of kern.appPaniekTot) expect(tot, app).toBeLessThanOrEqual(klok.nu());
    expect(kern.routes.size).toBe(0);
  });

  it('trigger-pad: focus A, druk, focus B, druk (cockpit), los, los → A krijgt zijn uit bij de tweede druk, B bij de eerste los', () => {
    const { kern } = opzet(C);
    const a = meldAan(kern, FL);
    const b = meldAan(kern, FL2);
    druk(kern, 'pad5-2');
    kern.focus('medisynth');
    druk(kern, 'pad5-2');
    expect(trig(a, 'take')).toEqual([{ t: 'trig', id: 'take', aan: true }, { t: 'trig', id: 'take', aan: false }]);
    expect(trig(b, 'take')).toEqual([{ t: 'trig', id: 'take', aan: true }]);
    los(kern, 'pad5-2');
    expect(trig(b, 'take')).toEqual([{ t: 'trig', id: 'take', aan: true }, { t: 'trig', id: 'take', aan: false }]);
    los(kern, 'pad5-2');
    expect(trig(a, 'take').length).toBe(2);
    expect(trig(b, 'take').length).toBe(2);
    expect(kern.apps.get('formula-lab').vast.size).toBe(0);
    expect(kern.apps.get('medisynth').vast.size).toBe(0);
    expect(kern.routes.size).toBe(0);
  });

  it('zelfde app, zelfde toets twee keer: hij is al in — geen tweede aan, geen gat in de paniek; de eerste los laat los', () => {
    const { kern } = opzet(C);
    const a = meldAan(kern, FL);
    druk(kern, 'stopall');
    druk(kern, 'stopall');
    expect(trig(a, 'paniek')).toEqual([{ t: 'trig', id: 'paniek', aan: true }]);
    expect(kern.appPaniekTot.get('formula-lab')).toBe(Infinity);
    los(kern, 'stopall');
    expect(trig(a, 'paniek')).toEqual([{ t: 'trig', id: 'paniek', aan: true }, { t: 'trig', id: 'paniek', aan: false }]);
    expect(kern.appPaniekTot.get('formula-lab')).toBeLessThan(Infinity);
    los(kern, 'stopall');
    expect(trig(a, 'paniek').length).toBe(2);

    leeg(a);
    druk(kern, 'pad5-2');
    druk(kern, 'pad5-2');
    los(kern, 'pad5-2');
    los(kern, 'pad5-2');
    expect(trig(a, 'take')).toEqual([{ t: 'trig', id: 'take', aan: true }, { t: 'trig', id: 'take', aan: false }]);
  });

  it('schakelaar en keuze: een tweede druk op een toets die al in is, schakelt niet nog eens', () => {
    const { kern } = opzet(C);
    const a = meldAan(kern, FL);
    leeg(a);
    druk(kern, 'pad4-2');
    druk(kern, 'pad4-2');
    los(kern, 'pad4-2');
    los(kern, 'pad4-2');
    expect(van(a, 'zet')).toEqual([{ t: 'zet', id: 'mute', v: 1, bron: 'apc40' }]);
    tik(kern, 'pad4-2');                    // daarna gewoon weer
    expect(van(a, 'zet').map((z) => z.v)).toEqual([1, 0]);
  });

  it('een los zonder druk (de toets was al los) gaat nergens heen, ook niet naar de app met focus', () => {
    const { kern } = opzet(C);
    druk(kern, 'stopall');                 // nog geen app: niemand
    const a = meldAan(kern, FL);
    leeg(a);
    los(kern, 'stopall');
    los(kern, 'pad5-2');
    expect(van(a, 'trig')).toEqual([]);
    expect(kern.appPaniekTot.has('formula-lab')).toBe(false);
  });

  it('Bank ertussen: pad vast op A, Bank in, dezelfde pad nog eens → A krijgt zijn uit; daarna hangt niets', () => {
    const { kern } = opzet(C);
    const a = meldAan(kern, FL);
    druk(kern, 'pad5-2');
    druk(kern, 'bank');
    druk(kern, 'pad5-2');
    expect(trig(a, 'take')).toEqual([{ t: 'trig', id: 'take', aan: true }, { t: 'trig', id: 'take', aan: false }]);
    los(kern, 'bank');
    los(kern, 'pad5-2');
    los(kern, 'pad5-2');
    expect(trig(a, 'take').length).toBe(2);
    expect(kern.routes.size).toBe(0);
    expect(kern.apps.get('formula-lab').vast.size).toBe(0);
  });

  it('Bank + Track Select op APC én cockpit: één focuswissel, niets blijft in', () => {
    const { kern } = opzet(C);
    meldAan(kern, FL);
    const b = meldAan(kern, MS);
    druk(kern, 'bank');
    druk(kern, 'bank');
    druk(kern, 'sel2');
    druk(kern, 'sel2');
    expect(kern.focusApp).toBe('medisynth');
    expect(van(b, 'focus')).toEqual([{ t: 'focus', aan: true }]);
    los(kern, 'sel2');
    los(kern, 'bank');
    expect(kern.hubIn).toBe(false);         // de eerste los laat los (de kern kent geen bronnen)
    los(kern, 'sel2');
    los(kern, 'bank');
    expect(kern.hubIn).toBe(false);
    expect(kern.routes.size).toBe(0);
  });

  it('Shift van twee bronnen: de eerste los laat Shift los; de shift-noot naar een lease-app blijft in balans', () => {
    const { kern } = opzet(C);
    const dj = meldAan(kern, DJ);
    leeg(dj);
    druk(kern, 'shift');
    druk(kern, 'shift');
    expect(kern.shiftIn).toBe(true);
    los(kern, 'shift');
    expect(kern.shiftIn).toBe(false);
    los(kern, 'shift');
    const c = noot('shift');
    expect(midi(dj)).toEqual([[0x90 | c.ch, c.n, 127], [0x80 | c.ch, c.n, 0]]);
  });

  it('lease-app: zelfde app krijgt één note-on en één note-off; na een focuswissel krijgt de eerste zijn note-off', () => {
    const { kern } = opzet(C);
    const dj = meldAan(kern, DJ);
    const a = meldAan(kern, FL);
    kern.focus('varve-dj');
    leeg(dj, a);
    const c = noot('pad5-2');
    druk(kern, 'pad5-2');
    druk(kern, 'pad5-2');
    los(kern, 'pad5-2');
    los(kern, 'pad5-2');
    expect(midi(dj)).toEqual([[0x90 | c.ch, c.n, 127], [0x80 | c.ch, c.n, 0]]);

    leeg(dj, a);
    druk(kern, 'pad5-2');                   // APC, naar Varve DJ
    kern.focus('formula-lab');
    druk(kern, 'pad5-2');                   // cockpit, naar Formula Lab
    expect(midi(dj)).toEqual([[0x90 | c.ch, c.n, 127], [0x80 | c.ch, c.n, 0]]);
    expect(trig(a, 'take')).toEqual([{ t: 'trig', id: 'take', aan: true }]);
    los(kern, 'pad5-2');
    los(kern, 'pad5-2');
    expect(midi(dj).length).toBe(2);
    expect(trig(a, 'take')).toEqual([{ t: 'trig', id: 'take', aan: true }, { t: 'trig', id: 'take', aan: false }]);
  });

  it('faders en knoppen (geen druk/los) maken geen route en blijven werken tijdens een dubbele druk', () => {
    const { kern } = opzet(C);
    const a = meldAan(kern, FL);
    druk(kern, 'stopall');
    druk(kern, 'stopall');
    draai(kern, 'fader1', 0);
    leeg(a);
    draai(kern, 'fader1', 0.5);
    expect(van(a, 'zet').at(-1)).toMatchObject({ id: 'in1' });
    expect([...kern.routes.keys()]).toEqual(['stopall']);
    los(kern, 'stopall');
    expect(kern.routes.size).toBe(0);
  });

  it('de APC valt weg terwijl de toets van twee bronnen in is: één los, de latere los van de cockpit gaat nergens heen', () => {
    const { kern } = opzet(C);
    const a = meldAan(kern, FL);
    druk(kern, 'stopall');
    druk(kern, 'stopall');
    kern.apparaatWeg('apc40');
    los(kern, 'stopall');
    expect(trig(a, 'paniek')).toEqual([{ t: 'trig', id: 'paniek', aan: true }, { t: 'trig', id: 'paniek', aan: false }]);
    expect(kern.appPaniekTot.get('formula-lab')).toBeLessThan(Infinity);
  });
});

describe('Stop All vast terwijl de app zijn paniek-trigger kwijtraakt (#laatLos → #stopAllLos)', () => {
  // Bij de los op Stop All beëindigt #manifestInvoer de paniek alleen als de indeling nog een paniek-trigger heeft.
  // Is de app intussen een lease geworden (of verloor zijn manifest de paniek), dan moet #laatLos het zelf doen.
  const LEASE_A = { ...DJ, app: 'formula-lab', naam: 'Formula Lab' };
  const ZONDER_PANIEK_A = { ...FL, params: FL.params.filter((p) => p.id !== 'paniek') };

  for (const [naam, manifest] of [['lease', LEASE_A], ['manifest zonder paniek', ZONDER_PANIEK_A]]) {
    it(`A wordt ${naam}, focus B, Stop All nog eens (cockpit), twee keer los → de paniek van A eindigt`, () => {
      const { kern, klok } = opzet(C);
      const a = meldAan(kern, FL);
      meldAan(kern, MS);
      druk(kern, 'stopall');               // APC, op A
      expect(kern.appPaniekTot.get('formula-lab')).toBe(Infinity);
      stuurApp(kern, a, { t: 'manifest', manifest });
      kern.focus('medisynth');
      druk(kern, 'stopall');               // cockpit, op B: A krijgt eerst zijn los
      expect(kern.appPaniekTot.get('formula-lab')).toBeLessThan(Infinity);
      los(kern, 'stopall');
      los(kern, 'stopall');
      for (const [app, tot] of kern.appPaniekTot) expect(tot, app).toBeLessThan(Infinity);
      klok.loop(kern.paniekNaloopMs + 1);
      for (const [app, tot] of kern.appPaniekTot) expect(tot, app).toBeLessThanOrEqual(klok.nu());
    });

    it(`A wordt ${naam} terwijl Stop All vast is, dan valt de APC weg → de paniek van A eindigt`, () => {
      const { kern } = opzet(C);
      const a = meldAan(kern, FL);
      druk(kern, 'stopall');
      stuurApp(kern, a, { t: 'manifest', manifest });
      kern.apparaatWeg('apc40');
      expect(kern.appPaniekTot.get('formula-lab')).toBeLessThan(Infinity);
      expect(kern.routes.size).toBe(0);
    });
  }
});

describe('een los die nooit aankomt (verloren note-off, snelle replug zonder apparaatWeg)', () => {
  // Bewust vastgelegd (§11): de hub ziet de toets nog als in. De eerstvolgende druk bij dezelfde app telt niet
  // ("hij is al in"), de los erna laat hem los. Er blijft niets hangen; het kost Clay hooguit één tik.
  it('trigger: druk zonder los, dan twee tikken → aan, uit, aan, uit (één tik gemist, niets hangt)', () => {
    const { kern } = opzet(C);
    const a = meldAan(kern, FL);
    druk(kern, 'pad5-2');                   // de los gaat verloren
    tik(kern, 'pad5-2');
    tik(kern, 'pad5-2');
    expect(trig(a, 'take').map((t) => t.aan)).toEqual([true, false, true, false]);
    expect(kern.routes.size).toBe(0);
    expect(kern.apps.get('formula-lab').vast.size).toBe(0);
  });

  it('schakelaar: druk zonder los, dan een tik → schakelt niet; de tik daarna wel', () => {
    const { kern } = opzet(C);
    const a = meldAan(kern, FL);
    druk(kern, 'pad4-2');                   // mute aan, de los gaat verloren
    leeg(a);
    tik(kern, 'pad4-2');
    expect(van(a, 'zet')).toEqual([]);
    tik(kern, 'pad4-2');
    expect(van(a, 'zet').map((z) => z.v)).toEqual([0]);
  });
});

describe('LPD8-pads van twee bronnen (echte en virtuele LPD8)', () => {
  it('P1: een tweede druk tijdens de paniek start geen tweede paniek; de eerste los beëindigt hem, daarna niets meer', () => {
    const { kern, klok } = opzet(C);
    const a = meldAan(kern, FL);
    leeg(a);
    lpdDruk(kern, 1);                       // echte LPD8
    klok.loop(PANIEK_MS + 50);
    expect(kern.paniekActief).toBe(true);
    lpdDruk(kern, 1);                       // virtueel
    klok.loop(PANIEK_MS + 50);
    expect(trig(a, 'paniek')).toEqual([{ t: 'trig', id: 'paniek', aan: true }]);
    lpdLos(kern, 1);
    expect(kern.paniekActief).toBe(false);
    expect(kern.p1Timer).toBe(null);
    lpdLos(kern, 1);
    klok.loop(PANIEK_MS * 3);
    expect(kern.paniekActief).toBe(false);
    expect(trig(a, 'paniek')).toEqual([{ t: 'trig', id: 'paniek', aan: true }, { t: 'trig', id: 'paniek', aan: false }]);
  });

  it('P5–P8: lang of kort telt vanaf de laatste druk (bij twijfel laden, nooit per ongeluk een snapshot overschrijven)', () => {
    const { kern, klok } = opzet(C);
    const a = meldAan(kern, FL, { staat: { in1: 0.2 } });
    kern.bewaar(1);
    const bewaard = structuredClone(kern.snapshots.get(1));
    stuurApp(kern, a, { t: 'zet', id: 'in1', v: 0.9 });
    leeg(a);
    lpdDruk(kern, 5);                       // echte LPD8
    klok.loop(400);
    lpdDruk(kern, 5);                       // virtueel, 400 ms later
    klok.loop(400);
    lpdLos(kern, 5);                        // 800 ms na de eerste, 400 ms na de laatste druk: kort = laden
    expect(kern.snapshots.get(1)).toEqual(bewaard);
    expect(van(a, 'zet')).toEqual([{ t: 'zet', id: 'in1', v: 0.2, bron: 'snapshot' }]);
    lpdLos(kern, 5);
    expect(van(a, 'zet').length).toBe(1);
    expect(kern.padDruk.size).toBe(0);
  });

  it('pads die alleen druk sturen (LPD8 in PC-modus) blijven werken: elke druk telt (daarom geen "al in" voor P2–P8)', () => {
    const { kern, opname } = opzet(C);
    meldAan(kern, FL);
    lpdDruk(kern, 4);
    lpdDruk(kern, 4);
    lpdDruk(kern, 4);
    expect(opname).toEqual([true, false, true]);
  });

  it('de LPD8 valt weg: wat in was is los; een latere los van de virtuele LPD8 doet niets, een nieuwe druk werkt', () => {
    const { kern, klok } = opzet(C);
    const a = meldAan(kern, FL);
    lpdDruk(kern, 1);
    klok.loop(PANIEK_MS + 50);
    kern.apparaatWeg('lpd8');
    expect(kern.paniekActief).toBe(false);
    lpdLos(kern, 1);
    leeg(a);
    lpdDruk(kern, 1);
    klok.loop(PANIEK_MS + 50);
    expect(trig(a, 'paniek')).toEqual([{ t: 'trig', id: 'paniek', aan: true }]);
    lpdLos(kern, 1);
    expect(kern.paniekActief).toBe(false);
  });
});
