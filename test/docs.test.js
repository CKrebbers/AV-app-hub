// @ts-check
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** @param {string} pad */
const lees = (pad) => readFileSync(new URL(`../${pad}`, import.meta.url), 'utf8');
const handleidingen = ['docs/TOUCHDESIGNER.md', 'docs/LOGIC.md'];

describe('handleidingen kloppen met wat de hub doet', () => {
  it.each(handleidingen)('%s start de hub met een opdracht die bestaat (npm start)', (pad) => {
    const tekst = lees(pad);
    // `varve-hub` zonder npm link bestaat niet, en zonder `start` toont cli.js alleen de hulp.
    expect(tekst).not.toMatch(/\(`varve-hub`\)/);
    expect(tekst).toMatch(/Start eerst de hub\*\* \(`npm start`/);
    expect(JSON.parse(lees('package.json')).scripts.start).toBe('node src/cli.js start');
  });

  it.each(handleidingen)('%s: na een hub-herstart stuurt de hub het onthouden geheugen; zonder geheugen houdt de app zijn stand (PROTOCOL §12)', (pad) => {
    const tekst = lees(pad);
    expect(tekst).not.toMatch(/krijgt Sediment de standaardwaarden/);
    expect(tekst).not.toMatch(/begint (alles )?weer bij de standaardwaarden/);
    // Met geheugen: de hub stuurt de onthouden waarden (en zegt waar ze staan).
    expect(tekst).toMatch(/~\/\.varve-hub\/staat\.json/);
    // Zonder geheugen: de app houdt zijn eigen stand, een preset/snapshot zet ze gelijk.
    expect(tekst).toMatch(/houdt (Sediment|TD) zijn eigen stand/);
    expect(tekst).toMatch(/snapshot/);
  });
});
