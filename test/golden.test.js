// Golden tests: elk opgenomen logboek (jouw proef/opname-bestanden in proef/, plus test/fixtures/)
// wordt opnieuw door de ontleders gehaald. Dezelfde ruwe MIDI moet dezelfde gebeurtenis geven
// als toen. Verandert de hub zijn interpretatie van jouw hardware, dan faalt dit — bewust.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { leesLogboek } from '../src/core/logboek.js';
import { ApcSessie, Lpd8Sessie } from '../src/apparaten.js';
import { NepSysteem } from '../src/ports/nep.js';
import { NepKlok } from '../src/core/klok.js';

const HIER = new URL('.', import.meta.url).pathname;
const mappen = [join(HIER, 'fixtures'), join(HIER, '..', 'proef')];
const bestanden = mappen.filter(existsSync).flatMap((m) => readdirSync(m).filter((f) => f.endsWith('.jsonl')).map((f) => join(m, f)));

/** Speel een logboek opnieuw af; geef de verschillen terug. */
export function herspeel(tekst) {
  const { regels } = leesLogboek(tekst);
  const gemeen = { systeem: new NepSysteem(), klok: new NepKlok(), patroon: /x/ };
  const sessies = { apc40: new ApcSessie({ ...gemeen, dev: 'apc40' }), lpd8: new Lpd8Sessie({ ...gemeen, dev: 'lpd8' }) };
  const verschillen = [];
  let getoetst = 0;
  for (let i = 0; i < regels.length; i++) {
    const r = regels[i];
    if (!Array.isArray(r) && r.e === 'bevinding' && r.id === 'lpd8-profiel') sessies.lpd8.zetProfiel(r.data.profiel);
    if (!Array.isArray(r) || r[1] !== 'in') continue;
    const volgende = regels[i + 1];
    if (!volgende || volgende.e !== 'gebeurtenis') continue;
    const { ms, e, ...toen } = volgende;
    const nu = JSON.parse(JSON.stringify(sessies[r[2]].ontleed(r[3])));
    getoetst++;
    try { expect(nu).toEqual(toen); } catch { verschillen.push({ ms: r[0], dev: r[2], bytes: r[3], toen, nu }); }
  }
  return { getoetst, verschillen };
}

describe('golden: opgenomen logboeken', () => {
  it('er is minstens één logboek om te toetsen', () => expect(bestanden.length).toBeGreaterThan(0));
  for (const pad of bestanden) {
    it(pad.split('/').slice(-2).join('/'), () => {
      const { getoetst, verschillen } = herspeel(readFileSync(pad, 'utf8'));
      expect(getoetst).toBeGreaterThan(0);
      expect(verschillen.slice(0, 5)).toEqual([]);
    });
  }
});
