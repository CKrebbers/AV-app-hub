// @ts-check
// Duurtest (tools/duurtest.mjs, docs/DUURTEST.md): een korte avond in CI, zodat een grove regressie (een lek, een
// structuur die groeit, een paniek die blijft hangen, een timer die na stoppen blijft staan) meteen opvalt. De
// lange run (minuten) draait lokaal. Daarnaast gerichte tests voor de lekken die de duurtest vond.
import { describe, it, expect } from 'vitest';
import { draaiDuurtest, rapportTekst, maakToeval, Agenda, groeit, heapOordeel } from '../tools/duurtest.mjs';
import { opzet, meldAan, nepVerbinding, stuurApp, FL, MS } from './kern-hulp.js';
import { ApcSessie, maakApparaten } from '../src/apparaten.js';
import { NepKlok } from '../src/core/klok.js';
import { NepSysteem } from '../src/ports/nep.js';
import { MAX_PARAMS } from '../src/protocol/manifest.js';

describe('duurtest: een korte avond met de hele hub', () => {
  it('drie minuten nep-tijd (plus afbouw): geen lek, geen geschonden invariant, en er gebeurde van alles', async () => {
    // Seed 7 en een vaste nep-duur: elke run precies dezelfde avond, hoe snel de machine ook is.
    const r = await draaiDuurtest({ nepMs: 3 * 60_000, seed: 7, meetElkeMs: 500, heap: false });
    if (!r.ok) console.log(rapportTekst(r));
    expect(r.schendingen).toEqual([]);
    expect(r.lekken).toEqual([]);
    expect(r.ok).toBe(true);
    // De avond was echt een avond: alle soorten bediening en storing kwamen voor.
    for (const a of ['apc.fader', 'apc.knop', 'apc.toets', 'focus.apc', 'lpd8.knop', 'paniek', 'cockpit.zet', 'cockpit.virtueel', 'rommel', 'app.herstart', 'app.hapering']) {
      expect(r.acties[a] ?? 0, a).toBeGreaterThan(0);
    }
    expect(r.nepS).toBeGreaterThanOrEqual(180);
    expect(r.berichten.totaal.naarApp).toBeGreaterThan(10_000);
    expect(r.berichten.totaal.cockpit).toBeGreaterThan(1_000);
    // Na stoppen staat er niets meer op de klok; zonder clients zijn alleen de drivers verbonden.
    expect(r.timers.naStop).toBe(0);
    expect(r.groottes['kern.verbindingen'].naClients).toBe(3);
    expect(r.metingen.length).toBeGreaterThan(3);
  }, 180_000);
});

describe('duurtest: hulpmiddelen', () => {
  it('dezelfde seed geeft hetzelfde toeval, een andere seed ander', () => {
    const reeks = (/** @type {number} */ s) => { const t = maakToeval(s); return Array.from({ length: 5 }, () => t.getal()); };
    expect(reeks(7)).toEqual(reeks(7));
    expect(reeks(7)).not.toEqual(reeks(8));
    const t = maakToeval(1);
    for (let i = 0; i < 100; i++) { const g = t.geheel(2, 4); expect(g >= 2 && g <= 4).toBe(true); }
  });
  it('de agenda voert uit op tijd, bij gelijke tijd in volgorde van plannen', () => {
    const a = new Agenda();
    const uit = /** @type {string[]} */ ([]);
    a.plan(20, () => uit.push('b'));
    a.plan(10, () => uit.push('a'));
    a.plan(20, () => uit.push('c'));
    while (a.lengte) a.neem()?.fn();
    expect(uit).toEqual(['a', 'b', 'c']);
  });
  it('groeit: schommelen is geen groei, gestaag oplopen wel', () => {
    expect(groeit([0, 5, 0, 7, 3, 9, 0, 4, 8, 1, 6, 2])?.groeit).toBe(false);
    expect(groeit(Array.from({ length: 16 }, (_, i) => i * 20))?.groeit).toBe(true);
    expect(groeit([1, 2, 3])).toBeNull(); // te weinig metingen
    // Een wachtrij die toevallig vol is op het moment van meten (een volle repaint na het insteken) is geen groei.
    expect(groeit([...Array.from({ length: 15 }, () => 0), 400])?.groeit).toBe(false);
  });
  it('heapOordeel: ruis en pieken zijn geen lek, een stijgend minimum wel', () => {
    const MB = 1024 * 1024;
    const ruis = Array.from({ length: 30 }, (_, i) => (20 + (i % 3) * 4) * MB);
    expect(heapOordeel(ruis)?.lek).toBe(false);
    const lek = Array.from({ length: 30 }, (_, i) => (20 + i) * MB);
    expect(heapOordeel(lek)?.lek).toBe(true);
  });
});

