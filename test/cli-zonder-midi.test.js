import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HUB_MAP = join(import.meta.dirname, '..');

/**
 * Start de echte daemon en geef de uitvoer tot "varve-hub draait" (de drivers worden direct bij het
 * starten gekozen; ze openen hun poort pas na het uitstel).
 * @param {string[]} extra
 * @returns {Promise<string>}
 */
function startUitvoer(extra) {
  return new Promise((klaar, mis) => {
    const p = spawn(process.execPath, ['src/cli.js', 'start', '--poort', '0', ...extra], { cwd: HUB_MAP, env: { ...process.env, VARVE_HUB_STAAT: join(mkdtempSync(join(tmpdir(), 'varve-cli-')), 'staat.json') } }); // nooit het echte geheugen
    let uit = '';
    const stop = () => { clearTimeout(t); p.kill('SIGKILL'); };
    const t = setTimeout(() => { stop(); mis(new Error('hub startte niet:\n' + uit)); }, 10000);
    const lees = (/** @type {Buffer} */ b) => { uit += b; if (uit.includes('varve-hub draait')) { stop(); klaar(uit); } };
    p.stdout.on('data', lees);
    p.stderr.on('data', lees);
  });
}

describe('cli start zonder echte MIDI', () => {
  it('--zonder-midi: TD en Sediment krijgen geen (nep-)poort, en dat staat er duidelijk', async () => {
    const uit = await startUitvoer(['--zonder-midi']);
    expect(uit).toMatch(/av-scene-kit: geen MIDI-systeem met virtuele poorten.*"VARVE-HUB TD"/);
    expect(uit).toMatch(/sediment: geen MIDI-systeem met virtuele poorten.*"VARVE-HUB Logic"/);
    expect(uit).not.toMatch(/virtuele poort "VARVE-HUB/);
  }, 15000);
});
