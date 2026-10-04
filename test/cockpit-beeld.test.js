// Golf 5 · cockpit: opname-stand en slew-doel in het beeld (PROTOCOL.md §8).
//   kern.beeld().slews      = [{ app, id, doel, eindMs }] uit kern.slews, met `nu` op dezelfde kern-klok
//   kern.beeld().opnameInfo = { map, melding, fout, sinds } — src/hub.js geeft de Opnemer-meldingen door
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { opzet, meldAan, FL } from './kern-hulp.js';
import { startHub, isOpnameFout } from '../src/hub.js';
import { NepSysteem } from '../src/ports/nep.js';
import { laadConfig } from '../src/config.js';

const wacht = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @template T @param {() => T} fn @param {number} [ms] @returns {Promise<T>} */
const tot = async (fn, ms = 3000) => { const eind = Date.now() + ms; while (Date.now() < eind) { const x = fn(); if (x) return x; await wacht(10); } return fn(); };

describe('kern: slews in het beeld', () => {
  it('een cockpit-zet met slew_s staat in beeld.slews met doel en eindtijd, tot hij er is', () => {
    const { kern, klok, beelden } = opzet();
    meldAan(kern, FL);
    klok.loop(1000);
    expect(kern.beeld().slews).toEqual([]);
    expect(kern.beeld().nu).toBe(1000);
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'ruimte', v: 0.8 }); // standaard 0.4, slew_s 4
    expect(kern.beeld().slews).toEqual([{ app: 'formula-lab', id: 'ruimte', doel: 0.8, eindMs: 5000 }]);
    const voor = beelden();
    klok.loop(2000);
    const b = kern.beeld();
    expect(b.nu).toBe(3000);
    expect(b.slews).toEqual([{ app: 'formula-lab', id: 'ruimte', doel: 0.8, eindMs: 5000 }]);
    const tussen = b.apps.find((/** @type {any} */ a) => a.app === 'formula-lab').waarden.ruimte;
    expect(tussen).toBeGreaterThan(0.55);
    expect(tussen).toBeLessThan(0.65);
    expect(beelden()).toBeGreaterThan(voor); // de cockpit krijgt het glijden te zien
    // een nieuwe zet tijdens het glijden: nieuw doel, de volle slew_s vanaf nu
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'ruimte', v: 0.2 });
    expect(kern.beeld().slews).toEqual([{ app: 'formula-lab', id: 'ruimte', doel: 0.2, eindMs: 7000 }]);
    klok.loop(4100);
    expect(kern.beeld().slews).toEqual([]);
    expect(kern.beeld().apps.find((/** @type {any} */ a) => a.app === 'formula-lab').waarden.ruimte).toBe(0.2);
  });

  it('een parameter zonder slew_s springt en komt niet in beeld.slews', () => {
    const { kern } = opzet();
    meldAan(kern, FL);
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'in1', v: 0.7 });
    expect(kern.beeld().slews).toEqual([]);
  });
});

describe('kern: opnameInfo in het beeld', () => {
  it('begint leeg; zetOpnameInfo verandert alleen de meegegeven velden en meldt een nieuw beeld', () => {
    const { kern, klok, beelden } = opzet();
    expect(kern.beeld().opnameInfo).toEqual({ map: null, melding: null, fout: false, sinds: null });
    kern.zetOpnameInfo({ sinds: 1234 });
    kern.zetOpnameInfo({ map: '/a/2026-10-04_21-00-00', melding: 'opname loopt: /a/2026-10-04_21-00-00', fout: false });
    klok.loop(200);
    expect(kern.beeld().opnameInfo).toEqual({ map: '/a/2026-10-04_21-00-00', melding: 'opname loopt: /a/2026-10-04_21-00-00', fout: false, sinds: 1234 });
    const n = beelden();
    expect(n).toBeGreaterThan(0);
    kern.zetOpnameInfo({ melding: 'opname: kan niet schrijven — schijf vol', fout: true });
    klok.loop(200);
    expect(beelden()).toBe(n + 1);
    expect(kern.beeld().opnameInfo).toEqual({ map: '/a/2026-10-04_21-00-00', melding: 'opname: kan niet schrijven — schijf vol', fout: true, sinds: 1234 });
    // niets veranderd: geen nieuw beeld
    kern.zetOpnameInfo({ fout: true });
    klok.loop(200);
    expect(beelden()).toBe(n + 1);
    // rommel wordt netjes
    kern.zetOpnameInfo(/** @type {any} */ ({ map: 3, sinds: NaN, fout: 'ja', melding: null }));
    expect(kern.beeld().opnameInfo).toEqual({ map: null, melding: null, fout: false, sinds: null });
  });

  it('een kopie: wie het beeld aanpast, verandert de kern niet', () => {
    const { kern } = opzet();
    kern.zetOpnameInfo({ map: '/a' });
    const b = kern.beeld();
    b.opnameInfo.map = '/b';
    expect(kern.beeld().opnameInfo.map).toBe('/a');
  });
});

