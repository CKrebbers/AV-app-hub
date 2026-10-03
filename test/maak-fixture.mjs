// Maakt test/fixtures/synthetisch-f0.jsonl: een volledige F0-proef met de gesimuleerde gebruiker.
// Alleen opnieuw draaien als het logformaat bewust verandert: node test/maak-fixture.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { echteKlok } from '../src/core/klok.js';
import { Logboek } from '../src/core/logboek.js';
import { maakApparaten } from '../src/apparaten.js';
import { voerUit } from '../src/proef/runner.js';
import { f0Hardware } from '../src/proef/f0-hardware.js';
import { simulatie } from './gesimuleerd.js';

const config = { hotplug_ms: 5, led: { per_burst: 16, burst_ms: 4 }, apparaten: { apc40: { naam: 'apc40', modus: 0x42 }, lpd8: { naam: 'lpd8' } } };
const sim = simulatie();
const regels = [];
const logboek = new Logboek({ klok: echteKlok, schrijf: (r) => regels.push(r), kop: { soort: 'proef', naam: 'f0-hardware', synthetisch: true } });
const apparaten = maakApparaten({ systeem: sim.systeem, klok: echteKlok, config, logboek });
apparaten.start();
await voerUit(f0Hardware, { apparaten, io: sim.io, klok: echteKlok, logboek, schaal: 0.01, gebruiker: sim.gebruiker });
await apparaten.stop();
mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
writeFileSync(new URL('./fixtures/synthetisch-f0.jsonl', import.meta.url), regels.join('\n') + '\n');
console.log(`${regels.length} regels`);
process.exit(0);
