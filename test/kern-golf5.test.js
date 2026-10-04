// @ts-nocheck
// Golf 5: kern-fixes uit de generale repetitie (docs/REPETITIE.md, PROTOCOL §14).
// 1) Wat een app zelf verandert tijdens (of vlak na) een paniek, verplaatst het pickup-doel van een LPD8-macroknop niet.
// 2) Een keuze of schakelaar die al op die stand staat, krijgt geen zet nog eens (behalve replay).
import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import { opzet, meldAan, stuurApp, nepVerbinding, tik, druk, los, draai, lpdKnop, lpdDruk, lpdLos, van, leeg, CONFIG } from './kern-hulp.js';
import { PANIEK_MS, leesNaloopMs } from '../src/core/kern.js';

/** De standaard uit config.json, expliciet: de tests hangen niet af van de terugval in de code. */
const C5 = { ...CONFIG, paniek: { naloop_s: 5 } };

/** Waterschaal-achtig: volume (macro.intensiteit) op fader 1, paniek-trigger. Bij paniek zet hij zelf volume 0. */
const W = {
  v: 1, app: 'waterschaal', naam: 'Waterschaal',
  params: [
    { id: 'volume', naam: 'Volume', soort: 'waarde', hint: 'fader', rol: 'macro.intensiteit', standaard: 0.6 },
    { id: 'paniek', naam: 'Paniek', soort: 'trigger' },
  ],
};
/** MediSynth-achtig: niveau met dezelfde rol, zonder slew (zodat elke zet meteen te zien is). */
const M = { v: 1, app: 'medisynth', naam: 'MediSynth', params: [{ id: 'niveau', naam: 'Niveau', soort: 'waarde', rol: 'macro.intensiteit', standaard: 0.6 }] };

/** Zet K1 vast op `doel` (vanaf 0 opendraaien tot voorbij de app-waarde, dan terug naar doel). */
function vangK1(kern, doel) {
  for (let r = 0; r <= 100; r += 2) lpdKnop(kern, 1, r / 127);
  for (let r = 100; r >= Math.round(doel * 127); r -= 2) lpdKnop(kern, 1, r / 127);
}

/** Houd P1 vast (paniek), laat de app wat zelf doen, laat los. */
function paniek(kern, klok, tijdens = () => {}) {
  lpdDruk(kern, 1);
  klok.loop(PANIEK_MS + 50);
  expect(kern.paniekActief).toBe(true);
  tijdens();
  lpdLos(kern, 1);
  expect(kern.paniekActief).toBe(false);
}

const zetten = (v, id) => van(v, 'zet').filter((b) => b.id === id);

