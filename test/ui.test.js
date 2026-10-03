// Cockpit (ui/): pure delen in Node, de pagina zelf in een echte Chromium via playwright-core.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CONTROLS, OP_ID, PALET, rgb, ontleed } from '../src/devices/apc40mk2.js';
import { maakOntleder, standaardProfiel } from '../src/devices/lpd8.js';
import { INDELING, BREEDTE, HOOGTE } from '../ui/indeling.js';
import { drukBytes, losBytes, ccBytes, relBytes, lpdDruk, lpdLos, lpdKnop, animDuur } from '../ui/midi.js';
import { weergave, LED_KLEUR } from '../ui/led.js';
import { toonWaarde, invoerTekst, focusVan, isVerbonden, ademPeriode, ademSchaal, appKleur, paramSleutel } from '../ui/opmaak.js';
import { Verbinding, WACHTTIJDEN, cockpitUrl } from '../ui/verbinding.js';
import { startNepServer, bestandVoor } from './ui-nepserver.js';

const C = (/** @type {string} */ id) => /** @type {any} */ (OP_ID.get(id));

describe('indeling van de virtuele APC40', () => {
  it('plaatst alle 148 controls en niets anders', () => {
    expect(CONTROLS).toHaveLength(148);
    for (const c of CONTROLS) expect(INDELING[c.id], c.id).toBeDefined();
    expect(Object.keys(INDELING).sort()).toEqual(CONTROLS.map((c) => c.id).sort());
  });
  it('alles ligt binnen het paneel en niets overlapt', () => {
    const r = Object.entries(INDELING);
    for (const [id, p] of r) {
      expect(p.x >= 0 && p.y >= 0 && p.x + p.w <= BREEDTE && p.y + p.h <= HOOGTE, id).toBe(true);
    }
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
      const [a, p] = r[i], [b, q] = r[j];
      const over = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
      expect(over, `${a} overlapt ${b}`).toBe(false);
    }
  });
  it('rij 5 bovenaan, rij 1 onderaan; ◄ (left, note 97) links van ► (right, note 96)', () => {
    expect(INDELING['pad5-1'].y).toBeLessThan(INDELING['pad1-1'].y);
    expect(INDELING['pad1-1'].x).toBeLessThan(INDELING['pad1-8'].x);
    expect(INDELING.left.x).toBeLessThan(INDELING.right.x);
    expect(C('left').n).toBe(97);
    expect(INDELING.scene1.y).toBeGreaterThan(INDELING.scene5.y);
  });
});

