// @ts-check
// De av-kern-koppeling (koppelingen/av-kern, patch tot na de publicatie van 25 okt) tegen de echte kern:
// het manifest uit de patch zelf, Bank + Track Select geeft focus, LED's en ringen van av-kern op de APC,
// en elke LPD8-knop bereikt de av-kern-parameter met die rol.
import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Kern, MELDING, Bank, P, manifest, fysiek } from './spec/hulp.js';
import { valideerManifest, ROLLEN } from '../src/protocol/manifest.js';

const MAP = fileURLToPath(new URL('../koppelingen/av-kern/', import.meta.url));
const PATCHES = readdirSync(MAP).filter((f) => f.endsWith('.patch')).sort();

/** Inhoud van een nieuw bestand uit de patches (git format-patch). @param {string} pad */
function nieuwBestand(pad) {
  for (const f of PATCHES) {
    const regels = readFileSync(join(MAP, f), 'utf8').split('\n');
    const i = regels.indexOf(`+++ b/${pad}`);
    if (i < 0 || regels[i - 1] !== '--- /dev/null') continue;
    const uit = [];
    for (const r of regels.slice(i + 2)) { if (!r.startsWith('+')) break; uit.push(r.slice(1)); }
    return uit.join('\n');
  }
  throw new Error(`${pad} staat niet als nieuw bestand in koppelingen/av-kern`);
}

const MANIFEST = JSON.parse(nieuwBestand('src/ui/hub-manifest.json'));
/** rol → parameter-id in av-kern */
const PER_ROL = Object.fromEntries(MANIFEST.params.filter((/** @type {any} */ p) => p.rol).map((/** @type {any} */ p) => [p.rol, p.id]));
const STAAT = Object.fromEntries(MANIFEST.params.filter((/** @type {any} */ p) => p.soort !== 'trigger').map((/** @type {any} */ p) => [p.id, p.standaard ?? 0]));

