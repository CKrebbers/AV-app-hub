// @ts-check
// Avondmap: opnemen (LPD8-pad 4) en herhalen, met de spec-testbank (NepKlok, nep-APC, nep-apps via de kern)
// en een bestandssysteem in het geheugen, zodat schijf vol / map niet schrijfbaar na te spelen is.
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { Kern, MELDING, Bank, P, manifest } from './spec/hulp.js';
import * as LPD8 from '../src/devices/lpd8.js';
import { Opnemer, avondmapPad, mapNaam, duurTekst, GEBAREN, SAMENVATTING } from '../src/opname/opnemer.js';
import { leesOpname, herhaal, doelVanHub, vertaal, naarFabriek, verslag } from '../src/opname/herhaal.js';
import { BufferSchrijver, redenVan } from '../src/opname/schrijver.js';
import { staatHash, vergelijkEindstaat } from '../src/opname/staat.js';
import { NepKlok } from '../src/core/klok.js';

const MAP = '/avonden';
const BEGON = new Date(2026, 9, 3, 21, 4, 5);

/** Fout zoals node:fs hem geeft. @param {string} code */
const fsFout = (code) => Object.assign(new Error(`${code}: nep`), { code });

/**
 * Bestandssysteem in het geheugen. `faal` bepaalt per aanroep of hij mislukt (code) of blijft hangen ('hang').
 * @param {{ append?: (n: number) => string|null, mkdir?: (pad: string) => string|null }} [faal]
 */
function geheugenFs(faal = {}) {
  /** @type {Map<string, string>} */
  const bestanden = new Map();
  const mappen = new Set(['/']);
  const fs = {
    bestanden, mappen, appends: 0,
    /** @param {string} pad @param {{ recursive?: boolean }} [o] */
    async mkdir(pad, o) {
      const f = faal.mkdir?.(pad);
      if (f) throw fsFout(f);
      if (mappen.has(pad)) { if (o?.recursive) return; throw fsFout('EEXIST'); }
      mappen.add(pad);
    },
    /** @param {string} pad @param {string} tekst */
    appendFile(pad, tekst) {
      fs.appends++;
      const f = faal.append?.(fs.appends);
      if (f === 'hang') return new Promise(() => {});
      if (f) return Promise.reject(fsFout(f));
      bestanden.set(pad, (bestanden.get(pad) ?? '') + tekst);
      return Promise.resolve();
    },
    /** @param {string} pad @param {string} tekst */
    async writeFile(pad, tekst) { bestanden.set(pad, tekst); },
  };
  return fs;
}

/** Een paar apps zoals op een avond: manifest-apps met rollen, schakelaar, keuze en trigger. @param {Bank} h @param {boolean} [anders] */
function apps(h, anders = false) {
  const fl = h.app(manifest('formula-lab', [
    P.fader('helder', { rol: 'macro.helderheid' }), P.fader('vorm'), P.knop('draai'),
    P.schakelaar('aan', { hint: 'pad' }), P.trigger('flits', { hint: 'pad' }), P.keuze('palet', ['warm', 'koel', 'mono']),
  ]), anders ? { helder: 0.1, vorm: 0.9, draai: 0, aan: 0, palet: 1 } : { helder: 0.5, vorm: 0.2, draai: 0.4, aan: 1, palet: 0 });
  const ws = h.app(manifest('waterschaal', [P.fader('niveau', { rol: 'macro.helderheid' }), P.waarde('galm', { rol: 'macro.ruimte', slew_s: 1 })]),
    anders ? { niveau: 0.7, galm: 0.9 } : { niveau: 0.3, galm: 0.5 });
  h.even();
  return { fl, ws };
}

/**
 * Opnemer aan een testbank, bedraad zoals src/hub.js: ruwe bytes vlak vóór kern.invoer.
 * @param {Bank} h @param {ReturnType<typeof geheugenFs>} fs @param {object} [extra]
 */
