import { describe, it, expect } from 'vitest';
import * as APC from '../src/devices/apc40mk2.js';
import { opzet, meldAan, stuurApp, druk, los, tik, draai, van, leeg, hardware, FL, DJ, AVK } from './kern-hulp.js';

const MODUS = APC.intro(0x41);

describe('kern: lease-apps', () => {
  it('routeert alle APC-invoer als midi, behalve de hubtoets en alles terwijl die is ingedrukt', () => {
    const { kern } = opzet();
    const dj = meldAan(kern, DJ);
    leeg(dj);
    tik(kern, 'pad1-1');
    draai(kern, 'fader3', 0.5);
    expect(van(dj, 'midi')).toEqual([
      { t: 'midi', dev: 'apc40', bytes: [0x90, 0, 127] },
      { t: 'midi', dev: 'apc40', bytes: [0x80, 0, 0] },
      { t: 'midi', dev: 'apc40', bytes: [0xb2, 7, 64] },
    ]);
    leeg(dj);
    druk(kern, 'bank');
    tik(kern, 'pad2-2');
    draai(kern, 'fader1', 0.2);
    los(kern, 'bank');
    expect(van(dj, 'midi')).toEqual([]);
    // een toets die vóór de hubtoets werd ingedrukt, krijgt zijn 'los' toch
    druk(kern, 'shift');
    druk(kern, 'bank');
    los(kern, 'shift');
    los(kern, 'bank');
    expect(van(dj, 'midi').map((m) => m.bytes)).toEqual([[0x90, 98, 127], [0x80, 98, 0]]);
  });

  it('LED-kaart: bewaard per app, alleen getekend met focus; volledige repaint bij wisselen', () => {
    const { kern, opp } = opzet();
    const fl = meldAan(kern, FL);
    const dj = meldAan(kern, DJ);
    const led = [[0x90, 0, 5], [0x97, 0, 9], [0x90, 51, 127], [0x90, 82, 21], [0xb0, 16, 64], [0x92, 52, 2]];
    stuurApp(kern, dj, { t: 'led', bytes: led });
    expect(opp.gestuurd).toEqual([]); // geen focus: alleen bewaren

    kern.focus('varve-dj');
    const n = APC.MET_LED.length;
    // eerst alles uit (ringen op hun laatste stand: dk1 = de ring-LED van de app), dan ringtypes, dan de kaart
    expect(opp.gestuurd.slice(0, n)).toEqual(APC.MET_LED.flatMap((c) => APC.ledBerichten(c, c.led === 'ring' ? { waarde: c.id === 'dk1' ? 64 / 127 : 0 } : {})));
    expect(opp.gestuurd.slice(n + 16)).toEqual([[0x90, 0, 5], [0x97, 0, 9], [0x90, 51, 127], [0x90, 82, 21], [0x92, 52, 2]]);
    const beeldNa = hardware(opp.gestuurd);
    expect(beeldNa.get('rgb:0')).toBe('5/7:9');
    expect(beeldNa.get('n:2:52')).toBe(2);
    expect(kern.beeld().apps[1].lease).toBe(true);

    // met focus: meteen door, zonder model
    opp.gestuurd.length = 0;
    stuurApp(kern, dj, { t: 'led', bytes: [[0x90, 1, 45]] });
    expect(opp.gestuurd).toEqual([[0x90, 1, 45]]);

    // terug naar de manifest-app: vergeten + volledig tekenen, ringtypes terug
    const vergeten = opp.vergeten;
    kern.focus('formula-lab');
    expect(opp.vergeten).toBe(vergeten + 1);
    expect(opp.gestuurd.slice(1)).toEqual(APC.ringTypeBerichten(APC.RING.single));
    expect(opp.leds.get('pad1-1')).toEqual({});
    expect(opp.leds.get('dk1')).toEqual({ waarde: 0.4 });

    // en weer naar de lease-app: zelfde LED-beeld als zijn laatste staat
    opp.gestuurd.length = 0;
    kern.focus('varve-dj');
    const h = hardware(opp.gestuurd);
    expect(h.get('rgb:0')).toBe('5/7:9');
    expect(h.get('rgb:1')).toBe('45');
    expect(h.get('rgb:82')).toBe('21');
    expect(h.get('n:0:51')).toBe(127);
    expect(h.get('cc:0:16')).toBe(64);
    expect(h.get('rgb:2')).toBe('uit');
    expect(van(fl, 'midi')).toEqual([]);
  });

  it('lease → lease: alles uit en de kaart van de nieuwe app', () => {
    const { kern, opp } = opzet();
    const dj = meldAan(kern, DJ);
    const avk = meldAan(kern, AVK);
    stuurApp(kern, dj, { t: 'led', bytes: [[0x90, 3, 5]] });
    stuurApp(kern, avk, { t: 'led', bytes: [[0x90, 4, 45]] });
    opp.gestuurd.length = 0;
    kern.focus('av-kern');
    const h = hardware(opp.gestuurd);
    expect(h.get('rgb:3')).toBe('uit');
    expect(h.get('rgb:4')).toBe('45');
  });

  it('mode-SysEx van een app wordt nooit doorgestuurd', () => {
    const { kern, opp } = opzet();
    const dj = meldAan(kern, DJ);
    opp.gestuurd.length = 0;
    // rechtstreeks (ook als de transportlaag hem niet al zou filteren)
    kern.ontvang(dj, { t: 'led', bytes: [MODUS, [0x90, 0, 5]] });
    stuurApp(kern, dj, { t: 'led', bytes: [MODUS] });
    expect(opp.gestuurd).toEqual([[0x90, 0, 5]]);
  });

  it('rings:"auto": knop-CC gaat naar de app én terug naar de ring (emulatie van modus 0x41)', () => {
    const { kern, opp } = opzet();
    const avk = meldAan(kern, AVK);
    opp.gestuurd.length = 0;
    draai(kern, 'tk3', 0.5);
    expect(van(avk, 'midi').at(-1).bytes).toEqual([0xb0, 50, 64]);
    expect(opp.gestuurd).toEqual([[0xb0, 50, 64]]);
    // komt terug na wisselen
    meldAan(kern, FL);
    kern.focus('formula-lab');
    opp.gestuurd.length = 0;
    kern.focus('av-kern');
    expect(hardware(opp.gestuurd).get('cc:0:50')).toBe(64);

    // zonder rings:auto geen echo
    const { kern: k2, opp: o2 } = opzet();
    meldAan(k2, DJ);
    o2.gestuurd.length = 0;
    draai(k2, 'tk3', 0.5);
    expect(o2.gestuurd).toEqual([]);
  });

  it('hubtoets over een lease-app: overlay via bytes, loslaten zet de kaart terug', () => {
    const { kern, opp, leds } = opzet();
    const dj = meldAan(kern, DJ);
    stuurApp(kern, dj, { t: 'led', bytes: [[0x90, 32, 9]] }); // pad5-1 in DJ-kleur
    opp.gestuurd.length = 0;
    druk(kern, 'bank');
    const oranje = APC.dichtsteKleur('#ff7a1a');
    expect(opp.gestuurd).toContainEqual([0x96 + 3, 32, oranje]); // pulseren
    expect(kern.beeld().focus).toBe('varve-dj');
    // LED van de app tijdens de overlay: bewaren, niet tekenen
    opp.gestuurd.length = 0;
    stuurApp(kern, dj, { t: 'led', bytes: [[0x90, 32, 13], [0x90, 5, 13]] });
    expect(opp.gestuurd).toEqual([[0x90, 5, 13]]);
    opp.gestuurd.length = 0;
    leds.length = 0;
    los(kern, 'bank');
    expect(opp.gestuurd).toContainEqual([0x90, 32, 13]);
    expect(leds.at(-1).staat['pad5-1']).toEqual({ kleur: 13 });
    expect(van(dj, 'midi')).toEqual([]);
  });

  it('hartslag: stil en weg via de klok', () => {
    const { kern, klok } = opzet();
    meldAan(kern, DJ);
    klok.loop(3000);
    expect(kern.beeld().apps[0].status).toBe('stil');
    klok.loop(7000);
    expect(kern.beeld().apps[0].status).toBe('weg');
  });
});

