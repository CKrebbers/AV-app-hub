// @ts-check
// Specificatie: apps komen en gaan (hartslag, herverbinden, truth), snapshots, cockpit en de kern-events
// (PROTOCOL.md §3, §6, §8).
import { describe, it, expect, afterEach } from 'vitest';
import { Kern, MELDING, Bank, P, manifest, configKleur, fysiek } from './hulp.js';

describe.skipIf(!Kern)(`Apps komen en gaan, snapshots en de cockpit${MELDING}`, () => {
  /** @type {Bank[]} */
  let banken = [];
  const bank = (/** @type {any} */ o) => { const b = new Bank(o); banken.push(b); return b; };
  afterEach(() => { for (const b of banken) b.stop(); banken = []; });

  it('app valt stil → na 3 s knippert zijn slot, na 10 s is het uit; waarden blijven; elk bericht telt als hartslag', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1')]), { in1: 0.2 });
    const ws = h.app(manifest('waterschaal', [P.fader('x')]), { x: 0.7 });
    h.even();
    const begin = h.klok.nu();
    ws.zwijg();
    fl.zwijg(); // stuurt geen hb meer, maar wel elke seconde een zet
    const tot = (/** @type {number} */ s) => {
      while (h.klok.nu() < begin + s * 1000) { h.tijd(Math.min(1000, begin + s * 1000 - h.klok.nu())); fl.zet('in1', (h.klok.nu() % 1000) / 1000); }
    };
    tot(2.8);
    expect(h.appBeeld('waterschaal').status).toBe('actief');
    tot(3.3);
    expect(h.appBeeld('waterschaal').status).toBe('stil');
    h.metHubtoets(() => {
      h.even();
      expect(h.apc.rgb('pad5-2').anim).toBe('knipper');
      expect([h.apc.rgb('pad5-2').basis, h.apc.rgb('pad5-2').animKleur]).toContain(configKleur('waterschaal'));
    });
    tot(9.8);
    expect(h.appBeeld('waterschaal').status).toBe('stil');
    tot(10.3);
    expect(h.appBeeld('waterschaal').status).toBe('weg');
    h.metHubtoets(() => { h.even(); expect(h.apc.rgb('pad5-2').aan).toBe(false); });
    expect(h.appBeeld('waterschaal').waarden.x).toBeCloseTo(0.7, 3);
    expect(h.appBeeld('formula-lab').status).toBe('actief');
  });

  it('app verbreekt en komt terug → zelfde slot, zelfde waarden, weer actief, focus ongemoeid', () => {
    const h = bank();
    h.app(manifest('formula-lab', [P.fader('in1')]), { in1: 0.2 });
    const ws = h.app(manifest('waterschaal', [P.fader('x'), P.schakelaar('aan')]), { x: 0.7, aan: 1 });
    h.even();
    ws.verbreek();
    h.even();
    expect(h.appBeeld('waterschaal')).toMatchObject({ status: 'weg', slot: 2 });
    expect(h.appBeeld('waterschaal').waarden).toMatchObject({ x: 0.7, aan: 1 });
    h.metHubtoets(() => { h.even(); expect(h.apc.rgb('pad5-2').aan).toBe(false); });

    h.tijd(20000);
    ws.verbind();
    h.even();
    expect(h.appBeeld('waterschaal')).toMatchObject({ status: 'actief', slot: 2 });
    expect(h.appBeeld('waterschaal').waarden).toMatchObject({ x: 0.7, aan: 1 });
    expect(h.kern.beeld().focus).toBe('formula-lab');
    h.metHubtoets(() => { h.even(); expect(h.apc.rgb('pad5-2').kleur).toBe(configKleur('waterschaal')); });

    // Na terugkomen gewoon bespeelbaar.
    h.metHubtoets(() => h.tik('sel2'));
    ws.wis();
    h.fader(1, 0.7);
    expect(ws.laatsteZet('x')?.v).toBeCloseTo(fysiek(0.7), 2);
  });

  it('truth hub: bij terugkomen speelt de hub de laatst bekende waarden af; truth app: de hub stuurt niets ongevraagd', () => {
    const h = bank();
    // medisynth kan zijn staat niet melden (truth hub) en stuurt dus geen `staat`.
    const ms = h.app(manifest('medisynth', [P.fader('volume', { standaard: 0.2 }), P.waarde('toon', { standaard: 0.5 })], { truth: 'hub' }));
    const fl = h.app(manifest('formula-lab', [P.fader('in1')]), { in1: 0.2 });
    h.even();
    h.kern.cockpit({ t: 'zet', app: 'medisynth', id: 'volume', v: 0.66 });
    h.kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'in1', v: 0.66 });
    h.even();
    ms.verbreek();
    fl.verbreek();
    h.tijd(1000);
    ms.wis();
    fl.wis();

    ms.verbind({ inst: 'nieuwe-start' });
    fl.verbind({ inst: 'nieuwe-start' });
    h.even();
    const replay = ms.zetten().filter((b) => b.bron === 'replay');
    expect(replay.find((b) => b.id === 'volume')?.v).toBeCloseTo(0.66, 3);
    expect(fl.zetten()).toEqual([]);
  });

  it('snapshot bewaren en laden over drie apps met Bank + Shift + Scene 1', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1'), P.keuze('palet', ['a', 'b', 'c'])]), { in1: 0.3, palet: 1 });
    const ws = h.app(manifest('waterschaal', [P.fader('x'), P.schakelaar('aan')]), { x: 0.7, aan: 1 });
    const ms = h.app(manifest('medisynth', [P.knop('toon')]), { toon: 0.45 });
    h.even();

    h.metHubtoets(() => { h.druk('shift'); h.tik('scene1'); h.los('shift'); });
    h.even();
    expect([fl, ws, ms].flatMap((a) => a.zetten()).filter((b) => b.bron === 'snapshot')).toEqual([]);

    fl.zet('in1', 0.9); fl.zet('palet', 0);
    ws.zet('x', 0.1); ws.zet('aan', 0);
    ms.zet('toon', 0.95);
    h.wisApps();

    h.metHubtoets(() => h.tik('scene1'));
    h.even();
    const verwacht = { 'formula-lab': { in1: 0.3, palet: 1 }, waterschaal: { x: 0.7, aan: 1 }, medisynth: { toon: 0.45 } };
    for (const a of [fl, ws, ms]) {
      for (const [id, v] of Object.entries(verwacht[/** @type {keyof typeof verwacht} */ (a.id)])) {
        expect(a.laatsteZet(id), `${a.id}.${id}`).toMatchObject({ bron: 'snapshot' });
        expect(a.laatsteZet(id)?.v, `${a.id}.${id}`).toBeCloseTo(v, 3);
      }
      expect(h.appBeeld(a.id).waarden).toMatchObject(verwacht[/** @type {keyof typeof verwacht} */ (a.id)]);
    }
  });

  it('de cockpit zet waarden (bron cockpit, APC toont ze) en bewaart en laadt snapshots', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.knop('k1'), P.fader('in1')]), { k1: 0.2, in1: 0.4 });
    h.even();
    h.kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'k1', v: 0.9 });
    h.even();
    expect(fl.laatsteZet('k1')).toEqual({ t: 'zet', id: 'k1', v: 0.9, bron: 'cockpit' });
    expect(h.apc.ring('dk1')).toBeCloseTo(0.9, 1);
    expect(h.appBeeld('formula-lab').waarden.k1).toBeCloseTo(0.9, 3);

    h.kern.cockpit({ t: 'snapshot', nr: 3, actie: 'bewaar' });
    fl.zet('k1', 0.1);
    fl.zet('in1', 0.8);
    fl.wis();
    h.kern.cockpit({ t: 'snapshot', nr: 3, actie: 'laad' });
    h.even();
    expect(fl.laatsteZet('k1')).toMatchObject({ v: 0.9, bron: 'snapshot' });
    expect(fl.laatsteZet('in1')).toMatchObject({ bron: 'snapshot' });
    expect(fl.laatsteZet('in1')?.v).toBeCloseTo(0.4, 3);
    expect(h.apc.ring('dk1')).toBeCloseTo(0.9, 1);
  });

  it('app beweegt zelf → de hub werkt bij maar stuurt niets terug (geen echo)', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1'), P.knop('k1'), P.schakelaar('aan')]), { in1: 0.2, k1: 0.2, aan: 0 });
    h.even();
    fl.wis();
    for (let i = 1; i <= 20; i++) { fl.zet('in1', i / 20); fl.zet('k1', i / 20); fl.zet('aan', i % 2); }
    h.tijd(500);
    expect(fl.zetten()).toEqual([]);
    expect(h.appBeeld('formula-lab').waarden).toMatchObject({ in1: 1, k1: 1, aan: 0 });
  });

  it('kern.beeld() geeft de cockpit alles (apps met slot, status, focus, params, waarden; globaal; apparaten) en meldt wijzigingen hooguit 10x per seconde', () => {
    const h = bank();
    h.app(manifest('formula-lab', [P.fader('in1')], { kleur: '#3fbf5f' }), { in1: 0.25 });
    h.app({ v: 1, app: 'varve-dj', naam: 'Varve DJ', lease: true, params: [] });
    h.even();
    const b = h.kern.beeld();
    expect(b.focus).toBe('formula-lab');
    expect(b.globaal).toMatchObject({ bpm: 120, grondtoon: 'D' });
    expect(typeof b.apparaten).toBe('object');
    expect(b.apps).toHaveLength(2);
    const fl = b.apps.find((/** @type {any} */ a) => a.app === 'formula-lab');
    const dj = b.apps.find((/** @type {any} */ a) => a.app === 'varve-dj');
    expect(fl).toMatchObject({
      app: 'formula-lab', naam: 'Formula Lab', status: 'actief', focus: true, slot: 1, lease: false,
      waarden: { in1: 0.25 },
    });
    expect(fl.params.map((/** @type {any} */ p) => p.id)).toEqual(['in1']);
    expect(typeof fl.kleur).toBe('string');
    expect(dj).toMatchObject({ app: 'varve-dj', focus: false, slot: 2, lease: true });
    expect(() => JSON.stringify(b)).not.toThrow();

    // Meldingen: hooguit 10x per seconde, ook als er heel veel verandert, en nooit te laat.
    const app = h.apps[0];
    h.tijd(1000);
    const t0 = h.klok.nu();
    for (let i = 0; i < 100; i++) { app.zet('in1', (i % 50) / 50); h.klok.loop(10); }
    h.tijd(300);
    const inSeconde = h.ev.beeld.filter((t) => t >= t0 && t < t0 + 1000);
    expect(inSeconde.length).toBeGreaterThan(0);
    expect(inSeconde.length).toBeLessThanOrEqual(11);

    h.tijd(2000);
    const t1 = h.klok.nu();
    app.zet('in1', 0.123);
    h.tijd(250);
    expect(h.ev.beeld.some((t) => t >= t1)).toBe(true);
  });

  it('de cockpit ziet elke LED die de kern zet, elke controller-gebeurtenis en elk bericht naar een app', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1'), P.knop('k1'), P.schakelaar('aan')]), { in1: 0.2, k1: 0.4, aan: 1 });
    const ws = h.app(manifest('waterschaal', [P.fader('x')]), { x: 0.5 });
    h.even();
    h.metHubtoets(() => h.tik('sel2'));
    h.fader(1, 0.5);
    h.lpdKnop(1, 0.5);
    h.tijd(1000);

    // LEDs: voor elke control is de laatste 'leds'-melding gelijk aan de laatste oppervlak.zet.
    expect(h.ev.leds.length).toBeGreaterThan(0);
    for (const e of h.ev.leds) expect(e.dev).toBe('apc40');
    /** @type {Record<string, unknown>} */
    const gemeld = {}, gezet = {};
    for (const e of h.ev.leds) Object.assign(gemeld, e.staat);
    for (const [id, s] of h.opp.zetten) gezet[id] = s;
    expect(gemeld).toEqual(JSON.parse(JSON.stringify(gezet)));

    // Invoer: APC en LPD8.
    const els = h.ev.invoer.map((g) => `${g.dev}:${g.el}`);
    expect(els).toEqual(expect.arrayContaining(['apc40:bank', 'apc40:sel2', 'apc40:fader1', 'lpd8:k1']));

    // naarApp: precies wat de apps ontvingen.
    for (const a of [fl, ws]) {
      const zonderWelkom = (/** @type {any[]} */ l) => l.filter((b) => b.t !== 'welkom');
      expect(zonderWelkom(h.ev.naarApp.filter(([app]) => app === a.id).map(([, b]) => b))).toEqual(zonderWelkom(a.ontvangen));
    }
  });

  it('stop() ruimt alle timers op: daarna gebeurt er niets meer', () => {
    const h = bank();
    const ms = h.app(manifest('medisynth', [P.waarde('ruimte', { rol: 'macro.ruimte', slew_s: 10 })]), { ruimte: 0.5 });
    h.even();
    h.lpdSchuif(3, 0, 1);
    h.lpdDruk(1); // paniek-timer loopt
    h.kern.stop();
    expect(h.klok.timers.size).toBe(0);
    ms.wis();
    h.klok.loop(20000);
    expect(ms.ontvangen).toEqual([]);
  });
});
