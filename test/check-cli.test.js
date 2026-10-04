// @ts-check
// `node src/cli.js check` als echt proces: met een eigen HOME, config en paden in een tijdelijke map (nooit de
// echte thuismap), op een poort waar geen hub draait.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HUB_MAP = join(import.meta.dirname, '..');

/** Een poort waar zeker niemand luistert. */
const vrijePoort = () => new Promise((goed) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = /** @type {import('node:net').AddressInfo} */ (s.address()).port; s.close(() => goed(p)); });
});

/** @param {string[]} args @returns {Promise<{ code: number|null, uit: string }>} */
async function draai(args) {
  const tmp = mkdtempSync(join(tmpdir(), 'varve-check-cli-'));
  const config = JSON.parse(readFileSync(join(HUB_MAP, 'config.json'), 'utf8'));
  config.avondmap = join(tmp, 'avonden');
  config.geheugen = { pad: join(tmp, 'staat.json') };
  writeFileSync(join(tmp, 'config.json'), JSON.stringify(config));
  const env = { ...process.env, HOME: tmp, VARVE_HUB_CONFIG: join(tmp, 'config.json'), VARVE_HUB_PADEN: join(tmp, 'paden.json') };
  delete env.VARVE_HUB_STAAT;
  return new Promise((goed) => {
    const p = spawn(process.execPath, ['src/cli.js', 'check', ...args], { cwd: HUB_MAP, env });
    let uit = '';
    p.stdout.on('data', (b) => { uit += b; });
    p.on('close', (code) => goed({ code, uit }));
  });
}

describe('cli check', () => {
  it('--json met een set en --lan: geldige JSON, exitcode volgt de ✗ (paden.json en token ontbreken → 1)', async () => {
    const poort = await vrijePoort();
    const { code, uit } = await draai(['dj', '--json', '--lan', '--poort', String(poort)]);
    const j = JSON.parse(uit);
    expect(j.set).toBe('dj');
    expect(j.punten.find((/** @type {any} */ p) => p.naam === 'hub')).toMatchObject({ status: 'let', uitleg: `de hub draait nog niet (poort ${poort})` });
    expect(j.punten.find((/** @type {any} */ p) => p.naam === 'paden')).toMatchObject({ status: 'fout', teken: '✗' });
    expect(j.punten.find((/** @type {any} */ p) => p.naam === 'token')).toMatchObject({ status: 'fout' });
    expect(j.ok).toBe(false);
    expect(code).toBe(1);
  }, 15000);

  it('tekst zonder set: koppen en een slotregel; de hulp en npm run check kennen de opdracht', async () => {
    const { code, uit } = await draai(['--poort', String(await vrijePoort())]);
    expect(uit).toMatch(/^varve-hub check\n/);
    expect(uit).toMatch(/\nHub\n {2}! de hub draait nog niet/);
    expect(uit).toMatch(/\nBestanden\n/);
    expect(uit).not.toMatch(/\nSet\n/);
    expect(code === 0 || code === 1).toBe(true);
    expect(code === 1).toBe(/✗/.test(uit.split('\n').slice(1).join('\n')));
    const hulp = await new Promise((goed) => {
      const p = spawn(process.execPath, ['src/cli.js', 'help'], { cwd: HUB_MAP });
      let t = ''; p.stdout.on('data', (b) => { t += b; }); p.on('close', () => goed(t));
    });
    expect(hulp).toMatch(/\n {2}check \[set\] /);
    expect(JSON.parse(readFileSync(join(HUB_MAP, 'package.json'), 'utf8')).scripts.check).toBe('node src/cli.js check');
  }, 15000);
});
