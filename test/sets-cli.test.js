// @ts-check
// `varve-hub start [set]` van begin tot Ctrl-C, als echt proces.
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const HUB_MAP = join(import.meta.dirname, '..');
const CLI = join(HUB_MAP, 'src', 'cli.js');
const NEP_APP = join(HUB_MAP, 'tools', 'nep-app.mjs');

/** @param {string[]} args @param {Record<string, string>} [env] */
function cli(args, env = {}) {
  // Eigen geheugenbestand: `npm test` mag ~/.varve-hub/staat.json nooit lezen of schrijven.
  const staat = join(mkdtempSync(join(tmpdir(), 'varve-set-staat-')), 'staat.json');
  const p = spawn(process.execPath, [CLI, ...args], { cwd: HUB_MAP, env: { ...process.env, VARVE_HUB_STAAT: staat, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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

  /** Een set met één nep-app (td-lab) die zijn shell-pid in <map>/pid zet. */
  function proefSet() {
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
    const pid = () => (existsSync(join(map, 'pid')) ? Number(readFileSync(join(map, 'pid'), 'utf8')) : null);
    const leeft = () => { const p = pid(); if (!p) return false; try { process.kill(p, 0); return true; } catch { return false; } };
    const ruimOp = () => { const p = pid(); if (p) { try { process.kill(p, 'SIGKILL'); } catch { /* al weg */ } } };
    return { map, paden, set, leeft, ruimOp };
  }

  /** Een vrije poort. */
  const vrijePoort = async () => {
    const s = net.createServer();
    await new Promise((r) => s.listen(0, '127.0.0.1', () => r(undefined)));
    const p = /** @type {net.AddressInfo} */ (s.address()).port;
    await new Promise((r) => s.close(() => r(undefined)));
    return p;
  };

  it.skipIf(process.platform === 'win32')('start hub + set: app start in de map uit paden.json, snapshot en focus; Ctrl-C stopt de app en de hub', async () => {
    const { map, paden, set, leeft, ruimOp } = proefSet();
    const r = cli(['start', set, '--zonder-midi', '--geen-drivers', '--poort', '0', '--zonder-chrome'], { VARVE_HUB_PADEN: paden });
    try {
      expect(await tot(() => /Set "Proef": 1\/1 klaar/.test(r.uit))).toBe(true);
      expect(r.uit).toMatch(new RegExp(`td-lab: start ".*nep-app\\.mjs" --url ws://localhost:\\d+/app --app td-lab" in ${map.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      expect(r.uit).toMatch(/td-lab: klaar \(verbonden met de hub\)/);
      expect(r.uit).toMatch(/snapshot td-lab: helder=0\.2/);
      expect(r.uit).toMatch(/focus: td-lab/);
      expect(leeft()).toBe(true);
      r.p.kill('SIGINT');
      expect(await tot(() => r.code !== undefined)).toBe(true);
      expect(r.code).toBe(0);
      expect(r.uit).toMatch(/Gestopt: td-lab/);
      expect(await tot(() => !leeft(), 3000)).toBe(true);
    } finally {
      if (r.code === undefined) r.p.kill('SIGKILL');
      ruimOp();
    }
  });

  it.skipIf(process.platform === 'win32')('het Terminal-venster sluiten (SIGHUP) ruimt net zo op als Ctrl-C: geen wezen die hun poort vasthouden', async () => {
    const { paden, set, leeft, ruimOp } = proefSet();
    const r = cli(['start', set, '--zonder-midi', '--geen-drivers', '--poort', '0', '--zonder-chrome'], { VARVE_HUB_PADEN: paden });
    try {
      expect(await tot(() => /Set "Proef": 1\/1 klaar/.test(r.uit))).toBe(true);
      expect(leeft()).toBe(true);
      r.p.kill('SIGHUP');
      expect(await tot(() => r.code !== undefined)).toBe(true);
      expect(await tot(() => !leeft(), 3000)).toBe(true);
      expect(r.code).toBe(0);
    } finally {
      if (r.code === undefined) r.p.kill('SIGKILL');
      ruimOp();
    }
  });

  it.skipIf(process.platform === 'win32')('er draait al een hub: de set verbindt daarmee; Ctrl-C stopt alleen de app, de eerste hub blijft', async () => {
    const poort = await vrijePoort();
    const eerste = cli(['start', '--zonder-midi', '--geen-drivers', '--poort', String(poort)]);
    const { paden, set, leeft, ruimOp } = proefSet();
    /** @type {ReturnType<typeof cli>|null} */
    let r = null;
    try {
      expect(await tot(() => /varve-hub draait/.test(eerste.uit))).toBe(true);
      r = cli(['start', set, '--zonder-midi', '--geen-drivers', '--poort', String(poort), '--zonder-chrome'], { VARVE_HUB_PADEN: paden });
      const tweede = r;
      expect(await tot(() => /Set "Proef": 1\/1 klaar/.test(tweede.uit))).toBe(true);
      expect(tweede.uit).toMatch(new RegExp(`Er draait al een hub op poort ${poort} — de set "Proef" verbindt daarmee`));
      expect(tweede.uit).toMatch(/td-lab: klaar \(verbonden met de hub\)/);
      expect(tweede.uit).toMatch(/focus: td-lab/);
      tweede.p.kill('SIGINT');
      expect(await tot(() => tweede.code !== undefined)).toBe(true);
      expect(tweede.code).toBe(0);
      expect(await tot(() => !leeft(), 3000)).toBe(true);
      expect(eerste.code).toBe(undefined);              // de hub die al draaide, draait nog
      expect(tweede.uit).not.toMatch(/verbinding met de hub .* verbroken/);
    } finally {
      if (r && r.code === undefined) r.p.kill('SIGKILL');
      if (eerste.code === undefined) eerste.p.kill('SIGKILL');
      ruimOp();
    }
  });
});
