// @ts-check
// Specificatie: focus, slots en de hubtoets (PROTOCOL.md §3, §7 "Hubtoets ingedrukt").
// Zwarte doos: alleen wat Clay op de APC ziet en wat de apps ontvangen.
import { describe, it, expect, afterEach } from 'vitest';
import { Kern, MELDING, Bank, P, manifest, configKleur, appKleur } from './hulp.js';

describe.skipIf(!Kern)(`Focus en de hubtoets${MELDING}`, () => {
  /** @type {Bank[]} */
  let banken = [];
  const bank = (/** @type {any} */ o) => { const b = new Bank(o); banken.push(b); return b; };
  afterEach(() => { for (const b of banken) b.stop(); banken = []; });

  it('de eerste app die verbindt krijgt meteen de focus, een tweede app niet', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1')]), { in1: 0.2 });
    h.even();
    expect(h.kern.beeld().focus).toBe('formula-lab');
    expect(fl.focus()).toBe(true);

    const ws = h.app(manifest('waterschaal', [P.fader('x')]), { x: 0.5 });
    h.even();
    expect(h.kern.beeld().focus).toBe('formula-lab');
    expect(ws.focus()).not.toBe(true);
    expect(h.appBeeld('formula-lab').focus).toBe(true);
    expect(h.appBeeld('waterschaal').focus).toBe(false);
  });

  it('apps krijgen een slot in volgorde van aanmelden en houden dat slot als ze terugkomen', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', []));
    h.app(manifest('waterschaal', []));
    h.app(manifest('medisynth', []));
    h.even();
    expect([1, 2, 3].map((s) => h.kern.beeld().apps.find((/** @type {any} */ a) => a.slot === s)?.app))
      .toEqual(['formula-lab', 'waterschaal', 'medisynth']);

    fl.verbreek();
    h.tijd(2000);
    fl.verbind();
    h.app(manifest('uurwerk', []));
    h.even();
    expect(h.appBeeld('formula-lab').slot).toBe(1);
    expect(h.appBeeld('uurwerk').slot).toBe(4);
  });

  it('Bank + Track Select 2 → app 2 krijgt de focus en zijn LEDs staan op de APC', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.schakelaar('licht')]), { licht: 1 });
    const ws = h.app(manifest('waterschaal', [P.schakelaar('licht')]), { licht: 1 });
    h.even();
    const groen = configKleur('formula-lab'), cyaan = configKleur('waterschaal');
    expect(h.apc.brandend().some((id) => h.apc.rgb(id).kleur === groen)).toBe(true);

    h.metHubtoets(() => h.tik('sel2'));
    h.even();
    expect(h.kern.beeld().focus).toBe('waterschaal');
    expect(ws.focus()).toBe(true);
    expect(fl.focus()).toBe(false);
    const kleuren = h.apc.brandend().map((id) => h.apc.rgb(id).kleur);
    expect(kleuren).toContain(cyaan);
    expect(kleuren).not.toContain(groen);

    // Een leeg slot kiezen verandert niets.
    h.metHubtoets(() => h.tik('sel6'));
    h.even();
    expect(h.kern.beeld().focus).toBe('waterschaal');

    // De cockpit en kern.focus() doen hetzelfde als Bank + Track Select.
    h.kern.cockpit({ t: 'focus', app: 'formula-lab' });
    h.even();
    expect(h.kern.beeld().focus).toBe('formula-lab');
    expect(fl.focus()).toBe(true);
    expect(ws.focus()).toBe(false);
    h.kern.focus('waterschaal');
    h.even();
    expect(h.kern.beeld().focus).toBe('waterschaal');
  });

  it('hubtoets ingedrukt → bovenste rij toont de apps: focus pulseert, actief vol, stil knippert, weg en leeg uit', () => {
    const h = bank();
    h.app(manifest('formula-lab', []));
    h.app(manifest('waterschaal', []));
    const ms = h.app(manifest('medisynth', []));
    const uw = h.app(manifest('uurwerk', []));
    // Eigen manifestkleur gaat voor de kleur uit config.json.
    h.app(manifest('td-lab', [], { kleur: '#00ff00' }));
    uw.verbreek();
    ms.zwijg();
    h.tijd(4000);

    h.druk(h.hubtoets());
    h.even();
    const s1 = h.apc.rgb('pad5-1'), s2 = h.apc.rgb('pad5-2'), s3 = h.apc.rgb('pad5-3'), s4 = h.apc.rgb('pad5-4');
    expect(s1.anim).toBe('puls');
    expect([s1.basis, s1.animKleur]).toContain(configKleur('formula-lab'));
    expect(s2.anim).toBe(null);
    expect(s2.kleur).toBe(configKleur('waterschaal'));
    expect(s3.anim).toBe('knipper');
    expect([s3.basis, s3.animKleur]).toContain(configKleur('medisynth'));
    expect(s4.aan).toBe(false);
    expect(h.apc.rgb('pad5-5').kleur).toBe(appKleur('#00ff00'));
    for (const k of [6, 7, 8]) expect(h.apc.rgb(`pad5-${k}`).aan).toBe(false);
    h.los(h.hubtoets());
  });

  it('hubtoets ingedrukt → niets van wat je aanraakt bereikt een app', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [
      P.fader('in1'), P.knop('k1'), P.trigger('take'), P.schakelaar('aan'), P.keuze('palet', ['a', 'b', 'c']),
      P.trigger('paniek'),
    ], { scenes: ['A', 'B'] }), { in1: 0.5, k1: 0.5, aan: 0, palet: 0 });
    h.app(manifest('waterschaal', [P.fader('x')]), { x: 0.5 });
    h.fader(1, 0.5); // fader gevangen: zonder hubtoets zou hij doorkomen
    h.even();
    fl.wis();

    h.metHubtoets(() => {
      h.fader(1, 0.8);
      h.draai('dk1', 0.9);
      h.draai('tk1', 0.9);
      for (let r = 1; r <= 4; r++) for (let k = 1; k <= 8; k++) h.tik(`pad${r}-${k}`);
      h.tik('stopall');
      h.tik('play');
      h.tik('up');
    });
    h.even();
    const naarApp = fl.ontvangen.filter((b) => ['zet', 'trig', 'scene', 'midi'].includes(b.t));
    expect(naarApp).toEqual([]);
    expect(h.appBeeld('formula-lab').waarden.in1).toBeCloseTo(0.5, 2);
  });

  it('hubtoets loslaten → de focus-app staat weer precies zoals hij stond', () => {
    const h = bank();
    h.app(manifest('formula-lab', [P.keuze('palet', ['a', 'b', 'c', 'd', 'e']), P.schakelaar('aan')]), { palet: 1, aan: 1 });
    h.app(manifest('waterschaal', []));
    h.even();
    const voor = JSON.stringify(h.apc.grid());

    h.druk(h.hubtoets());
    h.even();
    expect(h.apc.rgb('pad5-1').anim).toBe('puls');
    expect(JSON.stringify(h.apc.grid())).not.toBe(voor);
    h.los(h.hubtoets());
    h.even();
    expect(JSON.stringify(h.apc.grid())).toBe(voor);
  });
});
