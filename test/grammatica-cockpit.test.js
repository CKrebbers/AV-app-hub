// @ts-check
// §19 in de cockpit: de pure hulpjes (ui/opmaak.js) in Node, en de echte cockpit in Chromium tegen een echte hub
// met de nep-harmonograaf (tools/nep-app.mjs --alfabet): de virtuele device-knoppen volgen het alfabet, de
// Maschine-schermen staan erin zoals de hub ze tekent, en de grammatica staat er in woorden.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startHub } from '../src/hub.js';
import { NepSysteem } from '../src/ports/nep.js';
import { laadConfig } from '../src/config.js';
import * as APC from '../src/devices/apc40mk2.js';
import { plekTekst, dkNamen, maschineVan } from '../ui/opmaak.js';
import { alfabetManifest } from '../tools/nep-app.mjs';
import { meldAan, FL } from './kern-hulp.js';

const uitvoerbaar = process.env.PW_CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
let heeftBrowser = false;
try { heeftBrowser = uitvoerbaar ? existsSync(uitvoerbaar) : existsSync(chromium.executablePath()); } catch { heeftBrowser = false; }

describe('§19 cockpit-hulpjes (ui/opmaak.js)', () => {
  it('plekTekst: alfabet-plek en moment, anders null', () => {
    expect(plekTekst({ rol: 'alfabet.beweging' })).toBe('3 beweging');
    expect(plekTekst({ rol: 'moment.flits' })).toBe('pad 1 flits');
    expect(plekTekst({ rol: 'macro.ruimte' })).toBe(null);
    expect(plekTekst(null)).toBe(null);
  });

  it('dkNamen: namen uit beeld.pickup; op de alfabet-pagina een lege plek met zijn woord', () => {
    const beeld = {
      focus: 'x', pickup: { dk1: { id: 'a' }, dk3: { id: 'b' }, fader1: { id: 'c' } },
      apps: [{ app: 'x', pagina: 0, paginas: ['alfabet', 'meer'], params: [{ id: 'a', naam: 'Grootte' }, { id: 'b', naam: 'Snelheid' }, { id: 'c', naam: 'C' }] }],
    };
    const n = dkNamen(beeld);
    expect(n.dk1).toEqual({ tekst: 'Grootte', titel: '1 schaal · Grootte', leeg: false });
    expect(n.dk2).toEqual({ tekst: 'dichtheid', titel: '2 dichtheid: leeg (doet niets in deze app)', leeg: true });
    expect(n.fader1).toBeUndefined();
    // Op de volgende pagina geen woorden; een lease-app of geen focus: niets.
    expect(dkNamen({ ...beeld, apps: [{ ...beeld.apps[0], pagina: 1 }] }).dk2).toBeUndefined();
    expect(dkNamen({ ...beeld, apps: [{ ...beeld.apps[0], lease: true }] })).toEqual({});
    expect(dkNamen({})).toEqual({});
  });

  it('maschineVan: gecontroleerd; zonder bediening zegt hij voor wie hij speelt', () => {
    expect(maschineVan({ spelers: { 'maschine-mk2': 'varve-dj' }, maschine: null })).toEqual({ bedient: null, speelt: 'varve-dj' });
    const m = maschineVan({ maschine: { app: 'x', naam: 'X', knoppen: [{ woord: 'schaal', naam: 'Z', tekst: '50%', v: 2 }], pads: [{ woord: 'flits', naam: 'F', in: true }] } });
    expect(m.bedient?.knoppen).toHaveLength(8);
    expect(m.bedient?.knoppen[0]).toEqual({ woord: 'schaal', naam: 'Z', tekst: '50%', v: 1 });
    expect(m.bedient?.knoppen[7]).toEqual({ woord: 'ruimte', naam: null, tekst: null, v: null });
    expect(m.bedient?.pads[0]).toMatchObject({ pad: 1, woord: 'flits', in: true });
  });
});

