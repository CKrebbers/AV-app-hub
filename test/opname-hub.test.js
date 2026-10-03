// End-to-end avondmap: de hele hub (nep-APC, nep-LPD8, echte WebSocket-apps) neemt een avond op naar een
// echte map, en `varve-hub herhaal` speelt hem af tegen een tweede, draaiende hub via de cockpit.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHub } from '../src/hub.js';
import { NepSysteem } from '../src/ports/nep.js';
import { laadConfig } from '../src/config.js';
import { NepApp, voorbeeldManifest } from '../tools/nep-app.mjs';
import { GEBAREN, SAMENVATTING } from '../src/opname/opnemer.js';
import { cockpitUrl } from '../src/opname/cockpit-doel.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
const tot = async (fn, ms = 3000) => { const eind = Date.now() + ms; while (Date.now() < eind) { const x = fn(); if (x) return x; await wacht(10); } return fn(); };
const lopend = [];
afterEach(async () => { for (const x of lopend.splice(0).reverse()) await x(); });

function tijdelijk() {
  const map = mkdtempSync(join(tmpdir(), 'varve-avond-'));
  lopend.push(() => rmSync(map, { recursive: true, force: true }));
  return map;
}

async function opzet({ thuis, avondmap = '~/avonden' }) {
  const config = { ...laadConfig(), hotplug_ms: 20, avondmap };
  const systeem = new NepSysteem();
  const apc = systeem.voegToe('APC40 mkII');
  const lpd8 = systeem.voegToe('LPD8 mk2');
  lpd8.antwoord = (b) => { if (b[1] === 0x7e) setTimeout(() => lpd8.injecteer([0xf0, 0x7e, 0, 6, 2, 0x47, 0x4c, 0, 0xf7]), 1); };
  const meldingen = [];
  const hub = await startHub({ config, systeem, poort: 0, drivers: false, opname: { thuis, git: 'test-git' }, log: (t) => meldingen.push(String(t)) });
  lopend.push(() => hub.stop());
  const url = hub.adres.replace('http', 'ws') + '/app';
  const app = (naam) => { const a = new NepApp({ url, manifest: voorbeeldManifest(naam) }).start(); lopend.push(() => a.stop()); return a; };
  const a1 = app('formula-lab');
  await tot(() => hub.kern.beeld().apps.length === 1);
  const a2 = app('waterschaal');
  await tot(() => hub.kern.beeld().apps.length === 2 && hub.apparaten.apc.verbonden && hub.apparaten.lpd8.model === 'mk2');
  return { hub, apc, lpd8, a1, a2, meldingen };
}

/** LPD8 mk2: pad 4 = noot 39 (kanaal 10). */
const p4 = (lpd8) => { lpd8.injecteer([0x99, 39, 100]); lpd8.injecteer([0x89, 39, 0]); };

