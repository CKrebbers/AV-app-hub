// De KP3+ als gebaar op de app met focus (PROTOCOL §21) en de klokbronnen (EFX-500 > tap > config, §20), in de kern.
// Geen hardware: de bytes gaan door de echte ontleders (src/devices/kp3plus.js, efx500.js), de tijd is een NepKlok.
// De CC-nummers zijn de gok uit config (12/13/92); wat de echte KP3+ stuurt, meet de proef kp3plus.
import { describe, it, expect } from 'vitest';
import * as KP3 from '../src/devices/kp3plus.js';
import * as EFX from '../src/devices/efx500.js';
import { valideerManifest } from '../src/protocol/manifest.js';
import { CONFIG, MS, opzet, meldAan, van, leeg, lpdDruk } from './kern-hulp.js';

/** Een app met twee waarden die het XY-vlak via `xy` (op id) aanstuurt, en een trigger voor programmageheugen 3. */
const VORM = {
  v: 1, app: 'formula-lab', naam: 'Formula Lab', xy: { x: 'vorm', y: 'galm' },
  params: [
    { id: 'vorm', naam: 'Vorm', soort: 'waarde', standaard: 0.25 },
    { id: 'galm', naam: 'Galm', soort: 'waarde', standaard: 0.5 },
    { id: 'kp3.p3', naam: 'Favoriet 3', soort: 'trigger' },
  ],
};

/** @param {any} kern @param {any} [config] */
function kp3(kern, config = {}) {
  const o = KP3.maakOntleder(KP3.instellingen(config));
  return {
    /** @param {number[]} b */ stuur: (b) => kern.invoer(o(b), b),
    raak: () => kern.invoer(o([0xb0, 92, 127]), [0xb0, 92, 127]),
    los: () => kern.invoer(o([0xb0, 92, 0]), [0xb0, 92, 0]),
    /** @param {number} v */ x: (v) => kern.invoer(o([0xb0, 12, v]), [0xb0, 12, v]),
    /** @param {number} v */ y: (v) => kern.invoer(o([0xb0, 13, v]), [0xb0, 13, v]),
  };
}
const zets = (v) => van(v, 'zet').map((b) => [b.id, Math.round(b.v * 1000) / 1000, b.bron]);

