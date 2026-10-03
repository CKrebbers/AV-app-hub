// Golf 2: fouten in de kern die bij de chaostests boven kwamen. Elke test liet de fout eerst zien.
import { describe, it, expect } from 'vitest';
import * as APC from '../src/devices/apc40mk2.js';
import {
  opzet, opzetApc, meldAan, stuurApp, nepVerbinding, druk, los, tik, draai, lpd, lpdDruk, lpdLos, van, leeg, hardware,
  CONFIG, FL, MS, DJ,
} from './kern-hulp.js';

const MODE40 = [0xf0, 0x47, 0x7f, 0x29, 0x60, 0x00, 0x04, 0x40, 0x00, 0x00, 0x00, 0xf7];

describe('LPD8-pickup volgt wijzigingen van buitenaf (§10: er springt nooit iets)', () => {
  const X = { v: 1, app: 'x', naam: 'X', params: [{ id: 'galm', naam: 'G', soort: 'waarde', rol: 'macro.ruimte', standaard: 0.2 }] };
  const k3 = (kern, r) => lpd(kern, [0xb0, 72, r]);

  it('na een snapshot wacht K3 weer tot hij de nieuwe waarde kruist', () => {
    const { kern } = opzet();
    const x = meldAan(kern, X);
    k3(kern, 25); k3(kern, 26);
    kern.bewaar(1);
    for (let r = 26; r <= 100; r += 2) k3(kern, r);
    expect(kern.apps.get('x').waarden.galm).toBeCloseTo(100 / 127, 3);
    kern.laad(1);
    const na = kern.apps.get('x').waarden.galm;
    leeg(x);
    k3(kern, 101);
    expect(van(x, 'zet')).toEqual([]);
    expect(kern.apps.get('x').waarden.galm).toBe(na);
    // terugdraaien tot over de nieuwe waarde: dan pakt hij weer op
    for (let r = 100; r >= 20; r -= 2) k3(kern, r);
    expect(van(x, 'zet').length).toBeGreaterThan(0);
  });

  it('na een zet van de app zelf springt de eerste tik niet', () => {
    const { kern } = opzet();
    const x = meldAan(kern, X);
    k3(kern, 25); k3(kern, 26);
    for (let r = 26; r <= 100; r += 2) k3(kern, r);
    stuurApp(kern, x, { t: 'zet', id: 'galm', v: 0.1 });
    leeg(x);
    k3(kern, 102);
    expect(van(x, 'zet')).toEqual([]);
    expect(kern.apps.get('x').waarden.galm).toBe(0.1);
  });
});

describe('Bank loslaten over een lease-app met alleen animatie', () => {
  it('pad5-1 knippert weer tegen uit, niet tegen de slotkleur', async () => {
    const { kern, draad, sync } = await opzetApc();
    meldAan(kern, FL);
    const dj = meldAan(kern, DJ);
    kern.focus('varve-dj');
    stuurApp(kern, dj, { t: 'led', bytes: [[0x9c, 32, 5]] });
    sync();
    expect(hardware(draad).get('rgb:32')).toBe('uit/12:5');
    druk(kern, 'bank'); sync(); los(kern, 'bank'); sync();
    expect(hardware(draad).get('rgb:32')).toBe('uit/12:5');
    kern.stop();
  });

  it('een scene-knop die pulseert komt terug zonder het wit van een bewaarde snapshot', async () => {
    const { kern, draad, sync } = await opzetApc();
    meldAan(kern, FL);
    const dj = meldAan(kern, DJ);
    kern.focus('varve-dj');
    kern.bewaar(1);
    stuurApp(kern, dj, { t: 'led', bytes: [[0x80, 82, 0], [0x97, 82, 45]] });
    sync();
    expect(hardware(draad).get('rgb:82')).toBe('uit/7:45');
    druk(kern, 'bank'); sync(); los(kern, 'bank'); sync();
    expect(hardware(draad).get('rgb:82')).toBe('uit/7:45');
    kern.stop();
  });
});