describe('bytes zoals de echte controller', () => {
  it('pad: note-on 127 en note-off 127 op kanaal 0', () => {
    expect(drukBytes(C('pad3-4'))).toEqual([0x90, 19, 127]);
    expect(losBytes(C('pad3-4'))).toEqual([0x80, 19, 127]);
  });
  it('stripknoppen dragen de track in het kanaal', () => {
    expect(drukBytes(C('sel3'))).toEqual([0x92, 51, 127]);
    expect(losBytes(C('stop8'))).toEqual([0x87, 52, 127]);
    expect(drukBytes(C('bank'))).toEqual([0x90, 103, 127]);
  });
  it('faders en knoppen: absolute CC, geklemd', () => {
    expect(ccBytes(C('fader2'), 1)).toEqual([0xb1, 7, 127]);
    expect(ccBytes(C('fader2'), 0.5)).toEqual([0xb1, 7, 64]);
    expect(ccBytes(C('dk3'), 2)).toEqual([0xb0, 18, 127]);
    expect(ccBytes(C('xf'), -1)).toEqual([0xb0, 15, 0]);
  });
  it('tempo en cue: two\'s complement, en ontleed() leest het terug', () => {
    expect(relBytes(C('tempo'), 1)).toEqual([0xb0, 13, 1]);
    expect(relBytes(C('tempo'), -1)).toEqual([0xb0, 13, 127]);
    expect(relBytes(C('cue'), -64)).toEqual([0xb0, 47, 64]);
    expect(relBytes(C('cue'), 200)).toEqual([0xb0, 47, 63]);
    for (const d of [-64, -5, -1, 1, 7, 63]) expect(ontleed(relBytes(C('cue'), d)).delta).toBe(d);
  });
  it('footswitch: CC 64 127/0', () => {
    expect(drukBytes(C('voet'))).toEqual([0xb0, 64, 127]);
    expect(losBytes(C('voet'))).toEqual([0xb0, 64, 0]);
    expect(ontleed(drukBytes(C('voet'))).kind).toBe('druk');
  });
  it('elke control geeft bytes die ontleed() naar dezelfde control terugleest', () => {
    for (const c of CONTROLS) {
      const b = c.soort === 'rel' ? relBytes(c, 1) : c.t === 'cc' && c.soort !== 'voet' ? ccBytes(c, 0.5) : drukBytes(c);
      expect(ontleed(b).el, c.id).toBe(c.id);
      if (c.t === 'note') expect(ontleed(losBytes(c))).toMatchObject({ el: c.id, kind: 'los' });
    }
  });
  it('LPD8 (mk2-fabrieksstand) op kanaal 10, gelezen door het standaardprofiel', () => {
    const lees = maakOntleder(standaardProfiel('mk2'));
    expect(lpdDruk(0)).toEqual([0x99, 36, 127]);
    expect(lpdLos(7)).toEqual([0x89, 43, 0]);
    expect(lpdKnop(0, 1)).toEqual([0xb9, 70, 127]);
    expect(lpdDruk(2, 0)[2]).toBe(1); // velocity 0 zou note-off zijn
    expect(lees(lpdDruk(4, 90))).toMatchObject({ el: 'p5', kind: 'druk' });
    expect(lees(lpdLos(4))).toMatchObject({ el: 'p5', kind: 'los' });
    expect(lees(lpdKnop(7, 0.5))).toMatchObject({ el: 'k8', kind: 'waarde', raw: 64 });
  });
  it('animatieduur volgt de snelheid (1/24..1/2 noot) en de bpm', () => {
    expect(animDuur(4, 120)).toBeCloseTo(1);
    expect(animDuur(0, 120)).toBeCloseTo(1 / 12);
    expect(animDuur(4, 60)).toBeCloseTo(2);
    expect(animDuur(undefined, NaN)).toBeCloseTo(0.5);
  });
});

describe('LedStaat → weergave', () => {
  it('rgb vast, uit, en met animatie', () => {
    expect(weergave(C('pad1-1'), { kleur: 45 }, PALET)).toMatchObject({ aan: true, kleur: PALET[45], anim: null });
    expect(weergave(C('pad1-1'), { kleur: 0 }, PALET)).toMatchObject({ aan: false, kleur: null });
    expect(weergave(C('pad1-1'), null, PALET).aan).toBe(false);
    // zonder kleur2: de kleur zelf animeert tegen zwart (zoals Varve DJ)
    expect(weergave(C('scene2'), { kleur: 5, anim: { soort: 'puls', snelheid: 4 } }, PALET, 120)).toMatchObject({ kleur: null, kleur2: PALET[5], anim: 'puls', duur: 1 });
    // met kleur2: basis op kanaal 0, kleur2 animeert (zoals Ableton)
    expect(weergave(C('pad2-2'), { kleur: 21, anim: { soort: 'knipper', snelheid: 2, kleur2: 5 } }, PALET)).toMatchObject({ kleur: PALET[21], kleur2: PALET[5], anim: 'knipper' });
  });
  it('eenkleurig, clip stop, A|B en ringen', () => {
    expect(weergave(C('rec2'), { aan: true }, PALET)).toMatchObject({ aan: true, kleur: LED_KLEUR.rec });
    expect(weergave(C('devL'), { aan: true }, PALET).kleur).toBe(LED_KLEUR.standaard);
    expect(weergave(C('solo1'), { aan: false }, PALET).aan).toBe(false);
    expect(weergave(C('stop4'), { knipper: true }, PALET)).toMatchObject({ aan: true, anim: 'knipper', kleur2: LED_KLEUR.stop });
    expect(weergave(C('ab1'), { stand: 2 }, PALET)).toMatchObject({ aan: true, kleur: LED_KLEUR.ab2, stand: 2 });
    expect(weergave(C('dk1'), { waarde: 1.4 }, PALET).ring).toBe(1);
  });
});