describe('KP3+: het gebaar op de app met focus (§21)', () => {
  it('aanraken en bewegen zet X en Y; loslaten veert terug naar de waarden van vóór het aanraken', () => {
    const { kern } = opzet();
    const v = meldAan(kern, VORM, { staat: { vorm: 0.25, galm: 0.5 } });
    kern.focus('formula-lab');
    leeg(v);
    const k = kp3(kern);
    k.raak(); k.x(127); k.y(0);
    expect(zets(v)).toEqual([['vorm', 1, 'kp3plus'], ['galm', 0, 'kp3plus']]);
    leeg(v);
    k.los();
    expect(zets(v)).toEqual([['vorm', 0.25, 'kp3plus'], ['galm', 0.5, 'kp3plus']]);
    expect(kern.beeld().apps[0].waarden).toMatchObject({ vorm: 0.25, galm: 0.5 });
  });

  it('hold in config.json: na loslaten blijft het staan', () => {
    const config = { ...CONFIG, apparaten: { kp3plus: { hold: true } } };
    const { kern } = opzet(config);
    const v = meldAan(kern, VORM);
    kern.focus('formula-lab');
    const k = kp3(kern, config);
    k.raak(); k.x(64); leeg(v); k.los();
    expect(zets(v)).toEqual([]);
  });

  it('de Hold-knop van de KP3+ (als hij een CC heeft) houdt het ook vast', () => {
    const config = { ...CONFIG, apparaten: { kp3plus: { cc: { hold: 95 } } } };
    const { kern } = opzet(config);
    const v = meldAan(kern, VORM);
    kern.focus('formula-lab');
    const k = kp3(kern, config);
    k.stuur([0xb0, 95, 127]);
    k.raak(); k.x(64); leeg(v); k.los();
    expect(zets(v)).toEqual([]);
    k.stuur([0xb0, 95, 0]);
    k.raak(); k.x(10); leeg(v); k.los();
    expect(zets(v)).toEqual([['vorm', 0.504, 'kp3plus']]);   // terug naar 64/127, de stand van vóór deze aanraking
  });

  it('zonder xy in het manifest: de rol uit config.json (standaard alfabet.vervorming / alfabet.ruimte)', () => {
    const config = { ...CONFIG, apparaten: { kp3plus: { xy: { x: 'macro.ruimte', y: 'macro.helderheid' } } } };
    const { kern } = opzet(config);
    const v = meldAan(kern, MS);
    kern.focus('medisynth');
    leeg(v);
    const k = kp3(kern, config);
    k.x(127); k.y(127);
    expect(zets(v)).toEqual([['galm', 1, 'kp3plus'], ['licht', 1, 'kp3plus']]);
  });

  it('een app die de rollen niet heeft: niets, geen fout', () => {
    const { kern } = opzet();
    const v = meldAan(kern, MS);
    kern.focus('medisynth');
    leeg(v);
    const k = kp3(kern);
    k.raak(); k.x(100); k.y(100); k.los();
    expect(zets(v)).toEqual([]);
  });

  it('maps/<app>.json (config.kaarten) gaat voor het manifest', () => {
    const config = { ...CONFIG, kaarten: { 'formula-lab': { xy: { x: 'galm' } } } };
    const { kern } = opzet(config);
    const v = meldAan(kern, VORM);
    kern.focus('formula-lab');
    leeg(v);
    const k = kp3(kern, config);
    k.x(127); k.y(0);
    expect(zets(v)).toEqual([['galm', 1, 'kp3plus'], ['galm', 0, 'kp3plus']]);
  });

  it('wisselt de focus tijdens het aanraken, dan blijft het gebaar bij de app waar het begon (ook het terugveren)', () => {
    const { kern } = opzet();
    const v = meldAan(kern, VORM);
    const w = meldAan(kern, { ...VORM, app: 'medisynth', naam: 'MediSynth' });
    kern.focus('formula-lab');
    const k = kp3(kern);
    k.raak(); k.x(127);
    kern.focus('medisynth');
    leeg(v, w);
    k.x(0); k.los();
    expect(zets(v)).toEqual([['vorm', 0, 'kp3plus'], ['vorm', 0.25, 'kp3plus']]);
    expect(zets(w)).toEqual([]);
  });

  it('zonder focus gebeurt er niets; valt de KP3+ weg tijdens het aanraken, dan veert het terug', () => {
    const { kern } = opzet();
    const v = meldAan(kern, VORM);
    kern.focus(null);
    leeg(v);
    const k = kp3(kern);
    k.raak(); k.x(127);
    expect(zets(v)).toEqual([]);
    k.los();
    kern.focus('formula-lab');
    k.raak(); k.x(127);
    leeg(v);
    kern.apparaatWeg('kp3plus');
    expect(zets(v)).toEqual([['vorm', 0.25, 'kp3plus']]);
  });

  it('een programmageheugen gaat als trigger kp3.p<nr> naar de app met focus, als die hem heeft', () => {
    const { kern } = opzet();
    const v = meldAan(kern, VORM);
    kern.focus('formula-lab');
    leeg(v);
    const k = kp3(kern);
    k.stuur([0xc0, 2]);   // effectprogramma 2 → p3
    k.stuur([0xc0, 7]);   // p8: heeft de app niet
    expect(van(v, 'trig')).toEqual([{ t: 'trig', id: 'kp3.p3', aan: true }, { t: 'trig', id: 'kp3.p3', aan: false }]);
  });

  it('manifest xy: per as een rol of id; ongeldig = fout', () => {
    expect(valideerManifest(VORM)).toMatchObject({ ok: true, manifest: { xy: { x: 'vorm', y: 'galm' } } });
    expect(valideerManifest({ ...VORM, xy: { x: 'alfabet.vervorming' } })).toMatchObject({ ok: true, manifest: { xy: { x: 'alfabet.vervorming' } } });
    expect(valideerManifest({ ...VORM, xy: { x: 'Vorm!' } }).ok).toBe(false);
    expect(valideerManifest({ ...VORM, xy: { z: 'vorm' } }).ok).toBe(false);
    expect(valideerManifest({ ...VORM, xy: 'vorm' }).ok).toBe(false);
    const { xy, ...zonder } = VORM;
    const r = valideerManifest(zonder);
    expect(r.ok && 'xy' in r.manifest).toBe(false);
  });
});

/** Tikken van de EFX-500 op een tempo, met de NepKlok ertussen. @param {any} kern @param {any} klok @param {number} bpm @param {number} n */
function efxTikken(kern, klok, bpm, n) {
  const d = 60000 / (24 * bpm);
  for (let i = 0; i < n; i++) { kern.invoer(EFX.ontleed([0xf8]), [0xf8]); klok.loop(d); }
}
const bpmVan = (v) => van(v, 'globaal').filter((b) => 'bpm' in b.waarden).map((b) => b.waarden.bpm);

