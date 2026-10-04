// @ts-check
// Golf 8: een controller die sneller terug is dan één hotplug-ronde, en sturen dat mislukt (docs/DUURTEST.md "Open
// punten" 3, STATUS.md "Bekende risico's"). De hub sluit de poort dan meteen, opent hem opnieuw en initialiseert het
// apparaat opnieuw (APC: modus, ringtypes, alle LEDs; LPD8: identiteitsvraag); begrensd, zodat een kapotte poort geen
// lus wordt. Eén logregel per storing, niet per bericht.
import { describe, it, expect } from 'vitest';
import { NepKlok } from '../src/core/klok.js';
import { NepSysteem } from '../src/ports/nep.js';
import { maakApparaten } from '../src/apparaten.js';
import { HERSTEL } from '../src/core/aansluiting.js';
import { startHub } from '../src/hub.js';
import { laadConfig } from '../src/config.js';
import * as A from '../src/devices/apc40mk2.js';
import * as L from '../src/devices/lpd8.js';

const config = { hotplug_ms: 2000, led: { per_burst: 16, burst_ms: 4 }, apparaten: { apc40: { naam: 'apc40', modus: 0x42 }, lpd8: { naam: 'lpd8' } } };
const VOL_BEELD = 1 + 16 + 125;   // intro, 16 ringtypes, alle LEDs

function opzet() {
  const klok = new NepKlok(), systeem = new NepSysteem();
  const app = maakApparaten({ systeem, klok, config });
  /** @type {string[]} */
  const meldingen = [];
  /** @type {unknown[]} */
  const fouten = [];
  app.apc.bij('verbonden', () => meldingen.push('verbonden'));
  app.apc.bij('weg', () => meldingen.push('weg'));
  app.apc.bij('fout', (/** @type {unknown} */ e) => fouten.push(e));
  return { klok, systeem, app, meldingen, fouten };
}

/** De apparaten stoppen met een nep-klok (zwartEnWacht wacht op de wachtrij). @param {any} app @param {NepKlok} klok */
async function stopMet(app, klok) {
  let klaar = false;
  const stop = app.stop().then(() => { klaar = true; });
  for (let i = 0; i < 200 && !klaar; i++) { klok.loop(10); await Promise.resolve(); await Promise.resolve(); }
  await stop;
}

const intros = (/** @type {number[][]} */ v) => v.filter((b) => b[0] === 0xf0 && b[1] === 0x47).length;

