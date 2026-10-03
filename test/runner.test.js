import { describe, it, expect } from 'vitest';
import { echteKlok } from '../src/core/klok.js';
import { Logboek } from '../src/core/logboek.js';
import { maakApparaten } from '../src/apparaten.js';
import { voerUit } from '../src/proef/runner.js';
import { simulatie } from './gesimuleerd.js';

const config = { hotplug_ms: 5, led: { per_burst: 16, burst_ms: 4 }, apparaten: { apc40: { naam: 'apc40', modus: 0x42 }, lpd8: { naam: 'lpd8' } } };
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));

/** Eén stap draaien; de test speelt zelf de gebruiker (geen automatische simulatie). */
async function eenStap(doe, speel) {
  const sim = simulatie();
  sim.gebruiker.l.clear();
  const logboek = new Logboek({ klok: echteKlok, schrijf: () => {}, kop: {} });
  const apparaten = maakApparaten({ systeem: sim.systeem, klok: echteKlok, config, logboek });
  apparaten.start();
  await wacht(20);
  const run = voerUit({ naam: 't', titel: 't', stappen: [{ id: 's', titel: 's', doe }] }, { apparaten, io: sim.io, klok: echteKlok, logboek, gebruiker: sim.gebruiker });
  await wacht(5);
  await speel(sim);
  const b = await run;
  await apparaten.stop();
  return b;
}
const wachtOpPlayRecord = async (h) => h.bevinding('r', await h.wachtOp({ dev: 'apc40', ids: ['play', 'record'], tekst: 'druk play en record' }));

describe('proef-runner: overslaan', () => {
  it('een losse Enter of andere tekst tijdens het wachten slaat NIET over', async () => {
    const b = await eenStap(wachtOpPlayRecord, async (sim) => {
      sim.poorten.apc.injecteer([0x90, 91, 127]);
      sim.typ(''); await wacht(5);
      sim.typ('j'); await wacht(5);
      sim.poorten.apc.injecteer([0x90, 93, 127]);
    });
    expect(b.r).toMatchObject({ gezien: ['play', 'record'], overgeslagen: false });
  });

  it('"o" slaat over en noemt wat ontbreekt', async () => {
    const b = await eenStap(wachtOpPlayRecord, async (sim) => {
      sim.poorten.apc.injecteer([0x90, 91, 127]);
      sim.typ('o');
    });
    expect(b.r).toMatchObject({ gezien: ['play'], ontbrekend: ['record'], overgeslagen: true });
  });

  it('na een wachtstap gaat de volgende regel naar de volgende vraag', async () => {
    const b = await eenStap(async (h) => {
      await h.wachtOp({ dev: 'apc40', ids: ['play'], tekst: 'druk play' });
      h.bevinding('antwoord', await h.jn('klopt het?'));
    }, async (sim) => {
      sim.poorten.apc.injecteer([0x90, 91, 127]);
      await wacht(5);
      sim.typ('n te laat');
    });
    expect(b.antwoord).toEqual({ ok: false, notitie: 'te laat' });
  });

  it('een fout in een stap stopt de proef niet', async () => {
    const sim = simulatie();
    const logboek = new Logboek({ klok: echteKlok, schrijf: () => {}, kop: {} });
    const apparaten = maakApparaten({ systeem: sim.systeem, klok: echteKlok, config, logboek });
    const b = await voerUit({ naam: 't', titel: 't', stappen: [
      { id: 'kapot', titel: 'kapot', doe: async () => { throw new Error('boem'); } },
      { id: 'heel', titel: 'heel', doe: async (h) => h.bevinding('heel', true) },
    ] }, { apparaten, io: sim.io, klok: echteKlok, logboek });
    expect(b.heel).toBe(true);
  });
});
