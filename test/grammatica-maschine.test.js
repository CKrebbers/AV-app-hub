// @ts-check
// §19: de Maschine MK2 als hoofdbediening. Heeft de app met focus de Maschine niet in `speelt` maar volgt hij de
// grammatica, dan bedient de Maschine die app: draaiknoppen = alfabet, pads 1–8 = momenten, 9–16 = vrij (kaart),
// groep A–H = focus, schermen tonen naam en waarde. Anders speelt hij zoals altijd voor een lease-app (§17).
import { describe, it, expect } from 'vitest';
import { NepKlok } from '../src/core/klok.js';
import { Kern } from '../src/core/kern.js';
import * as MS from '../src/devices/maschine-mk2.js';
import { CONFIG, FL, DJ, nepOppervlak, meldAan, stuurApp, van, leeg, draai } from './kern-hulp.js';

const SPELER = { ...DJ, speelt: ['xboard49', 'maschine-mk2'] };
/** Een app met het alfabet (niet alle plekken), twee momenten (één met druk) en een schakelaar voor een vrije pad. */
const GRAM = {
  v: 1, app: 'gram', naam: 'Gram', kleur: '#2e5bff',
  params: [
    { id: 'zoom', naam: 'Zoom', soort: 'waarde', rol: 'alfabet.schaal', standaard: 0.5 },
    { id: 'snel', naam: 'Snelheid', soort: 'waarde', rol: 'alfabet.beweging', standaard: 0.2, slew_s: 4 },
    { id: 'modus', naam: 'Modus', soort: 'keuze', keuzes: ['warm', 'koel', 'mono'], rol: 'alfabet.vervorming' },
    { id: 'tint', naam: 'Tint', soort: 'waarde', rol: 'alfabet.kleur', standaard: 0.3 },
    { id: 'flits', naam: 'Flits', soort: 'trigger', rol: 'moment.flits', druk: 'flits_diep' },
    { id: 'flits_diep', naam: 'Flits diep', soort: 'waarde' },
    { id: 'wis', naam: 'Wis', soort: 'trigger', rol: 'moment.wis' },
    { id: 'aan', naam: 'Aan', soort: 'schakelaar', standaard: 1 },
  ],
};
const TWEE = { v: 1, app: 'twee', naam: 'Twee', kleur: '#ff0000', params: [{ id: 'z', naam: 'Z', soort: 'waarde', rol: 'alfabet.schaal' }] };

function opzet(extra = {}) {
  const klok = new NepKlok();
  const opp = nepOppervlak();
  /** Het speeloppervlak van de Maschine: lampjes per adres en de laatste schermen. */
  const maschine = {
    /** @type {any[]} */ log: [], /** @type {Map<string, number>} */ leds: new Map(), /** @type {Uint8Array[]} */ schermen: [],
    led(/** @type {number[]} */ m) { this.log.push(['led', m]); this.leds.set(`${m[0] & 0x0f}:${m[1]}`, m[2]); },
    scherm(/** @type {0|1} */ nr, /** @type {Uint8Array} */ d) { this.log.push(['scherm', nr]); this.schermen[nr] = Uint8Array.from(d); },
    leeg() { this.log.push(['leeg']); this.leds.clear(); this.schermen = []; },
  };
  const config = { ...CONFIG, kaarten: { gram: { 'maschine-mk2:pad9': { id: 'aan' } } }, ...extra };
  const kern = new Kern({ klok, config, oppervlak: opp, speelOppervlakken: { 'maschine-mk2': maschine } });
  const ms = (/** @type {number[]} */ b) => kern.invoer(MS.ontleedMidi(b), b);
  /** Draaiknop n (1..8) een aantal tellen (relatief, zoals de virtuele MIDI: tweecomplement, hooguit ±63 per bericht). */
  const knop = (/** @type {number} */ n, /** @type {number} */ tellen) => {
    for (let rest = tellen; rest !== 0;) {
      const d = Math.max(-63, Math.min(63, rest));
      ms([0xb0, MS.ENCODER_CC + n - 1, d < 0 ? 128 + d : d]);
      rest -= d;
    }
  };
  const knopNoot = (/** @type {string} */ naam) => /** @type {number} */ (MS.KNOP_NR.get(naam));
  const drukKnop = (/** @type {string} */ naam) => ms([0x91, knopNoot(naam), 127]);
  const losKnop = (/** @type {string} */ naam) => ms([0x81, knopNoot(naam), 0]);
  return { klok, kern, opp, maschine, ms, knop, drukKnop, losKnop, knopNoot };
}
/** @param {any} v @param {string} id */
const zetten = (v, id) => van(v, 'zet').filter((b) => b.id === id);

