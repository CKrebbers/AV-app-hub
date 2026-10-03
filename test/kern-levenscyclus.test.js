// Levenscyclus: ApcSessie (zwart, init/opnieuw aansluiten, weg), verbindingen die wegvallen of worden
// vervangen, truth hub, hb_s, en een paar randgevallen van config.
import { describe, it, expect } from 'vitest';
import * as APC from '../src/devices/apc40mk2.js';
import {
  opzet, opzetApc, meldAan, stuurApp, nepVerbinding, druk, los, tik, draai, van, leeg, hardware, CONFIG, FL, MS, DJ, AVK,
} from './kern-hulp.js';

describe('kern + ApcSessie: lease buiten het LED-model om', () => {
  it('zwart() terwijl een lease-app focus heeft: echt alles uit (afsluiten)', async () => {
    const { kern, s, draad, sync } = await opzetApc();
    const dj = meldAan(kern, DJ);
    stuurApp(kern, dj, { t: 'led', bytes: [[0x90, 3, 9], [0x90, 50, 127]] });
    sync();
    expect(hardware(draad).get('rgb:3')).toBe('9');
    s.zwart();
    sync();
    const h = hardware(draad);
    expect(h.get('rgb:3')).toBe('uit');
    expect(h.get('n:0:50')).toBe(0);
    kern.stop();
  });

  it('opnieuw aansluiten (init + verbonden) met een lease-app in focus: zijn kaart komt terug', async () => {
    const { kern, s, draad, sync } = await opzetApc();
    const dj = meldAan(kern, DJ);
    stuurApp(kern, dj, { t: 'led', bytes: [[0x90, 3, 9]] });
    sync();
    s.meld('weg', 'apc40');
    s.init();
    s.meld('verbonden', 'apc40');
    sync();
    expect(hardware(draad).get('rgb:3')).toBe('9');
    kern.stop();
  });

  it('opnieuw aansluiten met een manifest-app in focus: alles opnieuw getekend', async () => {
    const { kern, s, draad, sync } = await opzetApc();
    meldAan(kern, FL, { staat: { palet: 1 } });
    sync();
    const voor = hardware(draad);
    draad.length = 0;
    s.init();
    s.meld('verbonden', 'apc40');
    sync();
    const na = hardware(draad);
    for (const [k, v] of voor) expect([k, na.get(k)]).toEqual([k, v]);
    kern.stop();
  });

  it('APC valt weg terwijl de hubtoets is ingedrukt: niets blijft hangen', async () => {
    const { kern, s } = await opzetApc();
    const fl = meldAan(kern, FL);
    druk(kern, 'pad5-2'); // take (trigger) vast
    expect(van(fl, 'trig')).toEqual([{ t: 'trig', id: 'take', aan: true }]);
    druk(kern, 'bank');
    s.meld('weg', 'apc40');
    expect(van(fl, 'trig').at(-1)).toEqual({ t: 'trig', id: 'take', aan: false });
    leeg(fl);
    tik(kern, 'pad4-2'); // mute, gaat weer naar de app
    expect(van(fl, 'zet')).toEqual([{ t: 'zet', id: 'mute', v: 1, bron: 'apc40' }]);
    kern.stop();
  });

  it('stop() meldt de kern af bij het oppervlak', async () => {
    const { kern, s } = await opzetApc();
    meldAan(kern, FL);
    druk(kern, 'bank');
    kern.stop();
    s.meld('weg', 'apc40');
    expect(kern.hubIn).toBe(true);
  });
});

describe('kern: lease-app die wegvalt', () => {
  it('focus-app verbreekt: oppervlak uit; terug = zijn kaart terug', () => {
    const { kern, opp } = opzet();
    const dj = meldAan(kern, DJ);
    stuurApp(kern, dj, { t: 'led', bytes: [[0x90, 3, 9]] });
    const vergeten = opp.vergeten;
    kern.verbreek(dj);
    // het oppervlak tekent het lege model volledig opnieuw: alles uit
    expect(opp.vergeten).toBe(vergeten + 1);
    expect(opp.leds.get('pad1-4')).toEqual({});
    expect(kern.beeld().apps[0].status).toBe('weg');
    opp.gestuurd.length = 0;
    const dj2 = nepVerbinding();
    kern.verbind(dj2);
    stuurApp(kern, dj2, { t: 'hallo', app: 'varve-dj', inst: 'i1', v: 1 });
    expect(hardware(opp.gestuurd).get('rgb:3')).toBe('9');
    expect(van(dj2, 'focus')).toEqual([{ t: 'focus', aan: true }]);
  });

  it('met een echte ApcSessie: na verbreken staat pad 3 echt uit', async () => {
    const { kern, draad, sync } = await opzetApc();
    const dj = meldAan(kern, DJ);
    stuurApp(kern, dj, { t: 'led', bytes: [[0x90, 3, 9]] });
    sync();
    kern.verbreek(dj);
    sync();
    expect(hardware(draad).get('rgb:3')).toBe('uit');
    kern.stop();
  });
});

