// @ts-check
// Golf 8: een controller die sneller terug is dan één hotplug-ronde, en sturen dat mislukt (docs/DUURTEST.md "Open
// punten" 3, STATUS.md "Bekende risico's"). De hub sluit de poort dan meteen, opent hem opnieuw en initialiseert het
// apparaat opnieuw (APC: modus, ringtypes, alle LEDs; LPD8: identiteitsvraag); begrensd, zodat een kapotte poort geen
// lus wordt. Eén logregel per storing, niet per bericht.
import { describe, it, expect } from 'vitest';
import { NepKlok } from '../src/core/klok.js';
import { NepSysteem } from '../src/ports/nep.js';
import { maakApparaten } from '../src/apparaten.js';
import { HERSTEL, LIJST_MS, Aansluiting } from '../src/core/aansluiting.js';
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
    klok.loop(50);
    const nieuw = systeem.voegToe('APC40 mkII');      // t = 150: terug vóór de lijst-tik (250) het weg-zijn zag
    for (let i = 0; i < 40; i++) app.apc.zet(`pad${1 + (i % 5)}-${1 + (i % 8)}`, { kleur: 5 + i });
    app.apc.teken();                                  // de wachtrij stuurt naar de oude, dichte poort
    klok.loop(60);                                    // herstel (0 ms) en het hele beeld (142 berichten, 16 per 4 ms)
    expect(klok.nu()).toBeLessThan(LIJST_MS);
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
  it('één keer opnieuw openen, daarna alleen opnieuw initialiseren met toenemende pauzes; één fout-melding; komt terug zodra de poort weer werkt', () => {
    const { klok, systeem, app, meldingen, fouten } = opzet();
    const p = systeem.voegToe('APC40 mkII');
    p.kapot = true;                                   // open lukt, sturen niet
    /** @type {number[]} */ const pogingen = [];     // wanneer de hub de intro probeerde te sturen
    const stuur = p.stuur.bind(p);
    p.stuur = (b) => { if (b[0] === 0xf0 && b[1] === 0x47) pogingen.push(klok.nu()); stuur(b); };
    let opens = 0;
    const open = systeem.open.bind(systeem);
    systeem.open = (n) => { opens++; return open(n); };
    app.start();
    klok.loop(60000);
    expect(meldingen).toEqual(['verbonden', 'weg', 'verbonden']);   // alleen de eerste keer opnieuw open
    expect(opens).toBe(2);                            // ook de hotplug-rondes openen tijdens de pauzes niets
    expect(pogingen.length).toBeGreaterThan(3);       // hij probeert het wel opnieuw
    expect(pogingen.length).toBeLessThanOrEqual(14);  // maar niet elke 4 ms (dat waren er 15 000)
    expect(fouten).toHaveLength(1);
    const pauzes = pogingen.slice(1).map((t, i) => t - pogingen[i]);
    for (let i = 1; i < pauzes.length; i++) expect(pauzes[i]).toBeGreaterThanOrEqual(pauzes[i - 1]);
    expect(Math.max(...pauzes)).toBeLessThanOrEqual(HERSTEL.maxMs);

    p.kapot = false;                                  // weer goed (bv. een andere USB-poort)
    p.verstuurd.length = 0;
    klok.loop(HERSTEL.maxMs + config.hotplug_ms);
    expect(app.apc.verbonden).toBe(true);
    expect(p.verstuurd[0]).toEqual(A.intro(0x42));
    expect(p.verstuurd).toHaveLength(VOL_BEELD);
    expect(intros(p.verstuurd)).toBe(1);
    const daarna = [meldingen.length, pogingen.length];
    klok.loop(60000);
    expect([meldingen.length, pogingen.length]).toEqual(daarna);   // stabiel: niets meer opnieuw

    // Een nieuwe storing later is een nieuwe melding (en na lang goed weer meteen opnieuw openen).
    p.kapot = true;
    app.apc.zet('pad1-1', { kleur: 9 }); app.apc.teken();
    klok.loop(20);
    expect(fouten).toHaveLength(2);
    expect(meldingen.slice(daarna[0])).toEqual(['weg', 'verbonden']);
    app.apc.stop(); app.lpd8.stop();
  });

  it('een kapotte uitgang met een werkende ingang: de knoppen blijven aankomen, hooguit één keer weg (LPD8, een uur)', () => {
    const { klok, systeem, app } = opzet();
    const p = systeem.voegToe('LPD8 mk2');
    p.kapot = true;                                   // sturen gooit, de ingang werkt
    /** @type {string[]} */ const m = [];
    app.lpd8.bij('verbonden', () => m.push('verbonden'));
    app.lpd8.bij('weg', () => m.push('weg'));
    let aan = 0;
    app.lpd8.bij('gebeurtenis', () => aan++);
    app.start();
    const N = 36000;
    for (let i = 0; i < N; i++) { klok.loop(100); p.injecteer([0x99, 36, 100]); }
    expect(aan).toBe(N);
    expect(m.filter((x) => x === 'weg').length).toBeLessThanOrEqual(1);
    expect(app.lpd8.verbonden).toBe(true);
    app.apc.stop(); app.lpd8.stop();
  });

  it('een herstel dat gepland stond terwijl de ronde de poort al verving, sluit de nieuwe poort niet opnieuw', () => {
    const klok = new NepKlok(), systeem = new NepSysteem();
    /** @type {string[]} */ const m = [];
    const a = new Aansluiting({ systeem, patroon: /APC40/, klok, intervalMs: 2000,
      bijVerbonden: () => m.push('verbonden'), bijWeg: () => m.push('weg') });
    systeem.voegToe('APC40 mkII');
    a.start(); klok.loop(100);
    const oud = /** @type {any} */ (a.poort);
    systeem.verwijder('APC40 mkII');
    systeem.voegToe('APC40 mkII');
    a.herstel(oud);                                   // een stuurfout plant het herstel (0 ms) ...
    klok.wis(a.timer); a.kijk();                      // ... en vóór die timer draait de ronde (levend() false)
    klok.loop(5000);
    expect(m).toEqual(['verbonden', 'weg', 'verbonden']);
    expect(a.poort).not.toBe(oud);
    a.stop();
    expect(klok.timers.size).toBe(0);
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

/** Een systeem dat zich bij uittrekken gedraagt als RtMidi (src/ports/rtmidi.js): sturen gooit niet, de poort meldt
 *  niets en heeft geen levend(). Alleen de poortlijst ziet dat het apparaat weg was. @param {NepSysteem} nep */
function zoalsRtMidi(nep) {
  return {
    soort: 'rtmidi-nep',
    lijst: () => nep.lijst(),
    /** @param {string} naam */
    open(naam) {
      const p = nep.open(naam);
      return { naam: p.naam, stuur: (/** @type {number[]} */ b) => { try { p.stuur(b); } catch { /* alleen een WARNING op stderr */ } },
        bijBericht: (/** @type {any} */ fn) => p.bijBericht(fn), sluit: () => p.sluit() };
    },
  };
}

describe('met RtMidi (geen signaal van de poort) ziet de snelle lijst-tik een korte replug', () => {
  it('APC 0,6 s los, terug vóór de volgende ronde: weg, verbonden en opnieuw init binnen een tik', () => {
    const klok = new NepKlok(), nep = new NepSysteem();
    const app = maakApparaten({ systeem: zoalsRtMidi(nep), klok, config });
    /** @type {string[]} */ const m = [];
    app.apc.bij('verbonden', () => m.push('verbonden'));
    app.apc.bij('weg', () => m.push('weg'));
    nep.voegToe('APC40 mkII');
    app.start(); klok.loop(100);
    app.apc.zet('pad3-3', { kleur: 45 }); app.apc.teken(); klok.loop(10);
    nep.verwijder('APC40 mkII');
    app.apc.zet('pad3-4', { kleur: 46 }); app.apc.teken(); klok.loop(10);   // sturen "lukt" (RtMidi gooit niet)
    klok.loop(480);                                   // t = 600
    const nieuw = nep.voegToe('APC40 mkII');
    klok.loop(LIJST_MS);                              // t = 850, de volgende ronde is pas om 2000
    expect(m).toEqual(['verbonden', 'weg', 'verbonden']);
    expect(nieuw.verstuurd[0]).toEqual(A.intro(0x42));
    expect(nieuw.verstuurd).toContainEqual([0x90, 18, 45]);
    expect(nieuw.verstuurd).toHaveLength(VOL_BEELD);
    app.apc.stop(); app.lpd8.stop();
    expect(klok.timers.size).toBe(0);
  });

  it('een apparaat dat er niet is, opent de hub nog steeds alleen in de gewone ronde (hotplug_ms)', () => {
    const klok = new NepKlok(), nep = new NepSysteem();
    let opens = 0;
    const systeem = zoalsRtMidi(nep);
    const open = systeem.open;
    systeem.open = (n) => { opens++; return open(n); };
    const app = maakApparaten({ systeem, klok, config });
    app.start(); klok.loop(100);
    nep.voegToe('APC40 mkII');
    klok.loop(1800);
    expect(opens).toBe(0);                            // nog geen ronde geweest
    klok.loop(200);
    expect(opens).toBe(1);
    app.apc.stop(); app.lpd8.stop();
  });
});

describe('meldingen per soort storing', () => {
  /** @param {NepSysteem} systeem */
  function hikkend(systeem) {
    const lijst = systeem.lijst.bind(systeem);
    const h = { hik: 0, altijd: false };
    systeem.lijst = () => { if (h.altijd || h.hik > 0) { h.hik--; throw new Error('CoreMIDI hikje'); } return lijst(); };
    return h;
  }

  it('een hikje in de lijst terwijl de poort open is, is geen storing; een latere stuurfout wordt wel gemeld', () => {
    const { klok, systeem, app } = opzet();
    /** @type {string[]} */ const soorten = [];
    app.apc.bij('fout', (/** @type {Error} */ e, /** @type {string} */ soort) => soorten.push(`${soort}:${e.message}`));
    const h = hikkend(systeem);
    systeem.voegToe('APC40 mkII');
    app.start(); klok.loop(100);
    h.hik = 1; klok.loop(LIJST_MS);                   // één tik met een hikje
    expect(soorten).toEqual([]);
    expect(app.apc.verbonden).toBe(true);
    systeem.verwijder('APC40 mkII');                  // kabel eruit, met LED-verkeer
    app.apc.zet('pad1-1', { kleur: 3 }); app.apc.teken(); klok.loop(10);
    expect(soorten).toEqual(['sturen:poort APC40 mkII is dicht']);
    app.apc.stop(); app.lpd8.stop();
  });

  it('een lijst die steeds gooit terwijl de APC werkt: geen meldingen; is hij dicht, dan één openen-melding', () => {
    const { klok, systeem, app } = opzet();
    /** @type {string[]} */ const soorten = [];
    app.apc.bij('fout', (/** @type {Error} */ _e, /** @type {string} */ soort) => soorten.push(soort));
    const h = hikkend(systeem);
    systeem.voegToe('APC40 mkII');
    app.start(); klok.loop(100);
    h.altijd = true;
    for (let i = 0; i < 600; i++) { app.apc.zet('pad1-1', { kleur: i % 100 }); app.apc.teken(); klok.loop(100); }
    expect(soorten).toEqual([]);
    expect(app.apc.verbonden).toBe(true);
    app.apc.stop(); app.apc.start(); klok.loop(10000);   // nu niets open: de hub kan hem zo niet vinden
    expect(soorten).toEqual(['openen']);
    h.altijd = false; klok.loop(2000);
    expect(app.apc.verbonden).toBe(true);
    h.altijd = true; app.apc.stop(); app.apc.start(); klok.loop(4000);
    expect(soorten).toEqual(['openen', 'openen']);    // een nieuwe storing na een geslaagde open: weer gemeld
    app.apc.stop(); app.lpd8.stop();
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
      klok.loop(50);                                  // t = 150: nog vóór de lijst-tik
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