describe('§19 Maschine als hoofdbediening: wanneer', () => {
  it('de focus-app volgt de grammatica en speelt de Maschine niet: de Maschine bedient hem, niemand speelt', () => {
    const { kern, ms } = opzet();
    const dj = meldAan(kern, SPELER);
    const g = meldAan(kern, GRAM);
    kern.focus('gram');
    leeg(dj, g);
    ms([0x90, 36, 100]);
    expect(van(dj, 'midi')).toEqual([]);
    expect(van(g, 'trig')).toEqual([{ t: 'trig', id: 'flits', aan: true, v: expect.closeTo(100 / 127, 5) }]);
    const b = kern.beeld();
    expect(b.spelers['maschine-mk2']).toBe(null);
    expect(b.spelers.xboard49).toBe('varve-dj'); // de Xboard speelt gewoon door
    expect(b.maschine?.app).toBe('gram');
  });

  it('focus naar een app zonder grammatica (formula-lab): de Maschine speelt weer voor Varve DJ', () => {
    const { kern, ms, maschine } = opzet();
    const dj = meldAan(kern, SPELER);
    meldAan(kern, GRAM);
    meldAan(kern, FL);
    kern.focus('gram');
    maschine.log.length = 0;
    kern.focus('formula-lab');
    expect(maschine.log[0]).toEqual(['leeg']);
    leeg(dj);
    ms([0x90, 37, 90]);
    expect(van(dj, 'midi')).toEqual([{ t: 'midi', dev: 'maschine-mk2', bytes: [0x90, 37, 90] }]);
    expect(kern.beeld().maschine).toBe(null);
    expect(kern.beeld().spelers['maschine-mk2']).toBe('varve-dj');
  });

  it('een lease-app met maschine-mk2 in speelt houdt de Maschine, ook met alfabet-parameters', () => {
    const { kern, ms } = opzet();
    const s = meldAan(kern, { ...SPELER, params: [{ id: 'x', naam: 'X', soort: 'waarde', rol: 'alfabet.schaal' }] });
    leeg(s);
    ms([0xb0, 16, 20]);
    expect(van(s, 'midi').length).toBe(1);
    expect(van(s, 'zet')).toEqual([]);
    expect(kern.beeld().maschine).toBe(null);
  });

  it('zonder speelapparaten en zonder focus: niets, geen crash', () => {
    const { kern, ms, knop } = opzet();
    ms([0x90, 36, 100]);
    knop(1, 50);
    expect(kern.beeld().maschine).toBe(null);
  });
});

