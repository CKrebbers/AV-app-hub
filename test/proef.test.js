import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { echteKlok } from '../src/core/klok.js';
import { Logboek, leesLogboek } from '../src/core/logboek.js';
import { maakApparaten } from '../src/apparaten.js';
import { voerUit } from '../src/proef/runner.js';
import { f0Hardware } from '../src/proef/f0-hardware.js';
import { simulatie } from './gesimuleerd.js';
import * as A from '../src/devices/apc40mk2.js';

const config = { hotplug_ms: 5, led: { per_burst: 16, burst_ms: 4 }, apparaten: { apc40: { naam: 'apc40', modus: 0x42 }, lpd8: { naam: 'lpd8' } } };

/** Een volledige proef. `sim` om de nep-hardware vooraf aan te passen, `cfg` voor config.json-waarden (bv. hubtoets). */
async function draai(o = {}, { sim = simulatie(o), cfg = { hubtoets: 'bank' } } = {}) {
  const regels = [];
  const logboek = new Logboek({ klok: echteKlok, schrijf: (r) => regels.push(r), kop: { soort: 'proef', naam: 'f0-hardware', synthetisch: true } });
  const apparaten = maakApparaten({ systeem: sim.systeem, klok: echteKlok, config, logboek });
  apparaten.start();
  const bevindingen = await voerUit(f0Hardware, { apparaten, io: sim.io, klok: echteKlok, logboek, schaal: 0.01, gebruiker: sim.gebruiker, config: cfg });
  await apparaten.stop();
  return { bevindingen, regels, sim };
}

/** Vervang wat de gesimuleerde gebruiker doet voor sommige verwachtingen; de rest gaat zoals altijd. */
function onderschep(sim, fn) {
  const orig = [...sim.gebruiker.l.get('verwacht')];
  sim.gebruiker.l.set('verwacht', new Set([(w) => { if (fn(w)) return; for (const f of orig) f(w); }]));
}
const later = (fn) => setTimeout(fn, 1);

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

  it('ziet het als de LPD8-pads niets sturen bij loslaten (TOGGLE-modus): lang drukken en paniek werken dan niet', async () => {
    const { bevindingen: b, sim } = await draai({ lpd8Toggle: true });
    expect(b['lpd8-vasthouden']).toMatchObject({ noteOff: false, langDrukkenWerkt: false, paniekGehaald: false });
    expect(b['lpd8-vasthouden'].lang).toMatchObject({ gedrukt: true, los: false, ms: null });
    expect(sim.getoond.join('\n')).toMatch(/MOMENTARY/);
  }, 30000);

  it('ziet het als de hubtoets vasthouden verandert wat Track Select stuurt', async () => {
    const sim = simulatie();
    // BANK vast → TRACK SELECT 3 komt binnen als TRACK SELECT 1 (noot 51 op kanaal 0 i.p.v. 2)
    onderschep(sim, (w) => {
      if (w.soort !== 'eerste' || w.akkoord?.[1] !== 'sel3') return false;
      later(() => { for (const b of [[0x90, 103, 127], [0x90, 51, 127], [0x80, 51, 127], [0x80, 103, 127]]) sim.poorten.apc.injecteer(b); });
      return true;
    });
    const { bevindingen: b } = await draai({}, { sim });
    expect(b['hubtoets-akkoord'].focus).toMatchObject({ klopt: false, vreemd: ['sel1'] });
    expect(b['hubtoets-akkoord'].bewaren.klopt).toBe(true);
  }, 30000);

  it('telt een akkoord niet als de hubtoets al los was voor de andere knop kwam', async () => {
    const sim = simulatie();
    onderschep(sim, (w) => {
      if (w.soort !== 'eerste' || w.akkoord?.[2] !== 'scene2') return false;
      // SHIFT laat los vóór SCENE 2; daarna nog eens BANK aan/uit zodat de stap eindigt
      const msgs = [[0x90, 103, 127], [0x90, 98, 127], [0x80, 98, 127], [0x90, 83, 127], [0x80, 83, 127], [0x80, 103, 127]];
      later(() => { for (const b of msgs) sim.poorten.apc.injecteer(b); });
      return true;
    });
    const { bevindingen: b } = await draai({}, { sim });
    expect(b['hubtoets-akkoord'].bewaren.klopt).toBe(false);
    expect(b['hubtoets-akkoord'].bewaren.vreemd).toEqual([]);
  }, 30000);

  it('test de hubtoets uit config.json, niet vast BANK', async () => {
    const { bevindingen: b } = await draai({}, { cfg: { hubtoets: 'user' } });
    expect(b['hubtoets-akkoord']).toMatchObject({ hubtoets: 'user', focus: { klopt: true }, bewaren: { klopt: true } });
    expect(b['hubtoets-akkoord'].focus.volgorde[0]).toEqual({ el: 'user', kind: 'druk' });
    const { bevindingen: b2 } = await draai({}, { cfg: { hubtoets: 103 } }); // als nootnummer, zoals de kern het ook leest
    expect(b2['hubtoets-akkoord'].hubtoets).toBe('bank');
  }, 30000);

  it('legt "nee"-antwoorden met notitie vast', async () => {
    const { bevindingen: b } = await draai({ antwoorden: { grid: 'n pad 2-3 werd blauw', 'V2-midi-clock': 'n' } });
    expect(b.grid.positieKlopt).toEqual({ ok: false, notitie: 'pad 2-3 werd blauw' });
  }, 30000);

  it('ziet het als een knop iets anders stuurt dan verwacht (zoals ◄/► in av-kern)', async () => {
    const sim = simulatie();
    // Laat de nep-APC bij "druk ◄" het bericht van ► sturen
    const orig = sim.gebruiker.l.get('verwacht');
    sim.gebruiker.l.set('verwacht', new Set([(w) => {
      if (w.soort === 'eerste' && w.id === 'left') return setTimeout(() => sim.poorten.apc.injecteer([0x90, 96, 127]), 1);
      for (const fn of orig) fn(w);
    }]));
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
