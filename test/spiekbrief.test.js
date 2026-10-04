// @ts-check
// Spiekbrief (src/spiekbrief/, docs/SPIEKBRIEF.md): klopt wat er op papier staat met wat de hub ECHT doet?
// Voor elke set in sets/ wordt elke knop van de spiekbrief op een echte Kern ingedrukt (test/kern-hulp.js), met
// dezelfde manifesten en dezelfde config.json als de spiekbrief. Hermetisch: alleen bestanden uit dit repo.
import { describe, it, expect } from 'vitest';
import { laadConfig } from '../src/config.js';
import { lijstSets, laadSet } from '../src/sets/index.js';
import { PANIEK_MS, LANG_MS } from '../src/core/kern.js';
import { ROLLEN, keuzeNaarWaarde } from '../src/protocol/manifest.js';
import {
  spiekbriefVoorSet, maakSpiekbrief, laadBronnen, hubConfig, uitKern, spiekbriefHtml, lijstHtml, ROL_NAMEN,
  gewicht, dichtheid, verdeel,
} from '../src/spiekbrief/index.js';
import { datumUit } from '../src/spiekbrief/bronnen.js';
import { opzet, meldAan, druk, los, tik, draai, lpdKnop, lpdDruk, lpdLos, van, leeg } from './kern-hulp.js';

/** @typedef {import('../src/spiekbrief/model.js').Spiekbrief} Spiekbrief @typedef {import('../src/spiekbrief/model.js').AppBlad} AppBlad */

const CONFIG = hubConfig(laadConfig());
const SETS = lijstSets();
const { bronnen: BRONNEN } = laadBronnen();

/**
 * Een echte kern met de apps van een set aangemeld (setvolgorde), met hun manifest uit dezelfde bronnen.
 * @param {string} naam @param {any} [config]
 */
function hubMetSet(naam, config = CONFIG) {
  const set = laadSet(naam, { config });
  const h = opzet(config);
  /** @type {Record<string, any>} */
  const v = {};
  for (const app of Object.keys(set.apps)) {
    const b = BRONNEN[app];
    if (b) v[app] = meldAan(h.kern, /** @type {any} */ (b.manifest));
  }
  return { ...h, set, v };
}

/** Berichten die een app kreeg van een bepaald type, na het wissen. */
const nieuw = (/** @type {any} */ v, /** @type {string} */ t) => van(v, t);

/** Wat de kern naar de app stuurt als je deze control bedient (alleen zet/trig/scene/midi). */
function bedien(/** @type {any} */ h, /** @type {any} */ v, /** @type {string} */ ctrl, /** @type {string} */ rol) {
  leeg(v);
  if (rol === 'fader' || rol === 'ring') { draai(h.kern, ctrl, 0); draai(h.kern, ctrl, 1); }
  else { druk(h.kern, ctrl); los(h.kern, ctrl); }
  h.klok.loop(50);
  return v.ontvangen.filter((/** @type {any} */ b) => ['zet', 'trig', 'scene', 'midi'].includes(b.t));
}