describe('hub: Opnemer-meldingen naar beeld.opnameInfo', () => {
  it('fout of niet', () => {
    expect(isOpnameFout('opname gestart — map wordt gemaakt in /x…')).toBe(false);
    expect(isOpnameFout('opname loopt: /x/2026-10-04_21-00-00')).toBe(false);
    expect(isOpnameFout('opname klaar: /x/2026 (1:00, 10 regels)')).toBe(false);
    expect(isOpnameFout('opname: schrijven lukt weer (/x/gebaren.jsonl)')).toBe(false);
    expect(isOpnameFout('opname: geen "avondmap" in config.json — er wordt niets opgenomen.')).toBe(true);
    expect(isOpnameFout('opname: achterstand te groot (schijf vol) — regels vallen weg')).toBe(true);
    expect(isOpnameFout('iets anders', new Error('EACCES'))).toBe(true);
  });

  /** @type {(() => Promise<void>)[]} */
  const lopend = [];
  afterEach(async () => { for (const f of lopend.splice(0).reverse()) await f(); });

  /** Bestanden in het geheugen; `kapot` = elke mkdir mislukt met die code. @param {string|null} [kapot] */
  function nepBestanden(kapot = null) {
    const mappen = new Set();
    return {
      mappen,
      async mkdir(/** @type {string} */ pad) {
        if (kapot) throw Object.assign(new Error(`${kapot}: ${pad}`), { code: kapot });
        if (mappen.has(pad)) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        mappen.add(pad);
      },
      async appendFile() {}, async writeFile() {}, async truncate() {},
    };
  }

  /** @param {{ avondmap?: string, bestanden: any }} o */
  async function hub({ avondmap = '/avonden', bestanden }) {
    const config = { ...laadConfig(), hotplug_ms: 20 };
    if (avondmap) config.avondmap = avondmap; else delete config.avondmap;
    const h = await startHub({
      config, systeem: new NepSysteem(), poort: 0, drivers: false,
      opname: { thuis: '/thuis', git: 'test-git', bestanden, datum: () => new Date(2026, 9, 4, 21, 0, 0), spoelMs: 50 },
    });
    lopend.push(() => h.stop());
    return h;
  }
  /** Virtuele LPD8 (mk2-fabrieksstand): pad 4 = noot 39 op kanaal 10. @param {any} h */
  const p4 = (h) => { h.opVirtueel('lpd8', [0x99, 39, 100]); h.opVirtueel('lpd8', [0x89, 39, 0]); };

  it('LPD8-pad 4: sinds, de map van de avond en "opname loopt"; na stoppen geen map en "opname klaar", de melding blijft', async () => {
    const h = await hub({ bestanden: nepBestanden() });
    const voor = h.kern.klok.nu();
    p4(h);
    expect(h.kern.beeld().opname).toBe(true);
    const map = join('/avonden', '2026-10-04_21-00-00');
    const info = await tot(() => { const i = h.kern.beeld().opnameInfo; return i.map ? i : null; });
    expect(info).toMatchObject({ map, melding: `opname loopt: ${map}`, fout: false });
    expect(info.sinds).toBeGreaterThanOrEqual(voor);
    expect(info.sinds).toBeLessThanOrEqual(h.kern.beeld().nu);
    p4(h);
    expect(h.kern.beeld().opname).toBe(false);
    const klaar = await tot(() => { const i = h.kern.beeld().opnameInfo; return /^opname klaar/.test(i.melding ?? '') ? i : null; });
    expect(klaar).toMatchObject({ map: null, fout: false, sinds: null });
    expect(klaar.melding).toContain(map);
  });

  it('map niet schrijfbaar: de fout staat in beeld.opnameInfo (fout: true), zonder map', async () => {
    const h = await hub({ bestanden: nepBestanden('EACCES') });
    p4(h);
    const info = await tot(() => { const i = h.kern.beeld().opnameInfo; return i.fout ? i : null; });
    expect(info).toMatchObject({ map: null, fout: true });
    expect(info.melding).toMatch(/^opname: kan niet schrijven in \/avonden/);
    expect(h.kern.beeld().opname).toBe(true);
  });

  it('geen avondmap in config.json: meteen een fout', async () => {
    const h = await hub({ avondmap: '', bestanden: nepBestanden() });
    p4(h);
    expect(h.kern.beeld().opnameInfo).toMatchObject({ map: null, fout: true });
    expect(h.kern.beeld().opnameInfo.melding).toMatch(/geen "avondmap"/);
    expect(typeof h.kern.beeld().opnameInfo.sinds).toBe('number');
  });
});