describe('verbindingen van een driver', () => {
  it('een WS-client met de app-id van een driver: weg is hij, dan neemt de driver het weer over', () => {
    const { kern } = opzet();
    const UW = { ...MS, app: 'uurwerk', naam: 'Uurwerk' };
    const drv = nepVerbinding(); // een driver: geen sluit()
    kern.verbind(drv);
    stuurApp(kern, drv, { t: 'hallo', app: 'uurwerk', inst: 'd1', v: 1 });
    stuurApp(kern, drv, { t: 'manifest', manifest: UW });
    const ws = nepVerbinding();
    ws.sluit = () => { ws.dicht = true; };
    kern.verbind(ws);
    stuurApp(kern, ws, { t: 'hallo', app: 'uurwerk', inst: 'w1', v: 1 });
    kern.verbreek(ws);
    expect(kern.apps.get('uurwerk').status).toBe('weg');
    stuurApp(kern, drv, { t: 'hb' });
    expect(kern.apps.get('uurwerk').status).toBe('actief');
    leeg(drv);
    kern.cockpit({ t: 'zet', app: 'uurwerk', id: 'galm', v: 0.3 });
    expect(van(drv, 'zet')).toEqual([{ t: 'zet', id: 'galm', v: 0.3, bron: 'cockpit' }]);
  });

  it('een vervangen WS-verbinding (met sluit) komt niet terug', () => {
    const { kern } = opzet();
    const ws1 = nepVerbinding(); ws1.sluit = () => {};
    kern.verbind(ws1);
    stuurApp(kern, ws1, { t: 'hallo', app: 'formula-lab', inst: 'a', v: 1 });
    stuurApp(kern, ws1, { t: 'manifest', manifest: FL });
    const ws2 = nepVerbinding(); ws2.sluit = () => {};
    kern.verbind(ws2);
    stuurApp(kern, ws2, { t: 'hallo', app: 'formula-lab', inst: 'b', v: 1 });
    kern.verbreek(ws2);
    stuurApp(kern, ws1, { t: 'hb' });
    expect(kern.apps.get('formula-lab').status).toBe('weg');
  });
});

describe('slots bij meer dan 8 apps', () => {
  it('een levende app krijgt het slot van een weggevallen app en is met Track Select te kiezen', () => {
    const { kern } = opzet();
    for (let i = 0; i < 8; i++) {
      const v = nepVerbinding();
      kern.verbind(v);
      stuurApp(kern, v, { t: 'hallo', app: `proef-${i}`, inst: 'i', v: 1 });
      kern.verbreek(v);
    }
    meldAan(kern, FL);
    const b = kern.beeld().apps;
    const slot = b.find((x) => x.app === 'formula-lab').slot;
    expect(slot).not.toBeNull();
    expect(b.filter((x) => x.slot === slot)).toHaveLength(1);
    expect(kern.slots.filter((x) => x === 'formula-lab')).toHaveLength(1);
    druk(kern, 'bank'); tik(kern, `sel${slot}`); los(kern, 'bank');
    expect(kern.focusApp).toBe('formula-lab');
  });

  it('een app zonder slot krijgt er een als hij terugkomt en er een vrij is geworden', () => {
    const { kern } = opzet();
    const vs = [];
    for (let i = 0; i < 8; i++) vs.push(meldAan(kern, { ...MS, app: `m${i}`, naam: `M${i}` }));
    const fl = meldAan(kern, FL);
    expect(kern.apps.get('formula-lab').slot).toBeNull(); // alle 8 leven nog
    kern.verbreek(fl);
    kern.verbreek(vs[3]);
    const fl2 = nepVerbinding();
    kern.verbind(fl2);
    stuurApp(kern, fl2, { t: 'hallo', app: 'formula-lab', inst: 'i2', v: 1 });
    expect(kern.apps.get('formula-lab').slot).toBe(4);
    expect(kern.apps.get('m3').slot).toBeNull();
  });
});

describe('trigger en een nieuw manifest', () => {
  it('los gaat naar de trigger die bij de druk hoorde, ook als het manifest intussen verschoof', () => {
    const { kern } = opzet();
    const fl = meldAan(kern, FL);
    druk(kern, 'pad5-2');
    expect(van(fl, 'trig')).toEqual([{ t: 'trig', id: 'take', aan: true }]);
    stuurApp(kern, fl, { t: 'manifest', manifest: { ...FL, params: [{ id: 'flits', naam: 'Flits', soort: 'trigger', hint: 'pad' }, ...FL.params] } });
    los(kern, 'pad5-2');
    expect(van(fl, 'trig')).toEqual([{ t: 'trig', id: 'take', aan: true }, { t: 'trig', id: 'take', aan: false }]);
    expect(kern.apps.get('formula-lab').vast.size).toBe(0);
  });
});

describe('gestopte kern', () => {
  it('een hallo na stop() start geen adem- of hartslagtimers meer', () => {
    const { kern, klok } = opzet();
    meldAan(kern, FL);
    kern.stop();
    const v = nepVerbinding();
    kern.verbind(v);
    stuurApp(kern, v, { t: 'hallo', app: 'medisynth', inst: 'i', v: 1 });
    expect(kern.ademTimer).toBeNull();
    expect(klok.timers.size).toBe(0);
  });
});

