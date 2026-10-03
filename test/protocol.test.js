import { describe, it, expect } from 'vitest';
import { valideerManifest, keuzeNaarWaarde, waardeNaarKeuze } from '../src/protocol/manifest.js';
import { leesVanApp, leesNaarApp, isModeSysex } from '../src/protocol/berichten.js';
import { voorbeeldManifest, NepApp } from '../tools/nep-app.mjs';
import { toetsApp } from '../tools/nep-hub.mjs';

describe('manifest', () => {
  it('het voorbeeld is geldig en krijgt standaardwaarden', () => {
    const r = valideerManifest(voorbeeldManifest());
    expect(r.ok).toBe(true);
    expect(r.manifest).toMatchObject({ truth: 'app', hb_s: 1, lease: false });
    expect(r.manifest.params.find((p) => p.id === 'flits').standaard).toBe(0);
  });
  it('noemt elke fout in gewone taal', () => {
    const r = valideerManifest({ v: 2, app: 'Hoofd Letters', params: [{ id: 'a', naam: 'A', soort: 'raar' }, { id: 'a', naam: 'B', soort: 'keuze', keuzes: ['x'] }, { id: 'c', naam: 'C', soort: 'waarde', standaard: 3, rol: 'macro.onzin' }] });
    expect(r.ok).toBe(false);
    expect(r.fouten.join('\n')).toMatch(/v moet 1/);
    expect(r.fouten.join('\n')).toMatch(/app moet/);
    expect(r.fouten.join('\n')).toMatch(/naam ontbreekt/);
    expect(r.fouten.join('\n')).toMatch(/soort moet/);
    expect(r.fouten.join('\n')).toMatch(/dubbel/);
    expect(r.fouten.join('\n')).toMatch(/2..8 keuzes/);
    expect(r.fouten.join('\n')).toMatch(/standaard moet 0..1/);
    expect(r.fouten.join('\n')).toMatch(/onbekende rol/);
  });
  it('lease-app mag zonder params en krijgt rings', () => {
    const r = valideerManifest({ v: 1, app: 'av-kern', naam: 'AV-kern', lease: true, rings: 'auto' });
    expect(r).toMatchObject({ ok: true, manifest: { lease: true, rings: 'auto', params: [] } });
  });
  it('keuze ↔ waarde', () => {
    expect([0, 1, 2].map((i) => keuzeNaarWaarde(i, 3))).toEqual([0, 0.5, 1]);
    expect([0, 0.3, 0.5, 0.74, 1].map((v) => waardeNaarKeuze(v, 3))).toEqual([0, 1, 1, 1, 2]);
  });
});

describe('berichten', () => {
  it('leest geldige app-berichten en klemt waarden', () => {
    expect(leesVanApp('{"t":"zet","id":"x","v":1.7}')).toEqual({ ok: true, bericht: { t: 'zet', id: 'x', v: 1 } });
    expect(leesVanApp({ t: 'staat', waarden: { a: -1, b: 0.5, c: 'x' } })).toEqual({ ok: true, bericht: { t: 'staat', waarden: { a: 0, b: 0.5 } } });
    expect(leesVanApp({ t: 'hb' })).toEqual({ ok: true, bericht: { t: 'hb' } });
  });
  it('negeert onbekende types, weigert kapotte berichten', () => {
    expect(leesVanApp({ t: 'toekomst' })).toEqual({ ok: true, onbekend: true, t: 'toekomst' });
    expect(leesVanApp('{kapot').ok).toBe(false);
    expect(leesVanApp({ t: 'hallo', app: 'X' }).ok).toBe(false);
  });
  it('filtert mode-SysEx uit LED-berichten van apps', () => {
    const r = leesVanApp({ t: 'led', bytes: [[0xf0, 0x47, 0x7f, 0x29, 0x60, 0, 4, 0x41, 1, 0, 0, 0xf7], [0x90, 0, 5]] });
    expect(r.bericht.bytes).toEqual([[0x90, 0, 5]]);
    expect(isModeSysex([0xf0, 0x47, 0x7f, 0x29, 0x60])).toBe(true);
  });
  it('controleert hub-berichten', () => {
    expect(leesNaarApp({ t: 'zet', id: 'a', v: 0.2 }).ok).toBe(true);
    expect(leesNaarApp({ t: 'zet', id: 'a', v: 2 }).ok).toBe(false);
    expect(leesNaarApp({ t: 'midi', dev: 'apc40', bytes: [0x90, 1, 127] }).ok).toBe(true);
  });
});

describe('conformiteit: nep-app tegen nep-hub', () => {
  it('de nep-app is conform PROTOCOL.md', async () => {
    let app;
    const r = await toetsApp({ poort: 0, start: (url) => { app = new NepApp({ url }).start(); } });
    app.stop();
    expect(r.uitslagen.filter((u) => !u.ok)).toEqual([]);
    expect(r.app).toBe('nep-app');
  }, 20000);
  it('een app zonder hartslag en zonder herverbinden valt door de toets', async () => {
    let app;
    const m = { ...voorbeeldManifest('slordig'), hb_s: 0.5 };
    const r = await toetsApp({ poort: 0, herverbindMs: 1500, start: (url) => { app = new NepApp({ url, manifest: m, herverbind: false }); app.start(); app.bij('open', () => clearInterval(app.hb)); } });
    app.stop();
    const fout = r.uitslagen.filter((u) => !u.ok).map((u) => u.naam);
    expect(fout).toContain('hartslag minstens elke 0.5 s');
    expect(fout).toContain('verbindt opnieuw na wegvallen');
  }, 20000);
});