describe('lekken die de duurtest vond', () => {
  it('een app die nooit een manifest stuurde, wordt vergeten als zijn verbinding dicht gaat (slot vrij, focus weg)', () => {
    const { kern } = opzet();
    for (let i = 0; i < 20; i++) {
      const v = nepVerbinding();
      kern.verbind(v);
      stuurApp(kern, v, { t: 'hallo', app: `proef-${i}`, inst: `p${i}`, v: 1 });
      kern.verbreek(v);
    }
    expect(kern.apps.size).toBe(0);
    expect(kern.beeld().apps).toEqual([]);
    expect(kern.focusApp).toBeNull();
    // Het slot van een vergeten app komt vrij voor de volgende.
    const fl = meldAan(kern, FL);
    expect(kern.apps.get('formula-lab')?.slot).toBe(1);
    expect(kern.focusApp).toBe('formula-lab');
    // Een app mét manifest blijft bekend (status weg, waarden bewaard), zoals altijd.
    kern.verbreek(fl);
    expect(kern.apps.get('formula-lab')?.status).toBe('weg');
  });

  it('vóór het manifest onthoudt de kern alleen geldige ids, hooguit zoveel als een manifest params heeft', () => {
    const { kern } = opzet();
    const v = nepVerbinding();
    kern.verbind(v);
    stuurApp(kern, v, { t: 'hallo', app: 'rommel', inst: 'r', v: 1 });
    for (let i = 0; i < 1000; i++) stuurApp(kern, v, { t: 'zet', id: `onzin-${i}`, v: 0.5 });
    stuurApp(kern, v, { t: 'zet', id: 'GEEN GELDIGE ID!', v: 0.5 });
    const a = /** @type {any} */ (kern.apps.get('rommel'));
    expect(Object.keys(a.waarden).length).toBe(MAX_PARAMS);
    expect(a.waarden).not.toHaveProperty('GEEN GELDIGE ID!');
  });

  it('een nieuw manifest ruimt de waarden op van parameters die het niet (meer) heeft', () => {
    const { kern } = opzet();
    const v = nepVerbinding();
    kern.verbind(v);
    stuurApp(kern, v, { t: 'hallo', app: 'medisynth', inst: 'm', v: 1 });
    stuurApp(kern, v, { t: 'staat', waarden: { galm: 0.7, ruis1: 0.1, ruis2: 0.2 } });   // vóór het manifest
    stuurApp(kern, v, { t: 'manifest', manifest: MS });
    expect(Object.keys(/** @type {any} */ (kern.apps.get('medisynth')).waarden).sort()).toEqual(['galm', 'licht']);
    expect(kern.apps.get('medisynth')?.waarden.galm).toBe(0.7);   // een eigen parameter houdt zijn waarde
    // Een app in ontwikkeling stuurt steeds een ander manifest: de waarden groeien niet mee.
    for (let i = 0; i < 50; i++) {
      stuurApp(kern, v, { t: 'manifest', manifest: { ...MS, params: [{ id: `p${i}`, naam: 'P', soort: 'waarde' }, ...MS.params] } });
    }
    expect(Object.keys(/** @type {any} */ (kern.apps.get('medisynth')).waarden).sort()).toEqual(['galm', 'licht', 'p49']);
    expect(kern.beeld().apps[0].waarden).toEqual({ galm: 0.7, licht: 0, p49: 0 });
  });

  it('een APC die losgetrokken wordt terwijl er nog LEDs in de wachtrij staan, laat de hub niet vallen', () => {
    const klok = new NepKlok();
    const systeem = new NepSysteem();
    systeem.voegToe('APC40 mkII');
    const app = maakApparaten({ systeem, klok, config: { apparaten: { apc40: { naam: 'apc40' }, lpd8: { naam: 'lpd8' } } } });
    const fouten = /** @type {unknown[]} */ ([]);
    app.apc.bij('fout', (/** @type {unknown} */ e) => fouten.push(e));
    let weg = 0;
    app.apc.bij('weg', () => { weg++; });
    app.start();
    klok.loop(10);
    for (let i = 0; i < 64; i++) app.apc.stuur([0x90, i % 40, 5]);   // vier porties van 16
    systeem.verwijder('APC40 mkII');                                   // de poort is dicht, de hotplug-ronde komt pas straks
    expect(() => klok.loop(100)).not.toThrow();
    expect(fouten).toHaveLength(1);                                    // één melding per storing, niet per bericht
    klok.loop(2000);                                                   // de hotplug-ronde ziet hem weg
    expect(weg).toBe(1);
    app.lpd8.stop();
    app.apc.stop();
  });

  it('ApcSessie.zwartEnWacht laat geen wachttimer op de klok staan, en stop() laat niets in de wachtrij', async () => {
    const klok = new NepKlok();
    const s = new ApcSessie({ dev: 'apc40', patroon: /apc/i, systeem: /** @type {any} */ ({}), klok });
    s.poort = /** @type {any} */ ({ naam: 'nep', stuur: () => {} });
    const wacht = s.zwartEnWacht(500);
    klok.loop(50);            // de wachtrij is leeg (16 per 4 ms)
    await wacht;
    expect(klok.timers.size).toBe(0);
    s.stuur([0x90, 1, 1]);
    s.stop();
    expect(s.rij.lengte).toBe(0);
    expect(klok.timers.size).toBe(0);
  });

  it('na hub-stop van de apparaten staat er niets meer op de klok', async () => {
    const klok = new NepKlok();
    const systeem = new NepSysteem();
    systeem.voegToe('APC40 mkII');
    const app = maakApparaten({ systeem, klok, config: { apparaten: { apc40: { naam: 'apc40' }, lpd8: { naam: 'lpd8' } } } });
    app.start();
    klok.loop(100);
    expect(app.apc.verbonden).toBe(true);
    let klaar = false;
    const stop = app.stop().then(() => { klaar = true; });
    for (let i = 0; i < 100 && !klaar; i++) { klok.loop(10); await Promise.resolve(); await Promise.resolve(); }
    await stop;
    expect(klok.timers.size).toBe(0);
  });
});