describe('P3 en de cockpit', () => {
  it('P3 stuurt een beeld, zodat de adem-cirkel opnieuw begint', () => {
    const { kern, klok, beelden } = opzet();
    meldAan(kern, FL);
    klok.loop(3000);
    const n = beelden();
    lpdDruk(kern, 3); lpdLos(kern, 3);
    klok.loop(BEELD_MARGE);
    expect(beelden()).toBe(n + 1);
  });
});
const BEELD_MARGE = 150;

describe('LED-berichten van een lease-app: precies één geldig bericht per element', () => {
  it('mode-SysEx verstopt achter iets anders, realtime-bytes en data > 127 gaan niet de draad op', () => {
    const { kern, opp } = opzet();
    const dj = meldAan(kern, DJ);
    opp.gestuurd.length = 0;
    stuurApp(kern, dj, {
      t: 'led', bytes: [
        [0x90, 0, 5, ...MODE40], [0xf0, 0x00, 0xf7, ...MODE40], [0xf0, 0xf8, ...MODE40.slice(1)],
        [0x90, 1, 200], [0x90, 2], [0xc0, 3, 4], [0x90, 3, 9],
      ],
    });
    expect(opp.gestuurd).toEqual([[0x90, 3, 9]]);
  });
});

describe('LED-flood van een lease-app', () => {
  /** Eén frame zoals een drukke lease-app hem stuurt: 40 pads basis + knipper, 16 ringen, 24 strip-LEDs. */
  const frame = (f) => {
    const b = [];
    for (let n = 0; n < 40; n++) b.push([0x90, n, (n + f) % 120 + 1], [0x9c, n, (n * 3 + f) % 120 + 1]);
    for (let i = 0; i < 8; i++) b.push([0xb0, 16 + i, f % 128], [0xb0, 48 + i, (f * 2) % 128]);
    for (let ch = 0; ch < 8; ch++) for (const n of [48, 49, 50]) b.push([0x90 | ch, n, f % 2 ? 1 : 0]);
    return b;
  };

  it('Bank is direct zichtbaar, ook na 10 s overspoelen', async () => {
    const { kern, s, draad, klok } = await opzetApc();
    const fl = meldAan(kern, FL);
    const dj = meldAan(kern, DJ);
    kern.focus('varve-dj');
    for (let f = 0; f < 600; f++) {
      stuurApp(kern, dj, { t: 'led', bytes: frame(f) });
      if (f % 60 === 0) stuurApp(kern, fl, { t: 'hb' });
      klok.loop(1000 / 60);
    }
    expect(s.rij.lengte).toBeLessThan(250); // hooguit LEASE_ACHTERSTAND_MS vooruit (was 32 000)
    druk(kern, 'bank');
    klok.loop(100); // was 8 s
    expect(String(hardware(draad).get('rgb:32')).split('/')[0]).toBe(String(kern.apps.get('formula-lab').kleur));
    kern.stop();
  });

  it('één enorm frame en dan focus naar een andere app: diens beeld staat er meteen', async () => {
    const { kern, s, klok } = await opzetApc();
    meldAan(kern, FL);
    const dj = meldAan(kern, DJ);
    kern.focus('varve-dj');
    klok.loop(100);
    const groot = Array.from({ length: 20000 }, (_, i) => [0x90, i % 40, (i % 120) + 1]);
    stuurApp(kern, dj, { t: 'led', bytes: groot });
    kern.focus('formula-lab');
    klok.loop(100);
    expect(s.rij.lengte).toBe(0);
    kern.stop();
  });
});

describe('ringen_nemen_waarde_over: false en lease-ringen', () => {
  const cfg = { ...CONFIG, ringen_nemen_waarde_over: false };

  it('een ring-LED van de lease-app telt niet als knopstand', () => {
    const { kern } = opzet(cfg);
    const fl = meldAan(kern, FL);
    const dj = meldAan(kern, DJ);
    draai(kern, 'dk1', 0);
    kern.focus('varve-dj');
    stuurApp(kern, dj, { t: 'led', bytes: [[0xb0, 16, 127]] });
    kern.focus('formula-lab');
    leeg(fl);
    draai(kern, 'dk1', 1 / 127);
    expect(van(fl, 'zet')).toEqual([]);
    expect(kern.apps.get('formula-lab').waarden.ruimte).toBe(0.4);
  });

  it('ook niet als de hub de ring onder de hubtoets terugzet', () => {
    const { kern } = opzet(cfg);
    const fl = meldAan(kern, FL);
    const dj = meldAan(kern, DJ);
    kern.focus('varve-dj');
    stuurApp(kern, dj, { t: 'led', bytes: [[0xb0, 16, 127]] });
    druk(kern, 'bank');
    draai(kern, 'dk1', 0);
    los(kern, 'bank');
    kern.focus('formula-lab');
    leeg(fl);
    draai(kern, 'dk1', 1 / 127);
    expect(van(fl, 'zet')).toEqual([]);
  });
});

void APC;