describe('§19 draaiknoppen = het alfabet', () => {
  it('knop 3 = beweging, relatief: 100 tellen = +0,1; direct, zonder slew (een hand op een knop)', () => {
    const { kern, knop } = opzet();
    const g = meldAan(kern, GRAM);
    leeg(g);
    knop(3, 100);
    expect(zetten(g, 'snel').at(-1)).toMatchObject({ v: expect.closeTo(0.3, 5), bron: 'maschine-mk2' });
    expect(kern.beeld().slews).toEqual([]);
    knop(3, -50);
    expect(zetten(g, 'snel').at(-1)?.v).toBeCloseTo(0.25, 5);
  });

  it('met SHIFT ingedrukt tien keer fijner; klemt op 0..1', () => {
    const { kern, knop, drukKnop, losKnop } = opzet();
    const g = meldAan(kern, GRAM);
    leeg(g);
    drukKnop('shift');
    knop(1, 100);
    expect(zetten(g, 'zoom').at(-1)?.v).toBeCloseTo(0.51, 5);
    losKnop('shift');
    for (let i = 0; i < 10; i++) knop(1, 63);
    expect(zetten(g, 'zoom').at(-1)?.v).toBe(1);
  });

  it('een keuze verspringt pas na een hele stap (125 tellen), en blijft aan de rand', () => {
    const { kern, knop } = opzet();
    const g = meldAan(kern, GRAM);
    leeg(g);
    knop(4, 60);
    knop(4, 60);
    expect(zetten(g, 'modus')).toEqual([]);
    knop(4, 10);
    expect(zetten(g, 'modus').at(-1)?.v).toBe(0.5);
    for (let i = 0; i < 8; i++) knop(4, 63);
    expect(zetten(g, 'modus').at(-1)?.v).toBe(1);
    expect(zetten(g, 'modus').length).toBe(2);
    knop(4, -63); knop(4, -63);
    expect(zetten(g, 'modus').at(-1)?.v).toBe(0.5);
  });

  it('een lege plek (knop 2, 6, 7, 8) doet niets', () => {
    const { kern, knop } = opzet();
    const g = meldAan(kern, GRAM);
    leeg(g);
    for (const n of [2, 6, 7, 8]) knop(n, 40);
    expect(van(g, 'zet')).toEqual([]);
  });

  it('de APC-ring van dezelfde plek volgt (device-knop 3 = Maschine-knop 3)', () => {
    const { kern, opp, knop } = opzet();
    meldAan(kern, GRAM);
    kern.focus('gram');
    knop(3, 300);
    expect(opp.leds.get('dk3')).toMatchObject({ waarde: expect.closeTo(0.5, 5) });
  });

  it('en andersom: draaien aan APC-knop 1 staat meteen op het scherm', () => {
    const { kern, maschine } = opzet();
    meldAan(kern, GRAM);
    kern.focus('gram');
    draai(kern, 'dk1', 0.8);
    expect(MS.leesTekst(maschine.schermen[0], 2, MS.KOLOM.rijWaarde, 3)).toBe('80%');
  });
});

describe('§19 pads: momenten en vrije pads', () => {
  it('pad 1 = flits met velocity; aftertouch gaat naar druk; loslaten = trig uit en druk naar 0', () => {
    const { kern, ms } = opzet();
    const g = meldAan(kern, GRAM);
    leeg(g);
    ms([0x90, 36, 127]);
    ms([0xa0, 36, 64]);
    ms([0x80, 36, 0]);
    expect(van(g, 'trig')).toEqual([{ t: 'trig', id: 'flits', aan: true, v: 1 }, { t: 'trig', id: 'flits', aan: false }]);
    expect(zetten(g, 'flits_diep').map((b) => b.v)).toEqual([expect.closeTo(64 / 127, 5), 0]);
  });

  it('een moment zonder druk krijgt geen zet bij aftertouch; een pad zonder moment doet niets', () => {
    const { kern, ms } = opzet();
    const g = meldAan(kern, GRAM);
    leeg(g);
    ms([0x90, 42, 80]); // pad 7 = wis
    ms([0xa0, 42, 100]);
    ms([0x80, 42, 0]);
    ms([0x90, 37, 80]); ms([0x80, 37, 0]); // pad 2 = stoot: niet in deze app
    expect(van(g, 'trig').map((b) => [b.id, b.aan])).toEqual([['wis', true], ['wis', false]]);
    expect(van(g, 'zet')).toEqual([]);
  });

  it('pad 9 uit de kaart (maps/gram.json "maschine-mk2:pad9") schakelt "aan"', () => {
    const { kern, ms } = opzet();
    const g = meldAan(kern, GRAM);
    leeg(g);
    ms([0x90, 44, 100]); ms([0x80, 44, 0]);
    expect(zetten(g, 'aan').map((b) => b.v)).toEqual([0]);
    ms([0x90, 44, 100]); ms([0x80, 44, 0]);
    expect(zetten(g, 'aan').map((b) => b.v)).toEqual([0, 1]);
  });

  it('niets blijft hangen: pad in, focus naar een andere app, pad los → het loslaten gaat naar de eerste', () => {
    const { kern, ms } = opzet();
    const g = meldAan(kern, GRAM);
    const t = meldAan(kern, TWEE);
    kern.focus('gram');
    leeg(g, t);
    ms([0x90, 36, 100]);
    kern.focus('twee');
    ms([0x80, 36, 0]);
    expect(van(g, 'trig').map((b) => b.aan)).toEqual([true, false]);
    expect(zetten(g, 'flits_diep').at(-1)?.v).toBe(0);
    expect(van(t, 'trig')).toEqual([]);
  });

  it('een speler drukte een pad in, daarna komt de grammatica: het loslaten gaat nog naar de speler', () => {
    const { kern, ms } = opzet();
    const dj = meldAan(kern, SPELER);
    const g = meldAan(kern, GRAM);
    kern.focus('varve-dj');
    leeg(dj, g);
    ms([0x90, 36, 100]);
    kern.focus('gram');
    ms([0x80, 36, 0]);
    expect(van(dj, 'midi').map((m) => m.bytes)).toEqual([[0x90, 36, 100], [0x80, 36, 0]]);
    expect(van(g, 'trig')).toEqual([]);
  });

  it('Maschine eruit met een pad in: trig uit en druk naar 0', () => {
    const { kern, ms } = opzet();
    const g = meldAan(kern, GRAM);
    leeg(g);
    ms([0x90, 36, 100]);
    kern.apparaatWeg('maschine-mk2');
    expect(van(g, 'trig').map((b) => b.aan)).toEqual([true, false]);
    expect(zetten(g, 'flits_diep').at(-1)?.v).toBe(0);
  });
});

