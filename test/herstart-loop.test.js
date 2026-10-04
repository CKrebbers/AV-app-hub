// @ts-check
// Het loopbestand (<geheugen>.loopt, src/opslag.js) mag alleen zeggen "de vorige hub viel om" als dat ook zo is, en
// alleen processen aanwijzen die echt van toen zijn. Met echte processen: een oud loopbestand met een hergebruikt
// procesnummer, twee hubs op hetzelfde geheugen, een tweede hub naast een die opneemt, en een nette stop gevolgd
// door een nieuwe avond (slots en focus beginnen dan leeg). Plus de randgevallen van openLoopbestand zelf.
import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NepApp, voorbeeldManifest } from '../tools/nep-app.mjs';
import { openLoopbestand, etimeMs, SPELING_MS, opstartMoment } from '../src/opslag.js';
import { bestaandProces, naarLogbestand, vorigLog, startSet } from '../src/sets/starter.js';
import { kernToegang } from '../src/sets/toegang.js';
import { NepKlok } from '../src/core/klok.js';
import { opzet } from './kern-hulp.js';
import { startProces } from '../src/sets/systeem.js';
import { echteKlok } from '../src/core/klok.js';
import { startCli, startHubProces, ruimProcessenOp, cockpit, vrijePoort, maakMap, maakConfig, nepSet, groepLeeft, tot, wacht, HUB_MAP } from './herstart-hulp.js';

/** @type {number[]} procesgroepen die deze tests startten */
const groepen = [];
/** @type {(() => unknown)[]} */
const opruimen = [];
afterEach(async () => {
  for (const f of opruimen.splice(0).reverse()) await f();
  for (const g of groepen.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch { /* al weg */ } }
  await ruimProcessenOp();
});

/** Een vreemd proces in een eigen procesgroep (zoals een shell of een macOS-agent die zijn groep leidt). */
function vreemdProces() {
  const p = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  const pid = /** @type {number} */ (p.pid);
  groepen.push(pid);
  return pid;
}

/** Een pid dat zeker niet (meer) leeft. */
async function dodePid() {
  const p = spawn('true', [], { stdio: 'ignore' });
  await new Promise((r) => p.on('exit', r));
  return /** @type {number} */ (p.pid);
}

