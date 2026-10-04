// @ts-check
// Een lopende opname (LPD8-pad 4, avondmap) als de hub stopt: netjes bij Ctrl-C/SIGTERM, leesbaar na kill -9, en
// na de herstart loopt de opname door in een nieuwe avond. Echte processen (node src/cli.js start).
import { describe, it, expect, afterEach } from 'vitest';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { leesOpname } from '../src/opname/herhaal.js';
import { herstelAvonden, laatsteVolledige } from '../src/opname/herstel.js';
import { startHubProces, ruimProcessenOp, cockpit, vrijePoort, maakMap, maakConfig, tot, wacht } from './herstart-hulp.js';

afterEach(ruimProcessenOp);

const P4_IN = [0x99, 39, 100], P4_UIT = [0x89, 39, 0];   // virtuele LPD8 (mk2-fabrieksstand): pad 4

/** Hub met avondmap en geheugen in een eigen map; de opname staat aan en er is wat gespeeld (en weggeschreven). */
async function hubDieOpneemt() {
  const map = maakMap();
  const avonden = join(map, 'avonden');
  const config = maakConfig(map, { avondmap: avonden });
  const staat = join(map, 'staat.json');
  const poort = await vrijePoort();
  const hub = await startHubProces({ poort, staat, config });
  const c = await cockpit(poort);
  c.virtueel('lpd8', P4_IN); c.virtueel('lpd8', P4_UIT);
  await tot(() => c.beeld.opname && c.beeld.opnameInfo?.map);
  for (let i = 0; i < 20; i++) c.virtueel('apc40', [0xb0, 7, i]);
  await wacht(1400);                                     // de opname schrijft per seconde weg
  return { map, avonden, config, staat, poort, hub, c, avond: /** @type {string} */ (c.beeld.opnameInfo.map) };
}

/** @param {string} pad */
const regels = (pad) => readFileSync(pad, 'utf8').split('\n').filter((r) => r.trim());

describe('opname en een herstart van de hub', () => {
  for (const sein of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    it(`${sein}: de avond wordt netjes afgesloten (eindregel, samenvatting) en het loopbestand verdwijnt`, async () => {
      const { hub, avond, staat } = await hubDieOpneemt();
      expect(existsSync(`${staat}.loopt`)).toBe(true);
      expect(JSON.parse(readFileSync(`${staat}.loopt`, 'utf8')).opname).toBe(true);
      hub.sein(sein);
      expect((await hub.einde).code).toBe(0);
      const r = regels(join(avond, 'gebaren.jsonl'));
      expect(JSON.parse(/** @type {string} */ (r.at(-1))).e).toBe('eind');
      expect(readFileSync(join(avond, 'samenvatting.md'), 'utf8')).not.toMatch(/afgebroken/);
      expect(existsSync(`${staat}.loopt`)).toBe(false);
    }, 20000);
  }

  it('kill -9: de opname blijft leesbaar tot de laatste volledige regel; na de herstart is hij hersteld en loopt de opname door', async () => {
    const { hub, avond, staat, poort, config } = await hubDieOpneemt();
    hub.sein('SIGKILL');
    await hub.einde;
    const gebaren = join(avond, 'gebaren.jsonl');
    expect(existsSync(join(avond, 'samenvatting.md'))).toBe(false);
    // Zoals een schrijfactie die precies bij de stop werd afgebroken: een halve laatste regel.
    appendFileSync(gebaren, '[1234.5,"in","apc40",[176,');
    expect(leesOpname(readFileSync(gebaren, 'utf8')).kapot).toBe(1);

    const hub2 = await startHubProces({ poort, staat, config });
    await hub2.wachtOp(/niet afgesloten \(de hub viel om\) — hersteld/);
    await hub2.wachtOp(/opname liep toen de hub omviel — loopt door/);
    const tekst = readFileSync(gebaren, 'utf8');
    expect(tekst.endsWith('\n')).toBe(true);
    const o = leesOpname(tekst);
    expect(o.kapot).toBe(0);
    expect(o.stappen.filter((s) => 'dev' in s).length).toBeGreaterThanOrEqual(20);
    expect(o.eind).toBe(null);
    expect(readFileSync(join(avond, 'samenvatting.md'), 'utf8')).toMatch(/afgebroken/);

    // De opname loopt door, in een nieuwe avond; de cockpit ziet REC.
    const c = await cockpit(poort);
    await tot(() => c.beeld.opnameInfo?.map && c.beeld.opnameInfo.map !== avond);
    expect(c.beeld.opname).toBe(true);
    const nieuw = /** @type {string} */ (c.beeld.opnameInfo.map);
    expect(nieuw).not.toBe(avond);
    // Eén druk op pad 4 stopt hem weer, zoals altijd.
    c.virtueel('lpd8', P4_IN); c.virtueel('lpd8', P4_UIT);
    await tot(() => existsSync(join(nieuw, 'samenvatting.md')) && c.beeld.opname === false);
    expect(c.beeld.opname).toBe(false);
    expect(JSON.parse(readFileSync(`${staat}.loopt`, 'utf8')).opname).toBe(false);
    hub2.sein('SIGTERM');
    expect((await hub2.einde).code).toBe(0);
    expect(readdirSync(join(avond, '..')).sort()).toHaveLength(2);
  }, 30000);
});

describe('herstel van afgebroken avonden (puur)', () => {
  it('laatsteVolledige: knipt een halve laatste regel af, telt regels en de laatste tijd', () => {
    const t = '{"v":1,"soort":"avond","begon":"2026-10-04T20:00:00.000Z"}\n{"ms":0,"e":"beginstand"}\n[12.5,"in","apc40",[176,7,1]]\n[13,"in","ap';
    const r = laatsteVolledige(t);
    expect(r).toMatchObject({ regels: 3, ms: 12.5, eind: false, weg: Buffer.byteLength('[13,"in","ap') });
    expect(t.slice(0, r.lengte).endsWith('\n')).toBe(true);
  });

  it('raakt niets aan dat deze hub zelf opneemt, wat al een samenvatting heeft, of wat geen avond is', async () => {
    const pad = (/** @type {string} */ ...x) => join('/avonden', ...x);
    /** @type {Record<string, string>} */
    const bestanden = {
      [pad('oud', 'gebaren.jsonl')]: '{"v":1,"soort":"avond","begon":"2026-10-04T20:00:00.000Z"}\n[5,"in","apc40",[176,7,1]]\n',
      [pad('af', 'gebaren.jsonl')]: '{"v":1,"soort":"avond","begon":"2026-10-04T19:00:00.000Z"}\n',
      [pad('af', 'samenvatting.md')]: '# klaar',
      [pad('nu', 'gebaren.jsonl')]: '{"v":1,"soort":"avond","begon":"2026-10-04T21:00:00.000Z"}\n',
      [pad('vreemd', 'gebaren.jsonl')]: '{"v":1,"soort":"proef"}\n',
    };
    /** @type {string[]} */
    const geschreven = [];
    const r = await herstelAvonden({
      map: '/avonden', voor: new Date('2026-10-04T20:30:00.000Z'),
      fs: {
        readdir: async () => ['oud', 'af', 'nu', 'vreemd'],
        readFile: async (p) => bestanden[p],
        bestaat: async (p) => p in bestanden,
        truncate: async () => { throw new Error('niet nodig'); },
        writeFile: async (p, t) => { geschreven.push(p); bestanden[p] = t; },
      },
    });
    expect(r).toEqual([{ map: pad('oud'), regels: 2, weg: 0, duur_ms: 5 }]);
    expect(geschreven).toEqual([pad('oud', 'samenvatting.md')]);
  });
});
