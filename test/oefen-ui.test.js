// @ts-check
// Oefenruimte in een echte Chromium tegen een echte hub: de pagina verbindt Zon en Zee, toont de les,
// wijst de juiste knoppen aan, en de lessen zijn met de virtuele controllers op de pagina te halen.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startHub } from '../src/hub.js';
import { NepSysteem } from '../src/ports/nep.js';
import { laadConfig } from '../src/config.js';

const uitvoerbaar = process.env.PW_CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
let heeftBrowser = false;
try { heeftBrowser = uitvoerbaar ? existsSync(uitvoerbaar) : existsSync(chromium.executablePath()); } catch { heeftBrowser = false; }

describe.skipIf(!heeftBrowser)('oefenruimte in de browser', () => {
  /** @type {import('playwright-core').Browser} */ let browser;
  /** @type {import('playwright-core').Page} */ let page;
  /** @type {any} */ let hub;
  /** @type {string[]} */ let fouten;

  beforeAll(async () => {
    browser = await chromium.launch({ ...(uitvoerbaar ? { executablePath: uitvoerbaar } : {}), headless: true });
  });
  afterAll(async () => { await browser?.close(); });
  beforeEach(async () => {
    hub = await startHub({ config: laadConfig(), systeem: new NepSysteem(), poort: 0, drivers: false, opname: false });
    page = await browser.newPage({ viewport: { width: 1400, height: 2400 } });   // hoog: de virtuele APC in beeld zonder scrollen
    fouten = [];
    page.on('pageerror', (e) => fouten.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') fouten.push(m.text()); });
  });
  afterEach(async () => { await page?.close(); await hub?.stop(); });

  const midden = async (/** @type {string} */ sel) => {
    const b = /** @type {{ x: number, y: number, width: number, height: number }} */ (await page.locator(sel).boundingBox());
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, b };
  };
  /** Bank vasthouden (shift-klik), Track Select n, Bank los. @param {number} n */
  async function focusMet(n) {
    const bank = await midden('[data-id="bank"]');
    await page.keyboard.down('Shift'); await page.mouse.click(bank.x, bank.y); await page.keyboard.up('Shift');
    const sel = await midden(`[data-id="sel${n}"]`);
    await page.mouse.click(sel.x, sel.y);
    await page.mouse.click(bank.x, bank.y);
  }
  const slot = (/** @type {string} */ app) => hub.kern.beeld().apps.find((/** @type {any} */ a) => a.app === app)?.slot;

  it('verbindt Zon en Zee, haalt les 1, en wijst bij les 2 Bank en Track Select aan', async () => {
    await page.goto(`${hub.adres}/oefen`);
    await expect.poll(() => hub.kern.beeld().apps.filter((/** @type {any} */ a) => a.status === 'actief').map((/** @type {any} */ a) => a.app).sort())
      .toEqual(['oefen-zee', 'oefen-zon']);
    await page.locator('#knop-volgende').waitFor({ state: 'visible' });
    expect(await page.textContent('#les-titel')).toBe('Welkom: de hub');
    expect(await page.isVisible('#virtueel .apc')).toBe(true);        // geen echte controllers → virtuele open
    await page.click('#knop-volgende');
    expect(await page.textContent('#les-titel')).toMatch(/^Focus/);
    const doel = hub.kern.beeld().focus === 'oefen-zon' ? 'oefen-zee' : 'oefen-zon';
    await expect.poll(() => page.$$eval('.wijs', (e) => e.map((x) => /** @type {HTMLElement} */ (x).dataset.id).sort())).toEqual(['bank', `sel${slot(doel)}`].sort());
    expect(fouten).toEqual([]);
  });

  it('les 2 is met de virtuele APC te halen: Bank vasthouden + Track Select, heen en terug', async () => {
    await page.goto(`${hub.adres}/oefen`);
    await page.locator('#knop-volgende').waitFor({ state: 'visible' });
    await page.click('#knop-volgende');
    const eerst = hub.kern.beeld().focus === 'oefen-zon' ? 'oefen-zee' : 'oefen-zon';
    await focusMet(slot(eerst));
    await expect.poll(() => hub.kern.beeld().focus).toBe(eerst);
    await expect.poll(() => page.textContent('#opdracht')).toMatch(/^Goed!/);
    const terug = eerst === 'oefen-zon' ? 'oefen-zee' : 'oefen-zon';
    await focusMet(slot(terug));
    await page.locator('#geleerd').waitFor({ state: 'visible' });
    expect(await page.textContent('#geleerd')).toMatch(/Bank \+ Track Select/);
    expect(await page.$$eval('#voortgang button.gehaald', (e) => e.length)).toBe(2);
    expect(fouten).toEqual([]);
  });

  it('les 3: fader 1 op de virtuele APC beweegt de Gloed van de Zon (na pickup)', async () => {
    await page.goto(`${hub.adres}/oefen`);
    await page.locator('#knop-volgende').waitFor({ state: 'visible' });
    await page.click('#voortgang li:nth-child(3) button');
    if (hub.kern.beeld().focus !== 'oefen-zon') await focusMet(slot('oefen-zon'));
    await expect.poll(() => page.textContent('#opdracht')).toMatch(/Gloed/);
    const f = await midden('[data-id="fader1"]');
    const apcY = async () => (await page.locator('#apc').boundingBox())?.y;
    const y0 = await apcY();
    for (const [van, naar] of [[f.b.y + f.b.height - 4, f.b.y + 4], [f.b.y + 4, f.b.y + f.b.height - 4]]) {
      await page.mouse.move(f.x, van); await page.mouse.down();
      await page.mouse.move(f.x, naar, { steps: 25 }); await page.mouse.up();
      await page.waitForTimeout(200);   // zoals een hand: niet binnen een paar ms opnieuw drukken
    }
    await expect.poll(() => page.textContent('#opdracht')).toMatch(/Grootte/);
    expect(await apcY()).toBe(y0);   // pickup-tekst en berichtenlijst laten de controllers niet verspringen
    expect(fouten).toEqual([]);
  });

  it('onthoudt waar je was: na herladen begin je bij dezelfde les', async () => {
    await page.goto(`${hub.adres}/oefen`);
    await page.locator('#knop-volgende').waitFor({ state: 'visible' });
    await page.click('#voortgang li:nth-child(5) button');
    expect(await page.textContent('#les-nr')).toBe('Les 5 van 14');
    await page.reload();
    await expect.poll(() => page.textContent('#les-nr')).toBe('Les 5 van 14');
    expect(await page.$$eval('#voortgang button.gehaald', (e) => e.length)).toBe(1); // les 1 (welkom)
  });

  it('het glij-teken: een zet van de hub op de Galm (slew_s 3) toont doel en resttijd, en verdwijnt als hij er is (les 14)', async () => {
    await page.goto(`${hub.adres}/oefen`);
    await page.locator('#knop-volgende').waitFor({ state: 'visible' });
    await page.click('#voortgang li:nth-child(14) button');
    expect(await page.textContent('#les-nr')).toBe('Les 14 van 14');
    expect(await page.textContent('#les-titel')).toMatch(/^Glijden/);
    const galm = '#app-oefen-zee [data-p="galm"]';
    expect(await page.isVisible(`${galm} .doel`)).toBe(false);
    expect(await page.textContent(`${galm} .naar`)).toBe('');
    const apcY = async () => (await page.locator('#apc').boundingBox())?.y;
    const y0 = await apcY();
    hub.kern.cockpit({ t: 'zet', app: 'oefen-zee', id: 'galm', v: 0.9 });   // een zet van de hub zelf, zoals een snapshot
    await page.locator(`${galm}.glijdt .doel`).waitFor({ state: 'visible' });
    expect(await page.textContent(`${galm} .naar`)).toMatch(/^→ 90% · [0-3],\d s$/);
    expect(await page.getAttribute(galm, 'data-doel')).toBe('0.9');
    // de andere parameters glijden niet
    expect(await page.$$eval('.oefen-app .p.glijdt', (e) => e.map((x) => /** @type {HTMLElement} */ (x).dataset.p))).toEqual(['galm']);
    await expect.poll(() => page.textContent('#opdracht')).toMatch(/Laat los en wacht/);
    expect(await apcY()).toBe(y0);   // het teken laat de controllers niet verspringen
    await page.locator(`${galm}.glijdt`).waitFor({ state: 'detached', timeout: 6000 });
    expect(await page.isVisible(`${galm} .doel`)).toBe(false);
    expect(await page.textContent(`${galm} .w`)).toBe('90%');
    await page.locator('#geleerd').waitFor({ state: 'visible' });
    expect(await page.textContent('#geleerd')).toMatch(/Alle lessen gehaald/);
    expect(fouten).toEqual([]);
  });

  it('toont tempo en adem onder het tafereel (les 12)', async () => {
    await page.goto(`${hub.adres}/oefen`);
    await expect.poll(() => page.textContent('#klokken')).toMatch(/^tempo 120 bpm · adem 10,0 s/);
  });

  it('twee tabs: de oude tab zegt dat Zon en Zee in een andere tab open zijn (en blijft niet herverbinden)', async () => {
    await page.goto(`${hub.adres}/oefen`);
    await page.locator('#knop-volgende').waitFor({ state: 'visible' });
    const tweede = await browser.newPage();
    await tweede.goto(`${hub.adres}/oefen`);
    await expect.poll(() => page.textContent('#let-op'), { timeout: 8000 }).toMatch(/andere tab/);
    expect(await page.textContent('#app-oefen-zon .slot')).toBe('open in een andere tab');
    await tweede.close();
  });

  it('past op een telefoon: geen horizontale scroll op 390 px', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${hub.adres}/oefen`);
    await page.locator('#les-titel').waitFor();
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  });
});