describe('kern met een echte ApcSessie als oppervlak', () => {
  it('ApcSessie.vergeet(): volgende teken() stuurt alles opnieuw', async () => {
    const { ApcSessie } = await import('../src/apparaten.js');
    const { NepKlok } = await import('../src/core/klok.js');
    const s = new ApcSessie({ dev: 'apc40', patroon: /apc/i, systeem: /** @type {any} */ ({}), klok: new NepKlok() });
    s.teken();
    expect(s.teken()).toBe(0);
    s.vergeet();
    expect(s.teken()).toBe(APC.MET_LED.length);
  });

  it('manifest → lease → manifest: de draad eindigt in precies het manifest-beeld', async () => {
    const { ApcSessie } = await import('../src/apparaten.js');
    const { NepKlok } = await import('../src/core/klok.js');
    const { Kern } = await import('../src/core/kern.js');
    const { CONFIG } = await import('./kern-hulp.js');
    const klok = new NepKlok();
    const s = new ApcSessie({ dev: 'apc40', patroon: /apc/i, systeem: /** @type {any} */ ({}), klok });
    const draad = [];
    s.rij.stuur = (b) => draad.push(b);
    const kern = new Kern({ klok, config: CONFIG, oppervlak: s });
    meldAan(kern, FL, { staat: { palet: 1 } });
    const dj = meldAan(kern, DJ);
    stuurApp(kern, dj, { t: 'led', bytes: [[0x90, 32, 5], [0x90, 3, 9], [0xb0, 16, 100]] });
    klok.loop(100); // de wachtrij stuurt 16 berichten per 4 ms
    const voor = hardware(draad);
    expect(voor.get('rgb:32')).not.toBe('uit');
    kern.focus('varve-dj');
    kern.focus('formula-lab');
    klok.loop(100);
    const na = hardware(draad);
    expect(na.get('rgb:32')).toBe(voor.get('rgb:32'));
    expect(na.get('rgb:3')).toBe('uit');
    expect(na.get('cc:0:16')).toBe(voor.get('cc:0:16'));
    for (const [k, v] of voor) expect([k, na.get(k)]).toEqual([k, v]);
    kern.stop();
  });
});
