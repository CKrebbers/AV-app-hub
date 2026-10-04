// @ts-check
// `node src/cli.js check` als echt proces: met een eigen HOME, config en paden in een tijdelijke map (nooit de
// echte thuismap), op een poort waar geen hub draait.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HUB_MAP = join(import.meta.dirname, '..');

const opruimen = /** @type {(() => void)[]} */ ([]);
afterEach(() => { for (const x of opruimen.splice(0)) x(); });

/** Een poort waar zeker niemand luistert. */
const vrijePoort = () => new Promise((goed) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = /** @type {import('node:net').AddressInfo} */ (s.address()).port; s.close(() => goed(p)); });
});

/**
 * @param {string[]} args @param {string[]} [via] standaard node src/cli.js check; of bv. ['npm', 'run', '-s', 'check', '--']
 * @returns {Promise<{ code: number|null, uit: string, fout: string }>}
 */
async function draai(args, via = [process.execPath, 'src/cli.js', 'check']) {
  const tmp = mkdtempSync(join(tmpdir(), 'varve-check-cli-'));
  opruimen.push(() => rmSync(tmp, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(join(HUB_MAP, 'config.json'), 'utf8'));
  config.avondmap = join(tmp, 'avonden');
  config.geheugen = { pad: join(tmp, 'staat.json') };
  writeFileSync(join(tmp, 'config.json'), JSON.stringify(config));
  const env = { ...process.env, HOME: tmp, VARVE_HUB_CONFIG: join(tmp, 'config.json'), VARVE_HUB_PADEN: join(tmp, 'paden.json') };
  delete env.VARVE_HUB_STAAT;
  return new Promise((goed) => {
    const p = spawn(via[0], [...via.slice(1), ...args], { cwd: HUB_MAP, env });
    let uit = '', fout = '';
    p.stdout.on('data', (b) => { uit += b; });
    p.stderr.on('data', (b) => { fout += b; });
    p.on('close', (code) => goed({ code, uit, fout }));
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

  it('npm run -s check -- --json (zoals docs/CHECK.md het voor scripts geeft): stdout is alleen JSON', async () => {
    const { uit } = await draai(['--json', '--poort', String(await vrijePoort())], ['npm', 'run', '-s', 'check', '--']);
    expect(JSON.parse(uit).punten.find((/** @type {any} */ p) => p.naam === 'hub').status).toBe('let');
    expect(readFileSync(join(HUB_MAP, 'docs', 'CHECK.md'), 'utf8')).toContain('npm run -s check -- dj --json');
  }, 30000);

  it('een ongeldige --poort: melding en exitcode 2 (niet stilletjes 7700)', async () => {
    const { code, uit, fout } = await draai(['--poort', 'abc']);
    expect(code).toBe(2);
    expect(uit).toBe('');
    expect(fout).toMatch(/--poort moet een poortnummer zijn \(1-65535\), niet "abc"/);
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