describe('loopbestand met procesnummers die niet meer van toen zijn (echte processen)', () => {
  for (const geval of /** @type {const} */ (['van vóór de laatste opstart', 'hergebruikt nummer, zelfde opstart'])) {
    it(`${geval}: de app start gewoon, en het vreemde proces blijft ongemoeid (ook bij Ctrl-C)`, async () => {
      const map = maakMap();
      const poort = await vrijePoort();
      const s = nepSet(map, poort);
      const vreemd = vreemdProces();
      await wacht(100);
      const oud = geval === 'van vóór de laatste opstart';
      // 'Zelfde opstart' moet ná de opstart van deze computer liggen: een verse CI-runner draait soms pas een paar
      // minuten. Halverwege de uptime (hooguit 10 min terug), ruim voorbij SPELING_MS vóór het vreemde proces.
      const terug = Math.min(10 * 60_000, (Date.now() - opstartMoment()) / 2);
      expect(terug, 'de computer draait te kort voor deze proef').toBeGreaterThan(3 * SPELING_MS);
      const toen = oud ? '2025-10-01T20:00:00.000Z' : new Date(Date.now() - terug).toISOString();
      // Bij 'oud' is zelfs het nummer van de hub van toen nu van het vreemde proces: geen "er draait nog een hub".
      writeFileSync(`${s.staat}.loopt`, JSON.stringify({
        v: 1, pid: oud ? vreemd : await dodePid(), begon: toen, set: 'Herstartproef',
        apps: { 'nep-a': vreemd }, sinds: { 'nep-a': toen }, opname: false, slots: ['nep-a'], focus: 'nep-a',
      }));
      const hub = await startCli({ args: s.args, staat: s.staat, config: s.config, env: s.env, klaar: s.klaar, ms: 25000 });
      const nepA = JSON.parse(readFileSync(`${s.staat}.loopt`, 'utf8')).apps['nep-a'];
      if (nepA !== vreemd) groepen.push(nepA);             // opruimen, ook als een verwachting hieronder faalt
      const uit = hub.uitvoer();
      expect(uit).not.toMatch(/er draait nog een hub/);
      expect(uit).not.toMatch(/draait nog sinds vóór de herstart/);
      expect(uit).toMatch(/nep-a: start "/);
      expect(uit).toMatch(oud ? /vóór de laatste herstart van de computer — dit is een gewone start/ : new RegExp(`nep-a: proces ${vreemd} is niet meer dat van toen`));
      hub.sein('SIGINT');
      expect((await hub.einde).code).toBe(0);
      expect(groepLeeft(vreemd)).toBe(true);
    }, 40000);
  }
});

describe('twee hubs, of een nette stop (echte processen)', () => {
  it('een tweede hub op hetzelfde geheugen laat het loopbestand van de eerste staan; valt de eerste daarna om, dan ziet de volgende start dat', async () => {
    const map = maakMap();
    const staat = join(map, 'staat.json');
    const [p1, p2] = [await vrijePoort(), await vrijePoort()];
    const hub1 = await startHubProces({ poort: p1, staat });
    const voor = readFileSync(`${staat}.loopt`, 'utf8');
    const hub2 = await startHubProces({ poort: p2, staat });
    await hub2.wachtOp(new RegExp(`er draait nog een hub met hetzelfde geheugen \\(proces ${hub1.pid}\\)`));
    expect(readFileSync(`${staat}.loopt`, 'utf8')).toBe(voor);
    await wacht(300);                                     // Ctrl-C pas als de hub zijn stop-afhandeling heeft (vlak na die regel)
    hub2.sein('SIGINT');
    expect((await hub2.einde).code).toBe(0);
    expect(readFileSync(`${staat}.loopt`, 'utf8')).toBe(voor);     // niet gewist
    hub1.sein('SIGKILL');
    await hub1.einde;
    const hub3 = await startHubProces({ poort: p1, staat });
    await hub3.wachtOp(/De vorige hub stopte niet netjes/);
  }, 40000);

  it('een tweede hub (andere poort, eigen geheugen, zelfde avondmap) laat de lopende avond van de eerste ongemoeid', async () => {
    const map = maakMap();
    const avonden = join(map, 'avonden');
    const config = maakConfig(map, { avondmap: avonden });
    const p1 = await vrijePoort();
    const hub1 = await startHubProces({ poort: p1, staat: join(map, 'staat1.json'), config });
    const c = await cockpit(p1);
    c.virtueel('lpd8', [0x99, 39, 100]); c.virtueel('lpd8', [0x89, 39, 0]);   // pad 4: opnemen
    await tot(() => c.beeld.opnameInfo?.map);
    const avond = /** @type {string} */ (c.beeld.opnameInfo.map);
    await wacht(1300);
    const hub2 = await startHubProces({ poort: await vrijePoort(), staat: join(map, 'staat2.json'), config });
    await wacht(500);
    expect(hub2.uitvoer()).not.toMatch(/niet afgesloten/);
    expect(existsSync(join(avond, 'samenvatting.md'))).toBe(false);
    c.sluit();
    hub1.sein('SIGINT');
    expect((await hub1.einde).code).toBe(0);
    expect(readFileSync(join(avond, 'samenvatting.md'), 'utf8')).not.toMatch(/afgebroken/);
  }, 40000);

  it('na een nette stop begint een nieuwe avond leeg: een andere app krijgt slot 1, en de oude focus-app pakt de focus niet af', async () => {
    const map = maakMap();
    const staat = join(map, 'staat.json');
    const poort = await vrijePoort();
    const app = (/** @type {string} */ id) => {
      const a = new NepApp({ url: `ws://127.0.0.1:${poort}/app`, manifest: voorbeeldManifest(id), inst: `${id}-1`, herverbind: false }).start();
      opruimen.push(() => a.stop());
      return a;
    };
    const actief = (/** @type {any} */ c, /** @type {string} */ id) => c.beeld.apps.find((/** @type {any} */ x) => x.app === id && x.status === 'actief');
    // Avond 1: A en B, Clay zet de focus op B; netjes gestopt.
    let hub = await startHubProces({ poort, staat });
    let c = await cockpit(poort);
    const a = app('app-a'); await tot(() => actief(c, 'app-a'));
    const b = app('app-b'); await tot(() => actief(c, 'app-b'));
    c.stuur({ t: 'focus', app: 'app-b' });
    await tot(() => c.beeld.focus === 'app-b');
    await wacht(1300);
    c.sluit(); a.stop(); b.stop();
    hub.sein('SIGINT');
    expect((await hub.einde).code).toBe(0);
    // Avond 2: C speelt (slot 1, focus); later komt B binnen.
    hub = await startHubProces({ poort, staat });
    c = await cockpit(poort);
    app('app-c'); await tot(() => actief(c, 'app-c'));
    expect(actief(c, 'app-c').slot).toBe(1);
    expect(c.beeld.focus).toBe('app-c');
    app('app-b'); await tot(() => actief(c, 'app-b'));
    await wacht(200);
    expect(c.beeld.focus).toBe('app-c');
    expect(actief(c, 'app-b').slot).toBe(2);
  }, 40000);
});

describe('openLoopbestand (randgevallen)', () => {
  const NU = Date.parse('2026-10-04T21:00:00.000Z');
  /** @param {object} inhoud @param {Partial<Parameters<typeof openLoopbestand>[0]>} [o] */
  const open = (inhoud, o = {}) => {
    const pad = join(maakMap(), 'staat.json.loopt');
    writeFileSync(pad, JSON.stringify(inhoud));
    const loop = openLoopbestand({ pad, set: 'avond', pid: 99999, datum: () => new Date(NU), opstart: () => NU - 3600_000, leeft: () => true, sindsVan: () => null, ...o });
    return { pad, loop, opnieuw: () => JSON.parse(readFileSync(pad, 'utf8')) };
  };
  const BEGON = new Date(NU - 600_000).toISOString();

  it('van vóór de opstart: verlopen — geen herstart, geen andere hub, maar wel "omgevallen" (voor het herstel van de avond)', () => {
    const { loop } = open({ v: 1, pid: 123, begon: new Date(NU - 7200_000).toISOString(), set: 'avond', apps: { x: 456 } });
    expect(loop).toMatchObject({ vorige: null, ander: null, verlopen: true, omgevallen: { begon: new Date(NU - 7200_000).toISOString() } });
  });

  it('het nummer van de hub van toen leeft, maar dat proces begon pas later: geen andere hub, een herstart', () => {
    const { loop } = open({ v: 1, pid: 123, begon: BEGON, set: 'avond', apps: {} }, { sindsVan: () => NU - 60_000 });
    expect(loop.ander).toBe(null);
    expect(loop.vorige).toMatchObject({ pid: 123, set: 'avond' });
  });

  it('de hub van toen draait echt nog: ander — het loopbestand blijft van hem (niet overschreven, niet gewist)', () => {
    const { loop, pad, opnieuw } = open({ v: 1, pid: 123, begon: BEGON, set: 'avond', apps: {} }, { sindsVan: () => Date.parse(BEGON) - 2000 });
    expect(loop).toMatchObject({ ander: 123, vorige: null, omgevallen: null });
    loop.app('x', 777); loop.opname(true); loop.slotsEnFocus({ slots: ['x'], focus: 'x' });
    expect(opnieuw().pid).toBe(123);
    loop.wis();
    expect(existsSync(pad)).toBe(true);
  });

  it('per app: alleen een proces dat begon toen de vorige hub het startte, telt; een overgenomen app houdt zijn begintijd', () => {
    const toen = new Date(NU - 300_000).toISOString();
    const starts = { 200: Date.parse(toen) + 1000, 201: NU - 5000 };
    const { loop, opnieuw } = open({ v: 1, pid: 123, begon: BEGON, set: 'avond', apps: { goed: 200, vreemd: 201, weg: 202 }, sinds: { goed: toen, vreemd: toen, weg: toen } },
      { leeft: () => false, sindsVan: (p) => /** @type {any} */ (starts)[p] ?? null });
    expect(loop.vorige?.apps).toEqual({ goed: 200, weg: 202 });
    expect(loop.vorige?.vreemd).toEqual({ vreemd: 201 });
    loop.app('goed', 200);
    loop.app('nieuw', 300);
    expect(opnieuw()).toMatchObject({ apps: { goed: 200, nieuw: 300 }, sinds: { goed: toen, nieuw: new Date(NU).toISOString() } });
  });

  it('slots en focus gaan alleen bij een echte wijziging naar schijf', () => {
    const { loop, opnieuw } = open({ v: 1, pid: 123, begon: BEGON, set: 'avond', apps: {}, slots: ['a', 'b'], focus: 'b' }, { leeft: () => false });
    expect(loop.vorige).toMatchObject({ slots: ['a', 'b'], focus: 'b' });
    loop.slotsEnFocus({ slots: ['c'], focus: 'c' });
    expect(opnieuw()).toMatchObject({ slots: ['c'], focus: 'c' });
  });

  it(`etimeMs leest ps etime ([[dd-]hh:]mm:ss); de speling is ${SPELING_MS / 1000} s`, () => {
    expect(etimeMs('  05:07\n')).toBe(307_000);
    expect(etimeMs('1:00:00')).toBe(3600_000);
    expect(etimeMs('2-03:04:05')).toBe(((2 * 24 + 3) * 3600 + 4 * 60 + 5) * 1000);
    expect(etimeMs('')).toBe(null);
  });
});

describe('overgenomen processen en logbestanden', () => {
  it('bestaandProces: een groep van alleen zombies telt als weg (en krijgt geen sein)', () => {
    /** @type {[number, string|number][]} */
    const seinen = [];
    const p = bestaandProces(4321, { kill: (pid, sein) => { seinen.push([pid, sein]); }, groep: () => false });
    expect(p.leeft()).toBe(false);
    p.stop('SIGTERM');
    expect(seinen).toEqual([[-4321, 0]]);
  });

  it('bestaandProces leest het logbestand van de app vanaf het einde mee', async () => {
    const map = maakMap();
    const log = join(map, 'nep-a.log');
    writeFileSync(log, 'van vóór de herstart\n');
    const p = bestaandProces(4321, { kill: () => {}, groep: () => true, log, klok: echteKlok, tikMs: 20 });
    let uit = '';
    p.bij('uitvoer', (t) => { uit += t; });
    writeFileSync(log, 'van vóór de herstart\nna de herstart\n');
    await tot(() => uit.includes('na de herstart'));
    expect(uit).toBe('na de herstart\n');
    p.stop('SIGTERM');
  });

  it('een overgenomen proces dat intussen stopt (of alleen nog zombies heeft): de starter start de app opnieuw, met een melding', async () => {
    const { kern } = opzet();
    const klok = new NepKlok();
    /** @type {string[]} */
    const log = [];
    /** @type {string[]} */
    const gestart = [];
    let oudLeeft = true;
    const s = startSet({
      set: { naam: 'x', apps: { 'nep-a': { start: { commando: 'nep-a starten' }, time_out_s: 20 } } },
      config: { apps: { 'nep-a': { repo: 'hub' } } }, paden: { hub: '/hub' }, bestaat: () => true,
      hub: kernToegang(kern), hubPoort: 7700, klok, openUrl: null, poortOpen: async () => false, log: (r) => log.push(r),
      herstart: { apps: { 'nep-a': 4321 } },
      bestaand: (pid) => ({ pid, bij: () => {}, leeft: () => oudLeeft, stop: () => {} }),
      startProces: (o) => { gestart.push(o.commando); let leeft = true; return { pid: 5000, bij: () => {}, leeft: () => leeft, stop: () => { leeft = false; } }; },
    });
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(log.join('\n')).toMatch(/nep-a: draait nog sinds vóór de herstart van de hub \(proces 4321\)/);
    expect(gestart).toEqual([]);
    oudLeeft = false;
    for (let t = 0; t < 10; t++) { klok.loop(250); for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); }
    expect(log.join('\n')).toMatch(/nep-a: het proces van vóór de herstart \(4321\) is gestopt — opnieuw starten/);
    expect(gestart).toEqual(['nep-a starten']);
    await s.stop();
  });

  it('naarLogbestand: het log van de vorige start blijft als <app>.vorige.log', async () => {
    const map = join(maakMap(), 'uitvoer');
    mkdirSync(map, { recursive: true });
    const pad = join(map, 'nep-a.log');
    writeFileSync(pad, 'wat de app zei vlak voor de crash\n');
    const start = naarLogbestand({ startProces, pad, klok: echteKlok, tikMs: 20 });
    const p = start({ commando: 'echo opnieuw', cwd: HUB_MAP, omgeving: {} });
    await new Promise((r) => p.bij('einde', r));
    await tot(() => !p.leeft());
    expect(readFileSync(vorigLog(pad), 'utf8')).toBe('wat de app zei vlak voor de crash\n');
    expect(readFileSync(pad, 'utf8')).toBe('opnieuw\n');
    expect(readdirSync(map).sort()).toEqual(['nep-a.log', 'nep-a.vorige.log']);
  });
});
