// @ts-check
// De spiekbrief op de hub (GET /spiekbrief) en in een echte Chromium: rendert zonder fouten, past op A4 liggend
// (1123×794 px bij 96 dpi) zonder horizontaal scrollen, en de print-PDF is precies één pagina per set.
// Hermetisch: een hub met NepSysteem, zonder drivers, met alleen de bestanden uit dit repo.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startHub } from '../src/hub.js';
import { NepSysteem } from '../src/ports/nep.js';
import { laadConfig } from '../src/config.js';
import { lijstSets } from '../src/sets/index.js';
import { meldAan } from './kern-hulp.js';
import { maakSpiekbrief, laadBronnen, hubConfig, spiekbriefHtml } from '../src/spiekbrief/index.js';
import { laadSet } from '../src/sets/index.js';

const uitvoerbaar = process.env.PW_CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
let heeftBrowser = false;
try { heeftBrowser = uitvoerbaar ? existsSync(uitvoerbaar) : existsSync(chromium.executablePath()); } catch { heeftBrowser = false; }

const SETS = lijstSets();
/** A4 liggend bij 96 dpi. */
const A4 = { width: 1123, height: 794 };
/** Het bedrukbare deel daarvan (@page margin 7 mm). */
const PAPIER = { width: 1070, height: 741 };

/** Aantal pagina's in een PDF van Chromium (elk /Type /Page-object, niet /Pages). @param {Buffer} pdf */
export const paginas = (pdf) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;

/** @type {any} */ let hub;
beforeAll(async () => { hub = await startHub({ config: laadConfig(), systeem: new NepSysteem(), poort: 0, drivers: false, opname: false }); });
afterAll(async () => { await hub?.stop(); });

/**
 * Woorden in de vakken van de APC die over twee regels breken terwijl dat niet hoeft: een woord van hooguit
 * 8 tekens (dat past altijd), of een woord dat ongebroken in de breedte van zijn vak past.
 * @param {import('playwright-core').Page} page
 */
const gesplitsteWoorden = (page) => page.evaluate(() => {
  /** @type {string[]} */
  const uit = [];
  for (const td of document.querySelectorAll('.sb-apc td')) {
    const cs = getComputedStyle(td);
    const ruimte = td.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const w = document.createTreeWalker(td, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      for (const m of (n.textContent ?? '').matchAll(/\S+/g)) {
        const r = document.createRange();
        r.setStart(n, m.index); r.setEnd(n, m.index + m[0].length);
        const regels = new Set([...r.getClientRects()].filter((x) => x.width > 0).map((x) => Math.round(x.top)));
        if (regels.size < 2) continue;
        const sp = document.createElement('span');
        sp.style.whiteSpace = 'nowrap'; sp.textContent = m[0];
        /** @type {Element} */ (n.parentElement).append(sp);
        const breed = sp.getBoundingClientRect().width;
        sp.remove();
        if (m[0].length <= 8 || breed <= ruimte) uit.push(`${/** @type {HTMLElement} */ (td).dataset.ctrl}: ${m[0]} (${breed.toFixed(0)} px in ${ruimte.toFixed(0)} px)`);
      }
    }
  }
  return uit;
});

/** @param {string} pad @param {RequestInit} [o] */
const haal = (pad, o) => fetch(`${hub.adres}${pad}`, o);

