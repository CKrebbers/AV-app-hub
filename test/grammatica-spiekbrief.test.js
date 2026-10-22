// @ts-check
// §19 op de spiekbrief: per app welke alfabet-plek wat is (de device-rij met het woord van elke plek, ook de lege),
// de Maschine-pads, en de pagina "Grammatica" met de rollen uit SYSTEEM §3. Ook in een echte Chromium: één A4.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { startHub } from '../src/hub.js';
import { NepSysteem } from '../src/ports/nep.js';
import { laadConfig } from '../src/config.js';
import { maakSpiekbrief, spiekbriefHtml, grammaticaHtml, GRAMMATICA_SET } from '../src/spiekbrief/index.js';
import { GRAMMATICA, ALFABET_REGELS } from '../src/protocol/grammatica.js';
import { alfabetManifest } from '../tools/nep-app.mjs';
import { meldAan } from './kern-hulp.js';

const uitvoerbaar = process.env.PW_CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
let heeftBrowser = false;
try { heeftBrowser = uitvoerbaar ? existsSync(uitvoerbaar) : existsSync(chromium.executablePath()); } catch { heeftBrowser = false; }

/** Aantal pagina's in een PDF van Chromium (zoals test/spiekbrief-pagina.test.js). @param {Buffer} pdf */
const paginas = (pdf) => (pdf.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;

/** Een set met de nep-harmonograaf (alfabet) en formula-lab (zonder alfabet), uit vastgelegde manifesten. */
function brief() {
  const config = laadConfig();
  const set = /** @type {any} */ ({ naam: 'Grammatica-proef', apps: { 'nep-alfabet': {}, 'formula-lab': {} }, focus: 'nep-alfabet' });
  const fl = { v: 1, app: 'formula-lab', naam: 'Formula Lab', params: [{ id: 'k', naam: 'Kleur', soort: 'waarde', hint: 'knop', rol: 'macro.kleur' }] };
  const bronnen = {
    'nep-alfabet': { manifest: alfabetManifest(), bron: /** @type {const} */ ('vastgelegd'), uitleg: 'test' },
    'formula-lab': { manifest: fl, bron: /** @type {const} */ ('vastgelegd'), uitleg: 'test' },
  };
  return maakSpiekbrief({ id: 'proef', set, config, bronnen });
}

describe('§19 spiekbrief: het alfabet per app', () => {
  it('de device-rij van een alfabet-app heeft het woord van elke plek, ook boven een lege', () => {
    const sb = brief();
    const a = /** @type {any} */ (sb.apps.find((x) => x.app === 'nep-alfabet'));
    expect(a.paginas[0].naam).toBe('alfabet');
    expect(a.paginas[0].dk.map((/** @type {any} */ v) => v?.naam ?? null)).toEqual(['Grootte', null, 'Snelheid', 'Fase', 'Tint', 'Lijndikte', 'Verhouding', 'Demping']);
    const html = spiekbriefHtml([sb], { css: 'inline' });
    const rij = /** @type {string} */ (/<tr class="sb-alfabet"[\s\S]*?<\/tr>/.exec(html)?.[0]);
    expect(rij).toContain('device <small>alfabet</small>');
    for (const w of ['schaal', 'dichtheid', 'beweging', 'vervorming', 'kleur', 'helderheid', 'variatie', 'ruimte']) expect(rij).toContain(`<small class="sb-plek">${w}</small>`);
    expect(rij).toMatch(/<td class="leeg alfabet" data-ctrl="dk2"><small class="sb-plek">dichtheid<\/small> <\/td>/);
    // formula-lab (zonder alfabet) houdt zijn gewone device-rij
    expect((html.match(/class="sb-alfabet"/g) ?? []).length).toBe(1);
  });

  it('Maschine-pads van de app staan op zijn kaart', () => {
    const html = spiekbriefHtml([brief()], { css: 'inline' });
    expect(html).toContain('Maschine-pads: 1 = Flits · 3 = Omkeren · 5 nieuw zaadje = Nieuw zaad · 7 = Wis spoor');
  });

  it('LPD8 K5 (kleur) noemt ook de alfabet-parameter (alfabet.kleur reageert op macro.kleur)', () => {
    const k5 = brief().lpd8.knoppen.find((k) => k.knop === 'K5');
    expect(k5?.apps.map((x) => `${x.app}:${x.param}`)).toEqual(['nep-alfabet:Tint', 'formula-lab:Kleur']);
    const k8 = brief().lpd8.knoppen.find((k) => k.knop === 'K3');
    expect(k8?.apps.map((x) => x.param)).toEqual(['Demping']);
  });
});

describe('§19 de pagina Grammatica', () => {
  it('zes delen uit SYSTEEM §3; wat de hub nog niet doet staat erbij als "komt nog"', () => {
    expect(GRAMMATICA.map((d) => d.titel)).toEqual(['Lagen', 'Toestanden', 'Het parameter-alfabet', 'Gebaren', 'Tijd', 'Navigatie']);
    expect(ALFABET_REGELS.map((r) => r.wat)).toEqual(['1 schaal', '2 dichtheid', '3 beweging', '4 vervorming', '5 kleur', '6 helderheid', '7 variatie', '8 ruimte']);
    expect(ALFABET_REGELS[4].betekent).toBe('tint, palet · ook LPD8 K5');
    const html = grammaticaHtml({ css: 'inline' });
    for (const d of GRAMMATICA) expect(html).toContain(`data-deel="${d.id}"`);
    expect(html).toContain('KP3+ XY');
    expect(html).toMatch(/<tr class="sb-komt"><th scope="row">Crossfader<\/th>/);
    expect(html).not.toContain('class="sb-deel sb-per-app"'); // zonder apps geen tabel per app
  });

  /** @type {any} */ let hub;
  beforeAll(async () => { hub = await startHub({ config: laadConfig(), systeem: new NepSysteem(), poort: 0, drivers: false, opname: false }); });
  afterAll(async () => { await hub?.stop(); });

  it('GET /spiekbrief?set=grammatica, met per app die de hub kent welke plek wat is; de lijst linkt ernaar', async () => {
    meldAan(hub.kern, alfabetManifest());
    const r = await fetch(`${hub.adres}/spiekbrief?set=${GRAMMATICA_SET}`);
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('Het parameter-alfabet');
    expect(html).toMatch(/<tr data-app="nep-alfabet"[^>]*><th scope="row">Nep-harmonograaf<\/th><td class="vol">Grootte<\/td><td class="leeg"><\/td><td class="vol">Snelheid/);
    const lijst = await (await fetch(`${hub.adres}/spiekbrief`)).text();
    expect(lijst).toContain('href="/spiekbrief?set=grammatica"');
  });

  it.skipIf(!heeftBrowser)('in Chromium: de grammatica en een set met een alfabet-app halen elk één A4, zonder fouten', async () => {
    const browser = await chromium.launch({ ...(uitvoerbaar ? { executablePath: uitvoerbaar } : {}), headless: true });
    try {
      for (const html of [grammaticaHtml({ css: 'inline', opHub: false, apps: brief().apps }), spiekbriefHtml([brief()], { css: 'inline', opHub: false })]) {
        const page = await browser.newPage({ viewport: { width: 1123, height: 794 } });
        /** @type {string[]} */ const fouten = [];
        page.on('pageerror', (e) => fouten.push(e.message));
        await page.setContent(html);
        const maat = await page.evaluate(() => ({ breed: document.documentElement.scrollWidth, zicht: document.documentElement.clientWidth }));
        expect(maat.breed).toBeLessThanOrEqual(maat.zicht);
        await page.emulateMedia({ media: 'print' });
        expect(paginas(await page.pdf({ preferCSSPageSize: true }))).toBe(1);
        expect(fouten).toEqual([]);
        await page.close();
      }
    } finally { await browser.close(); }
  }, 30000);
});