describe('kern: verbindingen', () => {
  it('tweede verbinding van dezelfde app neemt over; de oude krijgt een fout en wordt gesloten', () => {
    const { kern } = opzet();
    const v1 = meldAan(kern, FL);
    let gesloten = 0;
    v1.sluit = () => { gesloten++; };
    const v2 = meldAan(kern, FL, { inst: 'i2' });
    expect(van(v1, 'fout')).toHaveLength(1);
    expect(gesloten).toBe(1);
    // een late hallo op de oude verbinding pakt de app niet terug
    stuurApp(kern, v1, { t: 'hallo', app: 'formula-lab', inst: 'i1', v: 1 });
    leeg(v1, v2);
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'in1', v: 0.5 });
    expect(van(v2, 'zet')).toHaveLength(1);
    expect(van(v1, 'zet')).toHaveLength(0);
    // en een hallo op een verbroken verbinding ook niet
    kern.verbreek(v2);
    stuurApp(kern, v2, { t: 'hallo', app: 'formula-lab', inst: 'i2', v: 1 });
    expect(kern.beeld().apps[0].status).toBe('weg');
  });

  it('truth hub: alleen de eerste staat na de replay wordt genegeerd; latere staat telt', () => {
    const { kern, klok } = opzet();
    const man = { v: 1, app: 'uurwerk', naam: 'Uurwerk', truth: 'hub', params: [{ id: 'x', naam: 'X', soort: 'waarde', standaard: 0.3 }] };
    const v1 = meldAan(kern, man);
    kern.verbreek(v1);
    const v2 = nepVerbinding();
    kern.verbind(v2);
    stuurApp(kern, v2, { t: 'hallo', app: 'uurwerk', inst: 'nieuw', v: 1 });
    stuurApp(kern, v2, { t: 'manifest', manifest: man });
    stuurApp(kern, v2, { t: 'staat', waarden: { x: 0 } });
    expect(kern.beeld().apps[0].waarden.x).toBe(0.3);
    klok.loop(1000);
    stuurApp(kern, v2, { t: 'staat', waarden: { x: 0.77 } });
    expect(kern.beeld().apps[0].waarden.x).toBe(0.77);
  });

  it('hartslag volgt manifest.hb_s: een app met hb_s 5 die op tijd klopt, wordt nooit stil', () => {
    const { kern, klok } = opzet();
    const v = meldAan(kern, { ...MS, hb_s: 5 });
    const st = () => kern.beeld().apps[0].status;
    for (let i = 0; i < 6; i++) { klok.loop(5000); expect(st()).toBe('actief'); stuurApp(kern, v, { t: 'hb' }); }
    klok.loop(15000); expect(st()).toBe('stil');
    klok.loop(35000); expect(st()).toBe('weg');
  });

  it('lease → manifest voor dezelfde app (nieuw manifest zonder lease): oppervlak vergeten en volledig getekend', () => {
    const { kern, opp } = opzet();
    const dj = meldAan(kern, DJ);
    stuurApp(kern, dj, { t: 'led', bytes: [[0x90, 3, 9]] });
    const v = opp.vergeten;
    stuurApp(kern, dj, { t: 'manifest', manifest: { v: 1, app: 'varve-dj', naam: 'Varve DJ', params: [{ id: 'x', naam: 'X', soort: 'waarde' }] } });
    expect(opp.vergeten).toBe(v + 1);
    expect(opp.gestuurd.slice(-16)).toEqual(APC.ringTypeBerichten(APC.RING.single));
  });
});

describe('kern: config', () => {
  it('rings valt terug op config.apps.<app>.rings', () => {
    const config = { ...CONFIG, apps: { ...CONFIG.apps, 'av-kern': { ...CONFIG.apps['av-kern'], rings: 'auto' } } };
    const { kern, opp } = opzet(config);
    const { rings, ...zonder } = AVK;
    expect(rings).toBe('auto');
    meldAan(kern, zonder);
    opp.gestuurd.length = 0;
    draai(kern, 'tk3', 0.5);
    expect(opp.gestuurd).toEqual([[0xb0, 50, 64]]);
    // manifest wint van config
    const { kern: k2, opp: o2 } = opzet(config);
    meldAan(k2, { ...zonder, rings: 'host' });
    o2.gestuurd.length = 0;
    draai(k2, 'tk3', 0.5);
    expect(o2.gestuurd).toEqual([]);
  });

  it('numerieke hubtoets (103 = Bank) werkt als de naam', () => {
    const { kern } = opzet({ ...CONFIG, hubtoets: 103 });
    meldAan(kern, FL);
    meldAan(kern, MS);
    druk(kern, 'bank');
    tik(kern, 'sel2');
    los(kern, 'bank');
    expect(kern.focusApp).toBe('medisynth');
  });

  it("'invoer'-event voor elke gebeurtenis; slot gedimd voor een app zonder manifest", () => {
    const { kern, opp } = opzet();
    const gezien = [];
    kern.bij('invoer', (g) => gezien.push(g.el));
    meldAan(kern, FL);
    const v = nepVerbinding();
    kern.verbind(v);
    stuurApp(kern, v, { t: 'hallo', app: 'medisynth', inst: 'i', v: 1 });
    druk(kern, 'bank');
    expect(opp.leds.get('pad5-2')).toEqual({ kleur: APC.dichtsteKleur('#312059') }); // #8b5cff op ≈ een derde
    los(kern, 'bank');
    expect(gezien).toEqual(['bank', 'bank']);
  });
});
