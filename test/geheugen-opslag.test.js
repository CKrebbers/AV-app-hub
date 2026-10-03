// Golf 4 · geheugen op schijf (src/opslag.js): pad, lezen (ontbrekend/kapot), gedebounced en atomisch schrijven,
// en de hele hub over een herstart heen.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { geheugenPad, leesGeheugen, schrijfGeheugen, koppelGeheugen, schrijfMsUit, SCHRIJF_MS } from '../src/opslag.js';
import { spawn } from 'node:child_process';
import { opzet, meldAan, stuurApp, FL } from './kern-hulp.js';
import { startHub } from '../src/hub.js';
import { NepSysteem } from '../src/ports/nep.js';
import { laadConfig } from '../src/config.js';
import { NepApp } from '../tools/nep-app.mjs';

const mappen = [];
const lopend = [];
afterEach(async () => {
  for (const x of lopend.splice(0)) await x();
  for (const m of mappen.splice(0)) rmSync(m, { recursive: true, force: true });
});
const nieuweMap = () => { const m = mkdtempSync(join(tmpdir(), 'varve-geheugen-')); mappen.push(m); return m; };

const TH = {
  v: 1, app: 'td-test', naam: 'TD-test', truth: 'hub', hb_s: 1,
  params: [
    { id: 'mix', naam: 'Mix', soort: 'waarde', standaard: 0.5, hint: 'fader' },
    { id: 'gloed', naam: 'Gloed', soort: 'waarde', standaard: 0.2, hint: 'knop', slew_s: 0.2 },
  ],
};

/** fs met een logboek van schrijfacties. */
function telFs() {
  const log = [];
  return {
    log,
    fs: {
      ...fs,
      openSync: (p, f) => { log.push(['open', p]); return fs.openSync(p, f); },
      writeFileSync: (p, d) => { log.push(['schrijf']); return fs.writeFileSync(p, d); },
      fsyncSync: (fd) => { log.push(['fsync']); return fs.fsyncSync(fd); },
      renameSync: (a, b) => { log.push(['rename', a, b]); return fs.renameSync(a, b); },
    },
  };
}

describe('opslag: pad en lezen', () => {
  it('pad uit config (~ = thuismap); $VARVE_HUB_STAAT gaat voor; zonder pad uit', () => {
    expect(geheugenPad({ geheugen: { pad: '~/.varve-hub/staat.json' } }, { env: {}, thuis: '/home/clay' })).toBe('/home/clay/.varve-hub/staat.json');
    expect(geheugenPad(laadConfig(), { env: {}, thuis: '/Users/clay' })).toBe('/Users/clay/.varve-hub/staat.json');
    expect(geheugenPad({ geheugen: { pad: '~/x.json' } }, { env: { VARVE_HUB_STAAT: '/tmp/y.json' }, thuis: '/h' })).toBe('/tmp/y.json');
    expect(geheugenPad({}, { env: {}, thuis: '/h' })).toBeNull();
  });

  it('ontbrekend bestand: leeg, met melding', () => {
    const r = leesGeheugen(join(nieuweMap(), 'staat.json'));
    expect(r.data).toBeNull();
    expect(r.melding).toMatch(/nog geen geheugen.*begint leeg/);
  });

  it('kapot bestand: leeg, melding, en het oude bestand blijft bewaard als .kapot', () => {
    const pad = join(nieuweMap(), 'staat.json');
    writeFileSync(pad, '{"v":1,"snapshots":{"1":');
    const r = leesGeheugen(pad);
    expect(r.data).toBeNull();
    expect(r.melding).toMatch(/kapot.*begint leeg.*\.kapot/);
    expect(existsSync(pad)).toBe(false);
    expect(readFileSync(`${pad}.kapot`, 'utf8')).toBe('{"v":1,"snapshots":{"1":');
  });

  it('schrijven is atomisch: eerst een tijdelijk bestand, fsync, dan rename; de map wordt gemaakt', () => {
    const pad = join(nieuweMap(), 'diep', 'staat.json');
    const { fs: f, log } = telFs();
    schrijfGeheugen(pad, { v: 1, snapshots: {}, waarden: {} }, f);
    expect(log.map((x) => x[0])).toEqual(['open', 'schrijf', 'fsync', 'rename']);
    expect(log[0][1]).not.toBe(pad);
    expect(log[3]).toEqual(['rename', log[0][1], pad]);
    expect(JSON.parse(readFileSync(pad, 'utf8'))).toEqual({ v: 1, snapshots: {}, waarden: {} });
    expect(readdirSync(join(pad, '..'))).toEqual(['staat.json']);
  });
});