describe('§14 LPD8-pickup na paniek: K1 blijft gevangen', () => {
  it('waterschaal zet bij paniek zelf volume 0: de hub kent 0, maar de eerste tik van K1 zet beide apps weer', () => {
    const { kern, klok } = opzet();
    const w = meldAan(kern, W);
    const m = meldAan(kern, M);
    vangK1(kern, 36 / 127);
    expect(kern.apps.get('waterschaal').waarden.volume).toBeCloseTo(36 / 127, 6);
    expect(kern.apps.get('medisynth').waarden.niveau).toBeCloseTo(36 / 127, 6);

    paniek(kern, klok, () => stuurApp(kern, w, { t: 'zet', id: 'volume', v: 0 }));
    // De kern bewaart en toont de waarde van de app (de cockpit ziet volume 0).
    expect(kern.apps.get('waterschaal').waarden.volume).toBe(0);
    expect(kern.beeld().apps.find((a) => a.app === 'waterschaal').waarden.volume).toBe(0);
    // K1 is niet losgemaakt: zijn doel is nog de stand van de knop.
    expect(kern.lpdPickups.get('k1')).toMatchObject({ gevangen: true });

    leeg(w, m);
    lpdKnop(kern, 1, 38 / 127);
    expect(zetten(w, 'volume').at(-1)?.v).toBeCloseTo(38 / 127, 6);
    expect(zetten(m, 'niveau').at(-1)?.v).toBeCloseTo(38 / 127, 6);
    expect(zetten(w, 'volume').at(-1)?.bron).toBe('lpd8');
  });

  it('ook een staat van de app binnen de naloop (standaard 5 s) laat K1 met rust', () => {
    const { kern, klok } = opzet(C5);
    const w = meldAan(kern, W);
    const m = meldAan(kern, M);
    vangK1(kern, 40 / 127);
    paniek(kern, klok);
    klok.loop(4900);
    stuurApp(kern, w, { t: 'staat', waarden: { volume: 0 } });
    leeg(w, m);
    lpdKnop(kern, 1, 42 / 127);
    expect(zetten(w, 'volume').length).toBe(1);
    expect(zetten(m, 'niveau').length).toBe(1);
  });

  it('na de naloop volgt de pickup weer de buitenwereld (§11): een zet van de app laat K1 wachten', () => {
    const { kern, klok } = opzet(C5);
    const w = meldAan(kern, W);
    const m = meldAan(kern, M);
    vangK1(kern, 40 / 127);
    paniek(kern, klok);
    klok.loop(5100);
    stuurApp(kern, w, { t: 'zet', id: 'volume', v: 0 });
    leeg(w, m);
    lpdKnop(kern, 1, 42 / 127);
    expect(van(w, 'zet')).toEqual([]);
    expect(van(m, 'zet')).toEqual([]);
  });

  it('paniek.naloop_s komt uit config: 0 = alleen terwijl P1 vastgehouden wordt', () => {
    const { kern, klok } = opzet({ ...CONFIG, paniek: { naloop_s: 0 } });
    const w = meldAan(kern, W);
    meldAan(kern, M);
    vangK1(kern, 40 / 127);
    paniek(kern, klok);
    stuurApp(kern, w, { t: 'zet', id: 'volume', v: 0 });
    leeg(w);
    lpdKnop(kern, 1, 42 / 127);
    expect(van(w, 'zet')).toEqual([]);
  });

  it('K1 nog nooit aangeraakt: het doel blijft de waarde van vóór de paniek, niet de 0 van de app', () => {
    const { kern, klok } = opzet();
    const w = meldAan(kern, W);
    const m = meldAan(kern, M);
    paniek(kern, klok, () => stuurApp(kern, w, { t: 'zet', id: 'volume', v: 0 }));
    leeg(w, m);
    // De knop staat (toevallig) precies waar volume vóór de paniek stond: de eerste aanraking pakt meteen op.
    lpdKnop(kern, 1, 76 / 127);
    expect(zetten(w, 'volume').at(-1)?.v).toBeCloseTo(76 / 127, 6);
    expect(zetten(m, 'niveau').at(-1)?.v).toBeCloseTo(76 / 127, 6);
  });

  it('een cockpit-zet tijdens de paniek verplaatst het doel wél (alleen wat de app zelf doet, telt niet)', () => {
    const { kern, klok } = opzet();
    const w = meldAan(kern, W);
    meldAan(kern, M);
    vangK1(kern, 40 / 127);
    paniek(kern, klok, () => kern.cockpit({ t: 'zet', app: 'waterschaal', id: 'volume', v: 0.9 }));
    leeg(w);
    lpdKnop(kern, 1, 42 / 127);
    expect(van(w, 'zet')).toEqual([]);
  });

  it('Stop All van de app met focus telt als paniek voor die app', () => {
    const { kern } = opzet(C5);
    const w = meldAan(kern, W);
    const m = meldAan(kern, M);
    expect(kern.focusApp).toBe('waterschaal');
    vangK1(kern, 40 / 127);
    tik(kern, 'stopall');
    expect(van(w, 'trig')).toEqual([{ t: 'trig', id: 'paniek', aan: true }, { t: 'trig', id: 'paniek', aan: false }]);
    stuurApp(kern, w, { t: 'zet', id: 'volume', v: 0 });
    leeg(w, m);
    lpdKnop(kern, 1, 42 / 127);
    expect(zetten(w, 'volume').length).toBe(1);
    expect(zetten(m, 'niveau').length).toBe(1);
  });

  it('Stop All: na de naloop volgt de pickup weer de buitenwereld (§11)', () => {
    const { kern, klok } = opzet(C5);
    const w = meldAan(kern, W);
    const m = meldAan(kern, M);
    vangK1(kern, 40 / 127);
    tik(kern, 'stopall');
    klok.loop(5100);
    stuurApp(kern, w, { t: 'zet', id: 'volume', v: 0 });
    leeg(w, m);
    lpdKnop(kern, 1, 42 / 127);
    expect(van(w, 'zet')).toEqual([]);
    expect(van(m, 'zet')).toEqual([]);
  });

  it('Stop All ingedrukt gehouden: zolang hij vast is, telt elke zet van de app als paniek (ook na 10 s)', () => {
    const { kern, klok } = opzet(C5);
    const w = meldAan(kern, W);
    const m = meldAan(kern, M);
    vangK1(kern, 40 / 127);
    druk(kern, 'stopall');
    klok.loop(10000);
    stuurApp(kern, w, { t: 'zet', id: 'volume', v: 0 });
    leeg(w, m);
    lpdKnop(kern, 1, 42 / 127);
    expect(zetten(w, 'volume').length).toBe(1);
    expect(zetten(m, 'niveau').length).toBe(1);
    los(kern, 'stopall');
  });

  it('Stop All vast, de app stuurt een manifest zonder paniek-trigger, los: de naloop loopt toch af (geen eeuwige paniek)', () => {
    const { kern, klok } = opzet(C5);
    const w = meldAan(kern, W);
    const m = meldAan(kern, M);
    vangK1(kern, 40 / 127);
    druk(kern, 'stopall');
    stuurApp(kern, w, { t: 'manifest', manifest: { ...W, params: [W.params[0]] } });
    los(kern, 'stopall');
    expect(kern.appPaniekTot.get('waterschaal')).toBeLessThan(Infinity);
    klok.loop(3_600_000);
    stuurApp(kern, w, { t: 'zet', id: 'volume', v: 0.9 });
    leeg(w, m);
    lpdKnop(kern, 1, 42 / 127);
    expect(van(w, 'zet')).toEqual([]);
    expect(van(m, 'zet')).toEqual([]);
  });

  it('Stop All vast en de app wordt een lease, of de APC valt weg: ook dan eindigt de paniek van die app', () => {
    const { kern } = opzet(C5);
    const w = meldAan(kern, W);
    druk(kern, 'stopall');
    stuurApp(kern, w, { t: 'manifest', manifest: { v: 1, app: 'waterschaal', naam: 'Waterschaal', lease: true, params: [] } });
    los(kern, 'stopall');
    expect(kern.appPaniekTot.get('waterschaal')).toBeLessThan(Infinity);

    const b = opzet(C5);
    meldAan(b.kern, W);
    druk(b.kern, 'stopall');
    expect(b.kern.appPaniekTot.get('waterschaal')).toBe(Infinity);
    b.kern.apparaatWeg('apc40');
    expect(b.kern.appPaniekTot.get('waterschaal')).toBeLessThan(Infinity);
  });

  it('Stop All loslaten na een focuswissel start de naloop van de app waar het indrukken heen ging', () => {
    const { kern } = opzet(C5);
    meldAan(kern, W);
    meldAan(kern, M);
    expect(kern.focusApp).toBe('waterschaal');
    druk(kern, 'stopall');
    expect(kern.appPaniekTot.get('waterschaal')).toBe(Infinity);
    kern.focus('medisynth');
    los(kern, 'stopall');
    expect(kern.appPaniekTot.get('waterschaal')).toBeLessThan(Infinity);
    expect(kern.appPaniekTot.has('medisynth')).toBe(false);
  });

  it('een snapshot tijdens de paniek verplaatst het doel wél (zoals §11)', () => {
    const { kern, klok } = opzet(C5);
    const w = meldAan(kern, W);
    meldAan(kern, M);
    kern.cockpit({ t: 'zet', app: 'waterschaal', id: 'volume', v: 0.1 });
    kern.bewaar(1);
    vangK1(kern, 40 / 127);
    expect(kern.apps.get('waterschaal').waarden.volume).toBeCloseTo(40 / 127, 6);
    paniek(kern, klok, () => kern.laad(1));
    expect(kern.apps.get('waterschaal').waarden.volume).toBeCloseTo(0.1, 6);
    leeg(w);
    lpdKnop(kern, 1, 42 / 127);
    expect(van(w, 'zet')).toEqual([]);
  });

  it('K1 werkt ook terwijl P1 nog vastgehouden wordt (bewuste keuze, §14)', () => {
    const { kern, klok } = opzet(C5);
    const w = meldAan(kern, W);
    meldAan(kern, M);
    vangK1(kern, 40 / 127);
    lpdDruk(kern, 1);
    klok.loop(PANIEK_MS + 50);
    stuurApp(kern, w, { t: 'zet', id: 'volume', v: 0 });
    leeg(w);
    lpdKnop(kern, 1, 42 / 127);
    expect(zetten(w, 'volume').at(-1)?.v).toBeCloseTo(42 / 127, 6);
    lpdLos(kern, 1);
  });

  it('APC-fader van de app met focus volgt wél de buitenwereld: na volume 0 wacht hij weer (knipperende clip-stop)', () => {
    const { kern, klok } = opzet();
    const w = meldAan(kern, W);
    // Fader 1 = volume: oppakken op 0,6 en naar 0,5 schuiven.
    for (let v = 0.4; v <= 0.62; v += 0.02) draai(kern, 'fader1', v);
    draai(kern, 'fader1', 0.5);
    expect(kern.beeld().pickup.fader1).toMatchObject({ id: 'volume', gevangen: true });
    paniek(kern, klok, () => stuurApp(kern, w, { t: 'zet', id: 'volume', v: 0 }));
    expect(kern.beeld().pickup.fader1).toMatchObject({ doel: 0, gevangen: false });
    leeg(w);
    draai(kern, 'fader1', 0.52);
    expect(van(w, 'zet')).toEqual([]);
  });
});