describe('§19 groep A–H = focus op app-slot 1–8', () => {
  it('groep B geeft slot 2 de focus; groep D (leeg) doet niets', () => {
    const { kern, drukKnop, losKnop } = opzet();
    meldAan(kern, GRAM);
    meldAan(kern, TWEE);
    kern.focus('gram');
    drukKnop('groepB'); losKnop('groepB');
    expect(kern.focusApp).toBe('twee');
    drukKnop('groepD'); losKnop('groepD');
    expect(kern.focusApp).toBe('twee');
    drukKnop('groepA'); losKnop('groepA');
    expect(kern.focusApp).toBe('gram');
  });

  it('groep naar een app die de Maschine speelt: daarna speelt de Maschine voor hem (en terug via de APC)', () => {
    const { kern, ms, drukKnop, losKnop } = opzet();
    meldAan(kern, GRAM);
    const dj = meldAan(kern, SPELER);
    kern.focus('gram');
    drukKnop('groepB');
    losKnop('groepB'); // het loslaten hoort nog bij de grammatica
    leeg(dj);
    ms([0x90, 36, 100]);
    expect(van(dj, 'midi').map((m) => m.bytes)).toEqual([[0x90, 36, 100]]);
  });
});

describe('§19 lampjes en schermen', () => {
  it('pads van momenten die de app heeft zacht aan, de rest uit; ingedrukt vol', () => {
    const { kern, ms, maschine } = opzet();
    meldAan(kern, GRAM);
    const a = /** @type {any} */ (kern.apps.get('gram'));
    expect(maschine.leds.get('0:36')).toBe(a.dim);  // pad 1 flits
    expect(maschine.leds.get('0:37')).toBe(0);      // pad 2 stoot: niet in deze app
    expect(maschine.leds.get('0:42')).toBe(a.dim);  // pad 7 wis
    expect(maschine.leds.get('0:44')).toBe(a.kleur); // pad 9: schakelaar "aan" staat aan
    ms([0x90, 36, 100]);
    expect(maschine.leds.get('0:36')).toBe(a.kleur);
    ms([0x80, 36, 0]);
    expect(maschine.leds.get('0:36')).toBe(a.dim);
  });

  it('groepknoppen: focus vol, andere verbonden apps gedimd, lege slots uit', () => {
    const { kern, maschine, knopNoot } = opzet();
    meldAan(kern, GRAM);
    meldAan(kern, TWEE);
    kern.focus('gram');
    const g = /** @type {any} */ (kern.apps.get('gram')), t = /** @type {any} */ (kern.apps.get('twee'));
    expect(maschine.leds.get(`1:${knopNoot('groepA')}`)).toBe(g.kleur);
    expect(maschine.leds.get(`1:${knopNoot('groepB')}`)).toBe(t.dim);
    expect(maschine.leds.get(`1:${knopNoot('groepC')}`)).toBe(0);
  });

  it('de schermen tonen per knop het woord, de naam en de waarde; een lege plek een streep', () => {
    const { kern, knop, maschine } = opzet();
    meldAan(kern, GRAM);
    knop(3, 100);
    const [l, r] = maschine.schermen;
    const lees = (/** @type {Uint8Array} */ b, /** @type {number} */ kolom, /** @type {number} */ rij, n = 10) => MS.leesTekst(b, kolom * MS.KOLOM.breed + 2, rij, n).trimEnd();
    expect(lees(l, 0, MS.KOLOM.rijWoord)).toBe('SCHAAL');
    expect(lees(l, 0, MS.KOLOM.rijNaam)).toBe('ZOOM');
    expect(lees(l, 0, MS.KOLOM.rijWaarde)).toBe('50%');
    expect(lees(l, 1, MS.KOLOM.rijWoord)).toBe('DICHTHEID');
    expect(lees(l, 1, MS.KOLOM.rijNaam)).toBe('-');
    expect(lees(l, 2, MS.KOLOM.rijNaam)).toBe('SNELHEID');
    expect(lees(l, 2, MS.KOLOM.rijWaarde)).toBe('30%');
    expect(lees(l, 3, MS.KOLOM.rijWoord)).toBe('VERVORMING');
    expect(lees(l, 3, MS.KOLOM.rijWaarde)).toBe('WARM');
    expect(lees(r, 0, MS.KOLOM.rijWoord)).toBe('KLEUR');
    expect(lees(r, 0, MS.KOLOM.rijWaarde)).toBe('30%');
    expect(lees(r, 3, MS.KOLOM.rijWoord)).toBe('RUIMTE');
    expect(MS.leesTekst(l, 2, MS.KOLOM.rijOnder, 4)).toBe('GRAM');
  });

  it('beeld.maschine: wat de cockpit van de Maschine laat zien', () => {
    const { kern } = opzet();
    meldAan(kern, GRAM);
    const m = kern.beeld().maschine;
    expect(m?.knoppen.map((k) => k.woord)).toEqual(['schaal', 'dichtheid', 'beweging', 'vervorming', 'kleur', 'helderheid', 'variatie', 'ruimte']);
    expect(m?.knoppen.map((k) => k.id)).toEqual(['zoom', null, 'snel', 'modus', 'tint', null, null, null]);
    expect(m?.knoppen[3].tekst).toBe('warm');
    expect(m?.pads[0]).toMatchObject({ pad: 1, woord: 'flits', id: 'flits', druk: 'flits_diep' });
    expect(m?.pads[8]).toMatchObject({ pad: 9, woord: null, id: 'aan', aan: true });
  });

  it('de app stuurt zelf een nieuwe waarde: het scherm volgt', () => {
    const { kern, maschine } = opzet();
    const g = meldAan(kern, GRAM);
    stuurApp(kern, g, { t: 'zet', id: 'tint', v: 0.75 });
    expect(MS.leesTekst(maschine.schermen[1], 2, MS.KOLOM.rijWaarde, 3)).toBe('75%');
  });

  it('instellingen uit config.json (apparaten.maschine-mk2.grammatica)', () => {
    const { kern, knop } = opzet({ apparaten: { 'maschine-mk2': { grammatica: { tellen_vol: 500 } } } });
    const g = meldAan(kern, GRAM);
    leeg(g);
    knop(1, 50);
    expect(zetten(g, 'zoom').at(-1)?.v).toBeCloseTo(0.6, 5);
  });
});

