// @ts-check
// Specificatie: de LPD8 en de globale laag (PROTOCOL.md §6) — werkt altijd, los van de focus.
import { describe, it, expect, afterEach } from 'vitest';
import { Kern, MELDING, Bank, P, manifest } from './hulp.js';

/**
 * Gemeten ademperiode in seconden uit de globaal-berichten die app `app` ontving vanaf moment `vanaf`.
 * @param {Bank} h @param {string} app @param {number} vanaf
 */
function ademPeriode(h, app, vanaf) {
  const metingen = h.ev.naarApp
    .filter(([a, b, t]) => a === app && t >= vanaf && b.t === 'globaal' && typeof b.waarden.adem === 'number')
    .map(([, b, t]) => /** @type {[number, number]} */ ([t, b.waarden.adem]));
  let fase = 0;
  for (let i = 1; i < metingen.length; i++) {
    let d = metingen[i][1] - metingen[i - 1][1];
    if (d < -0.5) d += 1;
    fase += d;
  }
  const duur = (metingen.at(-1)[0] - metingen[0][0]) / 1000;
  return { periode: duur / fase, aantal: metingen.length };
}

describe.skipIf(!Kern)(`LPD8 en de globale laag${MELDING}`, () => {
  /** @type {Bank[]} */
  let banken = [];
  const bank = (/** @type {any} */ o) => { const b = new Bank(o); banken.push(b); return b; };
  afterEach(() => { for (const b of banken) b.stop(); banken = []; });

  it('LPD8-knop 3 → elke app met rol macro.ruimte krijgt een zet; iedereen krijgt globaal met alleen die macro', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1'), P.waarde('ruimte', { rol: 'macro.ruimte' })]), { in1: 0.1, ruimte: 0.4 });
    const ws = h.app(manifest('waterschaal', [P.waarde('galm', { rol: 'macro.ruimte' })]), { galm: 0.4 });
    const ms = h.app(manifest('medisynth', [P.waarde('toon')]), { toon: 0.4 });
    h.even();
    h.wisApps();

    h.lpdSchuif(3, 0, 1); // ergens onderweg wordt de macro opgepakt
    h.even();
    h.lpdKnop(3, 0.5);
    h.even();
    expect(fl.laatsteZet('ruimte')).toMatchObject({ bron: 'lpd8' });
    expect(fl.laatsteZet('ruimte')?.v).toBeCloseTo(64 / 127, 2);
    expect(ws.laatsteZet('galm')?.v).toBeCloseTo(64 / 127, 2);
    expect(fl.zetten('in1')).toEqual([]);
    expect(ms.zetten()).toEqual([]);

    for (const a of [fl, ws, ms]) {
      const met = a.globaal().filter((b) => 'macro.ruimte' in b.waarden);
      expect(met.length).toBeGreaterThan(0);
      expect(met.at(-1).waarden['macro.ruimte']).toBeCloseTo(64 / 127, 2);
      for (const b of met) expect(Object.keys(b.waarden).filter((k) => k.startsWith('macro.'))).toEqual(['macro.ruimte']);
    }
    expect(h.kern.beeld().globaal['macro.ruimte']).toBeCloseTo(64 / 127, 2);
  });

  it('LPD8-knoppen hebben pickup: een knop ver van de macro doet niets tot hij de macro kruist', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.waarde('kracht', { rol: 'macro.intensiteit' })]), { kracht: 0.5 });
    h.even();
    const m = h.kern.beeld().globaal['macro.intensiteit'];
    expect(typeof m).toBe('number');
    const ver = m > 0.5 ? 0 : 1, tegenover = m > 0.5 ? 1 : 0;
    const halfweg = (ver * 3 + m) / 4;
    h.wisApps();
    h.lpdKnop(1, ver);
    h.lpdKnop(1, halfweg);
    h.even();
    expect(fl.zetten('kracht')).toEqual([]);
    h.lpdSchuif(1, halfweg, tegenover);
    h.even();
    expect(fl.zetten('kracht').length).toBeGreaterThan(0);
    expect(fl.laatsteZet('kracht')?.v).toBeCloseTo(tegenover, 2);
  });

  it('een trage app (slew_s) krijgt de macro in kleine stapjes over zijn eigen tijd, een snelle app meteen', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.waarde('ruimte', { rol: 'macro.ruimte' })]), { ruimte: 0.5 });
    const ms = h.app(manifest('medisynth', [P.waarde('ruimte', { rol: 'macro.ruimte', slew_s: 4 })]), { ruimte: 0.5 });
    h.even();
    h.lpdSchuif(3, 0, 1);
    h.tijd(5000);
    expect(ms.laatsteZet('ruimte')?.v).toBeCloseTo(1, 2);
    h.wisApps();

    h.lpdKnop(3, 0);
    h.even();
    expect(fl.laatsteZet('ruimte')?.v).toBe(0);
    expect(ms.laatsteZet('ruimte')?.v ?? 1).toBeGreaterThan(0.9);
    h.tijd(1950); // halverwege
    const midden = ms.laatsteZet('ruimte')?.v;
    expect(midden).toBeGreaterThan(0.25);
    expect(midden).toBeLessThan(0.75);
    h.tijd(2500);
    expect(ms.laatsteZet('ruimte')?.v).toBeCloseTo(0, 2);
    // ~33 ms per stap over 4 s ≈ 120 stappen; ruim gemeten.
    expect(ms.zetten('ruimte').length).toBeGreaterThan(60);
    expect(ms.zetten('ruimte').length).toBeLessThan(200);
    const reeks = ms.zetten('ruimte').map((b) => b.v);
    for (let i = 1; i < reeks.length; i++) expect(reeks[i]).toBeLessThanOrEqual(reeks[i - 1]);
  });

  it('de adem loopt ~10x per seconde naar de apps; K7 regelt de periode: standaard 10 s, links 4 s, rechts 16 s', () => {
    const h = bank();
    h.app(manifest('formula-lab', []));
    h.even();
    let t = h.klok.nu();
    h.tijd(10000);
    const standaard = ademPeriode(h, 'formula-lab', t);
    expect(standaard.aantal).toBeGreaterThan(80);
    expect(standaard.aantal).toBeLessThan(120);
    expect(standaard.periode).toBeGreaterThan(8.5);
    expect(standaard.periode).toBeLessThan(11.5);

    h.lpdSchuif(7, 0, 1);
    t = h.klok.nu();
    h.tijd(16000);
    const rechts = ademPeriode(h, 'formula-lab', t).periode;
    expect(rechts).toBeGreaterThan(13.6);
    expect(rechts).toBeLessThan(18.4);

    h.lpdKnop(7, 0);
    t = h.klok.nu();
    h.tijd(8000);
    const links = ademPeriode(h, 'formula-lab', t).periode;
    expect(links).toBeGreaterThan(3.4);
    expect(links).toBeLessThan(4.6);
  });

  it('paniek pas na 1 s vasthouden van pad 1: trig paniek naar wie hem heeft, globaal paniek naar iedereen', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.trigger('paniek')]));
    const ws = h.app(manifest('waterschaal', [P.fader('x')]), { x: 0.3 });
    h.even();
    h.wisApps();

    h.lpdHoud(1, 500); // te kort
    h.even();
    expect(fl.trigs('paniek')).toEqual([]);
    expect(ws.globaal().some((b) => 'paniek' in b.waarden)).toBe(false);

    h.lpdDruk(1);
    h.tijd(1100); // nog steeds ingedrukt
    expect(fl.trigs('paniek')[0]).toEqual({ t: 'trig', id: 'paniek', aan: true });
    expect(ws.trigs()).toEqual([]);
    for (const a of [fl, ws]) expect(a.globaal().some((b) => b.waarden.paniek === 1)).toBe(true);
    h.lpdLos(1);
  });

  it('pad 2 tikt het tempo (standaard 120 bpm, grondtoon D); pad 3 zet de adem terug op het begin; pad 4 zet opnemen aan en uit', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', []));
    h.even();
    expect(h.kern.beeld().globaal).toMatchObject({ bpm: 120, grondtoon: 'D' });

    for (let i = 0; i < 4; i++) { h.lpdDruk(2); h.lpdLos(2); h.tijd(400); }
    const bpm = h.globaalStand(fl).bpm;
    expect(bpm).toBeGreaterThan(147);
    expect(bpm).toBeLessThan(153);
    expect(h.kern.beeld().globaal.bpm).toBeCloseTo(bpm, 5);

    h.tijd(3000);
    const t = h.klok.nu();
    h.lpdDruk(3);
    h.lpdLos(3);
    h.tijd(200);
    const eerste = h.ev.naarApp.find(([a, b, tt]) => a === 'formula-lab' && tt >= t && b.t === 'globaal' && typeof b.waarden.adem === 'number');
    expect(eerste?.[1].waarden.adem).toBeLessThan(0.05);

    h.lpdDruk(4); h.lpdLos(4);
    h.lpdDruk(4); h.lpdLos(4);
    expect(h.ev.opname).toEqual([true, false]);
  });

  it('pad 5 kort = snapshot laden, lang (>600 ms) = snapshot bewaren', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1')]), { in1: 0.3 });
    const ws = h.app(manifest('waterschaal', [P.fader('x')]), { x: 0.7 });
    h.even();
    h.lpdHoud(5, 800); // bewaren
    h.even();
    expect([...fl.zetten(), ...ws.zetten()].filter((b) => b.bron === 'snapshot')).toEqual([]);

    fl.zet('in1', 0.9);
    ws.zet('x', 0.1);
    h.wisApps();
    h.lpdHoud(6, 100); // ander, leeg snapshot: verandert niets
    h.lpdHoud(5, 100); // laden
    h.even();
    expect(fl.laatsteZet('in1')).toMatchObject({ bron: 'snapshot' });
    expect(fl.laatsteZet('in1')?.v).toBeCloseTo(0.3, 3);
    expect(ws.laatsteZet('x')?.v).toBeCloseTo(0.7, 3);
    expect(h.appBeeld('formula-lab').waarden.in1).toBeCloseTo(0.3, 3);
  });
});
