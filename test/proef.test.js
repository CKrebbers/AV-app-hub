import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { echteKlok } from '../src/core/klok.js';
import { Logboek, leesLogboek } from '../src/core/logboek.js';
import { maakApparaten } from '../src/apparaten.js';
import { voerUit } from '../src/proef/runner.js';
import { f0Hardware } from '../src/proef/f0-hardware.js';
import { simulatie } from './gesimuleerd.js';
import * as A from '../src/devices/apc40mk2.js';

const config = { hotplug_ms: 5, led: { per_burst: 16, burst_ms: 4 }, apparaten: { apc40: { naam: 'apc40', modus: 0x42 }, lpd8: { naam: 'lpd8' } } };

/**
 * Een volledige proef. `sim` om de nep-hardware vooraf aan te passen, `cfg` voor config.json-waarden (bv. hubtoets),
 * `stappen` om alleen die stap-ids te draaien, `schaal` voor de tijd (groter = ruimere marges voor tijdmetingen).
 */
async function draai(o = {}, { sim = simulatie(o), cfg = { hubtoets: 'bank' }, stappen = null, schaal = 0.01 } = {}) {
  const regels = [];
  const logboek = new Logboek({ klok: echteKlok, schrijf: (r) => regels.push(r), kop: { soort: 'proef', naam: 'f0-hardware', synthetisch: true } });
  const apparaten = maakApparaten({ systeem: sim.systeem, klok: echteKlok, config, logboek });
  apparaten.start();
  const protocol = stappen ? { ...f0Hardware, stappen: f0Hardware.stappen.filter((s) => stappen.includes(s.id)) } : f0Hardware;
  const bevindingen = await voerUit(protocol, { apparaten, io: sim.io, klok: echteKlok, logboek, schaal, gebruiker: sim.gebruiker, config: cfg ?? undefined });
  await apparaten.stop();
  return { bevindingen, regels, sim };
}

const later = (fn) => setTimeout(fn, 1);
/** Alleen de stappen voor lang drukken (plus apparaten zoeken), met schaal 0.1: 600 ms wordt 60 ms, 1 s wordt 100 ms. */
const VASTHOUDEN = { stappen: ['apparaten', 'lpd8-vasthouden'], schaal: 0.1 };
/** De gesimuleerde gebruiker houdt pad `nr` `ms` (onschaalde) milliseconden vast. */
function houdPad(sim, nr, ms, schaal = 0.1) {
  sim.onderschep((w) => {
    if (w.soort !== 'eerste' || w.pad !== nr || w.loslaten) return false;
    later(() => { sim.poorten.lpd8.injecteer([0x99, 35 + nr, 100]); setTimeout(() => sim.poorten.lpd8.injecteer([0x89, 35 + nr, 0]), ms * schaal); });
    return true;
  });
}