/** @param {string[]} args */
function cli(args, ms = 15000) {
  return new Promise((goed) => {
    const p = spawn(process.execPath, [CLI, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let uit = '', fout = '';
    p.stdout.on('data', (d) => { uit += d; });
    p.stderr.on('data', (d) => { fout += d; });
    const t = setTimeout(() => p.kill('SIGKILL'), ms);
    p.on('exit', (code) => { clearTimeout(t); goed({ code, uit, fout }); });
  });
}

const waarden = (hub) => Object.fromEntries(hub.kern.beeld().apps.map((a) => [a.app, a.waarden]));

describe('avondmap in de hele hub', () => {
  it('LPD8-pad 4 neemt op naar ~/…/<datum-tijd>/; `varve-hub herhaal` speelt het af tegen een andere hub met dezelfde eindstaat', async () => {
    const thuis = tijdelijk();
    const { hub, apc, lpd8, a1 } = await opzet({ thuis });
    p4(lpd8);
    await tot(() => hub.opnemer.actief);
    expect(hub.kern.beeld().opname).toBe(true);
    for (let r = 0; r <= 127; r += 4) { apc.injecteer([0xb0, 7, r]); await wacht(2); }   // fader 1 (pickup bij 0.5)
    await wacht(50);
    hub.opVirtueel('apc40', [0xb0, 0x30, 100]);                                        // virtuele draaiknop
    for (let r = 20; r <= 110; r += 6) { lpd8.injecteer([0xb0, 71, r]); await wacht(2); } // LPD8-knop 2: macro.helderheid
    await tot(() => a1.ontvangen.some((b) => b.t === 'zet' && b.bron === 'lpd8'));
    await wacht(100);
    p4(lpd8);
    const r = await tot(() => !hub.opnemer.actief) && await hub.opnemer.afgesloten;
    expect(r.verloren).toBe(0);

    const [naam] = readdirSync(join(thuis, 'avonden'));
    expect(naam).toMatch(/^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d$/);
    const map = join(thuis, 'avonden', naam);
    expect(r.map).toBe(map);
    const regels = readFileSync(join(map, GEBAREN), 'utf8').trim().split('\n').map((x) => JSON.parse(x));
    expect(regels[0]).toMatchObject({ v: 1, 'hub-git': 'test-git', lpd8: { bron: 'fabriek-mk2' } });
    expect(Object.keys(regels[0].apps).sort()).toEqual(['formula-lab', 'waterschaal']);
    const devs = new Set(regels.filter((x) => Array.isArray(x) && x[1] === 'in').map((x) => x[2]));
    expect(devs).toEqual(new Set(['apc40', 'apc40-virtueel', 'lpd8']));
    expect(regels.some((x) => Array.isArray(x) && x[1] === 'naar' && x[2] === 'formula-lab' && x[3].t === 'zet')).toBe(true);
    expect(regels.at(-1).e).toBe('eind');
    expect(readFileSync(join(map, SAMENVATTING), 'utf8')).toMatch(/formula-lab/);
    const verwacht = waarden(hub);

    // Tweede hub met verse apps (standaardwaarden): herhalen via de cockpit, 4× zo snel.
    const tweede = await opzet({ thuis: tijdelijk() });
    expect(waarden(tweede.hub)).not.toEqual(verwacht);
    const uit = await cli(['herhaal', map, '--hub', tweede.hub.adres, '--snelheid', '4']);
    expect(uit.fout).toBe('');
    expect(uit.uit).toMatch(/eindstaat klopt/);
    expect(uit.code).toBe(0);
    expect(waarden(tweede.hub)).toEqual(verwacht);
    expect(tweede.hub.kern.beeld().opname).toBe(false);   // pad 4 wordt niet afgespeeld
  }, 20000);

  it('map niet schrijfbaar (avondmap onder een bestand): melding, hub en apps lopen door', async () => {
    const thuis = tijdelijk();
    writeFileSync(join(thuis, 'bestand'), 'x');
    const { hub, apc, lpd8, a1, meldingen } = await opzet({ thuis, avondmap: '~/bestand/avonden' });
    p4(lpd8);
    await tot(() => hub.opnemer.actief);
    for (let r = 0; r <= 127; r += 8) apc.injecteer([0xb0, 7, r]);
    await tot(() => a1.ontvangen.some((b) => b.t === 'zet' && b.id === 'helder'));
    p4(lpd8);
    const r = await tot(() => !hub.opnemer.actief) && await hub.opnemer.afgesloten;
    expect(r.map).toBe(null);
    expect(meldingen.join('\n')).toMatch(/geen map|niet schrijfbaar|bestaat niet/);
    expect(meldingen.join('\n')).toMatch(/niets bewaard/);
    a1.ontvangen = [];
    for (let r = 127; r >= 0; r -= 8) apc.injecteer([0xb0, 7, r]);
    await tot(() => a1.ontvangen.some((b) => b.t === 'zet' && b.id === 'helder'));
    expect(a1.ontvangen.some((b) => b.t === 'zet' && b.id === 'helder')).toBe(true);
  });

  it('hub.stop() tijdens een opname sluit de avond netjes af (eind + samenvatting)', async () => {
    const thuis = tijdelijk();
    const { hub, apc, lpd8 } = await opzet({ thuis });
    p4(lpd8);
    await tot(() => hub.opnemer.actief);
    apc.injecteer([0xb0, 7, 20]);
    await hub.stop();
    const [naam] = readdirSync(join(thuis, 'avonden'));
    const map = join(thuis, 'avonden', naam);
    expect(existsSync(join(map, SAMENVATTING))).toBe(true);
    expect(JSON.parse(readFileSync(join(map, GEBAREN), 'utf8').trim().split('\n').at(-1)).e).toBe('eind');
  });

  it('herhaal zonder draaiende hub of met een kapot bestand: korte uitleg, exitcode 2', async () => {
    const map = tijdelijk();
    const leeg = await cli(['herhaal', join(map, 'bestaat-niet')]);
    expect(leeg.code).toBe(2);
    expect(leeg.fout).toMatch(/bestaat niet/);
    writeFileSync(join(map, GEBAREN), '{"v":1,"soort":"avond","apps":{}}\n');
    const geenHub = await cli(['herhaal', map, '--hub', '127.0.0.1:1']);
    expect(geenHub.code).toBe(2);
    expect(geenHub.fout).toMatch(/kan de hub niet bereiken/);
    expect(geenHub.fout).not.toMatch(/at .*\.js/);
    const snel = await cli(['herhaal', map, '--snelheid', 'nul']);
    expect(snel.code).toBe(2);
    expect(snel.fout).toMatch(/--snelheid/);
    expect(cockpitUrl('http://127.0.0.1:7700')).toBe('ws://127.0.0.1:7700/cockpit');
    expect(cockpitUrl('localhost:7700/')).toBe('ws://localhost:7700/cockpit');
  });
});