describe('opslag: gekoppeld aan de kern', () => {
  it('gedebounced: hooguit één keer per seconde, alleen bij echte wijzigingen; stop schrijft wat nog wacht', () => {
    const pad = join(nieuweMap(), 'staat.json');
    const { kern, klok } = opzet();
    const { fs: f, log } = telFs();
    const meldingen = [];
    const g = koppelGeheugen({ kern, pad, klok, fs: f, log: (...m) => meldingen.push(m.join(' ')) });
    expect(meldingen[0]).toMatch(/nog geen geheugen/);
    const schrijfacties = () => log.filter((x) => x[0] === 'rename').length;

    const th = meldAan(kern, TH);
    for (let i = 0; i < 50; i++) { stuurApp(kern, th, { t: 'zet', id: 'mix', v: i / 100 }); klok.loop(10); }
    // 500 ms aan wijzigingen: nog niets op schijf
    expect(schrijfacties()).toBe(0);
    klok.loop(SCHRIJF_MS);
    expect(schrijfacties()).toBe(1);
    expect(JSON.parse(readFileSync(pad, 'utf8')).waarden['td-test'].mix).toBe(0.49);

    // aanhoudend wijzigen (5 s lang elke 20 ms): nooit vaker dan eens per seconde
    for (let i = 0; i < 250; i++) { stuurApp(kern, th, { t: 'zet', id: 'mix', v: (i % 100) / 100 }); klok.loop(20); }
    expect(schrijfacties()).toBeGreaterThanOrEqual(4);
    expect(schrijfacties()).toBeLessThanOrEqual(6);

    // geen echte wijziging: niet schrijven
    klok.loop(SCHRIJF_MS);
    const n = schrijfacties();
    stuurApp(kern, th, { t: 'zet', id: 'mix', v: JSON.parse(readFileSync(pad, 'utf8')).waarden['td-test'].mix });
    klok.loop(SCHRIJF_MS * 2);
    expect(schrijfacties()).toBe(n);

    // wijziging en meteen stoppen: toch op schijf
    kern.bewaar(4);
    g.stop();
    expect(schrijfacties()).toBe(n + 1);
    expect(Object.keys(JSON.parse(readFileSync(pad, 'utf8')).snapshots)).toEqual(['4']);
    kern.bewaar(5);
    klok.loop(SCHRIJF_MS * 2);
    expect(schrijfacties()).toBe(n + 1); // na stop luistert hij niet meer
  });

  it('bij de start inlezen; onbruikbare inhoud (andere versie) = leeg beginnen, melding, oude bewaard', () => {
    const map = nieuweMap();
    const goed = join(map, 'goed.json');
    writeFileSync(goed, JSON.stringify({ v: 1, snapshots: { 2: { 'formula-lab': { in1: 0.3 } } }, waarden: {} }));
    const een = opzet();
    const m1 = [];
    koppelGeheugen({ kern: een.kern, pad: goed, klok: een.klok, log: (...m) => m1.push(m.join(' ')) });
    expect(m1).toEqual([`geheugen geladen uit ${goed}`]);
    expect(een.kern.beeld().snapshots).toEqual([2]);
    const fl = meldAan(een.kern, FL);
    fl.ontvangen.length = 0;
    een.kern.laad(2);
    expect(fl.ontvangen).toEqual([{ t: 'zet', id: 'in1', v: 0.3, bron: 'snapshot' }]);

    const raar = join(map, 'raar.json');
    writeFileSync(raar, JSON.stringify({ v: 9, snapshots: { 1: {} } }));
    const twee = opzet();
    const m2 = [];
    koppelGeheugen({ kern: twee.kern, pad: raar, klok: twee.klok, log: (...m) => m2.push(m.join(' ')) });
    expect(m2[0]).toMatch(/onbruikbaar \(onbekende versie 9\).*begint leeg/);
    expect(twee.kern.beeld().snapshots).toEqual([]);
    expect(existsSync(`${raar}.kapot`)).toBe(true);
  });

  it('een schrijffout breekt de hub niet; één melding, en de volgende wijziging probeert het opnieuw', () => {
    const pad = join(nieuweMap(), 'staat.json');
    const { kern, klok } = opzet();
    let stuk = true;
    const f = { ...fs, writeFileSync: (p, d) => { if (stuk) throw new Error('schijf vol'); return fs.writeFileSync(p, d); } };
    const meldingen = [];
    koppelGeheugen({ kern, pad, klok, fs: f, log: (...m) => meldingen.push(m.join(' ')) });
    kern.bewaar(1); klok.loop(SCHRIJF_MS);
    kern.bewaar(2); klok.loop(SCHRIJF_MS);
    expect(meldingen.filter((m) => m.includes('schijf vol'))).toHaveLength(1);
    expect(existsSync(pad)).toBe(false);
    expect(readdirSync(join(pad, '..'))).toEqual([]); // geen tijdelijk bestand achtergebleven
    stuk = false;
    kern.bewaar(3); klok.loop(SCHRIJF_MS);
    expect(Object.keys(JSON.parse(readFileSync(pad, 'utf8')).snapshots)).toEqual(['1', '2', '3']);
  });
});