describe('opmaak', () => {
  it('toont waarden per soort', () => {
    expect(toonWaarde({ soort: 'waarde' }, 0.257)).toBe('26%');
    expect(toonWaarde({ soort: 'waarde', min: 20, max: 2000, eenheid: 'Hz' }, 0.5)).toBe('1010 Hz');
    expect(toonWaarde({ soort: 'keuze', keuzes: ['a', 'b', 'c'] }, 0.5)).toBe('b');
    expect(toonWaarde({ soort: 'schakelaar' }, 1)).toBe('aan');
    expect(toonWaarde({ soort: 'waarde' }, undefined)).toBe('—');
  });
  it('beschrijft invoer', () => {
    expect(invoerTekst({ dev: 'apc40', el: 'pad3-4', kind: 'druk', v: 1, raw: 127 })).toBe('apc40 pad3-4 ▼');
    expect(invoerTekst({ dev: 'apc40', el: 'tempo', kind: 'delta', delta: -2 })).toBe('apc40 tempo -2');
    expect(invoerTekst({ dev: 'lpd8', el: 'k1', kind: 'waarde', v: 0.5, raw: 64 })).toBe('lpd8 k1 = 64');
    expect(invoerTekst({ dev: 'apc40', el: null, kind: 'onbekend', bytes: [0xf0, 0x7e] })).toBe('apc40 (onbekend) onbekend [f0 7e]');
  });
  it('leest focus, apparaten, adem en kleuren robuust', () => {
    expect(focusVan({ focus: 'b', apps: [] })).toBe('b');
    expect(focusVan({ apps: [{ app: 'a' }, { app: 'c', focus: true }] })).toBe('c');
    expect(focusVan(null)).toBe(null);
    expect([true, { verbonden: true }, 'verbonden'].map(isVerbonden)).toEqual([true, true, true]);
    expect([false, null, {}, 'weg'].map(isVerbonden)).toEqual([false, false, false, false]);
    expect(ademPeriode(0.5)).toBe(10);
    expect(ademPeriode(undefined)).toBe(10);
    expect(ademSchaal(0)).toBeCloseTo(0.5);
    expect(ademSchaal(0.5)).toBeCloseTo(1);
    expect(appKleur({ kleur: '#3FBF5F' })).toBe('#3FBF5F');
    expect(appKleur({ app: 'x' })).toMatch(/^hsl/);
    expect(paramSleutel('a', [{ id: 'x', soort: 'waarde' }])).not.toBe(paramSleutel('a', [{ id: 'x', soort: 'keuze', keuzes: ['p', 'q'] }]));
  });
});