describe('spiekbrief: het overzicht per set', () => {
  it('er zijn sets, en voor elke set komt er een spiekbrief met al zijn apps in setvolgorde', () => {
    expect(SETS.length).toBeGreaterThan(0);
    for (const naam of SETS) {
      const sb = spiekbriefVoorSet(naam, { config: laadConfig() });
      const set = laadSet(naam, { config: CONFIG });
      expect(sb.set.naam).toBe(set.naam);
      expect(sb.apps.map((a) => a.app)).toEqual(Object.keys(set.apps));
      expect(sb.live).toBe(false);
      for (const a of sb.apps) expect(a.slot).toBeNull();   // zonder hub geen Track Select-nummer: dat hangt af van wie zich eerst meldt
    }
  });

  it('manifesten: driver-apps uit apps/*.json, WS-apps zoals ze het laatst vastgelegd zijn, anders "volgt"', () => {
    const med = spiekbriefVoorSet('meditatie', { config: laadConfig() });
    const per = Object.fromEntries(med.apps.map((a) => [a.app, a]));
    expect(per.uurwerk.bron).toBe('driver');
    expect(per.uurwerk.bronUitleg).toBe('apps/uurwerk.json (http-driver)');
    expect(per.waterschaal.bron).toBe('vastgelegd');
    expect(per.waterschaal.bronUitleg).toMatch(/3 okt 2026/);
    expect(per['av-kern'].soort).toBe('volgt');        // av-kern meldde zich nog nooit: geen manifest
    expect(per['av-kern'].koppeling).toBe('lease');
    expect(datumUit('vastgelegd op 2026-10-03T16:05:44.828Z')).toBe('3 okt 2026');
    expect(datumUit('zonder datum')).toBeNull();
  });

  it('een kapot manifest staat er als fout, met de reden van de kern', () => {
    const set = { naam: 'Kapot', apps: { 'formula-lab': {} }, focus: 'formula-lab' };
    const sb = maakSpiekbrief({ id: 'kapot', set, config: CONFIG, bronnen: { 'formula-lab': { manifest: { v: 1, app: 'formula-lab', naam: 'FL', params: 'nee' }, bron: 'vastgelegd', uitleg: '' } } });
    expect(sb.apps[0].soort).toBe('fout');
    expect(sb.apps[0].fout).toMatch(/ongeldig manifest: params moet een lijst zijn/);
  });

  it('LPD8: K1–K8 volgen ROLLEN (PROTOCOL §6) en hebben elk een naam; P1–P8 met de tijden van de kern', () => {
    const sb = spiekbriefVoorSet('meditatie', { config: laadConfig() });
    expect(sb.lpd8.knoppen.map((k) => k.rol)).toEqual([...ROLLEN]);
    expect(sb.lpd8.knoppen.map((k) => k.knop)).toEqual(['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8']);
    for (const r of ROLLEN) expect(ROL_NAMEN[r]).toBeTruthy();
    expect(sb.lpd8.pads.map((p) => p.pad)).toEqual(['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8']);
    expect(sb.lpd8.pads[0].kort).toBe(`paniek: ${PANIEK_MS / 1000} s vasthouden`);
    expect(sb.lpd8.pads[4].uitleg).toBe(`kort = laden, langer dan ${String(LANG_MS / 1000).replace('.', ',')} s = bewaren`);
    expect(sb.lpd8.pads[0].uitleg).toMatch(/^Waterschaal, Uurwerk;/);
  });

  it('een kaart uit maps/ (config.kaarten) staat op de spiekbrief zoals de kern hem gebruikt', () => {
    const config = { ...CONFIG, kaarten: { ...CONFIG.kaarten, 'formula-lab': { fader5: { id: 'a' } } } };
    const sb = maakSpiekbrief({ id: 'dj', set: laadSet('dj', { config }), config, bronnen: BRONNEN });
    const fl = /** @type {AppBlad} */ (sb.apps.find((a) => a.app === 'formula-lab'));
    expect(fl.faders[4]?.id).toBe('a');
    expect(fl.faders[0]?.id).not.toBe('a');
    const h = hubMetSet('dj', config);
    h.kern.focus('formula-lab');
    expect([...new Set(bedien(h, h.v['formula-lab'], 'fader5', 'fader').map((b) => b.id))]).toEqual(['a']);
    expect(bedien(h, h.v['formula-lab'], 'fader1', 'fader')).toEqual([]);
  });
});