describe('de hele hub over een herstart heen', () => {
  const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
  const tot = async (fn, ms = 3000) => { const eind = Date.now() + ms; while (Date.now() < eind) { const x = fn(); if (x) return x; await wacht(10); } return fn(); };

  async function hub(pad) {
    const h = await startHub({ config: { ...laadConfig(), hotplug_ms: 20 }, systeem: new NepSysteem(), poort: 0, drivers: false, geheugen: pad });
    let gestopt = false;
    const stop = async () => { if (!gestopt) { gestopt = true; await h.stop(); } };
    lopend.push(stop);
    return { h, stop, url: h.adres.replace('http', 'ws') + '/app' };
  }
  const app = (url, manifest) => { const a = new NepApp({ url, manifest, herverbind: false }).start(); lopend.push(() => a.stop()); return a; };

  it('snapshots en truth:"hub"-waarden staan er na een herstart weer; de app krijgt ze als replay', async () => {
    const pad = join(nieuweMap(), 'staat.json');
    const een = await hub(pad);
    const a1 = app(een.url, TH);
    await tot(() => een.h.kern.beeld().apps[0]?.status === 'actief');
    een.h.kern.cockpit({ t: 'zet', app: 'td-test', id: 'mix', v: 0.8 });
    een.h.kern.cockpit({ t: 'zet', app: 'td-test', id: 'gloed', v: 0.6 });
    een.h.kern.cockpit({ t: 'snapshot', nr: 3, actie: 'bewaar' });
    await tot(() => a1.waarden.gloed === 0.6);
    a1.stop();
    await een.stop(); // schrijft meteen, zonder op de debounce te wachten
    const op = JSON.parse(readFileSync(pad, 'utf8'));
    expect(op.waarden['td-test']).toEqual({ mix: 0.8, gloed: 0.6 });
    expect(op.snapshots[3]['td-test']).toEqual({ mix: 0.8, gloed: 0.6 });

    const twee = await hub(pad);
    await tot(() => twee.h.kern.beeld().snapshots.length);
    expect(twee.h.kern.beeld().snapshots).toEqual([3]);
    const a2 = app(twee.url, TH); // een verse app: staat op zijn standaardwaarden
    await tot(() => a2.waarden.mix === 0.8 && a2.waarden.gloed === 0.6);
    expect(a2.ontvangen.filter((b) => b.t === 'zet' && b.id === 'mix')).toEqual([{ t: 'zet', id: 'mix', v: 0.8, bron: 'replay' }]);
    const gloed = a2.ontvangen.filter((b) => b.t === 'zet' && b.id === 'gloed');
    expect(gloed.length).toBeGreaterThan(1); // slew_s: verloopt
    expect(gloed.every((b) => b.bron === 'replay')).toBe(true);
    await wacht(50);
    expect(twee.h.kern.beeld().apps[0].waarden).toMatchObject({ mix: 0.8, gloed: 0.6 }); // de staat met standaardwaarden won niet
  });

  it('zonder geheugen-pad schrijft de hub niets, ook niet als $VARVE_HUB_STAAT gezet is (dat pad kiest de cli)', async () => {
    const map = nieuweMap();
    const oud = process.env.VARVE_HUB_STAAT;
    process.env.VARVE_HUB_STAAT = join(map, 'staat.json');
    try {
      const h = await startHub({ config: laadConfig(), systeem: new NepSysteem(), poort: 0, drivers: false });
      lopend.push(() => h.stop());
      expect(h.opslag).toBeNull();
      h.kern.bewaar(1);
      await h.stop();
      expect(readdirSync(map)).toEqual([]);
    } finally {
      if (oud === undefined) delete process.env.VARVE_HUB_STAAT; else process.env.VARVE_HUB_STAAT = oud;
    }
  });

  it('stoppen midden in een slew bewaart het doel, niet de tussenwaarde', async () => {
    const pad = join(nieuweMap(), 'staat.json');
    const TRAAG = { ...TH, params: [{ ...TH.params[1], slew_s: 4 }] };
    const een = await hub(pad);
    app(een.url, TRAAG);
    await tot(() => een.h.kern.beeld().apps[0]?.status === 'actief');
    een.h.kern.cockpit({ t: 'zet', app: 'td-test', id: 'gloed', v: 1 });
    await wacht(300);
    expect(een.h.kern.beeld().apps[0].waarden.gloed).toBeLessThan(0.5);
    await een.stop();
    expect(JSON.parse(readFileSync(pad, 'utf8')).waarden['td-test'].gloed).toBe(1);
  });
});