describe('verbinding met de hub', () => {
  class NepWS {
    /** @type {NepWS[]} */ static alle = [];
    constructor(url) { this.url = url; this.readyState = 0; this.verstuurd = []; NepWS.alle.push(this); }
    send(s) { this.verstuurd.push(JSON.parse(s)); }
    close() { this.readyState = 3; this.onclose?.(); }
    open() { this.readyState = 1; this.onopen?.(); }
    ontvang(x) { this.onmessage?.({ data: typeof x === 'string' ? x : JSON.stringify(x) }); }
  }
  it('herverbindt met 0,5 → 1 → 2 → 5 s en begint na succes weer vooraan', () => {
    NepWS.alle = [];
    /** @type {{ fn: () => void, ms: number }[]} */
    const timers = [];
    const statussen = [];
    const v = new Verbinding({ url: 'ws://x/cockpit', WS: NepWS, wacht: (fn, ms) => timers.push({ fn, ms }), bijStatus: (s) => statussen.push(s.status) }).start();
    for (let i = 0; i < 5; i++) { NepWS.alle.at(-1).close(); timers.at(-1).fn(); }
    expect(timers.map((t) => t.ms)).toEqual([...WACHTTIJDEN, 5000]);
    NepWS.alle.at(-1).open();
    expect(v.open).toBe(true);
    NepWS.alle.at(-1).close();
    expect(timers.at(-1).ms).toBe(500);
    expect(statussen).toContain('verbonden');
    expect(statussen.at(-1)).toBe('weg');
    v.stop();
  });
  it('stuurt alleen als hij open is en negeert onleesbare berichten', () => {
    NepWS.alle = [];
    const binnen = [];
    const v = new Verbinding({ url: 'ws://x', WS: NepWS, wacht: () => 0, bijBericht: (b) => binnen.push(b) }).start();
    expect(v.stuur({ t: 'focus', app: 'a' })).toBe(false);
    NepWS.alle[0].open();
    expect(v.stuur({ t: 'focus', app: 'a' })).toBe(true);
    expect(NepWS.alle[0].verstuurd).toEqual([{ t: 'focus', app: 'a' }]);
    NepWS.alle[0].ontvang('{kapot');
    NepWS.alle[0].ontvang('[1,2]');
    NepWS.alle[0].ontvang({ t: 'beeld', apps: [] });
    expect(binnen).toEqual([{ t: 'beeld', apps: [] }]);
    v.stop();
  });
  it('adres: zelfde host, /cockpit; ?hub= overschrijft', () => {
    expect(cockpitUrl(/** @type {any} */ ({ protocol: 'http:', host: 'mac.local:7700', search: '' }))).toBe('ws://mac.local:7700/cockpit');
    expect(cockpitUrl(/** @type {any} */ ({ protocol: 'https:', host: 'h', search: '' }))).toBe('wss://h/cockpit');
    expect(cockpitUrl(/** @type {any} */ ({ protocol: 'http:', host: 'h', search: '?hub=ws://a:1/cockpit' }))).toBe('ws://a:1/cockpit');
  });
});

describe('nep-server', () => {
  it('serveert alleen ui/, src/devices/ en src/protocol/', () => {
    expect(bestandVoor('/')).toMatch(/ui[/\\]index\.html$/);
    expect(bestandVoor('/ui/cockpit.js')).toMatch(/ui[/\\]cockpit\.js$/);
    expect(bestandVoor('/src/devices/apc40mk2.js')).toMatch(/apc40mk2\.js$/);
    expect(bestandVoor('/src/core/klok.js')).toBe(null);
    expect(bestandVoor('/ui/../package.json')).toBe(null);
    expect(bestandVoor('/ui/%2e%2e/config.json')).toBe(null);
  });
});

// ── de pagina in een echte browser ──────────────────────────────────────────

/** Chromium: PW_CHROMIUM, anders /opt/pw-browsers/chromium, anders die van playwright zelf (`npx playwright-core install chromium`). */
const uitvoerbaar = process.env.PW_CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
let heeftBrowser = true;
try { heeftBrowser = uitvoerbaar ? existsSync(uitvoerbaar) : existsSync(chromium.executablePath()); } catch { heeftBrowser = false; }
// In CI moet de browser er zijn (dan liever rood dan stil overgeslagen).
if (process.env.CI) heeftBrowser = true;
if (!heeftBrowser) console.warn('[ui.test] geen Chromium gevonden — browsertests overgeslagen. Installeer met: npx playwright-core install chromium');

