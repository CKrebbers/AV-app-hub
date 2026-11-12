// De proeven "kp3plus" en "efx500" (src/proef/kp3-efx.js) met de gesimuleerde gebruiker: een nep-USB-MIDI-interface
// met de KP3+ op MIDI 1 en de EFX-500 op MIDI 2. Ook een KP3+ met andere CC's dan de gok (de proef meet, hij neemt niets
// aan), zonder aanraak-CC, en zonder interface.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { echteKlok } from '../src/core/klok.js';
import { Logboek, leesLogboek } from '../src/core/logboek.js';
import { maakApparaten } from '../src/apparaten.js';
import { voerUit } from '../src/proef/runner.js';
import { kp3plus, efx500, perCc, KLOK_TIKKEN } from '../src/proef/kp3-efx.js';
import { PROTOCOLLEN } from '../src/proef/index.js';
import { laadConfig } from '../src/config.js';
import { simulatie } from './gesimuleerd.js';
import { herspeel } from './herspeel.js';
import { metInterface } from './nep-kp3-efx.js';

const CONFIG = { ...metInterface(laadConfig()), hotplug_ms: 5 };

/** @param {import('../src/proef/runner.js').Protocol} protocol @param {{ sim?: any, config?: any }} [o] */
async function draai(protocol, { sim = simulatie({ kp3efx: true, antwoorden: { 'efx-klok': '250' } }), config = CONFIG } = {}) {
  const regels = [];
  const logboek = new Logboek({ klok: echteKlok, schrijf: (r) => regels.push(r), kop: { soort: 'proef', naam: protocol.naam, synthetisch: true } });
  const apparaten = maakApparaten({ systeem: sim.systeem, klok: echteKlok, config, logboek });
  apparaten.start();
  const bevindingen = await voerUit(protocol, { apparaten, io: sim.io, klok: echteKlok, logboek, schaal: 0.01, gebruiker: sim.gebruiker, config, niProgrammas: () => [] });
  await apparaten.stop();
  return { bevindingen: /** @type {Record<string, any>} */ (bevindingen), regels, sim };
}
const stappenVan = (regels) => leesLogboek(regels.join('\n')).regels.filter((x) => x.e === 'stap');

describe('proef kp3plus', () => {
  it('staat in de lijst van varve-hub proef', () => {
    expect(PROTOCOLLEN.kp3plus).toBe(kp3plus);
    expect(PROTOCOLLEN.efx500).toBe(efx500);
  });

  it('docs/HARDWARE-AVOND.md (blok 9) noemt elke stap van beide proeven, in volgorde en met het nummer van de terminal', () => {
    const draaiboek = readFileSync(new URL('../docs/HARDWARE-AVOND.md', import.meta.url), 'utf8');
    const blok = draaiboek.slice(draaiboek.indexOf('## 9. KP3+ en EFX-500'));
    for (const [p, kop] of /** @type {const} */ ([[kp3plus, '### KP3+'], [efx500, '### EFX-500']])) {
      const deel = blok.slice(blok.indexOf(kop));
      const tabel = deel.slice(0, deel.indexOf('\n\n', deel.indexOf('| 1 |')));
      const rijen = [...tabel.matchAll(/^\| (\d+) \| ([^|]+?) \|/gm)].map((m) => ({ nr: Number(m[1]), titel: m[2] }));
      expect(rijen).toEqual(p.stappen.map((s, i) => ({ nr: i + 1, titel: s.titel })));
      expect(deel).toMatch(new RegExp(`node src/cli\\.js proef ${p.naam}`));
    }
  });

  it('meet X, Y, aanraken, kanaal, programmageheugens, FX Depth en Hold; config.json klopt dan', async () => {
    const { bevindingen: b, regels } = await draai(kp3plus);
    const stappen = stappenVan(regels);
    expect(stappen.filter((x) => x.status === 'fout')).toEqual([]);
    expect(stappen.filter((x) => x.status === 'klaar').map((x) => x.id)).toEqual(kp3plus.stappen.map((s) => s.id));
    expect(b['kp3-poort']).toMatchObject({ naam: 'USB MIDI Interface MIDI 1', patroon: 'interface midi 1' });
    expect(b['kp3-x']).toMatchObject({ x: 12, kanaal: 11, bereik: [0, 127] });
    expect(b['kp3-y']).toMatchObject({ y: 13 });
    expect(b['kp3-aanraak']).toMatchObject({ aanraak: 92 });
    expect(b['kp3-programmas'].soort).toBe('program-change');
    expect(b['kp3-programmas'].knoppen.map((k) => k.bytes)).toEqual(Array.from({ length: 8 }, (_, i) => [0xca, 10 + i]));
    expect(b['kp3-diepte']).toMatchObject({ diepte: 94 });
    expect(b['kp3-hold']).toMatchObject({ hold: 95 });
    expect(b['kp3plus-meting']).toMatchObject({ gemeten: { kanaal: 11, cc: { x: 12, y: 13, aanraak: 92, diepte: 94, hold: 95 } }, klopt: true });
  }, 30000);

  it('een KP3+ met andere CC\'s en zonder aanraak-CC: de proef meet wat hij echt stuurt en zegt wat in config.json moet', async () => {
    const sim = simulatie({ kp3efx: true, kp3: { x: 70, y: 71, aanraak: null, diepte: 72, hold: 73, kanaal: 1 } });
    const { bevindingen: b, sim: s } = await draai(kp3plus, { sim });
    expect(b['kp3plus-meting']).toMatchObject({ gemeten: { kanaal: 1, cc: { x: 70, y: 71, aanraak: null, diepte: 72, hold: 73 } }, klopt: false });
    expect(s.getoond.join('\n')).toMatch(/zet in config\.json → apparaten\.kp3plus:\n\s+"cc": \{"x":70,"y":71,"aanraak":null,"diepte":72,"hold":73\}/);
  }, 30000);

  it('perCc: telt per CC de verschillende waarden en de wissels aan/los', () => {
    expect(perCc([[0xb0, 1, 0], [0xb0, 1, 127], [0xb0, 1, 0], [0xb1, 2, 5], [0xc0, 3]])).toEqual([
      { cc: 1, kanaal: 1, n: 3, min: 0, max: 127, wissels: 2, verschillend: 2 },
      { cc: 2, kanaal: 2, n: 1, min: 5, max: 5, wissels: 0, verschillend: 1 },
    ]);
  });
});

