// @ts-check
// `varve-hub start [set]` van begin tot Ctrl-C, als echt proces.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HUB_MAP = join(import.meta.dirname, '..');
const CLI = join(HUB_MAP, 'src', 'cli.js');
const NEP_APP = join(HUB_MAP, 'tools', 'nep-app.mjs');

/** @param {string[]} args @param {Record<string, string>} [env] */
function cli(args, env = {}) {
  const p = spawn(process.execPath, [CLI, ...args], { cwd: HUB_MAP, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const r = { uit: '', code: /** @type {number|null|undefined} */ (undefined), p };
  p.stdout.on('data', (d) => { r.uit += d; });
  p.stderr.on('data', (d) => { r.uit += d; });
  p.on('exit', (code) => { r.code = code; });
  return r;
}
/** @param {() => unknown} fn */
const tot = async (fn, ms = 10000) => { const eind = Date.now() + ms; while (Date.now() < eind) { if (fn()) return true; await new Promise((r) => setTimeout(r, 25)); } return false; };

describe('cli start [set]', () => {
  it('een onbekende set: korte melding met de sets die er wel zijn, exitcode 1, geen hub gestart', async () => {
    const r = cli(['start', 'feest', '--zonder-midi', '--geen-drivers', '--poort', '0']);
    await tot(() => r.code !== undefined);
    expect(r.code).toBe(1);
    expect(r.uit).toMatch(/onbekende set "feest" — beschikbaar: dj, meditatie, scene-kit/);
    expect(r.uit).not.toMatch(/varve-hub draait/);
  });

  it.skipIf(process.platform === 'win32')('start hub + set: app start in de map uit paden.json, snapshot en focus; Ctrl-C stopt de app en de hub', async () => {
    const map = mkdtempSync(join(tmpdir(), 'set-cli-'));
    const paden = join(map, 'paden.json');
    writeFileSync(paden, JSON.stringify({ 'td-lab': map }));
    const set = join(map, 'proef.json');
    writeFileSync(set, JSON.stringify({
      naam: 'Proef',
      apps: { 'td-lab': { start: { commando: `echo $$ > pid; exec "${process.execPath}" "${NEP_APP}" --url {hub} --app td-lab` }, url: null } },
      snapshot: { 'td-lab': { helder: 0.2 } },
      focus: 'td-lab',
    }));
    const r = cli(['start', set, '--zonder-midi', '--geen-drivers', '--poort', '0', '--zonder-chrome'], { VARVE_HUB_PADEN: paden });
    try {
      expect(await tot(() => /Set "Proef": 1\/1 klaar/.test(r.uit))).toBe(true);
      expect(r.uit).toMatch(new RegExp(`td-lab: start ".*nep-app\\.mjs" --url ws://localhost:\\d+/app --app td-lab" in ${map.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      expect(r.uit).toMatch(/td-lab: klaar \(verbonden met de hub\)/);
      expect(r.uit).toMatch(/snapshot td-lab: helder=0\.2/);
      expect(r.uit).toMatch(/focus: td-lab/);
      const pid = Number(readFileSync(join(map, 'pid'), 'utf8'));
      const leeft = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
      expect(leeft()).toBe(true);
      r.p.kill('SIGINT');
      expect(await tot(() => r.code !== undefined)).toBe(true);
      expect(r.code).toBe(0);
      expect(r.uit).toMatch(/Gestopt: td-lab/);
      expect(await tot(() => !leeft(), 3000)).toBe(true);
    } finally {
      if (r.code === undefined) r.p.kill('SIGKILL');
      if (existsSync(join(map, 'pid'))) { try { process.kill(Number(readFileSync(join(map, 'pid'), 'utf8')), 'SIGKILL'); } catch { /* al weg */ } }
    }
  });
});