describe.each(SETS)('spiekbrief = wat de kern doet bij een echte druk: set %s', (naam) => {
  /** @type {Spiekbrief} */
  const sb = spiekbriefVoorSet(naam, { config: laadConfig() });

  it('APC: elke control op de spiekbrief stuurt precies die parameter naar de app met focus; lege vakken doen niets', () => {
    const h = hubMetSet(naam);
    let getoetst = 0;
    for (const a of sb.apps.filter((x) => x.soort === 'indeling')) {
      const v = h.v[a.app];
      const man = /** @type {any} */ (BRONNEN[a.app]).manifest;
      h.kern.focus(a.app);
      /** @type {[string, import('../src/spiekbrief/model.js').Vak|null, number][]} */
      const lijst = [
        ...a.faders.map((x, i) => /** @type {[string, any, number]} */ ([`fader${i + 1}`, x, 0])),
        ...a.tk.map((x, i) => /** @type {[string, any, number]} */ ([`tk${i + 1}`, x, 0])),
        ...a.grid.flatMap((r, i) => r.map((x, k) => /** @type {[string, any, number]} */ ([`pad${5 - i}-${k + 1}`, x, 0]))),
        ...a.paginas.flatMap((p, pi) => p.dk.map((x, i) => /** @type {[string, any, number]} */ ([`dk${i + 1}`, x, pi]))),
      ];
      let pagina = 0;
      for (const [ctrl, vak, pg] of lijst) {
        while (pagina < pg) { tik(h.kern, 'devR'); pagina++; }
        const rol = vak?.rol ?? (/^(fader|tk|dk)/.test(ctrl) ? (ctrl.startsWith('fader') ? 'fader' : 'ring') : 'trigger');
        const voor = vak ? h.kern.apps.get(a.app).waarden[vak.id] : undefined;
        const uit = bedien(h, v, ctrl, rol);
        if (!vak) { expect(uit, `${a.app} ${ctrl} is leeg op de spiekbrief`).toEqual([]); continue; }
        expect(vak.ctrl).toBe(ctrl);
        const p = man.params.find((/** @type {any} */ x) => x.id === vak.id);
        expect(p.naam, `${a.app} ${ctrl}`).toBe(vak.naam);
        if (vak.rol === 'trigger') expect(uit, `${a.app} ${ctrl}`).toEqual([{ t: 'trig', id: vak.id, aan: true }, { t: 'trig', id: vak.id, aan: false }]);
        else if (vak.rol === 'keuze') {
          const i = p.keuzes.indexOf(vak.optie);
          expect(i).toBeGreaterThanOrEqual(0);
          const doel = keuzeNaarWaarde(i, p.keuzes.length);
          // Dezelfde keuze nog eens sturen doet de kern niet (PROTOCOL §14); een andere optie wel, precies die.
          expect(uit.map((b) => [b.t, b.id, b.v]), `${a.app} ${ctrl}`).toEqual(voor === doel ? [] : [['zet', vak.id, doel]]);
          expect(h.kern.apps.get(a.app).waarden[vak.id]).toBe(doel);
        } else {
          expect(uit.length, `${a.app} ${ctrl} → ${vak.id}`).toBeGreaterThan(0);
          expect(uit.every((b) => b.t === 'zet' && b.id === vak.id), `${a.app} ${ctrl} → ${JSON.stringify(uit)}`).toBe(true);
        }
        getoetst++;
      }
      while (pagina > 0) { tik(h.kern, 'devL'); pagina--; }
      // Scènes en Stop All
      a.scenes.forEach((s, i) => {
        const uit = bedien(h, v, `scene${i + 1}`, 'trigger');
        if (s) { expect(uit).toEqual([{ t: 'scene', i }]); expect(s.naam).toBe(man.scenes[i]); getoetst++; } else expect(uit).toEqual([]);
      });
      const stop = bedien(h, v, 'stopall', 'trigger');
      if (a.stopAll) { expect(stop).toEqual([{ t: 'trig', id: 'paniek', aan: true }, { t: 'trig', id: 'paniek', aan: false }]); getoetst++; } else expect(stop).toEqual([]);
    }
    if (sb.apps.some((a) => a.soort === 'indeling')) expect(getoetst).toBeGreaterThan(0);
  });

  it('lease: met focus gaat de APC als ruwe MIDI naar de app (behalve Bank)', () => {
    const h = hubMetSet(naam);
    for (const a of sb.apps.filter((x) => x.soort === 'lease')) {
      h.kern.focus(a.app);
      const uit = bedien(h, h.v[a.app], 'pad1-1', 'trigger');
      expect(uit.map((b) => b.t)).toEqual(['midi', 'midi']);
      expect(bedien(h, h.v[a.app], 'bank', 'trigger')).toEqual([]);
    }
  });

  it('LPD8 K1–K8: precies de apps en parameters die de spiekbrief noemt krijgen de macro', () => {
    const h = hubMetSet(naam);
    sb.lpd8.knoppen.forEach((k, i) => {
      for (const v of Object.values(h.v)) leeg(v);
      lpdKnop(h.kern, i + 1, 0); lpdKnop(h.kern, i + 1, 1);
      h.klok.loop(60_000);                              // slew_s laten uitlopen
      const kregen = Object.entries(h.v).flatMap(([app, v]) => [...new Set(nieuw(v, 'zet').map((/** @type {any} */ b) => b.id))]
        .map((id) => ({ app, param: /** @type {any} */ (BRONNEN[app]).manifest.params.find((/** @type {any} */ p) => p.id === id).naam })));
      expect(kregen, `${k.knop} ${k.rol}`).toEqual(k.apps.map(({ app, param }) => ({ app, param })));
    });
  });

  it('LPD8 P1: pas na de tijd op de spiekbrief paniek, naar de apps die hij noemt; loslaten = uit', () => {
    const h = hubMetSet(naam);
    const metPaniek = sb.apps.filter((a) => a.paniek).map((a) => a.app);
    for (const v of Object.values(h.v)) leeg(v);
    lpdDruk(h.kern, 1);
    h.klok.loop(PANIEK_MS - 1);
    expect(Object.values(h.v).flatMap((v) => nieuw(v, 'trig'))).toEqual([]);
    h.klok.loop(1);
    expect(Object.entries(h.v).filter(([, v]) => nieuw(v, 'trig').some((/** @type {any} */ b) => b.id === 'paniek' && b.aan)).map(([app]) => app)).toEqual(metPaniek);
    lpdLos(h.kern, 1);
    expect(Object.entries(h.v).filter(([, v]) => nieuw(v, 'trig').some((/** @type {any} */ b) => b.id === 'paniek' && !b.aan)).map(([app]) => app)).toEqual(metPaniek);
    expect(sb.lpd8.pads[0].uitleg.startsWith(metPaniek.length ? metPaniek.map((a) => /** @type {AppBlad} */ (sb.apps.find((x) => x.app === a)).naam).join(', ') : 'geen app')).toBe(true);
  });
});