describe('§19 schermtekst (src/devices/maschine-mk2.js, puur)', () => {
  it('elk teken van het lettertype leest terug als zichzelf', () => {
    const alles = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,%-:/()+?!·><=_#\'*';
    const b = MS.leegScherm();
    for (let i = 0; i < alles.length; i += 40) MS.tekenTekst(b, 0, (i / 40) * 9, alles.slice(i, i + 40));
    let terug = '';
    for (let i = 0; i < alles.length; i += 40) terug += MS.leesTekst(b, 0, (i / 40) * 9, Math.min(40, alles.length - i));
    expect(terug).toBe(alles);
  });
  it('kleine letters worden hoofdletters, accenten vallen weg, onbekend wordt ?; max tekens snijdt af', () => {
    expect(MS.schermTekens('Ruimte → één ↔ ✓')).toBe('RUIMTE > EEN - ?');
    const b = MS.leegScherm();
    MS.tekenTekst(b, 0, 0, 'helderheidjes', 10);
    expect(MS.leesTekst(b, 0, 0, 12)).toBe('HELDERHEID  ');
  });
  it('twee schermen van precies 2048 bytes, ook zonder knoppen', () => {
    const [l, r] = MS.grammaticaSchermen({ app: 'x', knoppen: [] });
    expect(l.length).toBe(MS.SCHERM.bytes);
    expect(r.length).toBe(MS.SCHERM.bytes);
  });
});
