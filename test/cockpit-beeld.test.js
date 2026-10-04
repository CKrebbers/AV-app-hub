// Golf 5 · cockpit: opname-stand en slew-doel in het beeld (PROTOCOL.md §8).
//   kern.beeld().slews      = [{ app, id, doel, eindMs }] uit kern.slews, met `nu` op dezelfde kern-klok
//   kern.beeld().opnameInfo = { map, melding, fout, sinds } — src/hub.js geeft de Opnemer-meldingen door
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { opzet, meldAan, FL } from './kern-hulp.js';
import { startHub, isOpnameFout, opnameMeldingen } from '../src/hub.js';
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

  it('een fout van deze avond blijft staan tot een nieuwe avond begint', () => {
    /** @type {any} */ let info = {};
    const m = opnameMeldingen((x) => { info = { ...info, ...x }; });
    m.melding('opname gestart — map wordt gemaakt in /x…');
    m.melding('opname loopt: /x/a');
    expect(info).toEqual({ melding: 'opname loopt: /x/a', fout: false });
    m.melding('opname: samenvatting niet geschreven in /x/a — ENOSPC', new Error('ENOSPC'));
    m.melding('opname klaar: /x/a (1:00, 10 regels)');
    expect(info).toEqual({ melding: 'opname klaar: /x/a (1:00, 10 regels) — maar: samenvatting niet geschreven in /x/a — ENOSPC', fout: true });
    // schrijven lukte weer, maar er gingen regels verloren: toch rood
    m.melding('opname gestart — map wordt gemaakt in /x…');
    m.melding('opname: kan niet schrijven in /x — ENOSPC', new Error('ENOSPC'));
    m.melding('opname: schrijven lukt weer (/x/b/gebaren.jsonl)');
    expect(info.fout).toBe(false);
    m.melding('opname klaar: /x/b (1:00, 10 regels, 3 verloren)');
    expect(info.fout).toBe(false);
    m.klaar({ verloren: 3 });
    expect(info).toEqual({ melding: 'opname klaar: /x/b (1:00, 10 regels, 3 verloren)', fout: true });
    // een nieuwe avond: weer schoon
    m.melding('opname gestart — map wordt gemaakt in /x…');
    m.melding('opname klaar: /x/c (0:10, 2 regels)');
    m.klaar({ verloren: 0 });
    expect(info).toEqual({ melding: 'opname klaar: /x/c (0:10, 2 regels)', fout: false });
  });

  /** @type {(() => Promise<void>)[]} */
  const lopend = [];
  afterEach(async () => { for (const f of lopend.splice(0).reverse()) await f(); });

  /**
   * Bestanden in het geheugen; `kapot` = elke mkdir mislukt met die code; `vol` = appendFile en/of writeFile
   * mislukken met ENOSPC (schijf vol).
   * @param {string|null} [kapot] @param {{ append?: boolean, write?: boolean }} [vol]
   */
  function nepBestanden(kapot = null, vol = {}) {
    const mappen = new Set();
    const enospc = (/** @type {string} */ pad) => Object.assign(new Error(`ENOSPC: no space left on device, write '${pad}'`), { code: 'ENOSPC' });
    return {
      mappen,
      async mkdir(/** @type {string} */ pad, /** @type {{ recursive?: boolean }} */ o = {}) {
        if (kapot) throw Object.assign(new Error(`${kapot}: ${pad}`), { code: kapot });
        if (mappen.has(pad) && !o.recursive) throw Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
        mappen.add(pad);
      },
      async appendFile(/** @type {string} */ pad) { if (vol.append) throw enospc(pad); },
      async writeFile(/** @type {string} */ pad) { if (vol.write) throw enospc(pad); },
      async truncate() {},
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

  it('geen avondmap in config.json: meteen een fout, en geen sinds (er loopt niets, dus ook geen looptijd)', async () => {
    const h = await hub({ avondmap: '', bestanden: nepBestanden() });
    p4(h);
    expect(h.kern.beeld().opname).toBe(true);   // de pad-4-toggle staat aan…
    expect(h.kern.beeld().opnameInfo).toMatchObject({ map: null, fout: true, sinds: null });   // …maar er wordt niets opgenomen
    expect(h.kern.beeld().opnameInfo.melding).toMatch(/geen "avondmap"/);
  });

  /** Opname aan, wachten tot hij loopt, en weer uit; geeft de opnameInfo als de avond is afgesloten. @param {any} h */
  async function neemOp(h) {
    p4(h);
    await tot(() => h.kern.beeld().opnameInfo.map);
    await wacht(120);   // een paar spoelingen (spoelMs 50)
    p4(h);
    await h.opnemer.afgesloten;
    return h.kern.beeld().opnameInfo;
  }

  it('samenvatting niet geschreven (schijf vol): de fout verdwijnt niet achter "opname klaar"', async () => {
    const h = await hub({ bestanden: nepBestanden(null, { write: true }) });
    const info = await neemOp(h);
    expect(info.fout).toBe(true);
    expect(info.melding).toMatch(/^opname klaar: /);
    expect(info.melding).toMatch(/samenvatting niet geschreven/);
  });

  it('schijf vol tijdens de opname: na stoppen blijft het rood (regels verloren)', async () => {
    const h = await hub({ bestanden: nepBestanden(null, { append: true }) });
    const info = await neemOp(h);
    expect(info.melding).toMatch(/^opname klaar: /);
    expect(info.fout).toBe(true);
    expect(info.melding).toMatch(/ENOSPC|verloren/);
  });

  it('een nieuwe opname begint weer zonder fout', async () => {
    const b = nepBestanden(null, { write: true });
    const h = await hub({ bestanden: b });
    expect((await neemOp(h)).fout).toBe(true);
    // .. ruimte vrijgemaakt, nieuwe avond
    b.writeFile = async () => {};
    const info = await neemOp(h);
    expect(info).toMatchObject({ fout: false });
    expect(info.melding).toMatch(/^opname klaar: .*-2 /);
  });
});