describe('GET /spiekbrief', () => {
  it('de lijst van sets, met dezelfde beveiligingskoppen als de andere pagina\'s', async () => {
    const r = await haal('/spiekbrief');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(r.headers.get('x-frame-options')).toBe('DENY');
    expect(r.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
    expect(r.headers.get('referrer-policy')).toBe('no-referrer');
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    const html = await r.text();
    for (const s of SETS) expect(html).toContain(`href="/spiekbrief?set=${s}"`);
    expect(html).not.toMatch(/<script/i);
  });

  it('?set=<naam> geeft de spiekbrief; een onbekende naam of een pad geeft 404 met de sets die er wel zijn', async () => {
    const r = await haal('/spiekbrief?set=meditatie');
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('data-set="meditatie"');
    expect(html).toContain('href="/ui/spiekbrief.css"');
    for (const naam of ['bestaat-niet-xyz', '../config', '/etc/passwd', 'paden', `${SETS[0]}.json`]) {
      const f = await haal(`/spiekbrief?set=${encodeURIComponent(naam)}`);
      expect(f.status, naam).toBe(404);
      expect(await f.text()).toContain(`beschikbaar: ${SETS.join(', ')}`);
    }
    expect((await haal('/spiekbrief?set=alle').then((x) => x.text())).match(/class="sb-blad"/g)?.length).toBe(SETS.length);
    const kop = await haal('/spiekbrief?set=dj', { method: 'HEAD' });
    expect(kop.status).toBe(200);
    expect(await kop.text()).toBe('');
  });

  it('de stylesheet wordt geserveerd', async () => {
    const r = await haal('/ui/spiekbrief.css');
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/@page \{ size: A4 landscape/);
  });

  it('de spiekbrief rekent met dezelfde config als de kern van de hub (kaarten uit maps/ en config.json)', async () => {
    // hubConfig (src/spiekbrief/bronnen.js) doet voor de CLI wat src/hub.js voor de kern doet; zo wijken ze niet af.
    const config = { ...laadConfig(), kaarten: { 'formula-lab': { fader5: { id: 'a' } } } };
    const h = await startHub({ config, systeem: new NepSysteem(), poort: 0, drivers: false, opname: false });
    try {
      expect(hubConfig(config)).toEqual(h.kern.config);
      expect(hubConfig(laadConfig()).kaarten).toEqual(hub.kern.config.kaarten);
    } finally {
      await h.stop();
    }
  });

  it('live: wat de hub nu van een app weet, met het echte Track Select-nummer', async () => {
    const live = await startHub({ config: laadConfig(), systeem: new NepSysteem(), poort: 0, drivers: false, opname: false });
    try {
      meldAan(live.kern, { v: 1, app: 'medisynth', naam: 'MediSynth', params: [] });
      meldAan(live.kern, { v: 1, app: 'formula-lab', naam: 'Formula Lab', params: [{ id: 'live1', naam: 'Live één', soort: 'waarde', hint: 'fader' }] });
      const html = await (await fetch(`${live.adres}/spiekbrief?set=dj`)).text();
      expect(html).toMatch(/zoals de hub nu draait \(1 van de 2 apps bij de hub\)/);
      expect(html).toContain('data-ctrl="fader1" data-param="live1"');
      expect(html).toContain('Track Select <b>2</b>');
      expect(html).toMatch(/Ook bij de hub: .*MediSynth \(Track Select 1\)/);
    } finally {
      await live.stop();
    }
  });
});

describe.skipIf(!heeftBrowser)('spiekbrief in de browser', () => {
  /** @type {import('playwright-core').Browser} */ let browser;
  beforeAll(async () => { browser = await chromium.launch({ ...(uitvoerbaar ? { executablePath: uitvoerbaar } : {}), headless: true }); });
  afterAll(async () => { await browser?.close(); });

  /** @param {string} pad */
  async function open(pad) {
    const page = await browser.newPage({ viewport: A4 });
    /** @type {string[]} */
    const fouten = [];
    page.on('pageerror', (e) => fouten.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') fouten.push(m.text()); });
    page.on('requestfailed', (r) => fouten.push(`${r.url()} ${r.failure()?.errorText}`));
    const r = await page.goto(`${hub.adres}${pad}`);
    expect(r?.status()).toBe(200);
    await page.waitForLoadState('networkidle');
    return { page, fouten };
  }

  it('de lijst rendert zonder fouten', async () => {
    const { page, fouten } = await open('/spiekbrief');
    expect(await page.locator('.sb-sets li').count()).toBe(SETS.length);
    expect(fouten).toEqual([]);
    await page.close();
  });

  it.each(SETS)('set %s: rendert zonder fouten, past op 1123×794 zonder horizontaal scrollen, print op precies één A4', async (naam) => {
    const { page, fouten } = await open(`/spiekbrief?set=${naam}`);
    expect(await page.locator('.sb-app').count()).toBeGreaterThan(0);
    // de stijlen van de cockpit en de spiekbrief zijn geladen
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.sb-apps') ?? document.body).display)).toBe('grid');
    const maat = await page.evaluate(() => ({ breed: document.documentElement.scrollWidth, zicht: document.documentElement.clientWidth }));
    expect(maat.breed).toBeLessThanOrEqual(maat.zicht);
    // en die meting werkt: iets te breeds in het blad geeft wél horizontaal scrollen (niets wordt weggeknipt)
    const teBreed = await page.evaluate(() => {
      const d = document.createElement('div'); d.style.width = '2000px'; d.style.height = '1px';
      /** @type {Element} */ (document.querySelector('.sb-blad')).append(d);
      const r = document.documentElement.scrollWidth > document.documentElement.clientWidth;
      d.remove();
      return r;
    });
    expect(teBreed, 'een blad van 2000 px moet horizontaal scrollen').toBe(true);
    // geen kaart of tabel steekt buiten het venster
    const rechts = await page.evaluate(() => Math.max(...[...document.querySelectorAll('.sb-app, .sb-apc, .sb-altijd section')].map((e) => e.getBoundingClientRect().right)));
    expect(rechts).toBeLessThanOrEqual(A4.width);
    // op papier: zwart op wit, de appkleur als randje
    await page.emulateMedia({ media: 'print' });
    const papier = await page.evaluate(() => {
      const kaart = /** @type {HTMLElement} */ (document.querySelector('.sb-app'));
      return { achter: getComputedStyle(document.body).backgroundColor, tekst: getComputedStyle(document.body).color, rand: getComputedStyle(kaart).borderLeftWidth, kop: getComputedStyle(/** @type {Element} */ (document.querySelector('.kop'))).display };
    });
    expect(papier).toMatchObject({ achter: 'rgb(255, 255, 255)', tekst: 'rgb(0, 0, 0)', kop: 'none' });
    expect(parseFloat(papier.rand)).toBeGreaterThan(4);
    // op papier breekt een naam niet midden in een woord: een woord tot 8 tekens past altijd in zijn vak, een
    // langer woord breekt alleen als het echt niet past. Gemeten op de breedte van het papier (A4 liggend min 2× 7 mm).
    await page.setViewportSize(PAPIER);
    expect(await gesplitsteWoorden(page)).toEqual([]);
    const pdf = await page.pdf({ preferCSSPageSize: true });
    expect(paginas(pdf), `${naam}: pagina's in de PDF`).toBe(1);
    expect(fouten).toEqual([]);
    await page.close();
  });

  it('alle sets onder elkaar: één pagina per set', async () => {
    const { page, fouten } = await open('/spiekbrief?set=alle');
    await page.emulateMedia({ media: 'print' });
    expect(paginas(await page.pdf({ preferCSSPageSize: true }))).toBe(SETS.length);
    expect(fouten).toEqual([]);
    await page.close();
  });

  /** Alle apps uit de sets plus Sediment (minstens acht). */
  function allesSet() {
    const config = hubConfig(laadConfig());
    /** @type {Record<string, any>} */
    const apps = {};
    for (const s of SETS) Object.assign(apps, laadSet(s, { config }).apps);
    apps.sediment = { start: null };
    expect(Object.keys(apps).length).toBeGreaterThanOrEqual(8);
    return { config, set: /** @type {any} */ ({ naam: 'Alles', apps, focus: 'waterschaal' }) };
  }
  /** Een manifest met langere namen (tot `n` tekens) en desnoods twee keer zoveel parameters. @param {any} b @param {number} n @param {boolean} [dubbel] */
  function langeNamen(b, n, dubbel = false) {
    const c = structuredClone(b);
    if (!Array.isArray(c.manifest.params)) return c;
    const ps = dubbel ? [...c.manifest.params, ...c.manifest.params.map((/** @type {any} */ p) => ({ ...p, id: `${p.id}2` }))] : c.manifest.params;
    c.manifest.params = ps.map((/** @type {any} */ p) => ({ ...p, naam: `${p.naam} met een lange naam erbij en nog veel meer`.slice(0, n) }));
    return c;
  }
  /** @param {any} sb */
  async function eenA4(sb) {
    const page = await browser.newPage({ viewport: A4 });
    await page.setContent(spiekbriefHtml([sb], { css: 'inline' }));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.emulateMedia({ media: 'print' });
    const n = paginas(await page.pdf({ preferCSSPageSize: true }));
    await page.close();
    return n;
  }

  it('een set met acht apps (alle apps uit de sets plus Sediment) past ook op één A4', async () => {
    const { config, set } = allesSet();
    const sb = maakSpiekbrief({ id: 'alles', set, config, bronnen: laadBronnen().bronnen });
    expect(await eenA4(sb)).toBe(1);
  });

  it.each([14, 20, 30, 45])('lange namen (tot %i tekens, twee keer zoveel knoppen bij Formula Lab): de DJ-set blijft één A4', async (n) => {
    const config = hubConfig(laadConfig());
    const { bronnen } = laadBronnen();
    const sb = maakSpiekbrief({ id: 'dj', set: laadSet('dj', { config }), config, bronnen: { ...bronnen, 'formula-lab': langeNamen(bronnen['formula-lab'], n, true) } });
    expect(await eenA4(sb)).toBe(1);
  });

  it('acht apps, allemaal met lange namen: één A4', async () => {
    const { config, set } = allesSet();
    const bronnen = Object.fromEntries(Object.entries(laadBronnen().bronnen).map(([k, b]) => [k, langeNamen(b, 26)]));
    expect(await eenA4(maakSpiekbrief({ id: 'alles', set, config, bronnen }))).toBe(1);
  });
});