describe('proef F0 met gesimuleerde gebruiker', () => {
  it('loopt alle stappen door zonder fouten', async () => {
    const { regels } = await draai();
    const { regels: r } = leesLogboek(regels.join('\n'));
    const stappen = r.filter((x) => x.e === 'stap');
    expect(stappen.filter((x) => x.status === 'fout')).toEqual([]);
    expect(stappen.filter((x) => x.status === 'klaar').map((x) => x.id)).toEqual(f0Hardware.stappen.map((s) => s.id));
  }, 30000);

  it('vindt elke APC-control en levert de verwachte bevindingen', async () => {
    const { bevindingen: b } = await draai();
    expect(b.apparaten).toEqual({ apc40: 'APC40 mkII', lpd8: 'LPD8 mk2' });
    for (const id of ['grid', 'scenes', 'strips', 'faders', 'knoppen', 'relatief']) expect(b[id].ontbrekend, id).toEqual([]);
    // samen dekken de stappen alle 148 controls
    const gezien = new Set(['grid', 'scenes', 'strips', 'faders', 'knoppen', 'relatief'].flatMap((id) => b[id].gezien));
    for (const x of b['losse-knoppen'].uitslag) gezien.add(x.kreeg);
    if (b.voet.gezien) gezien.add('voet');
    expect([...A.OP_ID.keys()].filter((id) => !gezien.has(id))).toEqual([]);
    expect(b['losse-knoppen'].verwisseld).toEqual([]);
    expect(b['V1-ring-overname'].overgenomen).toBe(true);
    expect(b['V4-intro-antwoord']).toMatchObject({ ontvangen: true, lijktFaders: true });
    expect(b.identiteit.lpd8_model).toBe('mk2');
    expect(Object.keys(b.identiteit.lpd8_programmas)).toHaveLength(5);
    expect(b['lpd8-profiel'].profiel.pads.map((p) => p.n)).toEqual([36, 37, 38, 39, 40, 41, 42, 43]);
    expect(b['lpd8-profiel'].profiel.knoppen.map((k) => k.n)).toEqual([70, 71, 72, 73, 74, 75, 76, 77]);
    expect(b['lpd8-test'].ontbrekend).toEqual([]);
    expect(b.replug.weg.ok && b.replug.terug.ok).toBe(true);
    expect(b.repaint.berichten).toBeGreaterThan(100);
    // wat de hub sinds golf 1 van de hardware vraagt
    expect(b['hubtoets-akkoord']).toMatchObject({ hubtoets: 'bank', focus: { klopt: true, vreemd: [] }, bewaren: { klopt: true, vreemd: [] } });
    expect(b['lpd8-vasthouden']).toMatchObject({ noteOff: true, losBijLoslaten: true, langDrukkenWerkt: true, paniekGehaald: true, langMs: 600, paniekMs: 1000 });
    expect(b['lpd8-vasthouden'].lang.tussendoor).toBeGreaterThan(0); // aftertouch van de mk2 tijdens het vasthouden
    expect(b['lpd8-replug']).toMatchObject({ herkend: true, weg: { ok: true }, terug: { ok: true } });
  }, 30000);

  it('TOGGLE-modus, pad 8 staat nog aan van de vorige stappen: de eerste druk is een note-off, en de stap blijft niet hangen', async () => {
    const sim = simulatie({ lpd8Toggle: true });
    let aanBijBegin = null;
    sim.onderschep((w) => { if (w.stap === 'lpd8-vasthouden' && w.pad === 8 && aanBijBegin === null) aanBijBegin = sim.padAan.has(43); return false; });
    const { bevindingen: b } = await draai({}, { sim });
    expect(aanBijBegin).toBe(true); // zoals op de echte LPD8 na lpd8-leren en lpd8-test
    expect(b['lpd8-vasthouden']).toMatchObject({ toggle: true, noteOff: false, langDrukkenWerkt: false, paniekGehaald: false });
    expect(b['lpd8-vasthouden'].lang).toMatchObject({ gedrukt: true, los: false, eersteWasLos: true, ms: null });
    const tekst = sim.getoond.join('\n');
    expect(tekst).toMatch(/MOMENTARY/);
    expect(tekst).toMatch(/blijft hangen/);
    expect(tekst).toMatch(/overschreven/);
  }, 10000);

  it('TOGGLE-modus, pad 8 staat uit: de druk is een note-on en bij loslaten komt niets (na 10 s door)', async () => {
    const sim = simulatie({ lpd8Toggle: true });
    sim.onderschep((w) => { if (w.stap === 'lpd8-vasthouden' && w.pad === 8 && !w.loslaten) sim.padAan.delete(43); return false; });
    const { bevindingen: b } = await draai({}, { sim });
    expect(b['lpd8-vasthouden']).toMatchObject({ toggle: true, noteOff: false });
    expect(b['lpd8-vasthouden'].lang).toMatchObject({ gedrukt: true, los: false, eersteWasLos: false, losOvergeslagen: false });
  }, 10000);

  it('"o" tijdens het wachten op loslaten is onbeslist, geen TOGGLE-oordeel', async () => {
    const sim = simulatie();
    sim.onderschep((w) => { if (w.stap === 'lpd8-vasthouden' && w.pad === 8 && w.loslaten) { sim.typ('o'); return true; } return false; });
    houdPad(sim, 8, 3000);
    const { bevindingen: b } = await draai({}, { sim, ...VASTHOUDEN });
    expect(b['lpd8-vasthouden']).toMatchObject({ toggle: false, lang: { gedrukt: true, los: false, losOvergeslagen: true } });
    const tekst = sim.getoond.join('\n');
    expect(tekst).toMatch(/onbeslist/);
    expect(tekst).not.toMatch(/TOGGLE-modus/);
  }, 10000);

  it('pad 8 tussen 0,6 en 1 s vastgehouden: lang drukken werkt, paniek niet gehaald (en de terminal belooft geen paniek)', async () => {
    const sim = simulatie();
    houdPad(sim, 8, 800);
    const { bevindingen: b } = await draai({}, { sim, ...VASTHOUDEN });
    expect(b['lpd8-vasthouden']).toMatchObject({ noteOff: true, langDrukkenWerkt: true, paniekGehaald: false });
    const tekst = sim.getoond.join('\n');
    expect(tekst).toMatch(/Voor paniek houd je pad 1/);
    expect(tekst).not.toMatch(/lang drukken en paniek werken/);
  }, 10000);

  it('een "korte" tik op pad 5 die langer dan 0,6 s duurt: lang drukken telt niet als werkend', async () => {
    const sim = simulatie();
    houdPad(sim, 8, 1500);
    houdPad(sim, 5, 900);
    const { bevindingen: b } = await draai({}, { sim, ...VASTHOUDEN });
    expect(b['lpd8-vasthouden']).toMatchObject({ noteOff: true, losBijLoslaten: true, langDrukkenWerkt: false, paniekGehaald: true });
    expect(sim.getoond.join('\n')).toMatch(/Tik straks echt kort/);
  }, 10000);

  it('herkent de LPD8 na opnieuw aansluiten met het geleerde profiel (afwijkende noten en CC\'s)', async () => {
    const sim = simulatie({ padBasis: 48, knopBasis: 20 });
    const { bevindingen: b } = await draai({}, { sim });
    expect(b['lpd8-profiel'].profiel.pads.map((p) => p.n)).toEqual([48, 49, 50, 51, 52, 53, 54, 55]);
    expect(b['lpd8-profiel'].profiel.knoppen.map((k) => k.n)).toEqual([20, 21, 22, 23, 24, 25, 26, 27]);
    expect(b['lpd8-test'].ontbrekend).toEqual([]);
    expect(b['lpd8-replug']).toMatchObject({ herkend: true, gezien: ['p1', 'k1'] });
  }, 30000);

  it('ziet het als de hubtoets vasthouden verandert wat Track Select stuurt', async () => {
    const sim = simulatie();
    // BANK vast → TRACK SELECT 3 komt binnen als TRACK SELECT 1 (noot 51 op kanaal 0 i.p.v. 2)
    sim.onderschep((w) => {
      if (w.soort !== 'eerste' || w.akkoord?.[1] !== 'sel3') return false;
      later(() => { for (const b of [[0x90, 103, 127], [0x90, 51, 127], [0x80, 51, 127], [0x80, 103, 127]]) sim.poorten.apc.injecteer(b); });
      return true;
    });
    const { bevindingen: b } = await draai({}, { sim });
    expect(b['hubtoets-akkoord'].focus).toMatchObject({ klopt: false, vreemd: ['sel1'] });
    expect(b['hubtoets-akkoord'].focus.pogingen).toBeUndefined(); // een vreemde knop is een hardwarebevinding, geen herkansing
    expect(b['hubtoets-akkoord'].bewaren.klopt).toBe(true);
  }, 30000);

  it('telt een akkoord niet als SHIFT al los was voor SCENE 2 kwam (ook niet bij de herkansing)', async () => {
    const sim = simulatie();
    sim.onderschep((w) => {
      if (w.soort !== 'eerste' || w.akkoord?.[2] !== 'scene2') return false;
      const msgs = [[0x90, 103, 127], [0x90, 98, 127], [0x80, 98, 127], [0x90, 83, 127], [0x80, 83, 127], [0x80, 103, 127]];
      later(() => { for (const b of msgs) sim.poorten.apc.injecteer(b); });
      return true;
    });
    const { bevindingen: b } = await draai({}, { sim });
    expect(b['hubtoets-akkoord'].bewaren.klopt).toBe(false);
    expect(b['hubtoets-akkoord'].bewaren.vreemd).toEqual([]);
    expect(b['hubtoets-akkoord'].bewaren.pogingen).toHaveLength(2);
  }, 30000);

  it('blijft niet hangen als BANK al los is voor TRACK SELECT 3, en geeft één herkansing', async () => {
    const sim = simulatie();
    let keer = 0;
    sim.onderschep((w) => {
      if (w.soort !== 'eerste' || w.akkoord?.[1] !== 'sel3' || keer++) return false;
      // BANK tikken, daarna TRACK SELECT 3 tikken (te vroeg losgelaten)
      later(() => { for (const b of [[0x90, 103, 127], [0x80, 103, 127], [0x92, 51, 127], [0x82, 51, 127]]) sim.poorten.apc.injecteer(b); });
      return true;
    });
    const { bevindingen: b } = await draai({}, { sim, stappen: ['apparaten', 'hubtoets-akkoord'] });
    expect(b['hubtoets-akkoord'].focus).toMatchObject({ klopt: true });
    expect(b['hubtoets-akkoord'].focus.pogingen.map((p) => p.klopt)).toEqual([false, true]);
    expect(sim.getoond.join('\n')).toMatch(/BANK moet vast blijven tot na TRACK SELECT 3 — nog een keer\?/);
  }, 10000);

  it('zegt het als alleen BANK binnenkwam, en wacht dan op een nieuwe poging', async () => {
    const sim = simulatie();
    let keer = 0;
    sim.onderschep((w) => {
      if (w.soort !== 'eerste' || w.akkoord?.[1] !== 'sel3' || keer++) return false;
      later(() => { sim.poorten.apc.injecteer([0x90, 103, 127]); sim.poorten.apc.injecteer([0x80, 103, 127]); }); // TRACK SELECT 3 kwam niet door
      setTimeout(() => { for (const b of [[0x90, 103, 127], [0x92, 51, 127], [0x82, 51, 127], [0x80, 103, 127]]) sim.poorten.apc.injecteer(b); }, 20);
      return true;
    });
    const { bevindingen: b } = await draai({}, { sim, stappen: ['apparaten', 'hubtoets-akkoord'] });
    expect(sim.getoond.join('\n')).toMatch(/alleen BANK kwam binnen/);
    expect(b['hubtoets-akkoord'].focus).toMatchObject({ klopt: true });
  }, 10000);

  it('test de hubtoets uit config.json, niet vast BANK', async () => {
    const { bevindingen: b } = await draai({}, { cfg: { hubtoets: 'user' } });
    expect(b['hubtoets-akkoord']).toMatchObject({ hubtoets: 'user', focus: { klopt: true }, bewaren: { klopt: true } });
    expect(b['hubtoets-akkoord'].focus.volgorde[0]).toEqual({ el: 'user', kind: 'druk' });
    const { bevindingen: b2 } = await draai({}, { cfg: { hubtoets: 89 }, stappen: ['apparaten', 'hubtoets-akkoord'] }); // als nootnummer, zoals de kern het ook leest
    expect(b2['hubtoets-akkoord']).toMatchObject({ hubtoets: 'user', focus: { klopt: true } });
    expect(b2['hubtoets-akkoord'].waarschuwing).toBeUndefined();
  }, 30000);

  it('zegt het als de hubtoets in config.json niet bestaat, in plaats van stil BANK goed te keuren', async () => {
    const { bevindingen: b, sim } = await draai({}, { cfg: { hubtoets: 'BANK' }, stappen: ['apparaten', 'hubtoets-akkoord'] });
    expect(b['hubtoets-akkoord']).toMatchObject({ hubtoets: 'bank', focus: { klopt: true } });
    expect(b['hubtoets-akkoord'].waarschuwing).toMatch(/"BANK" bestaat niet/);
    const tekst = sim.getoond.join('\n');
    expect(tekst).toMatch(/hubtoets "BANK" bestaat niet/);
    expect(tekst).not.toMatch(/de hublaag werkt op deze APC/);
  }, 10000);

  it('zegt het als config.json kapot is, in plaats van stil de standaard te nemen', async () => {
    const map = mkdtempSync(join(tmpdir(), 'proef-config-'));
    const pad = join(map, 'config.json');
    writeFileSync(pad, '{ kapot');
    const oud = process.env.VARVE_HUB_CONFIG;
    process.env.VARVE_HUB_CONFIG = pad;
    try {
      const { sim, regels } = await draai({}, { cfg: null, stappen: ['apparaten'] });
      expect(sim.getoond.join('\n')).toMatch(/config\.json kon niet gelezen worden/);
      expect(leesLogboek(regels.join('\n')).regels.some((r) => r.e === 'waarschuwing' && r.config)).toBe(true);
    } finally {
      if (oud === undefined) delete process.env.VARVE_HUB_CONFIG; else process.env.VARVE_HUB_CONFIG = oud;
      rmSync(map, { recursive: true, force: true });
    }
  }, 10000);

  it('legt "nee"-antwoorden met notitie vast', async () => {
    const { bevindingen: b } = await draai({ antwoorden: { grid: 'n pad 2-3 werd blauw', 'V2-midi-clock': 'n' } });
    expect(b.grid.positieKlopt).toEqual({ ok: false, notitie: 'pad 2-3 werd blauw' });
  }, 30000);

  it('ziet het als een knop iets anders stuurt dan verwacht (zoals ◄/► in av-kern)', async () => {
    const sim = simulatie();
    // Laat de nep-APC bij "druk ◄" het bericht van ► sturen
    sim.onderschep((w) => {
      if (w.soort !== 'eerste' || w.id !== 'left') return false;
      later(() => sim.poorten.apc.injecteer([0x90, 96, 127]));
      return true;
    });
    const regels = [];
    const logboek = new Logboek({ klok: echteKlok, schrijf: (r) => regels.push(r), kop: {} });
    const apparaten = maakApparaten({ systeem: sim.systeem, klok: echteKlok, config, logboek });
    apparaten.start();
    const b = await voerUit(f0Hardware, { apparaten, io: sim.io, klok: echteKlok, logboek, schaal: 0.01, gebruiker: sim.gebruiker });
    await apparaten.stop();
    expect(b['losse-knoppen'].verwisseld).toEqual([{ verwacht: 'left', kreeg: 'right' }]);
  }, 30000);

  it('slaat LPD8-stappen over als er geen LPD8 is', async () => {
    const sim = simulatie();
    sim.systeem.verwijder('LPD8 mk2');
    const regels = [];
    const logboek = new Logboek({ klok: echteKlok, schrijf: (r) => regels.push(r), kop: {} });
    const apparaten = maakApparaten({ systeem: sim.systeem, klok: echteKlok, config, logboek });
    apparaten.start();
    await voerUit(f0Hardware, { apparaten, io: sim.io, klok: echteKlok, logboek, schaal: 0.01, gebruiker: sim.gebruiker });
    await apparaten.stop();
    const over = leesLogboek(regels.join('\n')).regels.filter((x) => x.e === 'stap' && x.status === 'overgeslagen').map((x) => x.id);
    expect(over).toEqual(['lpd8-leren', 'lpd8-test', 'lpd8-vasthouden', 'lpd8-leds', 'lpd8-replug']);
  }, 30000);
});

