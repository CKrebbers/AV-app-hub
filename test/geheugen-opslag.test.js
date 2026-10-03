// Golf 4 · geheugen op schijf (src/opslag.js): pad, lezen (ontbrekend/kapot), gedebounced en atomisch schrijven,
// en de hele hub over een herstart heen.
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { geheugenPad, leesGeheugen, schrijfGeheugen, koppelGeheugen, SCHRIJF_MS } from '../src/opslag.js';
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
      writeFileSync: (p, d) => { log.push(['schrijf', p]); return fs.writeFileSync(p, d); },
      renameSync: (a, b) => { log.push(['rename', a, b]); return fs.renameSync(a, b); },
      mkdirSync: fs.mkdirSync, readFileSync: fs.readFileSync, rmSync: fs.rmSync,
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

  it('schrijven is atomisch: eerst een tijdelijk bestand, dan rename; de map wordt gemaakt', () => {
    const pad = join(nieuweMap(), 'diep', 'staat.json');
    const { fs: f, log } = telFs();
    schrijfGeheugen(pad, { v: 1, snapshots: {}, waarden: {} }, f);
    expect(log).toHaveLength(2);
    expect(log[0][0]).toBe('schrijf');
    expect(log[0][1]).not.toBe(pad);
    expect(log[1]).toEqual(['rename', log[0][1], pad]);
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

  it('zonder geheugen-pad schrijft de hub niets', async () => {
    const map = nieuweMap();
    const h = await startHub({ config: laadConfig(), systeem: new NepSysteem(), poort: 0, drivers: false });
    lopend.push(() => h.stop());
    expect(h.opslag).toBeNull();
    h.kern.bewaar(1);
    await h.stop();
    expect(readdirSync(map)).toEqual([]);
  });
});