describe.skipIf(!heeftBrowser)('cockpit in de browser', { timeout: 20000 }, () => {
  /** @type {import('playwright-core').Browser} */ let browser;
  /** @type {Awaited<ReturnType<typeof startNepServer>>} */ let server;
  /** @type {import('playwright-core').Page} */ let page;
  /** @type {string[]} */ let fouten;

  beforeAll(async () => {
    server = await startNepServer();
    browser = await chromium.launch({ ...(uitvoerbaar ? { executablePath: uitvoerbaar } : {}), headless: true });
  }, 60000);
  afterAll(async () => { await browser?.close(); await server?.sluit(); });

  beforeEach(async () => {
    server.ontvangen.length = 0;
    fouten = [];
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on('pageerror', (e) => fouten.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') fouten.push(m.text()); });
    await page.goto(server.url);
    await page.waitForSelector('#verbinding[data-status="verbonden"]');
    await server.wachtOp(() => server.klanten.size >= 1);
  });
  afterEach(async () => {
    await page.close();
    await server.wachtOp(() => server.klanten.size === 0);
    expect(fouten).toEqual([]);
  });

  const virtueel = () => server.ontvangen.filter((b) => b.t === 'virtueel');
  /** @param {string} sel */
  const midden = async (sel) => {
    const r = await page.locator(sel).boundingBox();
    if (!r) throw new Error(`niet zichtbaar: ${sel}`);
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, r };
  };

  it('tekent alle 148 controls van de APC40 en de LPD8', async () => {
    expect(await page.locator('#apc .ctl').count()).toBe(148);
    const ids = await page.locator('#apc .ctl').evaluateAll((els) => els.map((e) => /** @type {HTMLElement} */ (e).dataset.id));
    expect(ids.sort()).toEqual(CONTROLS.map((c) => c.id).sort());
    expect(await page.locator('#lpd8 .lpd-pad').count()).toBe(8);
    expect(await page.locator('#lpd8 .lpd-knop').count()).toBe(8);
  });

  it('een leds-bericht kleurt de juiste pad in de juiste paletkleur', async () => {
    server.stuur({ t: 'leds', dev: 'apc40', staat: { 'pad2-5': { kleur: 45 }, 'rec3': { aan: true }, 'dk2': { waarde: 1 } } });
    const pad = page.locator('[data-id="pad2-5"]');
    await expect.poll(() => pad.getAttribute('data-kleur')).toBe('45');
    const [r, g, b] = rgb(PALET[45]);
    expect(await pad.evaluate((e) => getComputedStyle(e).backgroundColor)).toBe(`rgb(${r}, ${g}, ${b})`);
    expect(await page.locator('[data-id="pad5-2"]').evaluate((e) => e.classList.contains('aan'))).toBe(false);
    expect(await page.locator('[data-id="rec3"]').evaluate((e) => e.classList.contains('aan'))).toBe(true);
    expect(await page.locator('[data-id="dk2"]').evaluate((e) => e.style.getPropertyValue('--v'))).toBe('1');
    // pulseren via CSS-animatie
    server.stuur({ t: 'leds', dev: 'apc40', staat: { 'scene1': { kleur: 5, anim: { soort: 'puls', snelheid: 2 } } } });
    await expect.poll(() => page.locator('[data-id="scene1"]').evaluate((e) => getComputedStyle(e).animationName)).toBe('led-puls');
  });

  it('klik op pad3-4: note-on bij indrukken, note-off bij loslaten', async () => {
    const { x, y } = await midden('[data-id="pad3-4"]');
    await page.mouse.move(x, y);
    await page.mouse.down();
    await server.wachtOp(() => virtueel().length >= 1);
    expect(virtueel()).toEqual([{ t: 'virtueel', dev: 'apc40', bytes: [0x90, 19, 127] }]);
    await page.mouse.up();
    await server.wachtOp(() => virtueel().length >= 2);
    expect(virtueel()[1]).toEqual({ t: 'virtueel', dev: 'apc40', bytes: [0x80, 19, 127] });
  });

  it('shift-klik houdt Bank vast; nog een klik laat los', async () => {
    const { x, y } = await midden('[data-id="bank"]');
    await page.keyboard.down('Shift');
    await page.mouse.click(x, y);
    await page.keyboard.up('Shift');
    await server.wachtOp(() => virtueel().length >= 1);
    await page.waitForTimeout(100);
    expect(virtueel().map((b) => b.bytes)).toEqual([[0x90, 103, 127]]);
    expect(await page.locator('[data-id="bank"]').evaluate((e) => e.classList.contains('vast'))).toBe(true);
    // terwijl Bank vastzit kun je een pad indrukken (hublaag)
    const p = await midden('[data-id="pad5-2"]');
    await page.mouse.click(p.x, p.y);
    await page.mouse.click(x, y);
    await server.wachtOp(() => virtueel().length >= 4);
    expect(virtueel().map((b) => b.bytes)).toEqual([[0x90, 103, 127], [0x90, 33, 127], [0x80, 33, 127], [0x80, 103, 127]]);
  });

  it('fader 2 slepen stuurt CC 7 op kanaal 1, oplopend', async () => {
    const { x, r } = await midden('[data-id="fader2"]');
    await page.mouse.move(x, r.y + r.height * 0.85);
    await page.mouse.down();
    await page.mouse.move(x, r.y + r.height * 0.2, { steps: 8 });
    await page.mouse.up();
    await server.wachtOp(() => virtueel().length >= 3);
    const cc = virtueel().map((b) => b.bytes);
    expect(cc.every((b) => b[0] === 0xb1 && b[1] === 7)).toBe(true);
    const waarden = cc.map((b) => b[2]);
    expect(waarden.at(-1)).toBeGreaterThan(waarden[0]);
    expect(waarden.at(-1)).toBeGreaterThan(100);
  });

  it('tempo slepen stuurt relatieve stappen (two\'s complement)', async () => {
    const { x, y } = await midden('[data-id="tempo"]');
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 40, { steps: 10 });
    await page.mouse.move(x, y + 40, { steps: 20 });
    await page.mouse.up();
    await server.wachtOp(() => virtueel().length >= 2);
    const b = virtueel().map((m) => m.bytes);
    expect(b.every((m) => m[0] === 0xb0 && m[1] === 13)).toBe(true);
    const som = b.reduce((s, m) => s + ontleed(m).delta, 0);
    expect(som).toBe(-5); // 40 px op = +5, 80 px neer = −10
    expect(b.some((m) => m[2] >= 64)).toBe(true);
  });

  it('virtuele LPD8: pad op kanaal 10 en knop als CC 70+', async () => {
    const p = await midden('#lpd8 [data-id="p1"]');
    await page.mouse.click(p.x, p.y);
    const k = await midden('#lpd8 [data-id="k3"]');
    await page.mouse.move(k.x, k.y);
    await page.mouse.down();
    await page.mouse.move(k.x, k.y - 60, { steps: 4 });
    await page.mouse.up();
    await server.wachtOp(() => virtueel().length >= 3);
    const v = virtueel();
    expect(v.every((b) => b.dev === 'lpd8')).toBe(true);
    expect(v[0].bytes.slice(0, 2)).toEqual([0x99, 36]);
    expect(v[1].bytes).toEqual([0x89, 36, 0]);
    expect(v.slice(2).every((b) => b.bytes[0] === 0xb9 && b.bytes[1] === 72)).toBe(true);
  });

  const tweeApps = {
    t: 'beeld', focus: 'formula-lab',
    apps: [
      { app: 'formula-lab', naam: 'Formula Lab', kleur: '#3fbf5f', status: 'actief', focus: true, waarden: { in1: 0.25, palet: 0.5 },
        params: [
          { id: 'in1', naam: 'In 1', soort: 'waarde', standaard: 0, hint: 'fader' },
          { id: 'palet', naam: 'Palet', soort: 'keuze', keuzes: ['warm', 'koel', 'mono'], standaard: 0 },
        ] },
      { app: 'varve-dj', naam: 'Varve DJ', kleur: '#ff7f00', status: 'stil', focus: false, lease: true, params: [], waarden: {} },
    ],
    globaal: { 'macro.intensiteit': 0.75, adem: 0.25, bpm: 100, grondtoon: 'D' },
    apparaten: { apc40: true, lpd8: false },
  };

  it('beeld met twee apps: naam, kleur, status, focus en lease', async () => {
    server.stuur(tweeApps);
    await page.waitForSelector('.app[data-app="varve-dj"]');
    const apps = await page.locator('.app').evaluateAll((els) => els.map((e) => ({
      app: /** @type {HTMLElement} */ (e).dataset.app, naam: e.querySelector('.naam')?.textContent,
      kleur: getComputedStyle(/** @type {Element} */ (e.querySelector('.kleur'))).backgroundColor,
      focus: e.classList.contains('focus'), lease: e.classList.contains('met-lease'), status: /** @type {HTMLElement} */ (e).dataset.status,
    })));
    expect(apps).toEqual([
      { app: 'formula-lab', naam: 'Formula Lab', kleur: 'rgb(63, 191, 95)', focus: true, lease: false, status: 'actief' },
      { app: 'varve-dj', naam: 'Varve DJ', kleur: 'rgb(255, 127, 0)', focus: false, lease: true, status: 'stil' },
    ]);
    expect(await page.locator('#focus-titel').textContent()).toBe('Focus · Formula Lab');
    expect(await page.locator('.param[data-id="in1"] output').textContent()).toBe('25%');
    expect(await page.locator('.param[data-id="palet"] output').textContent()).toBe('koel');
    expect(await page.locator('#bpm').textContent()).toBe('100');
    expect(await page.locator('#dev-apc40').evaluate((e) => e.classList.contains('aan'))).toBe(true);
    expect(await page.locator('#dev-lpd8').evaluate((e) => e.classList.contains('aan'))).toBe(false);
    expect(await page.locator('.macro[data-rol="macro.intensiteit"] span').textContent()).toBe('75%');
  });

  it('klik op een app stuurt focus', async () => {
    server.stuur(tweeApps);
    await page.click('.app[data-app="varve-dj"] button');
    await server.wachtOp(() => server.ontvangen.find((b) => b.t === 'focus'));
    expect(server.ontvangen.filter((b) => b.t === 'focus')).toEqual([{ t: 'focus', app: 'varve-dj' }]);
  });

  it('parameters van de focus-app zetten: schuifje en keuze', async () => {
    server.stuur(tweeApps);
    await page.waitForSelector('.param[data-id="in1"] input');
    await page.locator('.param[data-id="in1"] input').fill('0.8');
    await page.click('.param[data-id="palet"] button:has-text("mono")');
    await server.wachtOp(() => server.ontvangen.filter((b) => b.t === 'zet').length >= 2);
    const zet = server.ontvangen.filter((b) => b.t === 'zet');
    expect(zet).toContainEqual({ t: 'zet', app: 'formula-lab', id: 'in1', v: 0.8 });
    expect(zet).toContainEqual({ t: 'zet', app: 'formula-lab', id: 'palet', v: 1 });
  });

  it('snapshots: klik = laden, shift-klik = bewaren', async () => {
    await page.click('.snapshot[data-nr="2"]');
    await page.click('.snapshot[data-nr="3"]', { modifiers: ['Shift'] });
    await server.wachtOp(() => server.ontvangen.filter((b) => b.t === 'snapshot').length >= 2);
    expect(server.ontvangen.filter((b) => b.t === 'snapshot')).toEqual([
      { t: 'snapshot', nr: 2, actie: 'laad' },
      { t: 'snapshot', nr: 3, actie: 'bewaar' },
    ]);
  });

  it('invoerlog toont de laatste 50 en de controller laat het zien', async () => {
    for (let i = 0; i < 60; i++) server.stuur({ t: 'invoer', g: { dev: 'apc40', el: 'fader3', kind: 'waarde', v: i / 127, raw: i } });
    server.stuur({ t: 'invoer', g: { dev: 'lpd8', el: 'p2', kind: 'druk', v: 1, raw: 100 } });
    await expect.poll(() => page.locator('#log li').first().textContent()).toContain('lpd8 p2');
    expect(await page.locator('#log li').count()).toBe(50);
    expect(await page.locator('[data-id="fader3"]').evaluate((e) => e.style.getPropertyValue('--v'))).toBe(String(59 / 127));
    expect(await page.locator('#lpd8 [data-id="p2"]').evaluate((e) => e.classList.contains('hw'))).toBe(true);
  });

  it('onbekende berichten breken niets', async () => {
    server.stuur({ t: 'iets-uit-de-toekomst', x: 1 });
    server.stuur({ t: 'leds', dev: 'apc40', staat: { bestaatniet: { kleur: 3 }, 'pad1-1': { kleur: 999 } } });
    server.stuur({ t: 'beeld' });
    await page.waitForTimeout(150);
    expect(await page.locator('[data-id="pad1-1"]').getAttribute('data-kleur')).toBe('127');
    expect(await page.locator('#apps-leeg').isVisible()).toBe(true);
  });

  it('herverbindt vanzelf als de hub wegvalt', async () => {
    server.verbreekAlle();
    await page.waitForSelector('#verbinding[data-status="weg"]');
    await page.waitForSelector('#verbinding[data-status="verbonden"]', { timeout: 5000 });
    await server.wachtOp(() => server.klanten.size >= 1);
  });
});
