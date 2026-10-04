// @ts-check
// Spiekbrief (src/spiekbrief/, docs/SPIEKBRIEF.md): klopt wat er op papier staat met wat de hub ECHT doet?
// Voor elke set in sets/ wordt elke knop van de spiekbrief op een echte Kern ingedrukt (test/kern-hulp.js), met
// dezelfde manifesten en dezelfde config.json als de spiekbrief. Hermetisch: alleen bestanden uit dit repo.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laadConfig, HUB_MAP } from '../src/config.js';
import { lijstSets, laadSet } from '../src/sets/index.js';
import { PANIEK_MS, LANG_MS } from '../src/core/kern.js';
import { ROLLEN, keuzeNaarWaarde } from '../src/protocol/manifest.js';
import {
  spiekbriefVoorSet, maakSpiekbrief, laadBronnen, hubConfig, uitKern, spiekbriefHtml, lijstHtml, ROL_NAMEN,
  gewicht, dichtheid, verdeel,
} from '../src/spiekbrief/index.js';
import { datumUit, VASTGELEGD_MAP } from '../src/spiekbrief/bronnen.js';
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

// Geen app in sets/ heeft meer dan één device-pagina of een kaart naar een losse knop: dit manifest wel.
// 12 knoppen in twee groepen (2 pagina's met naam), 20 waarden zonder hint (8 faders, 8 track-knoppen, 4 te veel)
// en een kaart die trigger t1 op clip-stop 3 zet (buiten de vaste vakken: "ook").
const knoppen = Array.from({ length: 12 }, (_, i) => ({ id: `k${i + 1}`, naam: `Knop ${i + 1}`, soort: 'waarde', hint: 'knop', groep: i < 6 ? 'Klank' : 'Beeld' }));
const waarden = Array.from({ length: 20 }, (_, i) => ({ id: `w${i + 1}`, naam: `Waarde ${i + 1}`, soort: 'waarde' }));
const PROEF = {
  v: 1, app: 'proef', naam: 'Proef',
  params: [...knoppen, ...waarden, { id: 't1', naam: 'Tik een', soort: 'trigger' }, { id: 't2', naam: 'Tik twee', soort: 'trigger' }],
};
const PROEF_CONFIG = { ...CONFIG, kaarten: { ...CONFIG.kaarten, proef: { stop3: { id: 't1' } } } };
const PROEF_SB = maakSpiekbrief({
  id: 'proef', set: /** @type {any} */ ({ naam: 'Proef', apps: { proef: {} }, focus: 'proef' }), config: PROEF_CONFIG,
  bronnen: { proef: { manifest: PROEF, bron: 'vastgelegd', uitleg: 'proef' } },
});

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
    // Wat er nu vastgelegd is, verandert met elke repetitie (--fixtures): de verwachting komt uit de bestanden zelf.
    const med = spiekbriefVoorSet('meditatie', { config: laadConfig() });
    expect(med.fouten).toEqual([]);
    const per = Object.fromEntries(med.apps.map((a) => [a.app, a]));
    expect(per.uurwerk.bron).toBe('driver');
    expect(per.uurwerk.bronUitleg).toBe('apps/uurwerk.json (http-driver)');
    for (const a of med.apps) {
      const b = BRONNEN[a.app];
      if (!b) { expect(a.soort, a.app).toBe('volgt'); expect(a.bron).toBeNull(); continue; }
      expect(a.bron, a.app).toBe(b.bron);
      expect(a.bronUitleg, a.app).toBe(b.uitleg);
      if (b.bron === 'vastgelegd') {
        const d = datumUit(String(JSON.parse(readFileSync(join(VASTGELEGD_MAP, `${a.app}.json`), 'utf8'))._bron ?? ''));
        if (d) expect(a.bronUitleg).toContain(`op ${d}`);
      }
    }
    expect(per.waterschaal.bron).toBe('vastgelegd');
    expect(per['av-kern'].koppeling).toBe('lease');
    expect(datumUit('vastgelegd op 2026-10-03T16:05:44.828Z')).toBe('3 okt 2026');
    expect(datumUit('zonder datum')).toBeNull();
  });

  it('een kapot bronbestand: de app staat er als fout met de reden, en het blad noemt het bestand', () => {
    const map = mkdtempSync(join(tmpdir(), 'spiekbrief-vastgelegd-'));
    writeFileSync(join(map, 'waterschaal.json'), '{kapot');
    const sb = spiekbriefVoorSet('meditatie', { config: laadConfig(), vastgelegdMap: map });
    const ws = /** @type {AppBlad} */ (sb.apps.find((a) => a.app === 'waterschaal'));
    expect(ws.soort).toBe('fout');
    expect(ws.fout).toMatch(/^waterschaal\.json: /);
    expect(sb.fouten).toHaveLength(1);
    expect(sb.fouten[0]).toMatch(/^waterschaal\.json: /);
    const html = spiekbriefHtml([sb]);
    expect(html).toMatch(/class="sb-opm sb-fouten">Niet te lezen[^<]*waterschaal\.json: /);
    expect(html).toMatch(/data-app="waterschaal"[\s\S]*?Indeling niet te bepalen<\/b> \(waterschaal\.json: /);
    // een kapot bestand van een app die niet in de set zit: alleen de melding, de apps zelf blijven gewoon
    const map2 = mkdtempSync(join(tmpdir(), 'spiekbrief-vastgelegd-'));
    writeFileSync(join(map2, 'iets-anders.json'), '[]');
    const sb2 = spiekbriefVoorSet('dj', { config: laadConfig(), vastgelegdMap: map2 });
    expect(sb2.fouten).toEqual(['iets-anders.json: geen manifest']);
    expect(sb2.apps.every((a) => a.soort !== 'fout')).toBe(true);
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
    const metPaniek = sb.apps.filter((a) => /** @type {any} */ (BRONNEN[a.app])?.manifest?.params?.some((/** @type {any} */ p) => p.id === 'paniek' && p.soort === 'trigger'));
    expect(sb.lpd8.pads[0].uitleg).toBe(metPaniek.length
      ? `${metPaniek.map((a) => a.naam).join(', ')}; loslaten = paniek uit` : 'geen app in deze set heeft een paniek (alleen globaal)');
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
  });

  it('P5–P8 en Bank + Scene 1–4 zijn dezelfde snapshots ("1–4 = LPD8 P5–P8"): bewaren met de een, laden met de ander', () => {
    const h = hubMetSet('meditatie');
    const ws = h.v.waterschaal;
    h.kern.focus('waterschaal');
    const waarde = () => h.kern.apps.get('waterschaal').waarden.druk;
    /** Fader 1 van Waterschaal (druk) helemaal omhoog: pakt op langs de stand en eindigt op 1. */
    const verander = () => { draai(h.kern, 'fader1', 0); draai(h.kern, 'fader1', 1); h.klok.loop(100); expect(waarde()).toBe(1); };
    const geladen = (/** @type {number} */ v) => van(ws, 'zet').some((/** @type {any} */ b) => b.id === 'druk' && b.v === v && b.bron === 'snapshot');
    const bankScene = (/** @type {number} */ n, shift = false) => {
      druk(h.kern, 'bank'); if (shift) druk(h.kern, 'shift'); tik(h.kern, `scene${n}`); if (shift) los(h.kern, 'shift'); los(h.kern, 'bank');
    };

    // P5 lang = bewaren; Bank + Scene 1 (zonder Shift) = laden
    const bewaard1 = waarde();
    lpdDruk(h.kern, 5); h.klok.loop(LANG_MS + 1); lpdLos(h.kern, 5);
    verander();
    leeg(ws);
    bankScene(1);
    h.klok.loop(10_000);
    expect(geladen(bewaard1), 'Bank + Scene 1 laadt wat P5 bewaarde').toBe(true);
    expect(waarde()).toBe(bewaard1);

    // Bank + Shift + Scene 2 = bewaren; P6 kort = laden
    draai(h.kern, 'fader1', 0.25); draai(h.kern, 'fader1', 0.3); h.klok.loop(100);
    const bewaard2 = waarde();
    expect(bewaard2).not.toBe(1);
    bankScene(2, true);
    verander();
    leeg(ws);
    lpdDruk(h.kern, 6); h.klok.loop(100); lpdLos(h.kern, 6);
    h.klok.loop(10_000);
    expect(geladen(bewaard2), 'P6 kort laadt wat Bank + Shift + Scene 2 bewaarde').toBe(true);
    expect(waarde()).toBe(bewaard2);
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

  it('dichtheid: weinig apps ruim in 2 kolommen; veel apps of lange namen dichter; kaarten verdeeld over de kortste kolom', () => {
    const sb = spiekbriefVoorSet('meditatie', { config: laadConfig() });
    expect(dichtheid(sb.apps, sb)).toMatchObject({ kolommen: 2, dicht: 0 });
    const veel = [...sb.apps, ...sb.apps];
    expect(dichtheid(veel, sb).dicht).toBeGreaterThan(0);  // meer dan 4 apps: nooit de ruime opmaak
    // lange namen tellen mee: dezelfde app met namen van 30 tekens is hoger, en het blad gaat een stap dichter
    const fl = /** @type {any} */ (structuredClone(BRONNEN['formula-lab']));
    fl.manifest.params = [...fl.manifest.params, ...fl.manifest.params.map((/** @type {any} */ p) => ({ ...p, id: `${p.id}2` }))];
    const lang = structuredClone(fl);
    lang.manifest.params = lang.manifest.params.map((/** @type {any} */ p) => ({ ...p, naam: `${p.naam} met een lange naam erbij`.slice(0, 30) }));
    const kort = maakSpiekbrief({ id: 'dj', set: laadSet('dj', { config: CONFIG }), config: CONFIG, bronnen: { ...BRONNEN, 'formula-lab': fl } });
    const lng = maakSpiekbrief({ id: 'dj', set: laadSet('dj', { config: CONFIG }), config: CONFIG, bronnen: { ...BRONNEN, 'formula-lab': lang } });
    const flk = /** @type {AppBlad} */ (kort.apps.find((a) => a.app === 'formula-lab'));
    const fll = /** @type {AppBlad} */ (lng.apps.find((a) => a.app === 'formula-lab'));
    expect(gewicht(fll)).toBeGreaterThan(gewicht(flk) * 1.3);
    expect(dichtheid(kort.apps, kort).dicht).toBe(0);
    expect(dichtheid(lng.apps, lng).dicht).toBeGreaterThan(0);
    const kol = verdeel(sb.apps, 2);
    expect(kol.flat().map((a) => a.app).sort()).toEqual(sb.apps.map((a) => a.app).sort());
    const som = kol.map((k) => k.reduce((s, a) => s + gewicht(a), 0));
    expect(Math.abs(som[0] - som[1])).toBeLessThanOrEqual(Math.max(...sb.apps.map(gewicht)));
  });
});

describe('spiekbrief: device-pagina\'s, "ook" en "niet op de APC" op een echte kern', () => {
  const sb = PROEF_SB;
  const a = sb.apps[0];

  it('het model: twee pagina\'s met hun groepnaam, t1 bij "ook" en vier waarden "niet op de APC"', () => {
    expect(a.soort).toBe('indeling');
    expect(a.paginas.map((p) => p.naam)).toEqual(['Klank', 'Beeld']);
    expect(a.paginas[0].dk.slice(0, 6).map((v) => v?.id)).toEqual(['k1', 'k2', 'k3', 'k4', 'k5', 'k6']);
    expect(a.paginas[1].dk.slice(0, 6).map((v) => v?.id)).toEqual(['k7', 'k8', 'k9', 'k10', 'k11', 'k12']);
    expect(a.overig.map((v) => [v.ctrl, v.id, v.rol])).toEqual([['stop3', 't1', 'trigger']]);
    expect(a.niet).toEqual(['Waarde 17', 'Waarde 18', 'Waarde 19', 'Waarde 20']);
    expect(a.grid.flat().filter(Boolean).map((v) => v?.id)).toEqual(['t2']);
    const html = spiekbriefHtml([sb]);
    expect(html).toMatch(/<tr data-pagina="1"><th scope="row">device <small>◄\/► 2 Beeld<\/small><\/th>/);
    expect(html).toContain('<span data-ctrl="stop3" data-param="t1">stop3 = Tik een</span>');
    expect(html).toContain('niet op de APC (cockpit): Waarde 17, Waarde 18, Waarde 19, Waarde 20');
  });

  it('elke device-knop op elke pagina (Device ► bladert) stuurt de parameter die de spiekbrief noemt; clip-stop 3 = t1', () => {
    const h = opzet(PROEF_CONFIG);
    const v = meldAan(h.kern, PROEF);
    h.kern.focus('proef');
    let getoetst = 0;
    a.paginas.forEach((p, pi) => {
      if (pi > 0) tik(h.kern, 'devR');
      expect(h.kern.apps.get('proef').pagina).toBe(pi);
      p.dk.forEach((vak, i) => {
        const uit = bedien(h, v, `dk${i + 1}`, 'ring');
        if (!vak) { expect(uit, `pagina ${pi} dk${i + 1} is leeg`).toEqual([]); return; }
        expect(uit.length, `pagina ${pi} dk${i + 1}`).toBeGreaterThan(0);
        expect([...new Set(uit.map((b) => b.id))], `pagina ${pi} dk${i + 1}`).toEqual([vak.id]);
        getoetst++;
      });
    });
    expect(getoetst).toBe(12);
    expect(bedien(h, v, 'stop3', 'trigger')).toEqual([{ t: 'trig', id: 't1', aan: true }, { t: 'trig', id: 't1', aan: false }]);
    // wat "niet op de APC" staat, zit op geen enkele control
    const ind = h.kern.apps.get('proef').indeling;
    const overal = new Set([ind.vast, ...ind.paginas].flatMap((t) => Object.values(t).map((x) => /** @type {any} */ (x).id)));
    for (const id of ['w17', 'w18', 'w19', 'w20']) expect(overal.has(id), id).toBe(false);
  });
});

describe('spiekbrief: live en de takeover van een fader', () => {
  it('een app die weg is: niet meegeteld "bij de hub", en "(niet verbonden)" achter zijn Track Select-nummer', () => {
    const h = opzet(CONFIG);
    const fl = meldAan(h.kern, /** @type {any} */ (BRONNEN['formula-lab']).manifest);
    const dj = meldAan(h.kern, /** @type {any} */ (BRONNEN['varve-dj']).manifest);
    const set = laadSet('dj', { config: CONFIG });
    const voor = spiekbriefHtml([maakSpiekbrief({ id: 'dj', set, config: CONFIG, bronnen: BRONNEN, kern: uitKern(h.kern) })]);
    expect(voor).toContain('(2 van de 2 apps bij de hub)');
    expect(voor).not.toContain('(niet verbonden)');
    h.kern.verbreek(fl);
    h.kern.verbreek(dj);
    const sb = maakSpiekbrief({ id: 'dj', set, config: CONFIG, bronnen: BRONNEN, kern: uitKern(h.kern) });
    expect(sb.apps.map((a) => [a.app, a.status, a.slot])).toEqual([['varve-dj', 'weg', 2], ['formula-lab', 'weg', 1]]);
    const html = spiekbriefHtml([sb]);
    expect(html).toContain('(0 van de 2 apps bij de hub)');
    expect(html).toContain('Track Select <b>1</b> (niet verbonden)');
    expect(html).toContain('Track Select <b>2</b> (niet verbonden)');
    expect(html).toContain('nu niet verbonden');
  });

  it('een fader met takeover direct of schaal staat zo op papier; een ring alleen als de hub de ringen niet laat overnemen', () => {
    const man = {
      v: 1, app: 'formula-lab', naam: 'Formula Lab',
      params: [
        { id: 'a', naam: 'Aa', soort: 'waarde', hint: 'fader', takeover: 'direct' },
        { id: 'b', naam: 'Bee', soort: 'waarde', hint: 'fader', takeover: 'schaal' },
        { id: 'c', naam: 'Cee', soort: 'waarde', hint: 'fader' },
        { id: 'd', naam: 'Dee', soort: 'waarde', hint: 'knop', takeover: 'direct' },
      ],
    };
    const set = /** @type {any} */ ({ naam: 'T', apps: { 'formula-lab': {} }, focus: 'formula-lab' });
    const maak = (/** @type {any} */ config) => spiekbriefHtml([maakSpiekbrief({ id: 't', set, config, bronnen: { 'formula-lab': { manifest: man, bron: 'vastgelegd', uitleg: '' } } })]);
    const html = maak(CONFIG);
    expect(html).toContain('data-ctrl="fader1" data-param="a">Aa <i class="sb-overname">direct</i></td>');
    expect(html).toContain('data-ctrl="fader2" data-param="b">Bee <i class="sb-overname">schaal</i></td>');
    expect(html).toContain('data-ctrl="fader3" data-param="c">Cee</td>');
    expect(html).toContain('data-ctrl="dk1" data-param="d">Dee</td>');   // ringen nemen de stand over: takeover telt niet
    expect(html).toContain('class="sb-overname-uitleg"');
    const zonder = maak({ ...CONFIG, ringen_nemen_waarde_over: false });
    expect(zonder).toContain('data-ctrl="dk1" data-param="d">Dee <i class="sb-overname">direct</i></td>');
    // zonder zo'n fader of ring ook geen uitleg in de legenda
    expect(spiekbriefHtml([spiekbriefVoorSet('scene-kit', { config: laadConfig() })])).not.toContain('sb-overname');
  });
});

describe('spiekbrief: wat er zichtbaar boven de vakken staat', () => {
  /** De tabellen van een blad: per rij de kop en de control-ids van de vakken; de kolomkoppen. @param {string} html */
  function tabellen(html) {
    return [...html.matchAll(/<table class="sb-apc (sb-strook|sb-pads)"[^>]*>([\s\S]*?)<\/table>/g)].map(([, soort, t]) => {
      const kop = /<thead>([\s\S]*?)<\/thead>/.exec(t)?.[1] ?? '';
      const kolommen = [...kop.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
      const rijen = [...(/<tbody>([\s\S]*?)<\/tbody>/.exec(t)?.[1] ?? '').matchAll(/<tr[^>]*><th scope="row">([\s\S]*?)<\/th>([\s\S]*?)<\/tr>/g)]
        .map(([, label, cellen]) => ({
          label: label.replace(/<small>[\s\S]*<\/small>/, '').replace(/<[^>]+>/g, '').trim(),
          ctrls: [...cellen.matchAll(/<td\b([^>]*)>/g)].map((m) => /data-ctrl="([^"]*)"/.exec(m[1])?.[1] ?? null),
        }));
      return { soort, kolommen, rijen };
    });
  }

  it.each([...SETS, 'proef'])('set %s: rijkop track/fader/device/rij N past bij de vakken eronder, kolomkop bij het kolomnummer', (naam) => {
    const sb = naam === 'proef' ? PROEF_SB : spiekbriefVoorSet(naam, { config: laadConfig() });
    const html = spiekbriefHtml([sb]);
    const PRE = /** @type {Record<string, string>} */ ({ track: 'tk', fader: 'fader', device: 'dk' });
    let rijen = 0;
    for (const t of tabellen(html)) {
      if (t.soort === 'sb-strook') {
        expect(t.kolommen).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
        for (const r of t.rijen) {
          expect(Object.keys(PRE), r.label).toContain(r.label);
          expect(r.ctrls.slice(0, 8), r.label).toEqual(t.kolommen.map((k) => `${PRE[r.label]}${k}`));
          expect([null, 'stopall']).toContain(r.ctrls[8]);
          rijen++;
        }
      } else {
        const nrs = t.kolommen.filter((k) => /^\d$/.test(k));
        t.rijen.forEach((r, i) => {
          const m = /^rij (\d)$/.exec(r.label);
          expect(m, r.label).not.toBeNull();
          const rij = Number(/** @type {RegExpExecArray} */ (m)[1]);
          expect(rij).toBe(5 - i);                               // rij 5 bovenaan, zoals op de APC
          expect(r.ctrls.slice(0, nrs.length)).toEqual(nrs.map((k) => `pad${rij}-${k}`));
          if (r.ctrls.length > nrs.length) expect(r.ctrls[nrs.length]).toBe(`scene${6 - rij}`);
          rijen++;
        });
      }
    }
    if (sb.apps.some((a) => a.soort === 'indeling')) expect(rijen).toBeGreaterThan(0);
    if (naam === 'proef') expect(rijen).toBe(2 + 4);          // pads rij 5–4 (t2 staat onder de plek van t1) + track, fader, device ×2
  });
});

describe('ui/spiekbrief.css', () => {
  it('evenveel { als }: een losse haak laat de regel erna wegvallen als de stylesheets aan elkaar staan (CLI)', () => {
    const css = readFileSync(join(HUB_MAP, 'ui', 'spiekbrief.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css.split('{').length).toBe(css.split('}').length);
    let diepte = 0;
    for (const c of css) { if (c === '{') diepte++; if (c === '}') diepte--; expect(diepte).toBeGreaterThanOrEqual(0); }
  });
});

describe('spiekbrief: de lijst (GET /spiekbrief) noemt kapotte bronbestanden', () => {
  it('een kapot vastgelegd manifest staat onder de sets, en op het blad van de set', async () => {
    const { spiekbriefPagina } = await import('../src/spiekbrief/index.js');
    const map = mkdtempSync(join(tmpdir(), 'spiekbrief-vastgelegd-'));
    writeFileSync(join(map, 'waterschaal.json'), '{kapot');
    const lijst = spiekbriefPagina(null, { vastgelegdMap: map });
    expect(lijst.code).toBe(200);
    expect(lijst.html).toMatch(/<p class="sb-opm">Niet te lezen: waterschaal\.json: /);
    expect(spiekbriefPagina(null).html).not.toContain('Niet te lezen');
    expect(spiekbriefPagina('meditatie', { vastgelegdMap: map }).html).toContain('class="sb-opm sb-fouten"');
  });
});
