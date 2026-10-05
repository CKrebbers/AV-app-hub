// Het protocol voor de speelapparaten (PROTOCOL §17): manifestveld `speelt`, `led` met dev, `scherm`, en de
// conformiteitstoets met een nep-app die speelt.
import { describe, it, expect } from 'vitest';
import { valideerManifest, SPEELAPPARATEN } from '../src/protocol/manifest.js';
import { leesVanApp, leesNaarApp, SCHERM_BYTES } from '../src/protocol/berichten.js';
import { NepApp, speelManifest, nepScherm } from '../tools/nep-app.mjs';
import { toetsApp } from '../tools/nep-hub.mjs';

const b64 = (n, x = 0) => Buffer.from(new Uint8Array(n).fill(x)).toString('base64');

describe('manifest: speelt', () => {
  it('een lease-app noemt de apparaten die hij speelt', () => {
    const r = valideerManifest({ v: 1, app: 'varve-dj', naam: 'Varve DJ', lease: true, speelt: ['xboard49', 'maschine-mk2'] });
    expect(r).toMatchObject({ ok: true, manifest: { lease: true, speelt: ['xboard49', 'maschine-mk2'] } });
    expect(SPEELAPPARATEN).toEqual(['xboard49', 'maschine-mk2']);
  });
  it('een apparaat dat deze hub niet kent valt weg, dubbel telt één keer (grondregel 5)', () => {
    const r = valideerManifest({ v: 1, app: 'x', naam: 'X', lease: true, speelt: ['xboard49', 'theremin-9000', 'xboard49'] });
    expect(r.ok && r.manifest.speelt).toEqual(['xboard49']);
  });
  it('speelt vraagt lease:true (de app krijgt ruwe MIDI), en is een lijst namen', () => {
    expect(valideerManifest({ v: 1, app: 'x', naam: 'X', speelt: ['xboard49'], params: [] })).toMatchObject({ ok: false, fouten: [expect.stringMatching(/lease: true/)] });
    expect(valideerManifest({ v: 1, app: 'x', naam: 'X', lease: true, speelt: 'xboard49' })).toMatchObject({ ok: false, fouten: [expect.stringMatching(/speelt moet een lijst/)] });
    expect(valideerManifest({ v: 1, app: 'x', naam: 'X', lease: true, speelt: ['Xboard 49'] }).ok).toBe(false);
    expect(valideerManifest({ v: 1, app: 'x', naam: 'X', speelt: [], params: [] }).ok).toBe(true);
  });
  it('zonder speelt verandert er niets aan een manifest', () => {
    const r = valideerManifest({ v: 1, app: 'varve-dj', naam: 'Varve DJ', lease: true });
    expect(r.ok && 'speelt' in r.manifest).toBe(false);
  });
});

