// @ts-check
// Sets: de bestanden in sets/ en hoe ze gecontroleerd worden (docs/SETS.md).
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { laadConfig, HUB_MAP } from '../src/config.js';
import { laadSet, valideerSet, lijstSets, laadPaden, vulIn, thuisPad, SETS_MAP } from '../src/sets/index.js';

const config = laadConfig();
const SETS = ['dj', 'meditatie', 'scene-kit'];
const lees = (/** @type {string} */ pad) => JSON.parse(readFileSync(join(HUB_MAP, pad), 'utf8'));

/** Een kleine geldige set om stuk te maken. @param {Record<string, any>} [x] */
const basis = (x = {}) => ({
  naam: 'Proef',
  apps: { 'formula-lab': { start: { commando: 'npm run dev -- --port {poort}' }, url: 'http://localhost:{poort}/?hub={hub}' } },
  ...x,
});
/** @param {unknown} s */
const fouten = (s) => { const r = valideerSet(s, config); return r.ok ? [] : r.fouten; };

describe('de sets in sets/', () => {
  it('meditatie, dj en scene-kit bestaan en kloppen met config.json', () => {
    expect(lijstSets()).toEqual(SETS);
    for (const n of SETS) {
      const s = laadSet(n, { config });
      for (const id of Object.keys(s.apps)) expect(config.apps).toHaveProperty(id);
      if (s.focus) expect(Object.keys(s.apps)).toContain(s.focus);
    }
  });

  it('geen paden en geen poortnummers van apps in een set: paden komen uit sets/paden.json, poorten uit config.json', () => {
    for (const n of SETS) {
      const tekst = readFileSync(join(SETS_MAP, `${n}.json`), 'utf8');
      expect(tekst).not.toMatch(/\/Users\/|\/home\/|~\//);
      for (const a of Object.values(config.apps)) if (a.poort) expect(tekst).not.toMatch(new RegExp(`(localhost:|port |PORT": ")${a.poort}\\b`));
    }
  });

  it('paden.json staat niet in git; paden.voorbeeld.json noemt elke repo die een set start', () => {
    const genegeerd = execFileSync('git', ['check-ignore', 'sets/paden.json'], { cwd: HUB_MAP, encoding: 'utf8' }).trim();
    expect(genegeerd).toBe('sets/paden.json');
    const voorbeeld = lees('sets/paden.voorbeeld.json');
    for (const n of SETS) {
      for (const [id, a] of Object.entries(laadSet(n, { config }).apps)) if (a.start) expect(voorbeeld).toHaveProperty(config.apps[id].repo);
    }
  });

  it('startcommando\'s volgen de echte repo\'s: vite op de poort uit config.json (av-kern houdt 5173), Varve DJ via PORT', () => {
    const m = laadSet('meditatie', { config });
    const dj = laadSet('dj', { config });
    for (const s of [m.apps.medisynth, dj.apps['formula-lab'], m.apps['av-kern']]) expect(s.start?.commando).toBe('npm run dev -- --port {poort} --strictPort');
    expect(m.apps.waterschaal.start?.commando).toMatch(/^python3 -m http\.server \{poort\}/);
    expect(m.apps.waterschaal.url).toBe('http://localhost:{poort}/td/waterschaal-lokaal.html?hub={hub}');
    expect(m.apps.uurwerk.start?.commando).toBe('./start.sh');
    expect(dj.apps['varve-dj'].start).toEqual({ commando: 'node server/index.js', omgeving: { PORT: '{poort}' } });
    // av-kern opent anders zelf een browser (vite open:true) — de starter opent Chrome.
    expect(m.apps['av-kern'].start?.omgeving?.BROWSER).toBe('none');
    expect([config.apps.medisynth.poort, config.apps['formula-lab'].poort, config.apps.waterschaal.poort, config.apps['varve-dj'].poort, config.apps.uurwerk.poort])
      .toEqual([5175, 5174, 8080, 8777, 8766]);
  });

  it('av-kern zit in de meditatie-set, wacht alleen op zijn poort en zegt dat de hub-koppeling pas na 25 okt komt', () => {
    const a = laadSet('meditatie', { config }).apps['av-kern'];
    expect(a.wacht).toBe('poort');
    expect(a.opmerking).toMatch(/25 okt/);
    expect(laadSet('meditatie', { config }).snapshot).not.toHaveProperty('av-kern');
  });

  it('elke URL van een browser-app heeft ?hub=', () => {
    for (const n of SETS) for (const a of Object.values(laadSet(n, { config }).apps)) if (a.url) expect(a.url).toMatch(/[?&]hub=\{hub\}/);
  });
});

describe('valideerSet', () => {
  it('een kleine set is geldig', () => expect(fouten(basis())).toEqual([]));

  it.each([
    ['geen object', [], /JSON-object/],
    ['zonder naam', basis({ naam: '' }), /naam ontbreekt/],
    ['zonder apps', basis({ apps: {} }), /apps ontbreekt/],
    ['onbekende app', basis({ apps: { 'bestaat-niet': {} } }), /apps\.bestaat-niet: geen app in config\.json/],
    ['onbekende variabele', basis({ apps: { 'formula-lab': { url: 'http://x/{pad}' } } }), /onbekende variabele \{pad\}/],
    ['{poort} zonder poort in config', basis({ apps: { 'td-lab': { start: { commando: 'x {poort}' } } } }), /\{poort\} gebruikt, maar config\.json → apps\.td-lab\.poort ontbreekt/],
    ['commando ontbreekt', basis({ apps: { 'formula-lab': { start: {} } } }), /start\.commando ontbreekt/],
    ['absolute map', basis({ apps: { 'formula-lab': { start: { commando: 'x', map: '/Users/clay' } } } }), /relatief aan de repo/],
    ['omgeving geen tekst', basis({ apps: { 'formula-lab': { start: { commando: 'x', omgeving: { PORT: 1 } } } } }), /omgeving/],
    ['verkeerde wacht', basis({ apps: { 'formula-lab': { wacht: 'altijd' } } }), /wacht moet kern\|poort\|geen/],
    ['wacht op poort zonder poort', basis({ apps: { 'td-lab': { wacht: 'poort' } } }), /geen poort/],
    ['snapshotwaarde buiten 0..1', basis({ snapshot: { 'formula-lab': { smooth: 2 } } }), /0\.\.1/],
    ['snapshot van een app buiten de set', basis({ snapshot: { medisynth: { niveau: 0.5 } } }), /snapshot\.medisynth: die app zit niet in deze set/],
    ['focus buiten de set', basis({ focus: 'medisynth' }), /focus: "medisynth" zit niet in deze set/],
    ['time-out geen getal', basis({ time_out_s: 'lang' }), /time_out_s/],
  ])('%s → duidelijke fout', (_, set, fout) => {
    expect(fouten(set).join('\n')).toMatch(fout);
  });

  it('laadSet: een onbekende set noemt de sets die er wel zijn', () => {
    expect(() => laadSet('feest', { config })).toThrow(/onbekende set "feest" — beschikbaar: dj, meditatie, scene-kit/);
  });

  it('laadSet: een set die niet klopt noemt elke fout', () => {
    const map = mkdtempSync(join(tmpdir(), 'sets-'));
    writeFileSync(join(map, 'stuk.json'), JSON.stringify(basis({ focus: 'x', apps: { onbekend: {} } })));
    expect(() => laadSet('stuk', { config, map })).toThrow(/set stuk klopt niet:\n {2}- apps\.onbekend.*\n {2}- focus/);
    writeFileSync(join(map, 'kapot.json'), '{ naam: ');
    expect(() => laadSet('kapot', { config, map })).toThrow(/kapot\.json is geen geldige JSON/);
  });
});

describe('paden en invullen', () => {
  it('laadPaden: ontbrekend bestand = leeg; _doc wordt overgeslagen; een niet-tekst is een fout', () => {
    const map = mkdtempSync(join(tmpdir(), 'paden-'));
    expect(laadPaden(join(map, 'niet-er.json'))).toEqual({});
    writeFileSync(join(map, 'p.json'), JSON.stringify({ _doc: 'uitleg', medisynth: '~/Projects/medisynth' }));
    expect(laadPaden(join(map, 'p.json'))).toEqual({ medisynth: '~/Projects/medisynth' });
    writeFileSync(join(map, 'q.json'), JSON.stringify({ medisynth: 5 }));
    expect(() => laadPaden(join(map, 'q.json'))).toThrow(/"medisynth" moet een map zijn/);
  });

  it('thuisPad en vulIn', () => {
    expect(thuisPad('~/Projects/x', '/thuis')).toBe('/thuis/Projects/x');
    expect(thuisPad('~', '/thuis')).toBe('/thuis');
    expect(thuisPad('/abs/x', '/thuis')).toBe('/abs/x');
    expect(vulIn('http://localhost:{poort}/?hub={hub}', { poort: 5174, hub: 'ws://localhost:7700/app' })).toBe('http://localhost:5174/?hub=ws://localhost:7700/app');
    expect(vulIn('{onbekend}', {})).toBe('{onbekend}');
  });
});
