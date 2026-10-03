// @ts-check
// Specificatie: een manifest-app bespelen op de APC (PROTOCOL.md §4, §7): indeling, pickup, ringen, grid.
// De precieze plek van pads op het grid ligt niet vast in het protocol; de tests zoeken die op zoals een
// speler dat doet: kijken wat brandt en drukken.
import { describe, it, expect, afterEach } from 'vitest';
import { Kern, MELDING, Bank, P, manifest, configKleur, helderheid, fysiek, keuzeWaarde, vindPad } from './hulp.js';

describe.skipIf(!Kern)(`Een manifest-app bespelen op de APC${MELDING}`, () => {
  /** @type {Bank[]} */
  let banken = [];
  const bank = (/** @type {any} */ o) => { const b = new Bank(o); banken.push(b); return b; };
  afterEach(() => { for (const b of banken) b.stop(); banken = []; });

  it('faders volgen het manifest: eerst de fader-parameters, daarna de overige waarden', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [
      P.waarde('a'), P.fader('f1'), P.trigger('t'), P.fader('f2'), P.waarde('b'),
    ]), { a: 0, f1: 0, f2: 0, b: 0 });
    h.even();
    /** @type {Record<number, string|null>} */
    const kaart = {};
    for (let i = 1; i <= 5; i++) {
      fl.wis();
      h.fader(i, 0);
      h.fader(i, 0.5);
      const z = fl.zetten().at(-1);
      kaart[i] = z?.id ?? null;
      if (z) expect(z).toMatchObject({ v: fysiek(0.5), bron: 'apc40' });
    }
    expect(kaart).toEqual({ 1: 'f1', 2: 'f2', 3: 'a', 4: 'b', 5: null });
  });

  it('fader staat fysiek op 0.9, app op 0.2 → bewegen verandert niets tot hij 0.2 kruist; tot dan knippert clip stop', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1'), P.fader('in2')]), { in1: 0.2, in2: 0.5 });
    h.even();
    expect(h.apc.clipstop('stop1')).toBe('knipper');
    expect(h.apc.clipstop('stop8')).not.toBe('knipper'); // strip zonder parameter

    for (const v of [0.9, 0.7, 0.5, 0.3]) h.fader(1, v);
    h.even();
    expect(fl.zetten('in1')).toEqual([]);
    expect(h.apc.clipstop('stop1')).toBe('knipper');

    h.fader(1, 0.1); // kruist 0.2 → gevangen
    h.even();
    expect(fl.laatsteZet('in1')?.v).toBeCloseTo(fysiek(0.1), 2);
    expect(h.apc.clipstop('stop1')).not.toBe('knipper');
    h.fader(1, 0.15);
    expect(fl.laatsteZet('in1')?.v).toBeCloseTo(fysiek(0.15), 2);

    // Een fader die vlak bij de waarde begint (binnen 0.02) is meteen gevangen.
    h.fader(2, 0.51);
    expect(fl.laatsteZet('in2')?.v).toBeCloseTo(fysiek(0.51), 2);
  });

  it('app verandert zelf een waarde → de fader moet opnieuw opgepakt worden, behalve als hij er vlak bij staat', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1')]), { in1: 0.5 });
    h.even();
    h.fader(1, 0.5);
    h.fader(1, 0.3);
    expect(fl.laatsteZet('in1')?.v).toBeCloseTo(fysiek(0.3), 2);

    fl.wis();
    fl.zet('in1', 0.7); // muis in de app
    h.even();
    expect(h.apc.clipstop('stop1')).toBe('knipper');
    h.fader(1, 0.35);
    h.fader(1, 0.5);
    expect(fl.zetten('in1')).toEqual([]);
    h.fader(1, 0.75); // kruist 0.7
    expect(fl.laatsteZet('in1')?.v).toBeCloseTo(fysiek(0.75), 2);

    // Vlak bij de fysieke stand: blijft gevangen.
    fl.zet('in1', fysiek(0.75) + 0.01);
    fl.wis();
    h.fader(1, 0.6);
    expect(fl.laatsteZet('in1')?.v).toBeCloseTo(fysiek(0.6), 2);
  });

  it('focus wisselen terwijl de fader nog op de stand van de vorige app staat → niets springt; eerst de nieuwe waarde kruisen', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1')]), { in1: 0.8 });
    const ws = h.app(manifest('waterschaal', [P.fader('x')]), { x: 0.2 });
    h.even();
    h.fader(1, 0.8); // opgepakt voor formula-lab
    h.fader(1, 0.79);
    expect(fl.laatsteZet('in1')?.v).toBeCloseTo(fysiek(0.79), 2);
    expect(h.apc.clipstop('stop1')).not.toBe('knipper');

    h.metHubtoets(() => h.tik('sel2'));
    h.even();
    expect(h.apc.clipstop('stop1')).toBe('knipper');
    h.wisApps();
    h.fader(1, 0.78);
    h.schuif('fader1', 0.78, 0.6);
    h.even();
    expect(ws.zetten('x')).toEqual([]);
    expect(h.appBeeld('waterschaal').waarden.x).toBeCloseTo(0.2, 3);
    expect(h.apc.clipstop('stop1')).toBe('knipper');

    h.schuif('fader1', 0.6, 0.15); // kruist 0.2 → opgepakt voor waterschaal
    h.even();
    expect(ws.zetten('x').length).toBeGreaterThan(0);
    expect(ws.zetten('x')[0].v).toBeGreaterThanOrEqual(0.18);
    expect(ws.laatsteZet('x')?.v).toBeCloseTo(fysiek(0.15), 2);
    expect(h.apc.clipstop('stop1')).not.toBe('knipper');
    expect(fl.zetten()).toEqual([]);

    // Terug naar formula-lab: die staat nog op 0.79 en moet opnieuw opgepakt worden.
    h.metHubtoets(() => h.tik('sel1'));
    h.even();
    expect(h.apc.clipstop('stop1')).toBe('knipper');
    h.wisApps();
    h.schuif('fader1', 0.15, 0.5);
    expect(fl.zetten('in1')).toEqual([]);
    expect(ws.zetten()).toEqual([]);
    h.schuif('fader1', 0.5, 0.85);
    expect(fl.zetten('in1').length).toBeGreaterThan(0);
    expect(fl.zetten('in1')[0].v).toBeGreaterThanOrEqual(0.76);
  });

  it('app herstart (nieuwe inst) met een andere waarde → de fader moet opnieuw opgepakt worden; een haperende verbinding (zelfde inst) speelt gewoon door', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1')]), { in1: 0.8 });
    h.even();
    h.fader(1, 0.8);
    expect(fl.laatsteZet('in1')?.v).toBeCloseTo(fysiek(0.8), 2);

    // Netwerkhapering: zelfde inst, zelfde waarde → meteen weer bespeelbaar.
    fl.waarden.in1 = fysiek(0.8);
    fl.verbreek();
    h.tijd(500);
    fl.verbind();
    h.even();
    fl.wis();
    h.fader(1, 0.75);
    expect(fl.laatsteZet('in1')?.v).toBeCloseTo(fysiek(0.75), 2);

    // Herstart: nieuwe inst, app begint weer op 0.2 → de fader op 0.75 mag niets doen tot hij 0.2 kruist.
    fl.waarden.in1 = 0.2;
    fl.verbreek();
    h.tijd(500);
    fl.verbind({ inst: 'herstart' });
    h.even();
    expect(h.apc.clipstop('stop1')).toBe('knipper');
    fl.wis();
    h.schuif('fader1', 0.75, 0.4);
    expect(fl.zetten('in1')).toEqual([]);
    expect(h.appBeeld('formula-lab').waarden.in1).toBeCloseTo(0.2, 3);
    h.schuif('fader1', 0.4, 0.1);
    expect(fl.zetten('in1').length).toBeGreaterThan(0);
    expect(fl.zetten('in1')[0].v).toBeLessThanOrEqual(0.22);
  });

  it('snapshot laden → de faders moeten de geladen waarden opnieuw oppakken', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.fader('in1')]), { in1: 0.3 });
    h.even();
    h.fader(1, 0.3);
    h.metHubtoets(() => { h.druk('shift'); h.tik('scene1'); h.los('shift'); }); // bewaren: in1 = 0.3
    h.schuif('fader1', 0.3, 0.8);
    expect(fl.laatsteZet('in1')?.v).toBeCloseTo(fysiek(0.8), 2);

    h.metHubtoets(() => h.tik('scene1')); // laden: in1 terug naar 0.3, fader staat nog op 0.8
    h.even();
    expect(fl.laatsteZet('in1')).toMatchObject({ bron: 'snapshot' });
    expect(h.apc.clipstop('stop1')).toBe('knipper');
    fl.wis();
    h.schuif('fader1', 0.8, 0.5);
    expect(fl.zetten('in1')).toEqual([]);
    h.schuif('fader1', 0.5, 0.2);
    expect(fl.zetten('in1').length).toBeGreaterThan(0);
    expect(fl.zetten('in1')[0].v).toBeLessThanOrEqual(0.32);
  });

  it('device-knoppen: bij focus springt de ring naar de waarde van de app en draaien werkt meteen', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.knop('k1'), P.knop('k2')]), { k1: 0.6, k2: 0.25 });
    h.even();
    expect(h.apc.ring('dk1')).toBeCloseTo(0.6, 1);
    expect(h.apc.ring('dk2')).toBeCloseTo(0.25, 1);

    h.draai('dk1', 0.65);
    expect(fl.laatsteZet('k1')).toMatchObject({ bron: 'apc40' });
    expect(fl.laatsteZet('k1')?.v).toBeCloseTo(fysiek(0.65), 2);

    // De app draait zelf → de ring draait mee.
    fl.zet('k2', 0.8);
    h.even();
    expect(h.apc.ring('dk2')).toBeCloseTo(0.8, 1);
  });

  it('met ringen_nemen_waarde_over uit moeten ook de draaiknoppen eerst opgepakt worden', () => {
    const h = bank({ config: { ringen_nemen_waarde_over: false } });
    const fl = h.app(manifest('formula-lab', [P.knop('k1')]), { k1: 0.2 });
    h.even();
    h.draai('dk1', 0.9);
    h.draai('dk1', 0.6);
    expect(fl.zetten('k1')).toEqual([]);
    h.schuif('dk1', 0.6, 0.1);
    expect(fl.zetten('k1').length).toBeGreaterThan(0);
    expect(fl.zetten('k1')[0].v).toBeLessThanOrEqual(0.22);
    expect(fl.laatsteZet('k1')?.v).toBeCloseTo(fysiek(0.1), 2);
  });

  it('meer dan 8 draaiknoppen → een pagina per groep; Device ► en ◄ (devR/devL) bladeren en de ringen springen mee', () => {
    const h = bank();
    const a = ['a1', 'a2', 'a3', 'a4', 'a5'], b = ['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7'];
    /** @type {Record<string, number>} */
    const w = {};
    a.forEach((id, i) => { w[id] = 0.1 + i * 0.1; });
    b.forEach((id, i) => { w[id] = 0.95 - i * 0.1; });
    const fl = h.app(manifest('formula-lab', [...a.map((id) => P.knop(id, { groep: 'a' })), ...b.map((id) => P.knop(id, { groep: 'b' }))]), w);
    h.even();
    /** Welke parameter bespeelt draaiknop i nu? @param {number} i */
    const welke = (i) => {
      fl.wis();
      const ring = h.apc.ring(`dk${i}`) ?? 0;
      h.draai(`dk${i}`, ring); // waar de ring staat: geen sprong
      return fl.zetten().at(-1)?.id ?? null;
    };
    expect([1, 2, 3, 4, 5, 6].map(welke)).toEqual([...a, null]);
    expect(h.apc.ring('dk1')).toBeCloseTo(w.a1, 1);

    h.tik('devR');
    h.even();
    expect(h.apc.ring('dk1')).toBeCloseTo(w.b1, 1);
    expect(h.apc.ring('dk7')).toBeCloseTo(w.b7, 1);
    expect([1, 7, 8].map(welke)).toEqual(['b1', 'b7', null]);

    h.tik('devL');
    h.even();
    expect(h.apc.ring('dk1')).toBeCloseTo(w.a1, 1);
    expect(welke(2)).toBe('a2');
  });

  it('triggers en schakelaars uit verschillende groepen komen in verschillende kolommen', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [
      P.trigger('t1', { groep: 'licht' }), P.trigger('t2', { groep: 'licht' }),
      P.trigger('t3', { groep: 'klank' }), P.trigger('t4', { groep: 'klank' }),
    ]));
    h.even();
    /** @param {string} id */
    const kolom = (id) => {
      const pad = vindPad(h, fl, (b) => b.t === 'trig' && b.id === id && b.aan);
      expect(pad, id).not.toBe(null);
      return /** @type {string} */ (pad).split('-')[1];
    };
    const [k1, k2, k3, k4] = ['t1', 't2', 't3', 't4'].map(kolom);
    expect(k1).toBe(k2);
    expect(k3).toBe(k4);
    expect(k1).not.toBe(k3);
  });

  it('waarden die niet meer op de faders passen komen op de track-knoppen', () => {
    const h = bank();
    const ids = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9'];
    const fl = h.app(manifest('formula-lab', ids.map((id) => P.waarde(id))), Object.fromEntries(ids.map((id) => [id, id === 'w9' ? 0.3 : 0])));
    h.even();
    expect(h.apc.ring('tk1')).toBeCloseTo(0.3, 1);
    h.draai('tk1', 0.35);
    expect(fl.laatsteZet('w9')?.v).toBeCloseTo(fysiek(0.35), 2);
    h.fader(8, 0);
    h.fader(8, 0.4);
    expect(fl.laatsteZet('w8')?.v).toBeCloseTo(fysiek(0.4), 2);
  });

  it('keuze: één kolom op het grid, gekozen rij vol in app-kleur, de rest gedimd; drukken kiest', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.keuze('palet', ['warm', 'koel', 'mono'])]), { palet: 0.5 });
    h.even();
    const groen = configKleur('formula-lab');
    const pads = h.apc.brandend();
    expect(pads).toHaveLength(3);
    expect(new Set(pads.map((id) => id.split('-')[1])).size).toBe(1); // één kolom
    const vol = pads.filter((id) => h.apc.rgb(id).kleur === groen && !h.apc.rgb(id).anim);
    expect(vol).toHaveLength(1);
    for (const id of pads.filter((p) => p !== vol[0])) {
      expect(helderheid(h.apc.rgb(id).kleur)).toBeGreaterThan(0);
      expect(helderheid(h.apc.rgb(id).kleur)).toBeLessThan(helderheid(groen));
    }

    const gekozen = [];
    for (const id of pads) {
      h.tik(id);
      h.even();
      gekozen.push(h.appBeeld('formula-lab').waarden.palet);
      expect(h.apc.rgb(id).kleur).toBe(groen);
      expect(pads.filter((p) => h.apc.rgb(p).kleur === groen)).toEqual([id]);
    }
    expect(gekozen.map((v) => Math.round(v * 2) / 2).sort()).toEqual([0, 1, 2].map((i) => keuzeWaarde(i, 3)));
  });

  it('schakelaar: pad vol als hij aan staat, gedimd als hij uit staat; drukken wisselt', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.schakelaar('licht')]), { licht: 0 });
    h.even();
    const groen = configKleur('formula-lab');
    const pad = vindPad(h, fl, (b) => b.t === 'zet' && b.id === 'licht');
    expect(pad).not.toBe(null);
    expect(fl.laatsteZet('licht')?.v).toBe(1);
    h.even();
    expect(h.apc.rgb(/** @type {string} */ (pad)).kleur).toBe(groen);

    h.tik(/** @type {string} */ (pad));
    h.even();
    expect(fl.laatsteZet('licht')?.v).toBe(0);
    const uit = h.apc.rgb(/** @type {string} */ (pad));
    expect(helderheid(uit.kleur)).toBeGreaterThan(0);
    expect(helderheid(uit.kleur)).toBeLessThan(helderheid(groen));

    // De app zet hem zelf aan → pad gaat vol.
    fl.zet('licht', 1);
    h.even();
    expect(h.apc.rgb(/** @type {string} */ (pad)).kleur).toBe(groen);
  });

  it('trigger: indrukken stuurt aan, loslaten uit; het pad licht wit zolang je drukt', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.trigger('take')]));
    h.even();
    const pad = /** @type {string} */ (vindPad(h, fl, (b) => b.t === 'trig' && b.id === 'take'));
    expect(pad).not.toBe(null);
    fl.wis();

    h.druk(pad);
    h.even();
    expect(fl.trigs('take')).toEqual([{ t: 'trig', id: 'take', aan: true }]);
    expect(h.apc.rgb(pad).kleur).toBe(3);
    h.los(pad);
    h.even();
    expect(fl.trigs('take').at(-1)).toEqual({ t: 'trig', id: 'take', aan: false });
    expect(h.apc.rgb(pad).kleur).not.toBe(3);
  });

  it('scene-knoppen sturen de scènes van de app; Stop All Clips geeft paniek', () => {
    const h = bank();
    const fl = h.app(manifest('formula-lab', [P.trigger('paniek')], { scenes: ['A', 'B', 'C'] }));
    h.even();
    h.tik('scene1');
    h.tik('scene3');
    expect(fl.van('scene')).toEqual([{ t: 'scene', i: 0 }, { t: 'scene', i: 2 }]);

    h.druk('stopall');
    expect(fl.trigs('paniek')).toEqual([{ t: 'trig', id: 'paniek', aan: true }]);
    h.los('stopall');
    expect(fl.trigs('paniek')).toEqual([{ t: 'trig', id: 'paniek', aan: true }, { t: 'trig', id: 'paniek', aan: false }]);
  });

  it('ongeldig manifest → de app hoort waarom en blijft verbonden; daarna een goed manifest werkt gewoon', () => {
    const h = bank();
    const m = manifest('formula-lab', [P.fader('in1')]);
    const fl = h.app({ ...m, params: 'geen lijst' });
    expect(fl.van('fout')).toHaveLength(1);
    expect(typeof fl.van('fout')[0].reden).toBe('string');
    expect(fl.verbonden).toBe(true);

    fl.zeg({ t: 'manifest', manifest: m });
    fl.zeg({ t: 'staat', waarden: { in1: 0.4 } });
    h.even();
    h.fader(1, 0.4);
    expect(fl.laatsteZet('in1')?.v).toBeCloseTo(fysiek(0.4), 2);
  });
});