function neemOp(h, fs, extra = {}) {
  const o = new Opnemer({
    kern: h.kern, klok: h.klok, map: MAP, bestanden: fs, datum: () => BEGON, git: 'abc123def',
    lpd8Profiel: () => LPD8.standaardProfiel('mk2'), ...extra,
  });
  o.koppel();
  /** @type {string[]} */
  const meldingen = [];
  o.bij('melding', (/** @type {string} */ t) => meldingen.push(t));
  const echt = h.kern.invoer.bind(h.kern);
  h.kern.invoer = (/** @type {any} */ g, /** @type {number[]} */ b) => { o.invoer(g.dev, b); echt(g, b); };
  return { o, meldingen };
}

/** Een avondje spelen: faders, knoppen, pads, focuswissel, LPD8-macro met slew, snapshot bewaren en laden. @param {Bank} h */
function speel(h) {
  h.schuif('fader1', 0, 0.9);
  h.tijd(120);
  h.schuif('fader2', 0.1, 0.6);
  h.draai('dk1', 0.7);
  for (let r = 1; r <= 5; r++) for (let k = 1; k <= 3; k++) { h.tik(`pad${r}-${k}`); h.tijd(20); }
  h.tijd(300);
  h.lpdHoud(5, 800);                    // snapshot 1 bewaren
  h.lpdSchuif(3, 0, 1);                 // macro.ruimte → galm (met slew)
  h.tijd(1500);
  h.metHubtoets(() => h.tik('sel2'));   // focus naar waterschaal
  h.tijd(100);
  h.schuif('fader1', 0, 0.25);
  h.lpdSchuif(2, 0, 0.8);               // macro.helderheid → beide apps
  h.tijd(200);
  h.lpdHoud(5, 100);                    // snapshot 1 laden
  h.tijd(400);
  h.schuif('fader1', 0.25, 0.4);
  h.tijd(300);
}

/** Eindwaarden per app zoals de cockpit ze ziet. @param {Bank} h */
const eindstaat = (h) => Object.fromEntries(h.kern.beeld().apps.map((/** @type {any} */ a) => [a.app, a.waarden]));