describe('spiekbrief: P2–P8 en de hublaag op een echte kern', () => {
  it('P2 tap tempo, P3 adem opnieuw, P4 opname, P5–P8 kort = laden en lang = bewaren (dezelfde snapshots als Bank + Scene)', () => {
    const h = hubMetSet('meditatie');
    const sb = spiekbriefVoorSet('meditatie', { config: laadConfig() });
    expect(sb.lpd8.pads.slice(1, 4).map((p) => p.kort)).toEqual(['tap tempo', 'adem opnieuw', 'opname aan/uit']);
    lpdDruk(h.kern, 2); lpdLos(h.kern, 2); h.klok.loop(500); lpdDruk(h.kern, 2); lpdLos(h.kern, 2);
    expect(h.kern.globaal.bpm).toBe(120);
    h.klok.loop(3000);
    lpdDruk(h.kern, 3); lpdLos(h.kern, 3);
    expect(h.kern.globaal.adem).toBe(0);
    lpdDruk(h.kern, 4); lpdLos(h.kern, 4);
    expect(h.opname).toEqual([true]);
    // P5 lang (> LANG_MS) = bewaren als snapshot 1; P6 kort = laden (snapshot 2 is leeg: er gebeurt niets)
    lpdDruk(h.kern, 5); h.klok.loop(LANG_MS + 1); lpdLos(h.kern, 5);
    expect(h.kern.snapshots.has(1)).toBe(true);
    lpdDruk(h.kern, 6); h.klok.loop(LANG_MS - 100); lpdLos(h.kern, 6);
    expect(h.kern.snapshots.has(2)).toBe(false);
    // P5 kort = snapshot 1 laden: Waterschaal krijgt zijn bewaarde stand terug
    const ws = h.v.waterschaal;
    h.kern.focus('waterschaal');
    draai(h.kern, 'fader1', 0); draai(h.kern, 'fader1', 1);
    leeg(ws);
    lpdDruk(h.kern, 5); h.klok.loop(100); lpdLos(h.kern, 5);
    h.klok.loop(10_000);
    expect(van(ws, 'zet').some((/** @type {any} */ b) => b.id === 'druk' && b.v === 0 && b.bron === 'snapshot')).toBe(true);
    // en het is dezelfde snapshot als Bank + Scene 1
    druk(h.kern, 'bank'); druk(h.kern, 'shift'); tik(h.kern, 'scene2'); los(h.kern, 'shift'); los(h.kern, 'bank');
    expect(h.kern.snapshots.has(2)).toBe(true);
  });

  it('live: Track Select-nummers komen uit de kern, en Bank + dat nummer geeft die app de focus', () => {
    for (const naam of SETS) {
      const h = hubMetSet(naam);
      const sb = maakSpiekbrief({ id: naam, set: h.set, config: CONFIG, bronnen: BRONNEN, kern: uitKern(h.kern) });
      expect(sb.live).toBe(true);
      expect(sb.hub.toetsNaam).toBe('bank');
      for (const a of sb.apps.filter((x) => x.soort !== 'volgt')) {
        expect(a.bron).toBe('live');
        expect(a.slot).toBeGreaterThan(0);
        druk(h.kern, 'bank'); tik(h.kern, `sel${a.slot}`); los(h.kern, 'bank');
        expect(h.kern.focusApp, `${naam}: Bank + Track Select ${a.slot}`).toBe(a.app);
      }
    }
  });

  it('live: wat de hub van een app weet gaat voor het vastgelegde manifest, en andere verbonden apps staan erbij', () => {
    const h = opzet(CONFIG);
    meldAan(h.kern, { v: 1, app: 'sediment', naam: 'Sediment', params: [] });
    meldAan(h.kern, { v: 1, app: 'formula-lab', naam: 'Formula Lab nieuw', params: [{ id: 'x', naam: 'Iks', soort: 'waarde', hint: 'fader' }] });
    const set = laadSet('dj', { config: CONFIG });
    const sb = maakSpiekbrief({ id: 'dj', set, config: CONFIG, bronnen: BRONNEN, kern: uitKern(h.kern) });
    const fl = /** @type {AppBlad} */ (sb.apps.find((a) => a.app === 'formula-lab'));
    expect(fl.naam).toBe('Formula Lab nieuw');
    expect(fl.faders[0]?.naam).toBe('Iks');
    expect(fl.slot).toBe(2);
    const dj = /** @type {AppBlad} */ (sb.apps.find((a) => a.app === 'varve-dj'));
    expect(dj.bron).toBe('vastgelegd');                 // nog niet bij de hub: het vastgelegde manifest, zonder slot
    expect(dj.slot).toBeNull();
    expect(sb.ookVerbonden.map((a) => [a.app, a.slot])).toEqual([['sediment', 1]]);
  });
});