describe('docs/HARDWARE-AVOND.md loopt gelijk met de proef', () => {
  const draaiboek = readFileSync(new URL('../docs/HARDWARE-AVOND.md', import.meta.url), 'utf8');

  it('noemt elke stap van de F0-proef, in dezelfde volgorde en met hetzelfde nummer als de terminal', () => {
    const tabel = draaiboek.slice(draaiboek.indexOf('stap voor stap'), draaiboek.indexOf('### De vijf open vragen'));
    const rijen = [...tabel.matchAll(/^\| (\d+) \| ([^|]+?) \|/gm)].map((m) => ({ nr: Number(m[1]), titel: m[2] }));
    expect(rijen).toEqual(f0Hardware.stappen.map((s, i) => ({ nr: i + 1, titel: s.titel })));
  });

  it('gebruikt alleen opdrachten die bestaan zonder npm link', () => {
    const scripts = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts;
    expect(draaiboek).not.toMatch(/^varve-hub /m);
    for (const [, s] of draaiboek.matchAll(/npm (?:run )?(\w+)/g)) if (s !== 'install') expect(scripts[s === 'start' ? 'start' : s], s).toBeDefined();
    const cli = readFileSync(new URL('../src/cli.js', import.meta.url), 'utf8');
    for (const [, op] of draaiboek.matchAll(/node src\/cli\.js (\w+)/g)) expect(cli, op).toMatch(new RegExp(`^  (async )?${op}\\(`, 'm'));
  });

  it('legt de vijf open vragen en de extra metingen uit', () => {
    for (const v of ['V1', 'V2', 'V3', 'V4', 'V5']) expect(draaiboek).toMatch(new RegExp(`\\*\\*${v} — `));
    expect(draaiboek).toMatch(/ringen_nemen_waarde_over/);
    expect(draaiboek).toMatch(/MOMENTARY/);
  });
});
