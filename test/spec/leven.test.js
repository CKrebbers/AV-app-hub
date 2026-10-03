// @ts-check
// Specificatie: apps komen en gaan (hartslag, herverbinden, truth), snapshots, cockpit en de kern-events
// (PROTOCOL.md §3, §6, §8).
import { describe, it, expect, afterEach } from 'vitest';
import { Kern, MELDING, Bank, P, manifest, leaseManifest, configKleur, fysiek } from './hulp.js';

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

    // Hij komt weer tot leven (verbinding was nooit dicht): één bericht is genoeg.
    ws.hb();
    h.even();
    expect(h.appBeeld('waterschaal').status).toBe('actief');
    h.metHubtoets(() => { h.even(); expect(h.apc.rgb('pad5-2')).toMatchObject({ kleur: configKleur('waterschaal'), anim: null }); });
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
    for (const a of [fl, ws, ms]) expect(a.van('scene'), `${a.id}: Bank + Scene is een hub-snapshot, geen scène`).toEqual([]);
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

  it('kern.beeld() geeft de cockpit alles (apps met slot, status, focus, params, waarden; globaal; apparaten) en meldt wijzigingen hooguit 10x per seconde, ook tijdens aanhoudend bewegen (throttle, geen debounce)', () => {
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

  it('de virtuele APC in de cockpit toont precies wat de echte APC toont, ook bij de hubtoets en bij een lease-app', () => {
    const h = bank();
    h.app(manifest('formula-lab', [P.fader('in1'), P.knop('k1'), P.schakelaar('aan'), P.keuze('palet', ['a', 'b', 'c'])]), { in1: 0.2, k1: 0.4, aan: 1, palet: 0.5 });
    h.app(manifest('waterschaal', [P.fader('x'), P.knop('y')]), { x: 0.5, y: 0.9 });
    const dj = h.app(leaseManifest('varve-dj'));
    h.tijd(500);
    // De cockpit begint met alles uit en krijgt alleen gewijzigde LEDs (PROTOCOL.md §8): wat hij daaruit opbouwt
    // moet op elk moment gelijk zijn aan wat er fysiek op de APC staat.
    for (const e of h.ev.leds) expect(e.dev).toBe('apc40');
    expect(h.cockpitVerschil(), 'formula-lab met focus').toEqual([]);

    h.druk(h.hubtoets());
    h.even();
    expect(h.cockpitVerschil(), 'hubtoets ingedrukt').toEqual([]);
    h.tik('sel2');
    h.los(h.hubtoets());
    h.even();
    expect(h.cockpitVerschil(), 'waterschaal met focus').toEqual([]);
    h.fader(1, 0.9); // pickup: clip stop knippert
    h.even();
    expect(h.cockpitVerschil(), 'fader niet opgepakt').toEqual([]);

    // Lease-app: zijn LEDs lopen niet via zet() maar als ruwe bytes; de cockpit moet ze toch zien.
    dj.led([[0x90, 0, 5], [0x90, 9, 13], [0x97, 33, 21], [0x90, 82, 45], [0x92, 48, 127], [0xb0, 16, 100]]);
    h.metHubtoets(() => h.tik('sel3'));
    h.even();
    expect(h.apc.rgb('pad1-1').kleur).toBe(5);
    expect(h.cockpitVerschil(), 'varve-dj met focus').toEqual([]);
    dj.led([[0x80, 0, 0], [0x90, 1, 60]]);
    h.even();
    expect(h.cockpitVerschil(), 'varve-dj tekent door').toEqual([]);

    h.metHubtoets(() => h.tik('sel1'));
    h.tijd(500);
    expect(h.cockpitVerschil(), 'terug naar formula-lab').toEqual([]);
  });

  it('de cockpit ziet elke controller-gebeurtenis en elk bericht naar een app', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1'), P.knop('k1'), P.schakelaar('aan')]), { in1: 0.2, k1: 0.4, aan: 1 });
    const ws = h.app(manifest('waterschaal', [P.fader('x')]), { x: 0.5 });
    h.even();
    h.metHubtoets(() => h.tik('sel2'));
    h.fader(1, 0.5);
    h.lpdKnop(1, 0.5);
    h.tijd(1000);

    // Invoer: APC en LPD8.
    const els = h.ev.invoer.map((g) => `${g.dev}:${g.el}`);
    expect(els).toEqual(expect.arrayContaining(['apc40:bank', 'apc40:sel2', 'apc40:fader1', 'lpd8:k1']));

    // naarApp: precies wat de apps ontvingen.
    for (const a of [fl, ws]) {
      const zonderWelkom = (/** @type {any[]} */ l) => l.filter((b) => b.t !== 'welkom');
      expect(zonderWelkom(h.ev.naarApp.filter(([app]) => app === a.id).map(([, b]) => b))).toEqual(zonderWelkom(a.ontvangen));
    }
  });

  it('rommel van apps, cockpit en controllers laat de hub heel; daarna speelt alles gewoon (PROTOCOL.md §1.5)', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1')]), { in1: 0.4 });
    const dj = h.app(leaseManifest('varve-dj'));
    h.even();
    h.wisApps();

    // Een verbinding die nooit hallo zei, stuurt van alles en gaat (twee keer) dicht.
    /** @type {any[]} */
    const naamloosOntvangen = [];
    const naamloos = { app: null, stuur: (/** @type {any} */ b) => naamloosOntvangen.push(b) };
    h.kern.verbind(naamloos);
    for (const b of [
      { t: 'staat', waarden: { in1: 0.9 } }, { t: 'zet', id: 'in1', v: 0.9 }, { t: 'hb' },
      { t: 'led', bytes: [[0x90, 0, 5], [0x90, 82, 45]] },
      { t: 'manifest', manifest: manifest('formula-lab', [P.fader('in1')]) },
    ]) h.kern.ontvang(naamloos, b);
    h.kern.verbreek(naamloos);
    h.kern.verbreek(naamloos);

    // Een gewone app zegt onzin: onbekende parameter, en LEDs terwijl hij geen lease-app is.
    fl.zeg({ t: 'zet', id: 'bestaat-niet', v: 0.5 });
    fl.zeg({ t: 'staat', waarden: { 'bestaat-niet': 0.3 } });
    fl.zeg({ t: 'led', bytes: [[0x90, 0, 5], [0x90, 82, 45]] });

    // De cockpit vraagt dingen die niet bestaan.
    h.kern.cockpit({ t: 'zet', app: 'bestaat-niet', id: 'x', v: 0.5 });
    h.kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'bestaat-niet', v: 0.5 });
    h.kern.cockpit({ t: 'zet', app: 'varve-dj', id: 'x', v: 0.5 });
    h.kern.cockpit({ t: 'focus', app: 'bestaat-niet' });
    h.kern.focus('bestaat-niet');
    h.kern.cockpit({ t: 'snapshot', nr: 99, actie: 'laad' });
    h.kern.cockpit({ t: 'snapshot', nr: 0, actie: 'bewaar' });
    h.kern.cockpit({ t: 'snapshot', nr: 4, actie: 'laad' }); // nooit bewaard

    // Controllers sturen berichten zonder control (el null): pitchbend, program change, SysEx, onbekende noot.
    h.midi([0xe0, 0, 64]);
    h.midi([0xc0, 5]);
    h.midi([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x29, 0x00, 0x19, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xf7]);
    h.midi([0x90, 120, 127]);
    h.lpdMidi([0xc0, 3]);
    h.lpdMidi([0xb0, 1, 64]);
    h.lpdMidi([0x99, 60, 100]);
    h.lpdMidi([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x4c, 0x00, 0x19, 0x00, 0xf7]);
    h.tijd(1000);

    // Niets kwam bij de apps of op het oppervlak terecht.
    expect(fl.ontvangen.filter((b) => ['zet', 'trig', 'scene', 'midi'].includes(b.t))).toEqual([]);
    expect(dj.ontvangen.filter((b) => ['zet', 'trig', 'scene'].includes(b.t))).toEqual([]);
    expect(naamloosOntvangen.filter((b) => ['zet', 'trig', 'scene', 'midi'].includes(b.t))).toEqual([]);
    expect(h.apc.rgb('pad1-1').kleur).not.toBe(5);
    expect(h.apc.rgb('scene1').kleur).not.toBe(45);
    expect(h.kern.beeld().focus).toBe('formula-lab');
    expect(h.kern.beeld().apps.map((/** @type {any} */ a) => a.app).sort()).toEqual(['formula-lab', 'varve-dj']);
    expect(h.appBeeld('formula-lab')).toMatchObject({ status: 'actief', waarden: { in1: 0.4 } });

    // En de hub speelt gewoon door.
    h.fader(1, 0.4);
    h.fader(1, 0.45);
    expect(fl.laatsteZet('in1')).toMatchObject({ bron: 'apc40' });
    expect(fl.laatsteZet('in1')?.v).toBeCloseTo(fysiek(0.45), 2);
  });

  it('app verbindt opnieuw terwijl de oude verbinding nog niet dicht is → de nieuwe telt; het late sluiten van de oude maakt de app niet weg', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1')]), { in1: 0.4 });
    h.even();
    const oud = fl.v;
    /** @type {any[]} */
    const oudOntvangen = [];
    oud.stuur = (/** @type {any} */ b) => oudOntvangen.push(b);
    fl.verbind(); // zelfde app, nieuwe socket; de oude hangt nog
    h.even();
    h.kern.verbreek(oud); // de oude socket sluit pas nu
    h.tijd(500);
    expect(h.appBeeld('formula-lab')).toMatchObject({ status: 'actief', slot: 1 });
    expect(h.kern.beeld().apps).toHaveLength(1);

    fl.wis();
    h.fader(1, 0.4);
    h.fader(1, 0.45);
    expect(fl.laatsteZet('in1')?.v).toBeCloseTo(fysiek(0.45), 2);
    expect(oudOntvangen.filter((b) => b.t === 'zet')).toEqual([]);
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
