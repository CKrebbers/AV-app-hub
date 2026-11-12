// @ts-check
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { LESSEN } from '../ui/oefen/lessen.js';

/** @param {string} pad */
const lees = (pad) => readFileSync(new URL(`../${pad}`, import.meta.url), 'utf8');
const handleidingen = ['docs/TOUCHDESIGNER.md', 'docs/LOGIC.md'];

describe('handleidingen kloppen met wat de hub doet', () => {
  it.each([...handleidingen, 'docs/OPNAME.md'])('%s start de hub met een opdracht die bestaat (npm start)', (pad) => {
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

  it('docs/OPNAME.md en README geven herhaal als opdracht die zonder npm link bestaat', () => {
    const scripts = JSON.parse(lees('package.json')).scripts;
    expect(scripts.herhaal).toBe('node src/cli.js herhaal');
    for (const pad of ['docs/OPNAME.md', 'README.md']) {
      const tekst = lees(pad);
      expect(tekst).toMatch(/npm run herhaal -- /);
      expect(tekst).not.toMatch(/^varve-hub herhaal/m);
    }
  });
});

// ── opdrachten in de docs bestaan echt ───────────────────────────────────────

/** Alle docs die Clay leest: README, STATUS, PROTOCOL, CLAUDE en docs/*.md. */
const DOCS = ['README.md', 'STATUS.md', 'PROTOCOL.md', 'CLAUDE.md', ...readdirSync(new URL('../docs', import.meta.url)).filter((f) => f.endsWith('.md')).sort().map((f) => `docs/${f}`)];

/** De opdrachten van src/cli.js: de sleutels van `const opdrachten = { … }` (cli.js draait bij importeren, dus lezen). */
function cliOpdrachten() {
  const bron = lees('src/cli.js');
  const begin = bron.indexOf('const opdrachten = {');
  const eind = bron.indexOf('\n};', begin);
  return new Set([...bron.slice(begin, eind).matchAll(/^ {2}(?:async )?([a-z][\w-]*)\(\) \{/gm)].map((m) => m[1]));
}

/** Elke vondst van `re` (groep 1) in de docs, met waar. @param {RegExp} re */
function inDocs(re) {
  /** @type {{ waar: string, naam: string }[]} */
  const uit = [];
  for (const pad of DOCS) lees(pad).split('\n').forEach((regel, i) => { for (const m of regel.matchAll(re)) uit.push({ waar: `${pad}:${i + 1}`, naam: m[1] }); });
  return uit;
}

describe('opdrachten in de docs bestaan', () => {
  const scripts = JSON.parse(lees('package.json')).scripts;

  it('de lezer van src/cli.js vindt de opdrachten (anders toetst de rest niets)', () => {
    const o = cliOpdrachten();
    for (const x of ['start', 'check', 'doctor', 'token', 'installeer', 'proef', 'testpatroon', 'opname', 'herhaal', 'help']) expect(o.has(x), x).toBe(true);
  });

  it('elke `npm run X` staat in package.json (behalve `npm run dev`: de dev-server van een app, in zijn eigen repo)', () => {
    const vondsten = inDocs(/npm run(?: -s)? ([a-z][\w:-]*)/g);
    expect(vondsten.length).toBeGreaterThan(10);
    const fout = vondsten.filter((v) => v.naam !== 'dev' && !(v.naam in scripts)).map((v) => `${v.waar}: npm run ${v.naam}`);
    expect(fout).toEqual([]);
    for (const x of inDocs(/\bnpm (start|test)\b/g)) expect(scripts[x.naam], `${x.waar}: npm ${x.naam}`).toBeTypeOf('string');
  });

  it('elke `node src/cli.js X` en `varve-hub X` is een opdracht van src/cli.js', () => {
    const o = cliOpdrachten();
    const vondsten = [...inDocs(/node src\/cli\.js ([a-z][\w-]*)/g), ...inDocs(/`varve-hub ([a-z][\w-]*)/g)];
    expect(vondsten.length).toBeGreaterThan(10);
    expect(vondsten.filter((v) => !o.has(v.naam)).map((v) => `${v.waar}: ${v.naam}`)).toEqual([]);
    // en wat package.json via node src/cli.js start, bestaat ook
    for (const [naam, regel] of Object.entries(scripts)) {
      const m = /^node src\/cli\.js ([a-z][\w-]*)/.exec(String(regel));
      if (m) expect(o.has(m[1]), `npm run ${naam} → ${regel}`).toBe(true);
    }
  });

  it('elke `node tools/X` bestaat', () => {
    const vondsten = inDocs(/node (tools\/[\w.-]+)/g);
    expect(vondsten.length).toBeGreaterThan(3);
    expect(vondsten.filter((v) => !existsSync(new URL(`../${v.naam}`, import.meta.url))).map((v) => `${v.waar}: ${v.naam}`)).toEqual([]);
  });

  it('het aantal lessen van de oefenruimte klopt in README, STATUS en docs/OEFENEN.md', () => {
    const n = LESSEN.length;
    expect(lees('README.md')).toMatch(new RegExp(`\\b${n} korte lessen\\b`));
    expect(lees('docs/OEFENEN.md')).toMatch(new RegExp(`\\b${n} korte lessen\\b`));
    expect(lees('STATUS.md')).not.toMatch(new RegExp(`\\b(?!${n}\\b)\\d+ lessen\\b`));
    // de tabel in docs/OEFENEN.md: één rij per les, genummerd 1..n
    const rijen = [...lees('docs/OEFENEN.md').matchAll(/^\| (\d+) \| /gm)].map((m) => Number(m[1]));
    expect(rijen).toEqual(LESSEN.map((_, i) => i + 1));
  });
});

describe('de koppelingen staan op main sinds 19 okt (geen oude tak meer)', () => {
  // formula-lab #1, waterschaal #1, medisynth #4 en flux-screensaver #2 zijn op 19 okt gemerged. Wie de oude tak
  // claude/varve-hub-koppeling uitcheckt, mist alles wat daarna op main kwam (licentie, LEESMIJ).
  const OUDE_TAK = /claude\/varve-hub-koppeling/;
  const docs = ['README.md', 'STATUS.md', 'docs/HARDWARE-AVOND.md', 'docs/CHECK.md', 'docs/SETS.md', 'docs/REPETITIE.md', 'koppelingen/varve-dj/LEESMIJ.md'];
  it.each(docs)('%s stuurt niemand naar de oude tak (hooguit als waarschuwing)', (pad) => {
    for (const regel of lees(pad).split('\n')) {
      if (!OUDE_TAK.test(regel)) continue;
      expect(regel, `${pad}: ${regel}`).toMatch(/oude tak|niet meer gebruiken|toen op/);
    }
  });
  it('git checkout claude/varve-hub-koppeling staat nergens in het draaiboek', () => {
    expect(lees('docs/HARDWARE-AVOND.md')).not.toMatch(/checkout claude\/varve-hub-koppeling/);
    expect(lees('docs/HARDWARE-AVOND.md')).toMatch(/git switch main && git pull/);
  });
  it('check en de sets noemen main, niet de tak', async () => {
    const { KOPPELINGEN } = await import('../src/check/koppelingen.js');
    for (const [app, k] of Object.entries(KOPPELINGEN)) if (k) expect(k.waar, app).not.toMatch(OUDE_TAK);
    for (const set of readdirSync(new URL('../sets/', import.meta.url)).filter((f) => f.endsWith('.json'))) {
      expect(lees(`sets/${set}`), set).not.toMatch(OUDE_TAK);
    }
  });
});