describe('proef efx500', () => {
  it('meet de klok (tempo, spreiding, jitter), een tempowissel, zonder muziek, en wat de knoppen sturen', async () => {
    const { bevindingen: b, regels } = await draai(efx500);
    const stappen = stappenVan(regels);
    expect(stappen.filter((x) => x.status === 'fout')).toEqual([]);
    expect(stappen.filter((x) => x.status === 'klaar').map((x) => x.id)).toEqual(efx500.stappen.map((s) => s.id));
    expect(b['efx-poort']).toMatchObject({ naam: 'USB MIDI Interface MIDI 2' });
    expect(b['efx-klok']).toMatchObject({ gezien: true, tikken: KLOK_TIKKEN, display: 250 });
    // setTimeout is geen klok van een EFX: een paar BPM speling in CI.
    expect(Math.abs(b['efx-klok'].bpm - 250)).toBeLessThan(10);
    expect(b['efx-klok'].jitterMs.mediaanInterval).toBeGreaterThan(8);
    expect(b['efx-wissel'].na).toBeLessThan(b['efx-klok'].bpm);
    expect(Math.abs(b['efx-wissel'].na - 200)).toBeLessThan(10);
    expect(b['efx-stil']).toEqual({ tikken: 0, tiktDoor: false });
    expect(b['efx-knoppen']).toMatchObject({ aantal: 3, transport: ['start', 'stop'], anders: [[0xb0, 20, 64]] });
  }, 30000);

  it('het logboek is een golden test: één tik per tel, start/stop en de knoppen ontleed', async () => {
    const { regels } = await draai(efx500);
    const tekst = regels.join('\n');
    const { getoetst, verschillen } = herspeel(tekst);
    expect(verschillen).toEqual([]);
    const efxIn = leesLogboek(tekst).regels.filter((r) => Array.isArray(r) && r[1] === 'in' && r[2] === 'efx500');
    // 2 × KLOK_TIKKEN tikken, waarvan één per 24 gelogd (per aansluiting geteld), plus 3 knoppen
    expect(efxIn.length).toBeLessThan(30);
    expect(getoetst).toBeGreaterThan(5);
  }, 30000);

  it('zonder interface: de stappen die hem nodig hebben, worden overgeslagen', async () => {
    const sim = simulatie({});
    const { bevindingen: b, regels } = await draai(efx500, { sim });
    expect(b['efx-poort']).toMatchObject({ naam: null });
    expect(stappenVan(regels).filter((x) => x.status === 'overgeslagen').map((x) => x.id)).toEqual(['efx-klok', 'efx-wissel', 'efx-stil', 'efx-knoppen']);
  }, 30000);
});