describe('een controller die sneller terug is dan één hotplug-ronde', () => {
  it('APC 0,5 s los zonder dat er iets gestuurd wordt: weg, opnieuw verbonden, opnieuw init, en de hub hoort hem weer', () => {
    const { klok, systeem, app, meldingen } = opzet();
    systeem.voegToe('APC40 mkII');
    app.start(); klok.loop(100);
    app.apc.zet('pad3-3', { kleur: 45 }); app.apc.teken(); klok.loop(10);
    klok.loop(500);                                   // t = 610: midden tussen twee rondes (0 en 2000)
    systeem.verwijder('APC40 mkII');
    klok.loop(500);
    const nieuw = systeem.voegToe('APC40 mkII');      // terug vóór de volgende ronde
    klok.loop(5000);
    expect(meldingen).toEqual(['verbonden', 'weg', 'verbonden']);
    expect(nieuw.verstuurd[0]).toEqual(A.intro(0x42));
    expect(nieuw.verstuurd).toContainEqual([0x90, 18, 45]);     // hetzelfde beeld
    expect(nieuw.verstuurd).toHaveLength(VOL_BEELD);
    /** @type {any[]} */ const g = [];
    app.apc.bij('gebeurtenis', (/** @type {any} */ e) => g.push(e));
    nieuw.injecteer([0xb2, 7, 100]);
    expect(g).toEqual([{ dev: 'apc40', el: 'fader3', kind: 'waarde', v: 100 / 127, raw: 100 }]);
    app.apc.stop(); app.lpd8.stop();
    expect(klok.timers.size).toBe(0);
  });

  it('een stuurfout na een snelle replug: meteen (niet pas bij de volgende ronde) opnieuw openen en initialiseren', () => {
    const { klok, systeem, app, meldingen, fouten } = opzet();
    systeem.voegToe('APC40 mkII');
    app.start(); klok.loop(100);
    systeem.verwijder('APC40 mkII');
    klok.loop(200);
    const nieuw = systeem.voegToe('APC40 mkII');
    klok.loop(100);                                   // t = 400, de volgende ronde is pas om 2000
    for (let i = 0; i < 40; i++) app.apc.zet(`pad${1 + (i % 5)}-${1 + (i % 8)}`, { kleur: 5 + i });
    app.apc.teken();                                  // de wachtrij stuurt naar de oude, dichte poort
    klok.loop(60);                                    // herstel (0 ms) en het hele beeld (142 berichten, 16 per 4 ms)
    expect(klok.nu()).toBeLessThan(2000);
    expect(meldingen).toEqual(['verbonden', 'weg', 'verbonden']);
    expect(fouten).toHaveLength(1);                   // één melding, niet één per bericht
    expect(nieuw.verstuurd[0]).toEqual(A.intro(0x42));
    expect(nieuw.verstuurd).toHaveLength(VOL_BEELD);
    expect(nieuw.verstuurd).toContainEqual([0x90, 0, 5]);   // pad1-1 (rij 1 = onder) kreeg kleur 5 en staat er weer
    app.apc.stop(); app.lpd8.stop();
  });

  it('LPD8 0,5 s los: opnieuw verbonden, de identiteitsvraag gaat opnieuw, de pads werken weer', () => {
    const { klok, systeem, app } = opzet();
    systeem.voegToe('LPD8 mk2');
    /** @type {string[]} */ const m = [];
    app.lpd8.bij('verbonden', () => m.push('verbonden'));
    app.lpd8.bij('weg', () => m.push('weg'));
    app.start(); klok.loop(700);
    systeem.verwijder('LPD8 mk2');
    klok.loop(500);
    const nieuw = systeem.voegToe('LPD8 mk2');
    klok.loop(5000);
    expect(m).toEqual(['verbonden', 'weg', 'verbonden']);
    expect(nieuw.verstuurd).toEqual([[...L.IDENTITEIT_VRAAG]]);
    /** @type {any[]} */ const g = [];
    app.lpd8.bij('gebeurtenis', (/** @type {any} */ e) => g.push(e));
    nieuw.injecteer([0x99, 36, 100]);
    expect(g).toHaveLength(1);
    expect(g[0].kind).not.toBe('onbekend');
    app.apc.stop(); app.lpd8.stop();
  });

  it('een kabel die langer los is dan een ronde werkt nog zoals altijd (één weg, één verbonden)', () => {
    const { klok, systeem, app, meldingen } = opzet();
    systeem.voegToe('APC40 mkII');
    app.start(); klok.loop(100);
    systeem.verwijder('APC40 mkII'); klok.loop(4000);
    expect(meldingen).toEqual(['verbonden', 'weg']);
    const nieuw = systeem.voegToe('APC40 mkII'); klok.loop(2000);
    expect(meldingen).toEqual(['verbonden', 'weg', 'verbonden']);
    expect(nieuw.verstuurd).toHaveLength(VOL_BEELD);
    app.apc.stop(); app.lpd8.stop();
  });
});

