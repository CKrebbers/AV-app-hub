// Maakt test/fixtures/synthetisch-speelapparaten.jsonl: een volledige proef speelapparaten (Xboard49 + Maschine MK2)
// met de gesimuleerde gebruiker. Alleen opnieuw draaien als het logformaat bewust verandert:
//   node test/maak-fixture-speel.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { echteKlok } from '../src/core/klok.js';
import { Logboek } from '../src/core/logboek.js';
import { maakApparaten } from '../src/apparaten.js';
import { voerUit } from '../src/proef/runner.js';
import { speelapparaten } from '../src/proef/speelapparaten.js';
import { simulatie } from './gesimuleerd.js';

const config = {
  hotplug_ms: 5, led: { per_burst: 16, burst_ms: 4 },
  apparaten: { apc40: { naam: 'apc40', modus: 0x42 }, lpd8: { naam: 'lpd8' }, xboard49: { naam: 'xboard' }, 'maschine-mk2': { vid: '17cc', pid: '1140', stil_ms: 50 } },
};
const sim = simulatie({ speel: true });
const regels = [];
const logboek = new Logboek({ klok: echteKlok, schrijf: (r) => regels.push(r), kop: { soort: 'proef', naam: 'speelapparaten', synthetisch: true } });
const apparaten = maakApparaten({ systeem: sim.systeem, hid: sim.hid, klok: echteKlok, config, logboek });
apparaten.start();
await voerUit(speelapparaten, { apparaten, io: sim.io, klok: echteKlok, logboek, schaal: 0.01, gebruiker: sim.gebruiker, config, niProgrammas: () => [] });
await apparaten.stop();
mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
writeFileSync(new URL('./fixtures/synthetisch-speelapparaten.jsonl', import.meta.url), regels.join('\n') + '\n');
console.log(`${regels.length} regels`);
process.exit(0);