describe('§14 geen dubbele zets bij keuze en schakelaar', () => {
  /** Formula Lab-achtig: palette (keuze, macro.kleur) op het grid, smooth (schakelaar). */
  const F = {
    v: 1, app: 'formula-lab', naam: 'Formula Lab',
    params: [
      { id: 'palette', naam: 'Palet', soort: 'keuze', keuzes: ['a', 'b', 'c', 'd', 'e'], hint: 'kolom', rol: 'macro.kleur' },
      { id: 'smooth', naam: 'Smooth', soort: 'schakelaar' },
    ],
  };

  it('LPD8-macro K5 op een keuze: alleen een zet als de optie verandert', () => {
    const { kern } = opzet();
    const f = meldAan(kern, F);
    for (let r = 0; r <= 127; r++) lpdKnop(kern, 5, r / 127);
    const z = zetten(f, 'palette');
    // Opties 0..4 (0, 0.25, …, 1): van de beginstand 0 naar 4 = vier keer een andere optie.
    expect(z.map((b) => b.v)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(z.every((b) => b.bron === 'lpd8')).toBe(true);
    // Iedereen kreeg de macro wel als globaal (elke tik).
    expect(van(f, 'globaal').filter((b) => 'macro.kleur' in b.waarden).length).toBeGreaterThan(100);
  });

  it('APC-pad op de keuze die al gekozen is, en cockpit op dezelfde stand: geen zet', () => {
    const { kern } = opzet();
    const f = meldAan(kern, F);
    leeg(f);
    // Kolom 1 = palette, optie 0 bovenaan: rij 4 = optie 1.
    tik(kern, 'pad4-1');
    tik(kern, 'pad4-1');
    expect(zetten(f, 'palette')).toEqual([{ t: 'zet', id: 'palette', v: 0.25, bron: 'apc40' }]);
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'palette', v: 0.25 });
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'palette', v: 0.3 }); // kwantiseert ook naar optie 1
    expect(zetten(f, 'palette').length).toBe(1);
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'smooth', v: 1 });
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'smooth', v: 0.9 });
    expect(zetten(f, 'smooth')).toEqual([{ t: 'zet', id: 'smooth', v: 1, bron: 'cockpit' }]);
  });

  it('een ingeslikte zet werkt de LEDs van de app met focus toch bij', () => {
    const { kern, opp } = opzet();
    meldAan(kern, F);
    tik(kern, 'pad4-1');
    const aan = opp.leds.get('pad4-1');
    expect(aan).not.toEqual(opp.leds.get('pad5-1'));
    const getekend = opp.getekend;
    tik(kern, 'pad4-1');
    expect(opp.getekend).toBeGreaterThan(getekend);
    expect(opp.leds.get('pad4-1')).toEqual(aan);
    expect(kern.apps.get('formula-lab').waarden.palette).toBe(0.25);
  });

  it('heeft de app zelf een andere optie gekozen, dan gaat dezelfde zet als eerst wél weer', () => {
    const { kern } = opzet();
    const f = meldAan(kern, F);
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'palette', v: 0.5 });
    stuurApp(kern, f, { t: 'zet', id: 'palette', v: 0 });
    leeg(f);
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'palette', v: 0.5 });
    expect(zetten(f, 'palette')).toEqual([{ t: 'zet', id: 'palette', v: 0.5, bron: 'cockpit' }]);
  });

  it('een waarde (geen keuze) krijgt een gelijke zet gewoon wel', () => {
    const { kern } = opzet();
    const w = meldAan(kern, W);
    leeg(w);
    kern.cockpit({ t: 'zet', app: 'waterschaal', id: 'volume', v: 0.6 });
    expect(zetten(w, 'volume')).toEqual([{ t: 'zet', id: 'volume', v: 0.6, bron: 'cockpit' }]);
  });

  it('replay gaat altijd, ook als de keuze al op die stand stond (de app weet het nog niet)', () => {
    const { kern } = opzet();
    const H = { ...F, truth: 'hub', params: [{ ...F.params[0], standaard: 0.5 }, F.params[1]] };
    // Geheugen van de vorige hub-sessie, met dezelfde inst: direct opnieuw afspelen, ook al is 0.5 de standaard.
    expect(kern.importeer({ v: 1, snapshots: {}, waarden: { 'formula-lab': { palette: 0.5, smooth: 0 } }, inst: { 'formula-lab': 'i1' } }).ok).toBe(true);
    const f = meldAan(kern, H, { inst: 'i1' });
    expect(zetten(f, 'palette')).toEqual([{ t: 'zet', id: 'palette', v: 0.5, bron: 'replay' }]);
    expect(zetten(f, 'smooth')).toEqual([{ t: 'zet', id: 'smooth', v: 0, bron: 'replay' }]);
    // En na een herstart van de app (nieuwe inst) opnieuw.
    const v2 = nepVerbinding();
    kern.verbind(v2);
    stuurApp(kern, v2, { t: 'hallo', app: 'formula-lab', inst: 'i2', v: 1 });
    expect(zetten(v2, 'palette')).toEqual([{ t: 'zet', id: 'palette', v: 0.5, bron: 'replay' }]);
  });
});

