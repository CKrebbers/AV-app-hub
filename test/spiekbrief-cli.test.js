// @ts-check
// `varve-hub spiekbrief <set> [--uit bestand.html]` (npm run spiekbrief -- <set>): zonder draaiende hub een
// HTML om te printen. Als echt proces; schrijft alleen in een tijdelijke map.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lijstSets, laadSet } from '../src/sets/index.js';
import { laadConfig } from '../src/config.js';
import { laadBronnen, hubConfig } from '../src/spiekbrief/index.js';

const HUB_MAP = join(import.meta.dirname, '..');
const CLI = join(HUB_MAP, 'src', 'cli.js');

/** @param {string[]} args */
const cli = (args) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: HUB_MAP, encoding: 'utf8', timeout: 20_000 });
  return { code: r.status, uit: `${r.stdout}${r.stderr}` };
};

describe('cli spiekbrief', () => {
  it('schrijft één zelfstandige pagina (stijlen erin, geen script) en zegt waar', () => {
    const pad = join(mkdtempSync(join(tmpdir(), 'spiekbrief-')), 'med.html');
    const r = cli(['spiekbrief', 'meditatie', '--uit', pad]);
    expect(r.code).toBe(0);
    expect(r.uit).toContain(`spiekbrief → ${pad}`);
    // Elke app van de set staat in de regel; "volgt" alleen voor de apps waar (nu) geen manifest van is.
    const config = hubConfig(laadConfig());
    const set = laadSet('meditatie', { config });
    const namen = Object.keys(set.apps).map((a) => config.apps?.[a]?.naam ?? a);
    const { bronnen } = laadBronnen();
    const volgt = Object.keys(set.apps).filter((a) => !bronnen[a]).map((a) => config.apps?.[a]?.naam ?? a);
    const regel = r.uit.split('\n').find((l) => l.startsWith(`${set.naam}: `)) ?? '';
    for (const n of namen) expect(regel, n).toContain(n);
    if (volgt.length) expect(regel).toContain(` — indeling volgt als ${volgt.join(', ')} zich meldt`);
    else expect(regel).not.toContain('indeling volgt');
    expect(r.uit).not.toContain('localhost:7700');      // de poort komt uit config.json of de opdrachtregel, niet uit de CLI
    const html = readFileSync(pad, 'utf8');
    expect(html).toContain('data-set="meditatie"');
    expect(html).toContain('@page { size: A4 landscape');
    expect(html).not.toContain('href="/ui/');
    expect(html).not.toMatch(/<script/i);
    expect(html).toMatch(/gemaakt \d+ \w+ 20\d\d/);
  });

  it('alle: elke set een eigen blad', () => {
    const pad = join(mkdtempSync(join(tmpdir(), 'spiekbrief-')), 'alle.html');
    expect(cli(['spiekbrief', 'alle', '--uit', pad]).code).toBe(0);
    const html = readFileSync(pad, 'utf8');
    for (const s of lijstSets()) expect(html).toContain(`data-set="${s}"`);
  });

  it('zonder set of met een onbekende set: melding met de sets die er zijn, exitcode 1, geen bestand', () => {
    const map = mkdtempSync(join(tmpdir(), 'spiekbrief-'));
    const zonder = cli(['spiekbrief']);
    expect(zonder.code).toBe(1);
    const sets = lijstSets().join(', ');
    expect(zonder.uit).toContain(`gebruik: varve-hub spiekbrief <set|alle> [--uit bestand.html] — sets: ${sets}`);
    const onbekend = cli(['spiekbrief', 'bestaat-niet-xyz', '--uit', join(map, 'x.html')]);
    expect(onbekend.code).toBe(1);
    expect(onbekend.uit).toContain(`onbekende set "bestaat-niet-xyz" — beschikbaar: ${sets}`);
    expect(existsSync(join(map, 'x.html'))).toBe(false);
    expect(cli(['spiekbrief', 'dj', '--uit']).code).toBe(1);
  });

  it('npm run spiekbrief en de uitleg in docs/SPIEKBRIEF.md', () => {
    const pkg = JSON.parse(readFileSync(join(HUB_MAP, 'package.json'), 'utf8'));
    expect(pkg.scripts.spiekbrief).toBe('node src/cli.js spiekbrief');
    const doc = readFileSync(join(HUB_MAP, 'docs', 'SPIEKBRIEF.md'), 'utf8');
    expect(doc).toMatch(/npm run spiekbrief -- meditatie/);
    expect(doc).toMatch(/http:\/\/localhost:7700\/spiekbrief/);
    expect(cli(['help']).uit).toMatch(/spiekbrief <set>/);
  });
});