describe('koppelingen/av-kern: de bestanden', () => {
  it('twee patches (◄/► apart van de koppeling) in format-patch-vorm, plus een LEESMIJ', () => {
    expect(PATCHES).toHaveLength(2);
    expect(PATCHES[0]).toMatch(/^0001-APC40/);
    for (const f of PATCHES) {
      const t = readFileSync(join(MAP, f), 'utf8');
      expect(t.startsWith('From '), f).toBe(true);
      expect(t, f).toMatch(/^Subject: \[PATCH [12]\/2\]/m);
      expect(t, f).toMatch(/Co-Authored-By: Claude/);
    }
    const leesmij = readFileSync(join(MAP, 'LEESMIJ.md'), 'utf8');
    expect(leesmij).toMatch(/25 okt/);
    expect(leesmij).toMatch(/git apply --check/);
  });
  it('de ◄/►-patch raakt alleen apc40.ts en zijn test, niet de bevroren kern (midi.ts, bus.ts)', () => {
    const t = readFileSync(join(MAP, PATCHES[0]), 'utf8');
    expect([...t.matchAll(/^diff --git a\/(\S+)/gm)].map((m) => m[1])).toEqual(['src/kern/apc40.ts', 'test/kern.test.ts']);
    const alles = PATCHES.map((f) => readFileSync(join(MAP, f), 'utf8')).join('\n');
    expect(alles).not.toMatch(/^diff --git a\/src\/kern\/(midi|bus)\.ts/m);
  });
  it('de patches raken LOG.md en CLAUDE.md niet (die veranderen elke sessie: git am zou na 25 okt vastlopen); de LEESMIJ heeft de tekst', () => {
    const alles = PATCHES.map((f) => readFileSync(join(MAP, f), 'utf8')).join('\n');
    expect(alles).not.toMatch(/^diff --git a\/(LOG|CLAUDE)\.md/m);
    const leesmij = readFileSync(join(MAP, 'LEESMIJ.md'), 'utf8');
    expect(leesmij).toMatch(/LOG\.md/);
    expect(leesmij).toMatch(/## AV-app-hub \(`\?hub=ws:\/\/localhost:7700\/app`\)/); // de CLAUDE.md-alinea om te plakken
    expect(leesmij).toMatch(/git am --abort/); // wat Clay doet als het toch vastloopt
  });
  it('geen kleur in het manifest: config.json is de enige bron (apps.av-kern.kleur)', () => {
    expect(MANIFEST.kleur).toBeUndefined();
    const cfg = JSON.parse(readFileSync(fileURLToPath(new URL('../config.json', import.meta.url)), 'utf8'));
    expect(cfg.apps['av-kern'].kleur).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it('het manifest is geldig: lease, rings "auto", en een av-kern-parameter voor elke LPD8-rol', () => {
    const v = valideerManifest(MANIFEST);
    expect(v.ok, v.ok ? '' : v.fouten.join('; ')).toBe(true);
    expect(MANIFEST).toMatchObject({ app: 'av-kern', lease: true, rings: 'auto' });
    expect(Object.keys(PER_ROL).sort()).toEqual([...ROLLEN].sort());
    expect(MANIFEST.params.find((/** @type {any} */ p) => p.id === 'paniek')?.soort).toBe('trigger');
  });
});

describe.skipIf(!Kern)(`koppelingen/av-kern tegen de kern${MELDING}`, () => {
  /** @type {Bank[]} */
  let banken = [];
  const bank = () => { const b = new Bank(); banken.push(b); return b; };
  afterEach(() => { for (const b of banken) b.stop(); banken = []; });

  /** Een andere app eerst (die krijgt de focus), dan av-kern met het manifest uit de patch. */
  function opstelling() {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.waarde('in1', { hint: 'fader' })]), { in1: 0.2 });
    const ak = h.app(MANIFEST, STAAT);
    h.even();
    return { h, fl, ak };
  }

  it('Bank + Track Select geeft av-kern de focus; zijn LED\'s en ringen komen op de APC', () => {
    const { h, ak } = opstelling();
    expect(h.kern.beeld().focus).toBe('formula-lab');
    ak.led([[0x90, 8, 45], [0xb0, 48, 100]]); // pad2-1 Drone-kleur, ring tk1 (macro kleur)
    h.even();
    expect(h.apc.rgb('pad2-1').basis).not.toBe(45); // nog niet: geen focus

    const slot = ak.beeld().slot;
    h.metHubtoets(() => h.tik(`sel${slot}`));
    h.even();
    expect(h.kern.beeld().focus).toBe('av-kern');
    expect(ak.focus()).toBe(true);
    expect(h.apc.rgb('pad2-1').basis).toBe(45);
    expect(h.apc.ring('tk1')).toBeCloseTo(100 / 127, 3);

    // ruwe APC-invoer naar av-kern; draaien tekent de ring mee (rings:"auto", zoals modus 0x41)
    ak.wis();
    h.tik('pad3-4');
    h.draai('tk3', 0.25);
    expect(ak.midi().map((m) => m.bytes)).toEqual([[0x90, 19, 127], [0x80, 19, 0], [0xb0, 50, 32]]);
    expect(h.apc.ring('tk3')).toBeCloseTo(fysiek(0.25), 3);
  });

  it('elke LPD8-knop (K1–K8) zet de av-kern-parameter met die rol, met pickup', () => {
    const { h, ak } = opstelling();
    for (let k = 1; k <= 8; k++) {
      const id = PER_ROL[ROLLEN[k - 1]];
      h.lpdSchuif(k, 0, 0.9);
      h.tijd(300);
      expect(ak.laatsteZet(id)?.v, `K${k} → ${id}`).toBeCloseTo(fysiek(0.9), 2);
      expect(ak.laatsteZet(id)?.bron, `K${k}`).toBe('lpd8');
    }
    // korrel, contrast en adem (diepte) hebben geen rol: de LPD8 laat ze staan
    for (const id of ['korrel', 'contrast', 'adem']) expect(ak.zetten(id), id).toEqual([]);
  });

  it('LPD8 P1 1 s vast = trig paniek naar av-kern (Stop All in de app)', () => {
    const { h, ak } = opstelling();
    h.lpdHoud(1, 1200);
    h.even();
    expect(ak.trigs('paniek').map((t) => t.aan)).toEqual([true, false]);
  });
});