describe('een kapotte poort wordt geen lus', () => {
  it('opnieuw openen met toenemende pauzes; één fout-melding; komt terug zodra de poort weer werkt', () => {
    const { klok, systeem, app, meldingen, fouten } = opzet();
    const p = systeem.voegToe('APC40 mkII');
    p.kapot = true;                                   // open lukt, sturen niet
    app.start();
    /** @type {number[]} */ const opens = [];
    app.apc.bij('verbonden', () => opens.push(klok.nu()));
    klok.loop(60000);
    const keer = meldingen.filter((x) => x === 'verbonden').length;
    expect(keer).toBeGreaterThan(3);                  // hij probeert het wel opnieuw
    expect(keer).toBeLessThanOrEqual(12);             // maar niet elke 4 ms (dat waren er 15 000)
    expect(fouten).toHaveLength(1);
    const pauzes = opens.slice(1).map((t, i) => t - opens[i]);
    for (let i = 1; i < pauzes.length; i++) expect(pauzes[i]).toBeGreaterThanOrEqual(pauzes[i - 1]);
    expect(Math.max(...pauzes)).toBeLessThanOrEqual(HERSTEL.maxMs + config.hotplug_ms);

    p.kapot = false;                                  // weer goed (bv. een andere USB-poort)
    p.verstuurd.length = 0;
    klok.loop(HERSTEL.maxMs + config.hotplug_ms);
    expect(app.apc.verbonden).toBe(true);
    expect(p.verstuurd[0]).toEqual(A.intro(0x42));
    expect(intros(p.verstuurd)).toBe(1);
    const daarna = meldingen.length;
    klok.loop(60000);
    expect(meldingen.length).toBe(daarna);            // stabiel: niets meer opnieuw

    // Een nieuwe storing later is een nieuwe melding.
    p.kapot = true;
    app.apc.zet('pad1-1', { kleur: 9 }); app.apc.teken();
    klok.loop(20);
    expect(fouten).toHaveLength(2);
    app.apc.stop(); app.lpd8.stop();
  });

  it('na een lange goede verbinding is de eerste storing weer meteen (de pauzes beginnen opnieuw)', () => {
    const { klok, systeem, app, meldingen } = opzet();
    const p = systeem.voegToe('APC40 mkII');
    app.start(); klok.loop(100);
    for (let i = 0; i < 3; i++) {
      klok.loop(HERSTEL.stabielMs + 1000);
      systeem.verwijder('APC40 mkII');
      const q = systeem.voegToe('APC40 mkII');
      app.apc.zet('pad1-1', { kleur: 10 + i }); app.apc.teken();
      klok.loop(20);
      expect(intros(q.verstuurd)).toBe(1);
    }
    expect(meldingen).toEqual(['verbonden', 'weg', 'verbonden', 'weg', 'verbonden', 'weg', 'verbonden']);
    expect(p.open).toBe(false);
    app.apc.stop(); app.lpd8.stop();
  });

  it('stoppen tijdens een pauze laat niets op de klok staan', async () => {
    const { klok, systeem, app } = opzet();
    const p = systeem.voegToe('APC40 mkII');
    p.kapot = true;
    app.start(); klok.loop(1000);                     // midden in de pauzes
    await stopMet(app, klok);
    expect(klok.timers.size).toBe(0);
    const n = systeem.geopend.size;
    klok.loop(60000);
    expect(systeem.geopend.size).toBe(n);
  });
});

describe('de hub meldt een mislukte stuuractie één keer, met advies', () => {
  it('APC: één logregel bij een storing (niet per bericht), en de cockpit ziet hem weer verbonden', async () => {
    const klok = new NepKlok();
    const systeem = new NepSysteem();
    systeem.voegToe('APC40 mkII');
    /** @type {string[]} */ const log = [];
    const hub = await startHub({ config: { ...laadConfig(), hotplug_ms: 2000 }, systeem, klok, poort: 0, drivers: false, opname: false, log: (...a) => log.push(a.join(' ')) });
    try {
      klok.loop(100);
      expect(hub.kern.beeld().apparaten.apc40.verbonden).toBe(true);
      systeem.verwijder('APC40 mkII');
      klok.loop(300);
      const nieuw = systeem.voegToe('APC40 mkII');
      for (let i = 1; i <= 8; i++) hub.apparaten.apc.zet(`pad5-${i}`, { kleur: 20 + i });
      hub.apparaten.apc.teken();
      klok.loop(50);
      expect(log.filter((r) => /sturen mislukt/.test(r))).toEqual(['APC: sturen mislukt — kabel los? de hub probeert opnieuw']);
      expect(hub.kern.beeld().apparaten.apc40.verbonden).toBe(true);
      expect(nieuw.verstuurd[0]).toEqual(A.intro(hub.apparaten.apc.modus));
    } finally {
      let klaar = false;
      const stop = hub.stop().then(() => { klaar = true; });
      for (let i = 0; i < 400 && !klaar; i++) { klok.loop(10); await new Promise((r) => setTimeout(r, 1)); }
      await stop;
    }
  });

  it('LPD8: dezelfde regel met de naam van de LPD8', async () => {
    const klok = new NepKlok();
    const systeem = new NepSysteem();
    const p = systeem.voegToe('LPD8 mk2');
    p.kapot = true;
    /** @type {string[]} */ const log = [];
    const hub = await startHub({ config: { ...laadConfig(), hotplug_ms: 2000 }, systeem, klok, poort: 0, drivers: false, opname: false, log: (...a) => log.push(a.join(' ')) });
    try {
      klok.loop(20000);
      expect(log.filter((r) => /sturen mislukt/.test(r))).toEqual(['LPD8: sturen mislukt — kabel los? de hub probeert opnieuw']);
    } finally {
      let klaar = false;
      const stop = hub.stop().then(() => { klaar = true; });
      for (let i = 0; i < 400 && !klaar; i++) { klok.loop(10); await new Promise((r) => setTimeout(r, 1)); }
      await stop;
    }
  });
});