describe.skipIf(!heeftBrowser)('§19 cockpit in de browser met de nep-harmonograaf', () => {
  /** @type {any} */ let hub;
  /** @type {import('playwright-core').Browser} */ let browser;
  beforeAll(async () => {
    hub = await startHub({ config: laadConfig(), systeem: new NepSysteem(), poort: 0, drivers: false, opname: false });
    browser = await chromium.launch({ ...(uitvoerbaar ? { executablePath: uitvoerbaar } : {}), headless: true });
  });
  afterAll(async () => { await browser?.close(); await hub?.stop(); });

  it('device-knoppen volgen het alfabet, de Maschine-schermen en de grammatica staan erin', async () => {
    meldAan(hub.kern, alfabetManifest());
    meldAan(hub.kern, FL);
    hub.kern.focus('nep-alfabet');
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    /** @type {string[]} */ const fouten = [];
    page.on('pageerror', (e) => fouten.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') fouten.push(m.text()); });
    await page.goto(hub.adres);
    await page.waitForFunction(() => document.getElementById('maschine-wie')?.textContent?.includes('bedient'));
    // Virtuele APC: dk N = plek N, ook al staat het manifest door elkaar; plek 2 is leeg en toont zijn woord.
    const namen = await page.evaluate(() => Array.from({ length: 8 }, (_, i) => {
      const d = /** @type {HTMLElement} */ (document.querySelector(`.ctl[data-id="dk${i + 1}"]`));
      return `${d.dataset.naam}${d.dataset.naamLeeg !== undefined ? '(leeg)' : ''}`;
    }));
    expect(namen).toEqual(['Grootte', 'dichtheid(leeg)', 'Snelheid', 'Fase', 'Tint', 'Lijndikte', 'Verhouding', 'Demping']);
    // De ringen: dk1 = Grootte 50%, dk2 leeg = uit, dk3 = Snelheid 30%.
    const ring = (/** @type {string} */ id) => page.evaluate((x) => Number(document.querySelector(`.ctl[data-id="${x}"]`)?.getAttribute('aria-valuenow')), id);
    await page.waitForFunction(() => Number(document.querySelector('.ctl[data-id="dk1"]')?.getAttribute('aria-valuenow')) === 64);
    expect(await ring('dk2')).toBe(0);
    expect(await ring('dk3')).toBe(Math.round(0.3 * 127));
    // Draaien aan APC-knop 3 (zoals de hardware) zet Snelheid en staat ook op het Maschine-scherm.
    const c = /** @type {any} */ (APC.OP_ID.get('dk3'));
    hub.kern.invoer(APC.ontleed([0xb0, c.n, 127]), [0xb0, c.n, 127]);
    await page.waitForFunction(() => document.getElementById('mk2-l')?.dataset.tekst?.includes('beweging:Snelheid:100%'));
    expect(await page.locator('#mk2-l').getAttribute('data-tekst')).toBe('schaal:Grootte:50%|dichtheid:-:|beweging:Snelheid:100%|vervorming:Fase:0%');
    // Het scherm is echt getekend (er staan pixels aan).
    const aan = await page.evaluate(() => {
      const c = /** @type {HTMLCanvasElement} */ (document.getElementById('mk2-r'));
      const d = /** @type {CanvasRenderingContext2D} */ (c.getContext('2d')).getImageData(0, 0, 256, 64).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 100) n++;
      return n;
    });
    expect(aan).toBeGreaterThan(200);
    // De pads: 1 flits, 3 omkeren, 5 zaad, 7 wis; de plekken bij de parameters; de grammatica in zes delen.
    expect(await page.locator('#mk2-pads li.vol').evaluateAll((l) => l.map((x) => /** @type {HTMLElement} */ (x).dataset.pad).sort())).toEqual(['1', '3', '5', '7']);
    expect(await page.locator('.param[data-plek="3 beweging"] label').textContent()).toBe('3 bewegingSnelheid');
    expect(await page.locator('#grammatica-lijf section').count()).toBe(6);
    // Focus naar formula-lab (geen alfabet): geen woorden onder de knoppen, de Maschine bedient niet.
    hub.kern.focus('formula-lab');
    await page.waitForFunction(() => document.getElementById('maschine-wie')?.textContent === 'focus-app volgt geen grammatica');
    expect(await page.evaluate(() => document.querySelector('.ctl[data-id="dk2"]')?.hasAttribute('data-naam'))).toBe(false);
    expect(fouten).toEqual([]);
    await page.close();
  }, 30000);
});