describe('golf 4 review: opslag', () => {
  it('schrijf_ms uit config: alleen een eindig getal telt, nooit vaker dan eens per seconde', () => {
    expect(schrijfMsUit({})).toBe(SCHRIJF_MS);
    expect(schrijfMsUit(laadConfig())).toBe(SCHRIJF_MS);
    expect(schrijfMsUit({ geheugen: { schrijf_ms: '1s' } })).toBe(SCHRIJF_MS);
    expect(schrijfMsUit({ geheugen: { schrijf_ms: Number.NaN } })).toBe(SCHRIJF_MS);
    expect(schrijfMsUit({ geheugen: { schrijf_ms: 10 } })).toBe(SCHRIJF_MS);
    expect(schrijfMsUit({ geheugen: { schrijf_ms: 2500 } })).toBe(2500);
  });

  it('niet te lezen (geen ENOENT) en niet veilig te stellen: deze sessie niets schrijven, het oude blijft', () => {
    const pad = join(nieuweMap(), 'staat.json');
    writeFileSync(pad, '{"v":1,"snapshots":{"1":{}},"waarden":{}}');
    const { kern, klok } = opzet();
    const f = {
      ...fs,
      readFileSync: () => { throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); },
      renameSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    };
    const meldingen = [];
    const g = koppelGeheugen({ kern, pad, klok, fs: f, log: (...m) => meldingen.push(m.join(' ')) });
    expect(meldingen[0]).toMatch(/niet te lezen.*schrijft deze sessie niets/);
    kern.bewaar(4); klok.loop(SCHRIJF_MS * 2);
    g.stop();
    expect(readFileSync(pad, 'utf8')).toBe('{"v":1,"snapshots":{"1":{}},"waarden":{}}');
  });

  it('niet te lezen maar wel veilig te stellen (een map op het pad): naar .kapot, daarna gewoon schrijven', () => {
    const pad = join(nieuweMap(), 'staat.json');
    fs.mkdirSync(pad);
    const { kern, klok } = opzet();
    const meldingen = [];
    const g = koppelGeheugen({ kern, pad, klok, log: (...m) => meldingen.push(m.join(' ')) });
    expect(meldingen[0]).toMatch(/niet te lezen.*\.kapot/);
    expect(fs.statSync(`${pad}.kapot`).isDirectory()).toBe(true);
    kern.bewaar(2);
    g.stop();
    expect(Object.keys(JSON.parse(readFileSync(pad, 'utf8')).snapshots)).toEqual(['2']);
  });

  it('overgeslagen onderdelen: eerst een kopie als .kapot, zodat de volgende keer schrijven ze niet stil wegveegt', () => {
    const pad = join(nieuweMap(), 'staat.json');
    const inhoud = JSON.stringify({ v: 1, snapshots: { 1: { 'TD LAB': { x: 1 } } }, waarden: {} });
    writeFileSync(pad, inhoud);
    const { kern, klok } = opzet();
    const meldingen = [];
    const g = koppelGeheugen({ kern, pad, klok, log: (...m) => meldingen.push(m.join(' ')) });
    expect(meldingen[0]).toMatch(/1 ongeldige onderdelen overgeslagen.*\.kapot/);
    expect(readFileSync(`${pad}.kapot`, 'utf8')).toBe(inhoud);
    kern.bewaar(3);
    g.stop();
    expect(readFileSync(`${pad}.kapot`, 'utf8')).toBe(inhoud);
  });

  it('tijdelijke bestanden van een gecrasht proces worden bij de start opgeruimd (alleen die van dit pad)', () => {
    const map = nieuweMap();
    const pad = join(map, 'staat.json');
    for (const f of ['staat.json.4242.tmp', 'staat.json.kapot', 'ander.json.4242.tmp', 'staat.json.x.tmp']) writeFileSync(join(map, f), 'x');
    const { kern, klok } = opzet();
    koppelGeheugen({ kern, pad, klok });
    expect(readdirSync(map).sort()).toEqual(['ander.json.4242.tmp', 'staat.json.kapot', 'staat.json.x.tmp']);
  });

  it('een schrijffout zegt wat Clay kan doen', () => {
    const pad = join(nieuweMap(), 'staat.json');
    const { kern, klok } = opzet();
    const f = { ...fs, openSync: () => { throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); } };
    const meldingen = [];
    koppelGeheugen({ kern, pad, klok, fs: f, log: (...m) => meldingen.push(m.join(' ')) });
    kern.bewaar(1); klok.loop(SCHRIJF_MS);
    expect(meldingen.at(-1)).toMatch(/schrijfbaar.*geheugen\.pad.*VARVE_HUB_STAAT.*onthoudt niets/);
  });
});

