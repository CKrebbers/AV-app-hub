// Gedeelde hulp voor de kern-tests: nep-oppervlak, nep-verbindingen, controllers indrukken.
import { NepKlok } from '../src/core/klok.js';
import { Kern } from '../src/core/kern.js';
import * as APC from '../src/devices/apc40mk2.js';
import * as LPD8 from '../src/devices/lpd8.js';
import { leesVanApp } from '../src/protocol/berichten.js';

export const CONFIG = {
  hubtoets: 'bank',
  hartslag: { stil_s: 3, weg_s: 10 },
  apps: {
    'formula-lab': { naam: 'Formula Lab', kleur: '#3fbf5f' },
    medisynth: { naam: 'MediSynth', kleur: '#8b5cff' },
    'varve-dj': { naam: 'Varve DJ', kleur: '#ff7a1a' },
    'av-kern': { naam: 'AV-kern', kleur: '#2e5bff' },
  },
};

/** formula-lab: 2 faders, 1 device-knop met rol, keuze, trigger, schakelaar, paniek, 3 scènes. */
export const FL = {
  v: 1, app: 'formula-lab', naam: 'Formula Lab', kleur: '#3fbf5f', scenes: ['A', 'B', 'C'],
  params: [
    { id: 'in1', naam: 'In 1', soort: 'waarde', hint: 'fader' },
    { id: 'in2', naam: 'In 2', soort: 'waarde', hint: 'fader', standaard: 0.5 },
    { id: 'take', naam: 'Take', soort: 'trigger', hint: 'pad' },
    { id: 'palet', naam: 'Palet', soort: 'keuze', keuzes: ['warm', 'koel', 'mono'], hint: 'kolom' },
    { id: 'ruimte', naam: 'Ruimte', soort: 'waarde', hint: 'knop', standaard: 0.4, rol: 'macro.ruimte', slew_s: 4 },
    { id: 'mute', naam: 'Mute', soort: 'schakelaar' },
    { id: 'paniek', naam: 'Paniek', soort: 'trigger' },
  ],
};
/** medisynth: ruimte zonder slew, plus paniek. */
export const MS = {
  v: 1, app: 'medisynth', naam: 'MediSynth', kleur: '#8b5cff',
  params: [
    { id: 'galm', naam: 'Galm', soort: 'waarde', rol: 'macro.ruimte' },
    { id: 'licht', naam: 'Licht', soort: 'waarde', rol: 'macro.helderheid' },
    { id: 'paniek', naam: 'Paniek', soort: 'trigger' },
  ],
};
export const DJ = { v: 1, app: 'varve-dj', naam: 'Varve DJ', lease: true, params: [] };
export const AVK = { v: 1, app: 'av-kern', naam: 'AV-kern', lease: true, rings: 'auto', params: [] };

export function nepOppervlak() {
  const o = {
    /** @type {Map<string, any>} */ leds: new Map(),
    /** @type {number[][]} */ gestuurd: [],
    getekend: 0,
    vergeten: 0,
    zet(id, s) { o.leds.set(id, s); },
    teken() { o.getekend++; return 0; },
    stuur(b) { o.gestuurd.push(b); },
    vergeet() { o.vergeten++; },
  };
  return o;
}

export function opzet(config = CONFIG) {
  const klok = new NepKlok();
  const opp = nepOppervlak();
  const kern = new Kern({ klok, config, oppervlak: opp });
  const naarApp = [], leds = [], opname = [];
  let beelden = 0;
  kern.bij('naarApp', (app, b) => naarApp.push([app, b]));
  kern.bij('leds', (x) => leds.push(x));
  kern.bij('opname', (aan) => opname.push(aan));
  kern.bij('beeld', () => { beelden++; });
  return { klok, opp, kern, naarApp, leds, opname, beelden: () => beelden };
}

export function nepVerbinding() {
  const v = { app: null, ontvangen: [], stuur(b) { v.ontvangen.push(b); } };
  return v;
}

/** Stuur een bericht zoals de transportlaag het doet: eerst controleren. */
export function stuurApp(kern, v, b) {
  const r = leesVanApp(b);
  if (!r.ok || 'onbekend' in r) throw new Error(`ongeldig testbericht: ${JSON.stringify(b)}`);
  kern.ontvang(v, r.bericht);
}

export function meldAan(kern, manifest, { inst = 'i1', staat = null } = {}) {
  const v = nepVerbinding();
  kern.verbind(v);
  stuurApp(kern, v, { t: 'hallo', app: manifest.app, inst, v: 1 });
  stuurApp(kern, v, { t: 'manifest', manifest });
  if (staat) stuurApp(kern, v, { t: 'staat', waarden: staat });
  return v;
}

export const apc = (kern, bytes) => kern.invoer(APC.ontleed(bytes), bytes);
const ctrl = (id) => { const c = APC.OP_ID.get(id); if (!c) throw new Error(id); return c; };
export const druk = (kern, id) => { const c = ctrl(id); apc(kern, [0x90 | c.ch, c.n, 127]); };
export const los = (kern, id) => { const c = ctrl(id); apc(kern, [0x80 | c.ch, c.n, 0]); };
export const tik = (kern, id) => { druk(kern, id); los(kern, id); };
export const draai = (kern, id, v) => { const c = ctrl(id); apc(kern, [0xb0 | c.ch, c.n, Math.round(v * 127)]); };

const lpdOntleder = LPD8.maakOntleder(LPD8.standaardProfiel('mk2'));
export const lpd = (kern, bytes) => kern.invoer(lpdOntleder(bytes), bytes);
export const lpdKnop = (kern, k, v) => lpd(kern, [0xb0, 69 + k, Math.round(v * 127)]);
export const lpdDruk = (kern, p) => lpd(kern, [0x90, 35 + p, 100]);
export const lpdLos = (kern, p) => lpd(kern, [0x80, 35 + p, 0]);

/** Berichten van één type die een verbinding ontving. */
export const van = (v, t) => v.ontvangen.filter((b) => b.t === t);
/** Wis wat een verbinding tot nu toe ontving. */
export const leeg = (...vs) => { for (const v of vs) v.ontvangen.length = 0; };