describe('berichten: led met dev, scherm, midi', () => {
  it('led zonder dev (of apc40) is voor de APC; met dev voor een speelapparaat; een onbekend apparaat: negeren', () => {
    expect(leesVanApp({ t: 'led', bytes: [[0x90, 0, 5]] })).toEqual({ ok: true, bericht: { t: 'led', bytes: [[0x90, 0, 5]] } });
    expect(leesVanApp({ t: 'led', dev: 'apc40', bytes: [[0x90, 0, 5]] })).toEqual({ ok: true, bericht: { t: 'led', bytes: [[0x90, 0, 5]] } });
    expect(leesVanApp({ t: 'led', dev: 'maschine-mk2', bytes: [[0x90, 36, 5], [0xf0, 1, 0xf7]] })).toEqual({ ok: true, bericht: { t: 'led', dev: 'maschine-mk2', bytes: [[0x90, 36, 5]] } });
    expect(leesVanApp({ t: 'led', dev: 'theremin', bytes: [[0x90, 36, 5]] })).toEqual({ ok: true, onbekend: true, t: 'led' });
  });
  it('scherm: maschine-mk2, nr 0 of 1, base64 van precies 2048 bytes → bytes voor de kern', () => {
    const r = leesVanApp({ t: 'scherm', dev: 'maschine-mk2', nr: 1, data: b64(SCHERM_BYTES, 7) });
    expect(r.ok && r.bericht.t).toBe('scherm');
    expect(r.bericht.nr).toBe(1);
    expect(r.bericht.data).toBeInstanceOf(Uint8Array);
    expect(r.bericht.data.length).toBe(2048);
    expect(r.bericht.data[2047]).toBe(7);
    expect(leesVanApp({ t: 'scherm', dev: 'maschine-mk2', nr: 0, data: nepScherm() }).ok).toBe(true);
  });
  it('scherm: verkeerde lengte, geen base64 of een ander nr is een fout; een ander apparaat: negeren', () => {
    expect(leesVanApp({ t: 'scherm', dev: 'maschine-mk2', nr: 0, data: b64(2047) })).toMatchObject({ ok: false, fout: expect.stringMatching(/2048/) });
    expect(leesVanApp({ t: 'scherm', dev: 'maschine-mk2', nr: 0, data: '!!' + b64(2048).slice(2) }).ok).toBe(false);
    expect(leesVanApp({ t: 'scherm', dev: 'maschine-mk2', nr: 2, data: b64(2048) })).toMatchObject({ ok: false, fout: expect.stringMatching(/nr/) });
    expect(leesVanApp({ t: 'scherm', dev: 'maschine-mk2', nr: 0, data: 42 }).ok).toBe(false);
    expect(leesVanApp({ t: 'scherm', dev: 'push2', nr: 0, data: b64(2048) })).toEqual({ ok: true, onbekend: true, t: 'scherm' });
  });
  it('midi van de hub draagt altijd een dev (apc40, xboard49, maschine-mk2)', () => {
    expect(leesNaarApp({ t: 'midi', dev: 'xboard49', bytes: [0x90, 60, 100] }).ok).toBe(true);
    expect(leesNaarApp({ t: 'midi', dev: 'maschine-mk2', bytes: [0xa0, 36, 1] }).ok).toBe(true);
    expect(leesNaarApp({ t: 'midi', bytes: [0x90, 60, 100] }).ok).toBe(false);
  });
});

describe('conformiteit: een nep-app die speelt', () => {
  it('de nep-speler (lease, speelt xboard49 en maschine-mk2, stuurt een scherm en pad-lampjes) is conform', async () => {
    let app;
    const ontvangen = [];
    const r = await toetsApp({ poort: 0, start: (url) => { app = new NepApp({ url, manifest: speelManifest() }).start(); app.bij('bericht', (b) => ontvangen.push(b)); } });
    app.stop();
    expect(r.uitslagen.filter((u) => !u.ok)).toEqual([]);
    expect(r.uitslagen.map((u) => u.naam)).toContain('speelt xboard49, maschine-mk2: overleeft hun MIDI');
    expect(r.uitslagen.map((u) => u.naam)).toContain('scherm: alleen met maschine-mk2 in speelt');
    expect(ontvangen.filter((b) => b.t === 'midi').map((b) => b.dev)).toEqual(expect.arrayContaining(['xboard49', 'maschine-mk2']));
  }, 20000);
  it('een app die LED\'s stuurt voor een apparaat dat hij niet speelt, valt door de toets', async () => {
    let app;
    const m = { ...speelManifest('slordige-speler'), speelt: ['xboard49'] };
    const r = await toetsApp({ poort: 0, herverbindMs: 1500, start: (url) => {
      app = new NepApp({ url, manifest: m }).start();
      app.bij('open', () => app.ws.send(JSON.stringify({ t: 'led', dev: 'maschine-mk2', bytes: [[0x90, 36, 5]] })));
    } });
    app.stop();
    expect(r.uitslagen.filter((u) => !u.ok).map((u) => u.naam)).toContain('LED\'s met dev alleen voor apparaten uit speelt');
  }, 20000);
});