describe.skipIf(!Kern)(`avondmap: opnemen${MELDING}`, () => {
  /** @type {Bank[]} */
  let banken = [];
  const bank = () => { const b = new Bank(); banken.push(b); return b; };
  afterEach(() => { for (const b of banken) b.stop(); banken = []; });

  it('LPD8-pad 4 aan → map <avondmap>/<datum-tijd>/ met kop, beginstand, invoer en berichten; uit → eind + samenvatting.md', async () => {
    const h = bank();
    apps(h);
    h.lpdHoud(5, 800);                 // al een snapshot vóór de opname: hoort bij de beginstand
    const fs = geheugenFs();
    const { o } = neemOp(h, fs);
    h.lpdDruk(4); h.lpdLos(4);
    expect(o.actief).toBe(true);
    speel(h);
    h.lpdDruk(4); h.lpdLos(4);
    expect(o.actief).toBe(false);
    const r = await o.afgesloten;

    const map = join(MAP, mapNaam(BEGON));
    expect(mapNaam(BEGON)).toBe('2026-10-03_21-04-05');
    expect(r.map).toBe(map);
    const tekst = /** @type {string} */ (fs.bestanden.get(join(map, GEBAREN)));
    const regels = tekst.trim().split('\n').map((x) => JSON.parse(x));
    expect(regels[0]).toMatchObject({ v: 1, begon: BEGON.toISOString(), 'hub-git': 'abc123def' });
    expect(regels[0].apps['formula-lab']).toMatchObject({ naam: expect.any(String), manifest: expect.stringMatching(/^[0-9a-f]{12}$/) });
    expect(regels[0].apps.waterschaal.manifest).not.toBe(regels[0].apps['formula-lab'].manifest);
    expect(regels[1]).toMatchObject({ ms: 0, e: 'beginstand', focus: 'formula-lab' });
    expect(regels[1].apps['formula-lab']).toEqual({ helder: 0.5, vorm: 0.2, draai: 0.4, aan: 1, palet: 0 });
    expect(Object.keys(regels[1].snapshots)).toEqual(['1']);

    const in_ = regels.filter((x) => Array.isArray(x) && x[1] === 'in');
    const naar = regels.filter((x) => Array.isArray(x) && x[1] === 'naar');
    expect(in_.length).toBeGreaterThan(100);
    expect(new Set(in_.map((x) => x[2]))).toEqual(new Set(['apc40', 'lpd8']));
    for (const x of in_) { expect(typeof x[0]).toBe('number'); expect(x[3].every((/** @type {unknown} */ b) => Number.isInteger(b))).toBe(true); }
    // Alleen zet/trig/scene/focus naar apps (geen globaal/midi/welkom), en elk daarvan.
    expect(new Set(naar.map((x) => x[3].t))).toEqual(new Set(['zet', 'trig', 'focus']));
    const verwacht = h.ev.naarApp.filter(([, b]) => ['zet', 'trig', 'scene', 'focus'].includes(b.t));
    expect(naar.length).toBeLessThanOrEqual(verwacht.length);
    expect(naar.at(-1)?.[3]).toEqual(verwacht.at(-1)?.[1]);
    // tijd loopt op
    const ms = regels.slice(1).map((x) => (Array.isArray(x) ? x[0] : x.ms));
    expect(ms).toEqual([...ms].sort((a, b) => a - b));

    const eind = regels.at(-1);
    expect(eind.e).toBe('eind');
    expect(eind.apps['formula-lab'].waarden).toEqual(eindstaat(h)['formula-lab']);
    expect(eind.apps['formula-lab'].hash).toBe(staatHash(eindstaat(h)['formula-lab']));
    expect(eind.duur_ms).toBeGreaterThan(4000);

    const sam = /** @type {string} */ (fs.bestanden.get(join(map, SAMENVATTING)));
    expect(sam).toMatch(/# Avond 2026-10-03_21-04-05/);
    expect(sam).toMatch(new RegExp(`Duur: ${duurTekst(eind.duur_ms).replace(':', '\\:')}`));
    expect(sam).toMatch(/\| formula-lab \|.*\| waterschaal|\| waterschaal \|/s);
    expect(sam).toMatch(/Invoer: \d+ \((apc40 \d+, lpd8 \d+|lpd8 \d+, apc40 \d+)\)/);
    expect(sam).toMatch(/abc123def/);
  });

  it('opnemen → afspelen tegen een verse hub geeft dezelfde eindstaat (staat-hash per app)', async () => {
    const h1 = bank();
    apps(h1);
    const fs = geheugenFs();
    const { o } = neemOp(h1, fs);
    h1.lpdDruk(4); h1.lpdLos(4);
    speel(h1);
    h1.lpdDruk(4); h1.lpdLos(4);
    await o.afgesloten;
    const opname = leesOpname(/** @type {string} */ (fs.bestanden.get(join(MAP, mapNaam(BEGON), GEBAREN))));

    // Andere hub, apps met andere beginwaarden: de beginstand van de opname wordt eerst hersteld.
    const h2 = bank();
    apps(h2, true);
    expect(eindstaat(h2)).not.toEqual(eindstaat(h1));
    const belofte = herhaal({ opname, doel: doelVanHub({ kern: h2.kern }), klok: h2.klok });
    h2.tijd(opname.eind.duur_ms + 1000);
    const r = await belofte;
    expect(r.verschillen).toEqual([]);
    expect(eindstaat(h2)).toEqual(eindstaat(h1));
    expect(r.overgeslagen).toMatchObject({ 'opname-knop': 1 }); // de P4 die de opname stopte
    expect(h2.ev.opname).toEqual([]);                            // herhalen start geen nieuwe opname
    expect(verslag(r)).toMatch(/eindstaat klopt/);
  });

  it('--snelheid: 4× sneller afspelen geeft (zonder lang-drukken of slew) dezelfde eindstaat in een kwart van de tijd', async () => {
    const h1 = bank();
    apps(h1);
    const fs = geheugenFs();
    const { o } = neemOp(h1, fs);
    h1.lpdDruk(4); h1.lpdLos(4);
    h1.schuif('fader1', 0, 0.8); h1.tijd(2000);
    h1.schuif('fader2', 0, 0.3); h1.tijd(2000);
    h1.tik('pad1-1'); h1.tijd(1000);
    h1.lpdDruk(4);
    await o.afgesloten;
    const opname = leesOpname(/** @type {string} */ (fs.bestanden.get(join(MAP, mapNaam(BEGON), GEBAREN))));

    const h2 = bank();
    apps(h2, true);
    const belofte = herhaal({ opname, doel: doelVanHub({ kern: h2.kern }), klok: h2.klok, snelheid: 4, naloopMs: 100 });
    h2.tijd(opname.eind.duur_ms / 4 + 200);
    const r = await belofte;
    expect(r.verschillen).toEqual([]);
    expect(r.duurMs).toBeLessThanOrEqual(opname.eind.duur_ms / 4 + 200);
    expect(r.duurMs).toBeGreaterThan(opname.eind.duur_ms / 4 - 600);
    expect(() => herhaal({ opname, doel: doelVanHub({ kern: h2.kern }), klok: h2.klok, snelheid: 0 })).toThrow(/snelheid/);
  });

  it('verschillen in de eindstaat worden per app en parameter gerapporteerd', async () => {
    const h1 = bank();
    apps(h1);
    const fs = geheugenFs();
    const { o } = neemOp(h1, fs);
    h1.lpdDruk(4); h1.lpdLos(4);
    h1.schuif('fader1', 0, 0.8);
    h1.lpdDruk(4);
    await o.afgesloten;
    const opname = leesOpname(/** @type {string} */ (fs.bestanden.get(join(MAP, mapNaam(BEGON), GEBAREN))));

    const h2 = bank();
    apps(h2, true);  // zonder beginstand-herstel blijven de andere beginwaarden staan
    const belofte = herhaal({ opname, doel: doelVanHub({ kern: h2.kern }), klok: h2.klok, beginstand: false });
    h2.tijd(opname.eind.duur_ms + 500);
    const r = await belofte;
    const fl = r.verschillen?.find((v) => v.app === 'formula-lab');
    expect(fl?.soort).toBe('waarden');
    expect(fl?.ids?.map((x) => x.id)).toEqual(expect.arrayContaining(['vorm', 'aan', 'palet']));
    expect(fl?.ids?.find((x) => x.id === 'vorm')).toEqual({ id: 'vorm', verwacht: 0.2, werkelijk: 0.9 });
    expect(r.verschillen?.some((v) => v.app === 'waterschaal')).toBe(true);
    expect(verslag(r)).toMatch(/VERSCHILLEN in 2 app/);
    // Een app die er niet is, is ook een verschil.
    expect(vergelijkEindstaat(opname.eind.apps, { waterschaal: {} }).find((v) => v.app === 'formula-lab')).toEqual({ app: 'formula-lab', soort: 'ontbreekt' });
  });
});

describe.skipIf(!Kern)(`avondmap: schrijven blokkeert nooit${MELDING}`, () => {
  /** @type {Bank[]} */
  let banken = [];
  const bank = () => { const b = new Bank(); banken.push(b); return b; };
  afterEach(() => { for (const b of banken) b.stop(); banken = []; });

  it('regels gaan in een buffer en worden per tijdvak weggeschreven, niet per gebaar', async () => {
    const h = bank();
    apps(h);
    const fs = geheugenFs();
    const { o } = neemOp(h, fs, { spoelMs: 1000 });
    h.lpdDruk(4); h.lpdLos(4);
    h.schuif('fader1', 0, 1);                       // ±130 gebaren + zetten
    await Promise.resolve();
    expect(fs.appends).toBe(0);
    h.tijd(1000);
    await new Promise((r) => setImmediate(r));
    expect(fs.appends).toBe(1);
    h.lpdDruk(4);
    await o.afgesloten;
    expect(fs.appends).toBe(2);
  });

  it('een schrijfactie die blijft hangen houdt de hub niet op: invoer en apps lopen gewoon door', async () => {
    const h = bank();
    const { fl } = apps(h);
    const fs = geheugenFs({ append: () => 'hang' });
    const { o } = neemOp(h, fs, { spoelMs: 50 });
    h.lpdDruk(4); h.lpdLos(4);
    for (let i = 0; i < 20; i++) { h.schuif('fader1', 0, 1); h.schuif('fader1', 1, 0); h.tijd(100); }
    expect(fl.zetten('helder').length).toBeGreaterThan(1000);
    expect(o.actief).toBe(true);
  });

  it('schijf vol: melding, geen crash; wat bleef hangen gaat er later alsnog in, in de goede volgorde', async () => {
    const h = bank();
    const { fl } = apps(h);
    const fs = geheugenFs({ append: (n) => (n <= 2 ? 'ENOSPC' : null) });
    const { o, meldingen } = neemOp(h, fs, { spoelMs: 200 });
    h.lpdDruk(4); h.lpdLos(4);
    h.schuif('fader1', 0, 1);
    for (let i = 0; i < 6; i++) { h.tijd(200); await new Promise((r) => setImmediate(r)); }
    expect(meldingen.some((m) => /schijf is vol/.test(m))).toBe(true);
    expect(meldingen.filter((m) => /schijf is vol/.test(m))).toHaveLength(1);   // niet elke spoeling opnieuw
    expect(meldingen.some((m) => /lukt weer/.test(m))).toBe(true);
    h.schuif('fader2', 0, 1);
    expect(fl.zetten('vorm').length).toBeGreaterThan(0);
    h.lpdDruk(4);
    const r = await o.afgesloten;
    expect(r.verloren).toBe(0);
    const regels = /** @type {string} */ (fs.bestanden.get(join(MAP, mapNaam(BEGON), GEBAREN))).trim().split('\n').map((x) => JSON.parse(x));
    expect(regels[0].v).toBe(1);
    expect(regels[1].e).toBe('beginstand');
    expect(regels.at(-1).e).toBe('eind');
    const ms = regels.slice(1).map((x) => (Array.isArray(x) ? x[0] : x.ms));
    expect(ms).toEqual([...ms].sort((a, b) => a - b));
  });

  it('schijf blijft vol: afsluiten lukt toch (verloren regels geteld), de hub draait door', async () => {
    const h = bank();
    const { fl } = apps(h);
    const fs = geheugenFs({ append: () => 'ENOSPC' });
    const { o, meldingen } = neemOp(h, fs, { spoelMs: 100 });
    h.lpdDruk(4); h.lpdLos(4);
    h.schuif('fader1', 0, 1);
    h.tijd(500);
    h.lpdDruk(4); h.lpdLos(4);
    const r = await o.afgesloten;
    expect(r.verloren).toBeGreaterThan(0);
    expect(meldingen.join('\n')).toMatch(/schijf is vol/);
    fl.wis();
    h.schuif('fader2', 0, 1);
    expect(fl.zetten('vorm').length).toBeGreaterThan(0);
  });

  it('map niet schrijfbaar: melding "niets bewaard", geen crash, en een volgende opname probeert het opnieuw', async () => {
    const h = bank();
    apps(h);
    let kapot = true;
    const fs = geheugenFs({ mkdir: () => (kapot ? 'EACCES' : null) });
    const { o, meldingen } = neemOp(h, fs, { spoelMs: 100 });
    h.lpdDruk(4); h.lpdLos(4);
    h.schuif('fader1', 0, 1);
    h.tijd(300);
    h.lpdDruk(4);
    const r = await o.afgesloten;
    expect(r.map).toBe(null);
    expect(meldingen.join('\n')).toMatch(/niet schrijfbaar/);
    expect(meldingen.join('\n')).toMatch(/niets bewaard/);
    kapot = false;
    h.lpdLos(4);
    h.lpdDruk(4);
    h.tijd(300);
    h.lpdDruk(4);
    const r2 = await o.afgesloten;
    expect(r2.map).toBe(join(MAP, mapNaam(BEGON)));
    expect(fs.bestanden.has(join(r2.map, SAMENVATTING))).toBe(true);
  });

  it('te grote achterstand: regels vallen weg (geteld, één melding), het geheugen groeit niet onbegrensd', async () => {
    const h = bank();
    apps(h);
    const fs = geheugenFs({ append: () => 'hang' });
    const { o, meldingen } = neemOp(h, fs, { maxAchterstand: 4000 });
    h.lpdDruk(4); h.lpdLos(4);
    for (let i = 0; i < 5; i++) { h.schuif('fader1', 0, 1); h.schuif('fader1', 1, 0); }
    const s = /** @type {any} */ (o.huidig).schrijver;
    expect(s.tekens).toBeLessThanOrEqual(4000);
    expect(s.verloren).toBeGreaterThan(0);
    expect(meldingen.filter((m) => /achterstand/.test(m))).toHaveLength(1);
  });

  it('twee avonden in dezelfde seconde krijgen elk een eigen map', async () => {
    const h = bank();
    apps(h);
    const fs = geheugenFs();
    const { o } = neemOp(h, fs);
    for (let i = 0; i < 2; i++) { h.lpdDruk(4); h.lpdLos(4); h.tik('pad1-1'); h.lpdDruk(4); h.lpdLos(4); await o.afgesloten; }
    expect(fs.mappen.has(join(MAP, mapNaam(BEGON)))).toBe(true);
    expect(fs.mappen.has(join(MAP, `${mapNaam(BEGON)}-2`))).toBe(true);
  });
});

describe('avondmap: losse onderdelen', () => {
  it("avondmap uit config, met '~' uitgeschreven", () => {
    expect(avondmapPad({ avondmap: '~/Movies/varve-avonden' }, '/Users/clay')).toBe('/Users/clay/Movies/varve-avonden');
    expect(avondmapPad({}, '/Users/clay')).toBe('/Users/clay/Movies/varve-avonden');
    expect(avondmapPad({ avondmap: '/Volumes/X/avonden' }, '/Users/clay')).toBe('/Volumes/X/avonden');
    expect(avondmapPad({ avondmap: '~' }, '/Users/clay')).toBe('/Users/clay');
  });

  it('LPD8-invoer wordt gelezen met het profiel van toen en als mk2-fabrieksstand afgespeeld; SysEx en pad 4 vallen weg', () => {
    const eigen = { model: 'mk1', bron: 'geleerd', pads: Array.from({ length: 8 }, (_, i) => ({ t: 'note', n: 60 + i })), knoppen: Array.from({ length: 8 }, (_, i) => ({ n: 1 + i })) };
    const ont = LPD8.maakOntleder(/** @type {any} */ (eigen));
    expect(vertaal('lpd8', [0xb0, 3, 90], ont)).toEqual({ dev: 'lpd8', bytes: [0xb0, 72, 90] });      // knop 3
    expect(vertaal('lpd8', [0x90, 65, 80], ont)).toEqual({ dev: 'lpd8', bytes: [0x99, 41, 80] });     // pad 6 druk
    expect(vertaal('lpd8', [0x80, 65, 0], ont)).toEqual({ dev: 'lpd8', bytes: [0x89, 41, 0] });       // pad 6 los
    expect(vertaal('lpd8', [0x90, 63, 100], ont)).toEqual({ overslaan: 'opname-knop' });              // pad 4
    expect(vertaal('lpd8-virtueel', [0x99, 39, 100], ont)).toEqual({ overslaan: 'opname-knop' });
    expect(vertaal('lpd8-virtueel', [0xb0, 70, 5], ont)).toEqual({ dev: 'lpd8', bytes: [0xb0, 70, 5] });
    expect(vertaal('apc40', [0xf0, 0x7e, 0, 6, 2, 0xf7], ont)).toEqual({ overslaan: 'sysex' });
    expect(vertaal('apc40-virtueel', [0xb0, 7, 64], ont)).toEqual({ dev: 'apc40', bytes: [0xb0, 7, 64] });
    expect(naarFabriek({ el: null, kind: 'onbekend' })).toBe(null);
  });

  it('leesOpname: een afgebroken laatste regel (stroom weg) wordt overgeslagen; zonder eind is er niets te vergelijken', async () => {
    const tekst = [
      JSON.stringify({ v: 1, soort: 'avond', begon: 'x', 'hub-git': null, apps: {}, lpd8: null }),
      JSON.stringify({ ms: 0, e: 'beginstand', focus: null, globaal: {}, apps: {}, snapshots: {} }),
      JSON.stringify([5, 'in', 'apc40', [0xb0, 7, 3]]),
      '[12, "in", "apc4',
    ].join('\n');
    const o = leesOpname(tekst);
    expect(o.kapot).toBe(1);
    expect(o.stappen).toHaveLength(1);
    expect(o.eind).toBe(null);
    const klok = new NepKlok();
    /** @type {number[][]} */
    const gezien = [];
    const p = herhaal({ opname: o, klok, doel: { invoer: (_d, b) => gezien.push(b), cockpit: () => {}, eindstaat: () => ({}) } });
    klok.loop(1000);
    const r = await p;
    expect(gezien).toEqual([[0xb0, 7, 3]]);
    expect(r.verschillen).toBe(null);
    expect(verslag(r)).toMatch(/geen eindstaat/);
    expect(() => leesOpname('{"geen":"kop"}')).toThrow(/geen opname/);
  });

  it('staat-hash: volgorde en float-ruis tellen niet, een echte wijziging wel', () => {
    expect(staatHash({ a: 0.5, b: 0.25 })).toBe(staatHash({ b: 0.25, a: 0.5 + 1e-12 }));
    expect(staatHash({ a: 0.5 })).not.toBe(staatHash({ a: 0.51 }));
    expect(redenVan(fsFout('ENOSPC'))).toBe('de schijf is vol');
  });

  it('BufferSchrijver: een volle buffer wordt meteen (asynchroon) gespoeld, zonder op de timer te wachten', async () => {
    const klok = new NepKlok();
    const fs = geheugenFs();
    const s = new BufferSchrijver({ klaar: async () => '/x.jsonl', bestanden: fs, klok, spoelMs: 10_000, spoelTekens: 100 });
    for (let i = 0; i < 9; i++) s.schrijf('0123456789');
    await new Promise((r) => setImmediate(r));
    expect(fs.appends).toBe(0);
    s.schrijf('0123456789');
    await new Promise((r) => setImmediate(r));
    expect(fs.appends).toBe(1);
    expect(fs.bestanden.get('/x.jsonl')?.split('\n').length).toBe(11);
    const r = await s.sluit();
    expect(r).toMatchObject({ pad: '/x.jsonl', regels: 10, verloren: 0 });
    s.schrijf('na het sluiten');
    expect(s.buffer).toEqual([]);
  });
});
