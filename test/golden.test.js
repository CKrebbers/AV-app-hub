// Golden tests: elk opgenomen logboek (jouw proef/opname-bestanden in proef/, plus test/fixtures/)
// wordt opnieuw door de ontleders gehaald. Dezelfde ruwe MIDI (of HID-rapporten van de Maschine) moet dezelfde
// gebeurtenis geven als toen. Verandert de hub zijn interpretatie van jouw hardware, dan faalt dit — bewust.
// De ontleders per apparaat: test/herspeel.js.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { herspeel } from './herspeel.js';

export { herspeel };

const HIER = new URL('.', import.meta.url).pathname;
const mappen = [join(HIER, 'fixtures'), join(HIER, '..', 'proef')];
const bestanden = mappen.filter(existsSync).flatMap((m) => readdirSync(m).filter((f) => f.endsWith('.jsonl')).map((f) => join(m, f)));

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
