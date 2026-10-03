// De opdrachtregel: foutmeldingen die Clay begrijpt.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

/** @param {string[]} args */
function draai(args, ms = 8000) {
  return new Promise((goed) => {
    const p = spawn(process.execPath, [CLI, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, VARVE_HUB_STAAT: join(mkdtempSync(join(tmpdir(), 'varve-cli-')), 'staat.json') }, // nooit het echte geheugen
  });
    let uit = '', fout = '';
    p.stdout.on('data', (d) => { uit += d; });
    p.stderr.on('data', (d) => { fout += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), ms);
    p.on('exit', (code) => { clearTimeout(t); goed({ code, uit, fout }); });
  });
}

describe('cli start', () => {
  it('bezette poort → korte uitleg met --poort, geen stacktrace, exitcode ≠ 0', async () => {
    const bezet = net.createServer();
    await new Promise((r) => bezet.listen(0, '127.0.0.1', () => r(undefined)));
    const poort = /** @type {net.AddressInfo} */ (bezet.address()).port;
    try {
      const r = /** @type {{ code: number|null, uit: string, fout: string }} */ (await draai(['start', '--zonder-midi', '--geen-drivers', '--poort', String(poort)]));
      expect(r.code).not.toBe(0);
      expect(r.code).not.toBe(null);
      expect(r.fout).toMatch(new RegExp(`poort ${poort} is bezet`));
      expect(r.fout).toMatch(/--poort/);
      expect(r.fout).not.toMatch(/node:net|at Server/);
    } finally { await new Promise((r) => bezet.close(() => r(undefined))); }
  });
});