describe('§14 config', () => {
  it('config.json heeft paniek.naloop_s (een getal ≥ 0 met _doc) en de kern leest hem', async () => {
    const { laadConfig } = await import('../src/config.js');
    const cfg = laadConfig();
    expect(typeof cfg.paniek.naloop_s).toBe('number');
    expect(cfg.paniek.naloop_s).toBeGreaterThanOrEqual(0);
    expect(typeof cfg.paniek._doc).toBe('string');
    expect(opzet(cfg).kern.paniekNaloopMs).toBe(cfg.paniek.naloop_s * 1000);
    expect(opzet({ ...CONFIG, paniek: { naloop_s: 2 } }).kern.paniekNaloopMs).toBe(2000);
  });

  it('een ongeldige naloop_s ("vijf", "5s", -1) wordt gemeld en vervangen door 5 s', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const fout of ['vijf', '5s', -1, null, NaN]) {
        expect(opzet({ ...CONFIG, paniek: { naloop_s: fout } }).kern.paniekNaloopMs).toBe(5000);
      }
      expect(warn).toHaveBeenCalledTimes(5);
      expect(String(warn.mock.calls[0][0])).toMatch(/paniek\.naloop_s moet een getal/);
      expect(leesNaloopMs(undefined)).toBe(5000);
      expect(leesNaloopMs(0)).toBe(0);
      expect(warn).toHaveBeenCalledTimes(5);
    } finally {
      warn.mockRestore();
    }
  });
});