describe('klokbronnen: EFX-500 > tap > config (§20)', () => {
  it('nep-kloktikken op 120 BPM geven globaal.bpm 120, en de EFX is de bron', () => {
    const { kern, klok } = opzet({ ...CONFIG, tempo: { bpm: 100 } });
    const v = meldAan(kern, MS);
    expect(kern.globaal.bpm).toBe(100);
    expect(kern.beeld().tempo).toMatchObject({ bpm: 100, bron: 'config' });
    leeg(v);
    efxTikken(kern, klok, 120, 30);
    expect(kern.globaal.bpm).toBe(120);
    expect(bpmVan(v)).toEqual([120]);
    expect(kern.beeld().tempo).toMatchObject({ bpm: 120, bron: 'efx500', efx: { bpm: 120 } });
  });

  it('een kloktik is geen invoer voor de cockpit (24 per tel)', () => {
    const { kern, klok } = opzet();
    const invoer = [];
    kern.bij('invoer', (g) => invoer.push(g));
    efxTikken(kern, klok, 120, 30);
    expect(invoer).toEqual([]);
  });

  it('tap terwijl de EFX tikt: de EFX wint; valt de klok weg (> weg_ms), dan het tap-tempo', () => {
    const { kern, klok } = opzet();
    const v = meldAan(kern, MS);
    efxTikken(kern, klok, 128, 30);
    expect(kern.globaal.bpm).toBe(128);
    // vier taps terwijl de klok doortikt (25 tikken op 128 BPM ≈ 488 ms ertussen, dus ±123 BPM getapt)
    for (let i = 0; i < 4; i++) { lpdDruk(kern, 2); efxTikken(kern, klok, 128, 25); }
    const tap = kern.tempo.tap;
    expect(tap).toBeGreaterThan(120);
    expect(kern.globaal.bpm).toBe(128);
    expect(kern.beeld().tempo).toMatchObject({ bron: 'efx500', tap });
    leeg(v);
    klok.loop(1900);
    expect(kern.globaal.bpm).toBe(128);   // nog binnen weg_ms (2 s) na de laatste tik
    klok.loop(200);
    expect(kern.globaal.bpm).toBe(tap);
    expect(kern.beeld().tempo).toMatchObject({ bron: 'tap', efx: { bpm: null, vorige: 128 } });
    expect(bpmVan(v)).toEqual([tap]);
  });

  it('zonder tap blijft het laatste EFX-tempo staan als de klok wegvalt', () => {
    const { kern, klok } = opzet();
    efxTikken(kern, klok, 90, 30);
    klok.loop(3000);
    expect(kern.globaal.bpm).toBe(90);
    expect(kern.beeld().tempo.bron).toBe('laatste');
    // tap daarna werkt gewoon weer
    for (let i = 0; i < 3; i++) { lpdDruk(kern, 2); klok.loop(500); }
    expect(kern.globaal.bpm).toBe(120);
  });

  it('de EFX losgetrokken: meteen terug; komt hij terug, dan pas na een nieuwe meting (een hele tel) weer de bron', () => {
    const { kern, klok } = opzet();
    for (let i = 0; i < 3; i++) { lpdDruk(kern, 2); klok.loop(600); }
    expect(kern.globaal.bpm).toBe(100);
    efxTikken(kern, klok, 128, 30);
    expect(kern.globaal.bpm).toBe(128);
    kern.apparaatWeg('efx500');
    expect(kern.globaal.bpm).toBe(100);
    efxTikken(kern, klok, 140, 10);
    expect(kern.globaal.bpm).toBe(100);
    efxTikken(kern, klok, 140, 20);
    expect(kern.globaal.bpm).toBe(140);
  });

  it('start en stop van de EFX (als hij ze stuurt): globaal klok.loopt 1/0, alleen bij verandering', () => {
    const { kern } = opzet();
    const v = meldAan(kern, MS);
    leeg(v);
    for (const b of [[0xfa], [0xfb], [0xfc], [0xfc], [0xb0, 1, 2]]) kern.invoer(EFX.ontleed(b), b);
    expect(van(v, 'globaal').map((b) => b.waarden['klok.loopt'])).toEqual([1, 0]);
    expect(kern.beeld().tempo.efx.loopt).toBe(false);
  });

  it('stop() laat geen klok-timer staan', () => {
    const { kern, klok } = opzet();
    efxTikken(kern, klok, 120, 30);
    kern.stop();
    expect(kern.tempo.timer).toBe(null);
    expect([...klok.timers.keys()].length).toBe(0);
  });
});
