// Cockpit (ui/): pure delen in Node, de pagina zelf in een echte Chromium via playwright-core.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CONTROLS, OP_ID, PALET, rgb, ontleed } from '../src/devices/apc40mk2.js';
import { maakOntleder, standaardProfiel } from '../src/devices/lpd8.js';
import { INDELING, BREEDTE, HOOGTE } from '../ui/indeling.js';
import { drukBytes, losBytes, ccBytes, relBytes, lpdDruk, lpdLos, lpdKnop, animDuur } from '../ui/midi.js';
import { weergave, LED_KLEUR } from '../ui/led.js';
import { toonWaarde, invoerTekst, focusVan, isVerbonden, ademPeriode, ademSchaal, appKleur, paramSleutel, mapNaamVan, looptijdTekst, opnameVan, slewsVan } from '../ui/opmaak.js';
import { Verbinding, WACHTTIJDEN, VERBIND_TIJD, cockpitUrl } from '../ui/verbinding.js';
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
    expect(INDELING.scene1.y).toBeLessThan(INDELING.scene5.y); // Scene Launch 1 (note 82) bovenaan, protocol v1.2
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
  it('LPD8 (mk2-fabrieksstand): pads op kanaal 10, knoppen op kanaal 1 (ONDERZOEK §6), gelezen door het standaardprofiel', () => {
    const lees = maakOntleder(standaardProfiel('mk2'));
    expect(lpdDruk(0)).toEqual([0x99, 36, 127]);
    expect(lpdLos(7)).toEqual([0x89, 43, 0]);
    expect(lpdKnop(0, 1)).toEqual([0xb0, 70, 127]);
    expect(lpdKnop(7, 0)).toEqual([0xb0, 77, 0]);
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
  it('rare LedStaat geeft geen NaN of onbekende animatie', () => {
    expect(weergave(C('dk1'), /** @type {any} */ ({ waarde: 'x' }), PALET).ring).toBe(0);
    expect(weergave(C('ab1'), /** @type {any} */ ({ stand: 'x' }), PALET)).toMatchObject({ aan: false, stand: 0 });
    expect(weergave(C('pad1-1'), /** @type {any} */ ({ kleur: 3, anim: { soort: 'draai' } }), PALET).anim).toBe('puls');
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
  it('valt niet om over slechte invoer', () => {
    expect(focusVan({ apps: { a: { app: 'a', focus: true } } })).toBe(null);
    expect(focusVan({ apps: 'x' })).toBe(null);
    expect(paramSleutel('a', /** @type {any} */ ([null, { id: 'x', soort: 'waarde' }, 3]))).toBe('a|x:waarde:0');
    expect(paramSleutel('a', /** @type {any} */ ('x'))).toBe('a|');
  });
  it('opname: mapnaam, looptijd en melding uit het beeld', () => {
    expect(mapNaamVan('/Users/clay/Movies/varve-avonden/2026-10-04_21-00-00')).toBe('2026-10-04_21-00-00');
    expect(mapNaamVan('C:\\avonden\\2026-10-04_21-00-00-2\\')).toBe('2026-10-04_21-00-00-2');
    expect([mapNaamVan(null), mapNaamVan('')]).toEqual(['', '']);
    expect([looptijdTekst(0), looptijdTekst(61_900), looptijdTekst(3_725_000), looptijdTekst(-5), looptijdTekst(NaN)]).toEqual(['0:00', '1:01', '1:02:05', '0:00', '0:00']);
    const b = { opname: true, nu: 95_000, opnameInfo: { map: '/a/2026-10-04_21-00-00', melding: 'opname loopt: /a/2026-10-04_21-00-00', fout: false, sinds: 5_000 } };
    expect(opnameVan(b)).toEqual({ aan: true, map: '2026-10-04_21-00-00', looptijdMs: 90_000, melding: 'opname loopt: /a/2026-10-04_21-00-00', fout: false });
    // gestopt: geen REC meer, de melding blijft
    expect(opnameVan({ ...b, opname: false })).toMatchObject({ aan: false, map: '', looptijdMs: null, melding: 'opname loopt: /a/2026-10-04_21-00-00' });
    expect(opnameVan({ opname: true })).toEqual({ aan: true, map: '', looptijdMs: null, melding: '', fout: false });
    expect(opnameVan(null)).toEqual({ aan: false, map: '', looptijdMs: null, melding: '', fout: false });
  });
  it('slews van de focus-app uit het beeld', () => {
    const b = { nu: 1000, slews: [{ app: 'lab', id: 'niveau', doel: 0.8, eindMs: 3500 }, { app: 'ander', id: 'x', doel: 0.1, eindMs: 2000 }, { app: 'lab', id: 'kapot', doel: 'x' }, null] };
    expect([...slewsVan(b, 'lab')]).toEqual([['niveau', { doel: 0.8, restMs: 2500 }]]);
    expect(slewsVan(b, null).size).toBe(0);
    expect(slewsVan({ slews: 'x' }, 'lab').size).toBe(0);
    expect(slewsVan({ slews: [{ app: 'lab', id: 'n', doel: 1.4, eindMs: 1 }] }, 'lab').get('n')).toEqual({ doel: 1, restMs: null });
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
    const v = new Verbinding({ url: 'ws://x/cockpit', WS: NepWS, verbindTijd: 0, wacht: (fn, ms) => timers.push({ fn, ms }), bijStatus: (s) => statussen.push(s.status) }).start();
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
    const v = new Verbinding({ url: 'ws://x', WS: NepWS, verbindTijd: 0, wacht: () => 0, bijBericht: (b) => binnen.push(b) }).start();
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
  it('geeft het op na 4 s in CONNECTING en probeert opnieuw', () => {
    NepWS.alle = [];
    /** @type {{ fn: () => void, ms: number }[]} */
    const timers = [];
    const statussen = [];
    const v = new Verbinding({ url: 'ws://x', WS: NepWS, wacht: (fn, ms) => timers.push({ fn, ms }), bijStatus: (s) => statussen.push(s.status) }).start();
    expect(timers.map((t) => t.ms)).toEqual([VERBIND_TIJD]);
    timers[0].fn(); // blijft hangen in CONNECTING
    expect(NepWS.alle[0].readyState).toBe(3);
    expect(statussen.at(-1)).toBe('weg');
    expect(timers.at(-1).ms).toBe(WACHTTIJDEN[0]);
    timers.at(-1).fn();
    expect(NepWS.alle).toHaveLength(2);
    NepWS.alle[1].open();
    expect(v.open).toBe(true);
    // de time-out van een socket die wél opende doet niets
    timers.find((t) => t.ms === VERBIND_TIJD && t !== timers[0])?.fn();
    expect(v.open).toBe(true);
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
    await page.locator(sel).scrollIntoViewIfNeeded();
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

  it('virtuele LPD8: pad op kanaal 10 en knop als CC 70+ op kanaal 1', async () => {
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
    expect(v.slice(2).every((b) => b.bytes[0] === 0xb0 && b.bytes[1] === 72)).toBe(true);
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

  it('klik op een app werkt ook als het beeld 20×/s binnenkomt (rijen blijven staan)', async () => {
    server.stuur(tweeApps);
    await page.waitForSelector('.app[data-app="varve-dj"]');
    const knop = page.locator('.app[data-app="varve-dj"] button');
    const tik = setInterval(() => server.stuur({ ...tweeApps, globaal: { ...tweeApps.globaal, adem: Math.random() } }), 50);
    try {
      for (let i = 0; i < 6; i++) await knop.click({ delay: 90 });
      await knop.focus();
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => document.activeElement?.closest('.app')?.getAttribute('data-app'))).toBe('varve-dj');
    } finally { clearInterval(tik); }
    await server.wachtOp(() => server.ontvangen.filter((b) => b.t === 'focus').length >= 6);
    expect(server.ontvangen.filter((b) => b.t === 'focus')).toHaveLength(6);
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

  // ── loslaten: geen hangende toetsen in de hub ──

  it('Bank vast en de verbinding valt weg: na herverbinden krijgt de hub alsnog de note-off', async () => {
    const { x, y } = await midden('[data-id="bank"]');
    await page.keyboard.down('Shift');
    await page.mouse.click(x, y);
    await page.keyboard.up('Shift');
    await server.wachtOp(() => virtueel().length >= 1);
    server.verbreekAlle();
    await page.waitForSelector('#verbinding[data-status="weg"]');
    expect(await page.locator('[data-id="bank"]').evaluate((e) => e.classList.contains('vast'))).toBe(false);
    await page.mouse.click(x, y); // tijdens de onderbreking: gaat verloren, maar laat niets hangen
    await page.waitForSelector('#verbinding[data-status="verbonden"]', { timeout: 5000 });
    await server.wachtOp(() => virtueel().some((b) => b.bytes[0] === 0x80 && b.bytes[1] === 103));
    expect(virtueel().map((b) => b.bytes)).toEqual([[0x90, 103, 127], [0x80, 103, 127]]);
  });

  it('pagina sluiten of verbergen terwijl Bank en een LPD8-pad vastzitten: note-offs gaan eerst weg', async () => {
    await page.keyboard.down('Shift');
    let bank = await midden('[data-id="bank"]');
    await page.mouse.click(bank.x, bank.y);
    const pad = await midden('#lpd8 [data-id="p2"]');
    await page.mouse.click(pad.x, pad.y);
    await page.keyboard.up('Shift');
    await server.wachtOp(() => virtueel().length >= 2);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await server.wachtOp(() => virtueel().length >= 4);
    expect(virtueel().slice(2).map((b) => b.bytes)).toEqual([[0x80, 103, 127], [0x89, 37, 0]]);
    // en echt sluiten (pagehide) met Bank vast
    await page.evaluate(() => Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }));
    bank = await midden('[data-id="bank"]');
    await page.keyboard.down('Shift');
    await page.mouse.click(bank.x, bank.y);
    await page.keyboard.up('Shift');
    await server.wachtOp(() => virtueel().length >= 5);
    await page.close({ runBeforeUnload: true });
    // Een bericht dat tijdens het sluiten wordt verstuurd komt in nieuwere Chromium niet altijd aan; dat kan
    // de pagina niet garanderen. De hub doet het daarom zelf: valt een cockpit weg, dan laat de server zijn
    // ingedrukte toetsen los (test/hub.test.js). Hier eisen we: de verbinding is dicht, en als er toch nog
    // iets binnenkwam, dan is het de juiste note-off.
    await server.wachtOp(() => server.aantalKlanten === 0);
    if (virtueel().length >= 6) expect(virtueel().at(-1)?.bytes).toEqual([0x80, 103, 127]);
    page = await browser.newPage(); // voor afterEach
  });

  it('Enter op een pad en dan focus weg (geen keyup): note-off', async () => {
    await page.locator('[data-id="pad2-3"]').focus();
    await page.keyboard.down('Enter');
    await server.wachtOp(() => virtueel().length >= 1);
    await page.locator('[data-id="pad2-4"]').focus();
    await server.wachtOp(() => virtueel().length >= 2);
    expect(virtueel().map((b) => b.bytes)).toEqual([[0x90, 10, 127], [0x80, 10, 127]]);
    await page.keyboard.up('Enter');
    await page.waitForTimeout(50);
    expect(virtueel()).toHaveLength(2);
  });

  const metTrigger = {
    t: 'beeld', focus: 'lab',
    apps: [{ app: 'lab', naam: 'Lab', kleur: '#2e5bff', status: 'actief', focus: true, waarden: { niveau: 0.25 },
      params: [{ id: 'take', naam: 'Take', soort: 'trigger' }, { id: 'niveau', naam: 'Niveau', soort: 'waarde', standaard: 0 }] }],
    globaal: {},
  };
  const zetten = () => server.ontvangen.filter((b) => b.t === 'zet').map((b) => ({ id: b.id, v: b.v }));

  it('trigger: indrukken en loslaten in hetzelfde frame sturen allebei, en Enter werkt', async () => {
    server.stuur(metTrigger);
    const knop = page.locator('.param[data-id="take"] button');
    await knop.waitFor();
    await knop.evaluate((b) => {
      b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    });
    await server.wachtOp(() => zetten().length >= 2);
    expect(zetten()).toEqual([{ id: 'take', v: 1 }, { id: 'take', v: 0 }]);
    await knop.focus();
    await page.keyboard.down('Enter');
    await server.wachtOp(() => zetten().length >= 3);
    await page.keyboard.up('Enter');
    await server.wachtOp(() => zetten().length >= 4);
    await page.keyboard.press('Space');
    await server.wachtOp(() => zetten().length >= 6);
    await page.waitForTimeout(50);
    expect(zetten().slice(2)).toEqual([{ id: 'take', v: 1 }, { id: 'take', v: 0 }, { id: 'take', v: 1 }, { id: 'take', v: 0 }]);
  });

  it('een schuifje springt niet terug op een beeld dat de nieuwe waarde nog niet kent', async () => {
    server.stuur(metTrigger);
    const s = page.locator('.param[data-id="niveau"] input');
    await s.waitFor();
    await s.fill('0.8');
    server.stuur(metTrigger); // de hub heeft nog niet bevestigd: 0.25
    await page.waitForTimeout(80);
    expect(await s.inputValue()).toBe('0.8');
    await page.waitForTimeout(450);
    server.stuur(metTrigger); // daarna geldt weer wat de hub zegt
    await expect.poll(() => s.inputValue()).toBe('0.25');
  });

  // ── slew (§12) en opname ──

  const metSlew = (/** @type {number} */ niveau, /** @type {any[]} */ slews) => ({
    ...metTrigger, nu: 10_000, slews,
    apps: [{ ...metTrigger.apps[0], waarden: { niveau } }],
  });
  const rijStaat = (/** @type {string} */ id) => page.locator(`.param[data-id="${id}"]`).evaluate((rij) => {
    const naar = /** @type {HTMLElement} */ (rij.querySelector('.naar'));
    const doel = /** @type {HTMLElement} */ (rij.querySelector('.doel'));
    const tussen = /** @type {HTMLElement} */ (rij.querySelector('.tussen'));
    const schuif = /** @type {HTMLElement} */ (rij.querySelector('.schuif')).getBoundingClientRect();
    const zichtbaar = (/** @type {HTMLElement} */ e) => getComputedStyle(e).display !== 'none';
    return {
      glijdt: rij.classList.contains('glijdt'),
      schuif: /** @type {HTMLInputElement} */ (rij.querySelector('input')).value,
      getal: /** @type {HTMLElement} */ (rij.querySelector('output')).textContent,
      naar: zichtbaar(naar) ? naar.textContent : null,
      // waar de doelstreep en het eind van de tussenbalk staan, als aandeel van de schuifbreedte
      doel: zichtbaar(doel) ? (doel.getBoundingClientRect().left + doel.getBoundingClientRect().width / 2 - schuif.left) / schuif.width : null,
      tussen: zichtbaar(tussen) ? tussen.getBoundingClientRect().width / schuif.width : null,
    };
  });

  it('slew: de schuif staat op het doel met "→ 80%", de tussenwaarde is een aparte balk', async () => {
    server.stuur(metSlew(0.3, [{ app: 'lab', id: 'niveau', doel: 0.8, eindMs: 12_500 }]));
    await page.locator('.param[data-id="niveau"] input').waitFor();
    await expect.poll(() => rijStaat('niveau').then((r) => r.glijdt)).toBe(true);
    const r = await rijStaat('niveau');
    expect(r).toMatchObject({ schuif: '0.8', getal: '30%', naar: '→ 80%' });
    expect(r.doel).toBeCloseTo(0.8, 2);
    expect(r.tussen).toBeCloseTo(0.3, 2);
    // een slew van een andere app of parameter doet hier niets
    server.stuur(metSlew(0.3, [{ app: 'ander', id: 'niveau', doel: 0.8, eindMs: 12_500 }]));
    await expect.poll(() => rijStaat('niveau')).toMatchObject({ glijdt: false, schuif: '0.3', getal: '30%', naar: null, doel: null, tussen: null });
    // klaar met glijden: geen markering meer, de schuif staat op de waarde
    server.stuur(metSlew(0.55, [{ app: 'lab', id: 'niveau', doel: 0.8, eindMs: 12_500 }]));
    await expect.poll(() => rijStaat('niveau').then((r) => r.getal)).toBe('55%');
    server.stuur(metSlew(0.8, []));
    await expect.poll(() => rijStaat('niveau')).toMatchObject({ glijdt: false, schuif: '0.8', getal: '80%', naar: null });
  });

  it('slew: een schuif die je net losliet springt niet terug naar de tussenwaarde', async () => {
    server.stuur(metSlew(0.25, []));
    const s = page.locator('.param[data-id="niveau"] input');
    await s.waitFor();
    await s.fill('0.8');
    await server.wachtOp(() => zetten().some((z) => z.id === 'niveau' && z.v === 0.8));
    await page.waitForTimeout(500);   // ruim na de korte rust van een eigen wijziging
    // de hub glijdt: de app zit pas op 0,4 en daarna op 0,6
    server.stuur(metSlew(0.4, [{ app: 'lab', id: 'niveau', doel: 0.8, eindMs: 12_000 }]));
    await expect.poll(() => rijStaat('niveau').then((r) => r.getal)).toBe('40%');
    expect(await rijStaat('niveau')).toMatchObject({ glijdt: true, schuif: '0.8', naar: '→ 80%' });
    server.stuur(metSlew(0.6, [{ app: 'lab', id: 'niveau', doel: 0.8, eindMs: 12_000 }]));
    await expect.poll(() => rijStaat('niveau').then((r) => r.tussen ?? 0)).toBeCloseTo(0.6, 2);
    expect(await s.inputValue()).toBe('0.8');
  });

  it('slew terwijl je sleept: de schuif blijft van jou, de balk toont waar de app is', async () => {
    server.stuur(metSlew(0.25, []));
    const s = page.locator('.param[data-id="niveau"] input');
    await s.waitFor();
    await s.dispatchEvent('pointerdown');
    await s.fill('0.7');
    server.stuur(metSlew(0.35, [{ app: 'lab', id: 'niveau', doel: 0.5, eindMs: 12_000 }]));   // de hub loopt achter
    await expect.poll(() => rijStaat('niveau').then((r) => r.glijdt)).toBe(true);
    expect(await rijStaat('niveau')).toMatchObject({ schuif: '0.7', getal: '70%', naar: '→ 70%' });
    expect((await rijStaat('niveau')).tussen).toBeCloseTo(0.35, 2);
    await s.dispatchEvent('pointerup');
  });

  const opnameBeeld = (/** @type {any} */ x) => ({ ...tweeApps, nu: 100_000, ...x });
  const kop = () => page.evaluate(() => {
    const rec = /** @type {HTMLElement} */ (document.getElementById('rec'));
    const m = /** @type {HTMLElement} */ (document.getElementById('opname-melding'));
    const p4 = /** @type {HTMLElement} */ (document.querySelector('#lpd8 [data-id="p4"]'));
    return {
      rec: rec.hidden || getComputedStyle(rec).display === 'none' ? null : rec.textContent?.replace(/\s+/g, ' ').trim(),
      recKleur: getComputedStyle(rec).backgroundColor,
      melding: m.hidden ? null : m.textContent,
      meldingKleur: getComputedStyle(m).color,
      fout: m.classList.contains('fout'),
      p4: p4.classList.contains('opneemt'),
      p4Rand: getComputedStyle(p4).borderTopColor,
    };
  });
  const rood = (/** @type {string} */ c) => { const [r, g, b] = (c.match(/\d+/g) ?? []).map(Number); return r > 150 && r > 2 * g && r > 2 * b; };

  it('opname: rode REC met mapnaam en looptijd in de kop, P4 van de LPD8 rood, melding blijft staan', async () => {
    server.stuur(opnameBeeld({ opname: false }));
    await page.waitForSelector('.app[data-app="formula-lab"]');
    expect(await kop()).toMatchObject({ rec: null, melding: null, p4: false });
    server.stuur(opnameBeeld({ opname: true, opnameInfo: { map: null, melding: 'opname gestart — map wordt gemaakt in /x/avonden…', fout: false, sinds: 100_000 } }));
    await expect.poll(() => kop().then((k) => k.rec)).toBe('● REC 0:00');
    server.stuur(opnameBeeld({ opname: true, opnameInfo: { map: '/x/avonden/2026-10-04_21-00-00', melding: 'opname loopt: /x/avonden/2026-10-04_21-00-00', fout: false, sinds: 25_000 } }));
    await expect.poll(() => kop().then((k) => k.rec)).toMatch(/^● REC 2026-10-04_21-00-00 1:1[56]$/);
    let k = await kop();
    expect(k).toMatchObject({ melding: 'opname loopt: /x/avonden/2026-10-04_21-00-00', fout: false, p4: true });
    expect(rood(k.recKleur)).toBe(true);
    expect(rood(k.meldingKleur)).toBe(false);
    expect(rood(k.p4Rand)).toBe(true);
    // de looptijd telt zelf door tussen de beelden
    await expect.poll(() => kop().then((k) => k.rec), { timeout: 3000 }).toMatch(/1:1[67]$/);
    // een fout: rood, en hij blijft staan bij volgende beelden zonder nieuwe melding
    const fout = 'opname: kan niet schrijven in /x/avonden — schijf vol — maak ruimte vrij';
    server.stuur(opnameBeeld({ opname: true, opnameInfo: { map: '/x/avonden/2026-10-04_21-00-00', melding: fout, fout: true, sinds: 25_000 } }));
    await expect.poll(() => kop().then((k) => k.fout)).toBe(true);
    k = await kop();
    expect(k.melding).toBe(fout);
    expect(rood(k.meldingKleur)).toBe(true);
    // gestopt: REC weg, P4 weer gewoon, de laatste melding blijft
    server.stuur(opnameBeeld({ opname: false, opnameInfo: { map: null, melding: fout, fout: true, sinds: null } }));
    await expect.poll(() => kop().then((k) => k.rec)).toBe(null);
    expect(await kop()).toMatchObject({ melding: fout, fout: true, p4: false });
    server.stuur(opnameBeeld({ opname: false, opnameInfo: { map: null, melding: 'opname klaar: /x/avonden/2026-10-04_21-00-00 (1:20, 812 regels)', fout: false, sinds: null } }));
    await expect.poll(() => kop().then((k) => k.melding)).toBe('opname klaar: /x/avonden/2026-10-04_21-00-00 (1:20, 812 regels)');
    expect((await kop()).fout).toBe(false);
  });

  // ── LEDs ──

  it('na herverbinden staat er geen oude LED-kaart', async () => {
    server.stuur({ t: 'leds', dev: 'apc40', staat: { 'pad1-3': { kleur: 45 }, 'rec2': { aan: true } } });
    const pad = page.locator('[data-id="pad1-3"]');
    await expect.poll(() => pad.evaluate((e) => e.classList.contains('aan'))).toBe(true);
    server.verbreekAlle();
    await page.waitForSelector('#verbinding[data-status="weg"]');
    await page.waitForSelector('#verbinding[data-status="verbonden"]', { timeout: 5000 });
    expect(await pad.evaluate((e) => e.classList.contains('aan'))).toBe(false);
    expect(await pad.getAttribute('data-kleur')).toBe(null);
    expect(await page.locator('[data-id="rec2"]').evaluate((e) => e.classList.contains('aan'))).toBe(false);
    await server.wachtOp(() => server.klanten.size >= 1);
  });

  it('knipper met kleur2, en een bpm-wissel start een afgelopen oneshot niet opnieuw', async () => {
    server.stuur({ t: 'leds', dev: 'apc40', staat: {
      'pad4-4': { kleur: 21, anim: { soort: 'knipper', snelheid: 2, kleur2: 5 } },
      'stop2': { knipper: true },
      'scene3': { kleur: 9, anim: { soort: 'oneshot', snelheid: 0 } },
    } });
    const pad = page.locator('[data-id="pad4-4"]');
    await expect.poll(() => pad.evaluate((e) => getComputedStyle(e).animationName)).toBe('led-knipper');
    expect(await pad.evaluate((e) => e.style.getPropertyValue('--led2'))).toBe(PALET[5]);
    expect(await pad.evaluate((e) => e.style.getPropertyValue('--led'))).toBe(PALET[21]);
    expect(await page.locator('[data-id="stop2"]').evaluate((e) => getComputedStyle(e).animationName)).toBe('led-knipper');
    const scene = page.locator('[data-id="scene3"]');
    await expect.poll(() => scene.evaluate((e) => e.getAnimations()[0]?.playState)).toBe('finished');
    server.stuur({ t: 'beeld', apps: [], globaal: { bpm: 90 } });
    await expect.poll(() => page.locator('#bpm').textContent()).toBe('90');
    expect(await scene.evaluate((e) => e.getAnimations()[0]?.playState)).toBe('finished');
    expect(await pad.evaluate((e) => e.style.getPropertyValue('--duur'))).toBe(`${(animDuur(2, 90)).toFixed(3)}s`);
  });

  it('slechte invoer: geen crash, de rest van het bericht komt aan', async () => {
    server.stuur({ t: 'leds', dev: 'apc40', staat: { 'pad1-1': null, 'pad1-2': { kleur: 5 }, 'dk3': { waarde: 'x' }, 'pad1-4': { kleur: 'rood' } } });
    await expect.poll(() => page.locator('[data-id="pad1-2"]').getAttribute('data-kleur')).toBe('5');
    expect(await page.locator('[data-id="dk3"]').evaluate((e) => e.style.getPropertyValue('--v'))).toBe('0');
    expect(await page.locator('[data-id="pad1-4"]').getAttribute('data-kleur')).toBe('0');
    server.stuur({ t: 'beeld', apps: { a: 1 }, globaal: { bpm: 77 } });
    await expect.poll(() => page.locator('#bpm').textContent()).toBe('77');
    server.stuur({ t: 'beeld', apps: 'x', globaal: 'y', apparaten: 3 });
    server.stuur({ t: 'beeld', focus: 'a', apps: [null, { app: 'a', params: [null, { id: 'p', soort: 'waarde' }], waarden: 'z' }], globaal: { bpm: 78 } });
    await expect.poll(() => page.locator('#bpm').textContent()).toBe('78');
    expect(await page.locator('.param[data-id="p"]').count()).toBe(1);
  });

  it('tempo snel ver slepen: elke stap komt aan, ook boven de 63', async () => {
    const { x, y } = await midden('[data-id="tempo"]');
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y - 8 * 80, { steps: 1 });
    await page.mouse.up();
    await server.wachtOp(() => virtueel().length >= 2);
    expect(virtueel().reduce((s, m) => s + ontleed(m.bytes).delta, 0)).toBe(80);
  });

  it('herverbindt vanzelf als de hub wegvalt', async () => {
    server.verbreekAlle();
    await page.waitForSelector('#verbinding[data-status="weg"]');
    await page.waitForSelector('#verbinding[data-status="verbonden"]', { timeout: 5000 });
    await server.wachtOp(() => server.klanten.size >= 1);
  });
});
