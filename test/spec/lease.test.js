// @ts-check
// Specificatie: lease-modus (PROTOCOL.md §5) — Varve DJ en av-kern krijgen ruwe APC-MIDI en tekenen zelf LEDs.
import { describe, it, expect, afterEach } from 'vitest';
import { Kern, MELDING, Bank, P, manifest, leaseManifest, configKleur, fysiek } from './hulp.js';
import { isModeSysex } from '../../src/protocol/berichten.js';

const MODE_SYSEX = [0xf0, 0x47, 0x7f, 0x29, 0x60, 0x00, 0x04, 0x41, 0x00, 0x00, 0x00, 0xf7];

describe.skipIf(!Kern)(`Lease-apps: Varve DJ en av-kern${MELDING}`, () => {
  /** @type {Bank[]} */
  let banken = [];
  const bank = (/** @type {any} */ o) => { const b = new Bank(o); banken.push(b); return b; };
  afterEach(() => { for (const b of banken) b.stop(); banken = []; });

  it('lease-app met focus krijgt alle APC-invoer als ruwe MIDI, behalve de hubtoets en alles wat je met de hubtoets doet', () => {
    const h = bank();
    const dj = h.app(leaseManifest('varve-dj'));
    h.even();
    expect(h.kern.beeld().focus).toBe('varve-dj');

    h.druk('pad1-1');
    h.los('pad1-1');
    h.fader(3, 0.5);
    h.draai('dk1', 1);
    h.druk('sel4');
    expect(dj.midi()).toEqual([
      { t: 'midi', dev: 'apc40', bytes: [0x90, 0, 127] },
      { t: 'midi', dev: 'apc40', bytes: [0x80, 0, 0] },
      { t: 'midi', dev: 'apc40', bytes: [0xb2, 7, 64] },
      { t: 'midi', dev: 'apc40', bytes: [0xb0, 16, 127] },
      { t: 'midi', dev: 'apc40', bytes: [0x93, 51, 127] },
    ]);

    dj.wis();
    h.metHubtoets(() => {
      h.tik('pad1-1');
      h.fader(3, 0.9);
      h.tik('sel1');
    });
    expect(dj.midi()).toEqual([]);
    h.tik('pad2-2');
    expect(dj.midi().map((m) => m.bytes)).toEqual([[0x90, 9, 127], [0x80, 9, 0]]);
  });

  it('lease-app zonder focus krijgt geen MIDI; de LPD8 gaat nooit als MIDI naar een lease-app, wel als globaal', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.waarde('ruimte', { rol: 'macro.ruimte' })]), { ruimte: 0.5 });
    const dj = h.app(leaseManifest('varve-dj'));
    h.even();
    h.tik('pad1-1');
    h.fader(1, 0.3);
    expect(dj.midi()).toEqual([]);

    // Nu met focus op de lease-app: de LPD8 werkt nog steeds voor iedereen.
    h.metHubtoets(() => h.tik('sel2'));
    dj.wis();
    h.lpdSchuif(3, 0, 1);
    h.lpdHoud(5, 100);
    h.even();
    expect(dj.midi()).toEqual([]);
    expect(dj.globaal().some((b) => 'macro.ruimte' in b.waarden)).toBe(true);
    expect(fl.laatsteZet('ruimte')?.v).toBeCloseTo(1, 2);
  });

  it('LEDs van een lease-app zonder focus wachten; bij focus staat zijn kaart precies op de APC en de rest is uit', () => {
    const h = bank();
    h.app(manifest('formula-lab', [P.keuze('palet', ['a', 'b', 'c', 'd', 'e']), P.schakelaar('aan')]), { palet: 0.25, aan: 1 });
    const dj = h.app(leaseManifest('varve-dj'));
    h.even();
    const formulaGrid = JSON.stringify(h.apc.grid());

    dj.led([[0x90, 0, 5], [0x90, 9, 13], [0x97, 33, 21], [0x90, 82, 45], [0x92, 48, 127]]);
    h.even();
    expect(JSON.stringify(h.apc.grid())).toBe(formulaGrid); // nog niets van Varve DJ te zien
    expect(h.apc.rgb('scene1').kleur).not.toBe(45);

    h.metHubtoets(() => h.tik('sel2'));
    h.even();
    expect(h.apc.brandend().sort()).toEqual(['pad1-1', 'pad2-2', 'pad5-2']);
    expect(h.apc.rgb('pad1-1')).toMatchObject({ kleur: 5, anim: null });
    expect(h.apc.rgb('pad2-2')).toMatchObject({ kleur: 13, anim: null });
    expect(h.apc.rgb('pad5-2')).toMatchObject({ kleur: 21, anim: 'puls' });
    expect(h.apc.rgb('scene1').kleur).toBe(45);
    expect(h.apc.noot('rec3')).toBe(127);

    // Terug naar de manifest-app: zijn eigen beeld, niets meer van Varve DJ.
    h.metHubtoets(() => h.tik('sel1'));
    h.even();
    expect(JSON.stringify(h.apc.grid())).toBe(formulaGrid);
    expect(h.apc.rgb('scene1').kleur).not.toBe(45);
    expect(h.apc.noot('rec3')).toBe(0);
  });

  it('twee lease-apps: wisselen toont telkens precies de laatste LED-staat van elke app', () => {
    const h = bank();
    const dj = h.app(leaseManifest('varve-dj'));
    const ak = h.app(leaseManifest('av-kern', { rings: 'auto' }));
    h.even();
    dj.led([[0x90, 0, 5], [0x90, 0, 9], [0x90, 1, 60]]); // pad1-1 eerst 5, dan 9: de laatste telt
    ak.led([[0x90, 7, 41], [0x9c, 39, 45]]);
    h.even();
    expect(h.apc.rgb('pad1-1').kleur).toBe(9);

    for (let ronde = 0; ronde < 2; ronde++) {
      h.metHubtoets(() => h.tik('sel2'));
      h.even();
      expect(h.apc.brandend().sort()).toEqual(['pad1-8', 'pad5-8']);
      expect(h.apc.rgb('pad1-8')).toMatchObject({ kleur: 41, anim: null });
      expect(h.apc.rgb('pad5-8')).toMatchObject({ kleur: 45, anim: 'knipper' });

      dj.led([[0x80, 1, 0], [0x90, 2, 13]]); // Varve DJ tekent door terwijl hij geen focus heeft
      h.even();
      expect(h.apc.rgb('pad1-3').aan).toBe(false);

      h.metHubtoets(() => h.tik('sel1'));
      h.even();
      expect(h.apc.brandend().sort()).toEqual(['pad1-1', 'pad1-3']);
      expect(h.apc.rgb('pad1-1').kleur).toBe(9);
      expect(h.apc.rgb('pad1-3').kleur).toBe(13);
    }
  });

  it('hubtoets loslaten bij een lease-app → zijn LEDs komen terug en de slot-weergave verdwijnt', () => {
    const h = bank();
    const dj = h.app(leaseManifest('varve-dj'));
    h.app(manifest('formula-lab', []));
    h.even();
    dj.led([[0x90, 32, 45], [0x90, 0, 5]]);
    h.even();

    h.druk(h.hubtoets());
    h.even();
    expect(h.apc.rgb('pad5-1').anim).toBe('puls');
    expect(h.apc.rgb('pad5-2').kleur).toBe(configKleur('formula-lab'));
    h.los(h.hubtoets());
    h.even();
    expect(h.apc.rgb('pad5-1')).toMatchObject({ kleur: 45, anim: null });
    expect(h.apc.rgb('pad5-2').aan).toBe(false);
    expect(h.apc.rgb('pad1-1').kleur).toBe(5);
  });

  it('mode-SysEx van een app komt nooit op het oppervlak, ook niet bij wisselen', () => {
    const h = bank();
    const dj = h.app(leaseManifest('varve-dj'));
    h.app(manifest('formula-lab', []));
    h.even();
    // Rechtstreeks naar de kern, zonder de filter van de transportlaag: de kern moet zelf weigeren.
    h.kern.ontvang(dj.v, { t: 'led', bytes: [MODE_SYSEX, [0x90, 0, 5]] });
    h.even();
    expect(h.apc.rgb('pad1-1').kleur).toBe(5);

    h.metHubtoets(() => h.tik('sel2'));
    h.even();
    h.metHubtoets(() => h.tik('sel1'));
    h.even();
    // De hub mag zelf de modus zetten (0x42, bv. na een herstart van de APC); de 0x41 van de app nooit.
    const vanApp = (/** @type {number[]} */ b) => isModeSysex(b) && b[7] !== 0x42;
    expect(h.apc.sysex.filter(vanApp)).toEqual([]);
    expect(h.opp.gestuurd.filter(vanApp)).toEqual([]);
  });

  it('een pulserend pad van een lease-app komt na wisselen terug als puls op zijn basiskleur', () => {
    const h = bank();
    const dj = h.app(leaseManifest('varve-dj'));
    h.app(manifest('formula-lab', []));
    h.even();
    // Basiskleur 5 op kanaal 0, dan puls naar 21 op kanaal 7 (PROTOCOL.md: eerst basis, dan animatie).
    dj.led([[0x90, 10, 5], [0x97, 10, 21]]);
    h.even();
    expect(h.apc.rgb('pad2-3')).toMatchObject({ basis: 5, anim: 'puls', animKleur: 21 });
    for (let ronde = 0; ronde < 2; ronde++) {
      h.metHubtoets(() => h.tik('sel2'));
      h.even();
      expect(h.apc.rgb('pad2-3').aan).toBe(false);
      h.metHubtoets(() => h.tik('sel1'));
      h.even();
      expect(h.apc.rgb('pad2-3'), `ronde ${ronde + 1}`).toMatchObject({ basis: 5, anim: 'puls', animKleur: 21 });
    }
    // Hubtoets indrukken en loslaten tekent ook alles opnieuw.
    h.metHubtoets(() => h.even());
    h.even();
    expect(h.apc.rgb('pad2-3')).toMatchObject({ basis: 5, anim: 'puls', animKleur: 21 });
  });

  it('rings auto (av-kern): draaien zet ook de ring, zoals APC-modus 0x41; rings host (Varve DJ) laat de ring aan de app', () => {
    const h = bank();
    const ak = h.app(leaseManifest('av-kern', { rings: 'auto' }));
    h.even();
    h.draai('dk3', 0.7);
    h.draai('tk2', 0.2);
    expect(ak.midi().map((m) => m.bytes)).toEqual([[0xb0, 18, 89], [0xb0, 49, 25]]);
    expect(h.apc.ring('dk3')).toBeCloseTo(fysiek(0.7), 3);
    expect(h.apc.ring('tk2')).toBeCloseTo(fysiek(0.2), 3);

    const h2 = bank();
    const dj = h2.app(leaseManifest('varve-dj'));
    h2.even();
    h2.draai('dk3', 0.7);
    h2.even();
    expect(dj.midi().map((m) => m.bytes)).toEqual([[0xb0, 18, 89]]);
    expect(h2.apc.ring('dk3') ?? 0).not.toBeCloseTo(fysiek(0.7), 3);
  });
});