describe('golf 4 review: varve-hub start zet het geheugen aan', () => {
  /** Start de echte cli met het geheugen in een tijdelijke map (nooit de echte thuismap). */
  function startCli(map, extra = []) {
    const p = spawn(process.execPath, ['src/cli.js', 'start', '--zonder-midi', '--geen-drivers', '--poort', '0', ...extra], {
      cwd: join(import.meta.dirname, '..'),
      env: { ...process.env, HOME: map, VARVE_HUB_STAAT: join(map, 'staat.json') },
    });
    let uit = '';
    p.stdout.on('data', (b) => { uit += b; });
    p.stderr.on('data', (b) => { uit += b; });
    const klaar = new Promise((goed, mis) => {
      const t = setTimeout(() => mis(new Error('hub startte niet:\n' + uit)), 10000);
      const kijk = () => { const m = uit.match(/Cockpit: (http:\/\/\S+)/); if (m) { clearTimeout(t); goed(m[1]); } };
      p.stdout.on('data', kijk);
    });
    const weg = new Promise((r) => p.on('exit', r));
    const stop = async () => { p.kill('SIGINT'); await Promise.race([weg, new Promise((r) => setTimeout(r, 3000))]); p.kill('SIGKILL'); };
    lopend.push(stop);
    return { klaar, uitvoer: () => uit, stop };
  }
  const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
  const tot = async (fn, ms = 4000) => { const eind = Date.now() + ms; while (Date.now() < eind) { const x = fn(); if (x) return x; await wacht(20); } return fn(); };

  it('leest het pad ($VARVE_HUB_STAAT), speelt bewaarde waarden af en schrijft wijzigingen weg', async () => {
    const map = nieuweMap();
    const pad = join(map, 'staat.json');
    writeFileSync(pad, JSON.stringify({ v: 1, snapshots: { 2: {} }, waarden: { 'td-test': { mix: 0.7 } } }));
    const cli = startCli(map);
    const adres = await cli.klaar;
    expect(cli.uitvoer()).toContain(`Geheugen: ${pad}`);
    expect(cli.uitvoer()).toContain(`geladen uit ${pad}`);
    const a = new NepApp({ url: adres.replace('http', 'ws') + '/app', manifest: TH, herverbind: false }).start();
    lopend.push(() => a.stop());
    expect(await tot(() => a.waarden.mix === 0.7)).toBe(true);
    a.zelfZetten('mix', 0.3);
    expect(await tot(() => JSON.parse(readFileSync(pad, 'utf8')).waarden['td-test']?.mix === 0.3)).toBe(true);
    await cli.stop();
  }, 20000);

  it('--zonder-geheugen: niets gelezen of geschreven, en dat staat er', async () => {
    const map = nieuweMap();
    const cli = startCli(map, ['--zonder-geheugen']);
    await cli.klaar;
    expect(cli.uitvoer()).toMatch(/Geheugen uit/);
    await cli.stop();
    expect(readdirSync(map)).toEqual([]);
  }, 20000);
});
