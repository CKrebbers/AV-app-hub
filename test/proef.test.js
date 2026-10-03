import { describe, it, expect } from 'vitest';
import { echteKlok } from '../src/core/klok.js';
import { Logboek, leesLogboek } from '../src/core/logboek.js';
import { maakApparaten } from '../src/apparaten.js';
import { voerUit } from '../src/proef/runner.js';
import { f0Hardware } from '../src/proef/f0-hardware.js';
import { simulatie } from './gesimuleerd.js';
import * as A from '../src/devices/apc40mk2.js';

const config = { hotplug_ms: 5, led: { per_burst: 16, burst_ms: 4 }, apparaten: { apc40: { naam: 'apc40', modus: 0x42 }, lpd8: { naam: 'lpd8' } } };

async function draai(o = {}) {
  const sim = simulatie(o);
  const regels = [];
  const logboek = new Logboek({ klok: echteKlok, schrijf: (r) => regels.push(r), kop: { soort: 'proef', naam: 'f0-hardware', synthetisch: true } });
  const apparaten = maakApparaten({ systeem: sim.systeem, klok: echteKlok, config, logboek });
  apparaten.start();
  const bevindingen = await voerUit(f0Hardware, { apparaten, io: sim.io, klok: echteKlok, logboek, schaal: 0.01, gebruiker: sim.gebruiker });
  await apparaten.stop();
  return { bevindingen, regels, sim };
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
    expect(over).toEqual(['lpd8-leren', 'lpd8-test', 'lpd8-leds']);
  }, 30000);
});