describe('spiekbrief als HTML', () => {
  it('elk vak van het model staat met zijn control-id en parameter in de pagina; de LPD8 ook', () => {
    for (const naam of SETS) {
      const sb = spiekbriefVoorSet(naam, { config: laadConfig() });
      const html = spiekbriefHtml([sb], { css: 'link' });
      expect(html).toContain(`data-set="${naam}"`);
      for (const a of sb.apps) {
        expect(html).toContain(`data-app="${a.app}"`);
        const vakken = [...a.faders, ...a.tk, ...a.grid.flat(), ...a.paginas.flatMap((p) => p.dk)].filter(Boolean);
        for (const v of vakken) expect(html).toContain(`data-ctrl="${/** @type {any} */ (v).ctrl}" data-param="${/** @type {any} */ (v).id}"`);
        if (a.stopAll) expect(html).toContain(`data-ctrl="stopall" data-param="${a.stopAll.id}"`);
        if (a.soort === 'volgt') expect(html).toMatch(/Indeling volgt als de app zich meldt/);
      }
      for (const k of sb.lpd8.knoppen) expect(html).toContain(`data-ctrl="${k.ctrl}" data-rol="${k.rol}"`);
      expect(html).toContain('href="/ui/stijl.css"');
      expect(html).toContain('href="/ui/spiekbrief.css"');
      expect(html).not.toMatch(/<script/i);
    }
  });

  it('namen uit een manifest worden ge-escaped; een rare kleur komt er niet in', () => {
    const h = opzet(CONFIG);
    meldAan(h.kern, { v: 1, app: 'formula-lab', naam: '<img src=x onerror=alert(1)>', params: [{ id: 'x', naam: '"><script>alert(1)</script>', soort: 'trigger', hint: 'pad' }] });
    const set = laadSet('dj', { config: CONFIG });
    const sb = maakSpiekbrief({ id: 'dj', set, config: CONFIG, bronnen: BRONNEN, kern: uitKern(h.kern) });
    sb.apps[0].kleur = 'red;background:url(x)';
    const html = spiekbriefHtml([sb]);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('url(x)');
    expect(lijstHtml([{ id: 'a"b', naam: '<b>', beschrijving: '' }])).toContain('href="/spiekbrief?set=a%22b"');
  });

  it('los bestand (CLI): de stijlen staan in de pagina, geen links naar de hub', () => {
    const html = spiekbriefHtml([spiekbriefVoorSet('dj', { config: laadConfig() })], { css: 'inline', gemaakt: new Date(2026, 9, 4) });
    expect(html).not.toContain('href="/ui/');
    expect(html).toContain('@page { size: A4 landscape');
    expect(html).toContain('gemaakt 4 oktober 2026');
  });

  it('dichtheid: weinig apps in 2 kolommen; meer dan 4 apps in 3, en kaarten verdeeld over de kortste kolom', () => {
    const sb = spiekbriefVoorSet('meditatie', { config: laadConfig() });
    expect(dichtheid(sb.apps)).toMatchObject({ kolommen: 2, dicht: 0 });
    const veel = [...sb.apps, ...sb.apps];
    expect(dichtheid(veel).kolommen).toBe(3);
    const kol = verdeel(sb.apps, 2);
    expect(kol.flat().map((a) => a.app).sort()).toEqual(sb.apps.map((a) => a.app).sort());
    const som = kol.map((k) => k.reduce((s, a) => s + gewicht(a), 0));
    expect(Math.abs(som[0] - som[1])).toBeLessThanOrEqual(Math.max(...sb.apps.map(gewicht)));
  });
});
