// @ts-check
// Herhalen: een opgenomen avond (gebaren.jsonl) opnieuw afspelen tegen een draaiende hub, met dezelfde
// timing (of sneller/langzamer), en aan het eind de eindwaarden per app vergelijken met de opname.
//
// Alleen de ruwe controller-invoer wordt afgespeeld — precies alsof de controllers het deden. De berichten
// naar apps in de opname zijn het verwachte gevolg, niet de oorzaak. Overgeslagen:
// - SysEx (identiteitsantwoorden, programma-dumps): zegt niets over spelen;
// - LPD8-pad 4 indrukken: dat is de opname-knop zelf (anders start/stopt de herhaling een nieuwe opname).
//
// Een doel is alles waarmee de hub te bespelen is:
//   { invoer(dev: 'apc40'|'lpd8', bytes), cockpit(bericht), eindstaat(): Eindstaat | Promise<Eindstaat> }
// LPD8-bytes gaan altijd in de mk2-fabrieksstand naar het doel (zoals de virtuele LPD8 van de cockpit,
// PROTOCOL.md §10): de opname leest ze eerst met het profiel van toen. Zo maakt het geen verschil welke
// LPD8 (of welk profiel) de hub van nu heeft.
import * as APC from '../devices/apc40mk2.js';
import * as LPD8 from '../devices/lpd8.js';
import { vergelijkEindstaat } from './staat.js';

/** @typedef {import('../core/klok.js').Klok} Klok @typedef {import('./staat.js').Eindstaat} Eindstaat */
/** @typedef {{ invoer: (dev: 'apc40'|'lpd8', bytes: number[]) => void, cockpit: (b: any) => void, eindstaat: () => Eindstaat|Promise<Eindstaat> }} Doel */
/** @typedef {{ ms: number, dev: string, bytes: number[] } | { ms: number, profiel: any }} Stap */
/** @typedef {{ gespeeld: number, overgeslagen: Record<string, number>, verschillen: ReturnType<typeof vergelijkEindstaat>|null, eindstaat: Eindstaat, duurMs: number }} Resultaat */

const FABRIEK = LPD8.standaardProfiel('mk2');
const fabriekOntleder = LPD8.maakOntleder(FABRIEK);

/**
 * Lees gebaren.jsonl. Een afgebroken laatste regel (stroom weg tijdens het schrijven) wordt overgeslagen.
 * @param {string} tekst
 */
export function leesOpname(tekst) {
  /** @type {any[]} */
  const regels = [];
  let kapot = 0;
  for (const r of tekst.split('\n')) {
    if (!r.trim()) continue;
    try { regels.push(JSON.parse(r)); } catch { kapot++; }
  }
  const kop = regels[0];
  if (!kop || typeof kop !== 'object' || Array.isArray(kop) || kop.v !== 1) throw new Error('geen opname: de eerste regel is geen kop met v:1');
  /** @type {Stap[]} */
  const stappen = [];
  let beginstand = null, eind = null;
  /** @type {Record<string, number>} */
  const naar = {};
  for (const x of regels.slice(1)) {
    if (Array.isArray(x)) {
      if (x[1] === 'in' && typeof x[2] === 'string' && Array.isArray(x[3])) stappen.push({ ms: Number(x[0]) || 0, dev: x[2], bytes: x[3] });
      else if (x[1] === 'naar' && typeof x[2] === 'string') naar[x[2]] = (naar[x[2]] ?? 0) + 1;
    } else if (x && typeof x === 'object') {
      if (x.e === 'beginstand') beginstand = x;
      else if (x.e === 'eind') eind = x;
      else if (x.e === 'lpd8profiel') stappen.push({ ms: Number(x.ms) || 0, profiel: x.profiel });
    }
  }
  return { kop, beginstand, eind, stappen, naar, kapot };
}

/** Een LPD8-gebeurtenis in de mk2-fabrieksstand (wat de virtuele LPD8 zou sturen). @param {any} g @returns {number[]|null} */
export function naarFabriek(g) {
  const m = /^([pk])([1-8])$/.exec(g?.el ?? '');
  if (!m) return null;
  const i = Number(m[2]) - 1;
  const raw = typeof g.raw === 'number' ? g.raw : Math.round((g.v ?? 0) * 127);
  if (m[1] === 'k') return [0xb0, FABRIEK.knoppen[i].n, Math.max(0, Math.min(127, raw))];
  if (g.kind === 'druk') return [0x99, FABRIEK.pads[i].n, Math.max(1, Math.min(127, raw || 127))];
  if (g.kind === 'los') return [0x89, FABRIEK.pads[i].n, 0];
  return null;
}

/**
 * Eén opgenomen invoer → wat er naar het doel moet (of null = overslaan, met reden).
 * @param {string} dev @param {number[]} bytes @param {(b: number[]) => any} lpd8Ontleder ontleder van de echte LPD8 toen
 * @returns {{ dev: 'apc40'|'lpd8', bytes: number[] } | { overslaan: string }}
 */
export function vertaal(dev, bytes, lpd8Ontleder) {
  if (!bytes.length || bytes[0] === 0xf0) return { overslaan: 'sysex' };
  if (dev === 'apc40' || dev === 'apc40-virtueel') return { dev: 'apc40', bytes };
  if (dev === 'lpd8' || dev === 'lpd8-virtueel') {
    const g = (dev === 'lpd8' ? lpd8Ontleder : fabriekOntleder)(bytes);
    if (g.el === 'p4' && g.kind === 'druk') return { overslaan: 'opname-knop' };
    const b = naarFabriek(g);
    return b ? { dev: 'lpd8', bytes: b } : { overslaan: 'onbekend' };
  }
  return { overslaan: 'onbekend apparaat' };
}

/**
 * Zet de beginstand van de opname klaar via cockpit-opdrachten: eerst de snapshots (waarden zetten en
 * bewaren), dan de waarden van toen, dan de focus. Apps die er nu niet zijn, worden overgeslagen.
 * @param {Doel} doel @param {any} bs beginstand-regel @param {Set<string>|null} aanwezig apps die het doel nu kent (null = onbekend)
 */
export function herstelBeginstand(doel, bs, aanwezig = null) {
  if (!bs) return;
  const mag = (/** @type {string} */ app) => aanwezig === null || aanwezig.has(app);
  /** @param {Record<string, Record<string, number>>} stand */
  const zetAlles = (stand) => {
    for (const [app, w] of Object.entries(stand ?? {})) {
      if (!mag(app)) continue;
      for (const [id, v] of Object.entries(w ?? {})) if (typeof v === 'number') doel.cockpit({ t: 'zet', app, id, v });
    }
  };
  for (const [nr, s] of Object.entries(bs.snapshots ?? {})) {
    zetAlles(/** @type {any} */ (s));
    doel.cockpit({ t: 'snapshot', nr: Number(nr), actie: 'bewaar' });
  }
  zetAlles(bs.apps);
  if (bs.focus === null || (typeof bs.focus === 'string' && mag(bs.focus))) doel.cockpit({ t: 'focus', app: bs.focus });
}

/**
 * Speel een opname af. Lost op na de laatste invoer + naloop, met de verschillen in de eindstaat.
 * @param {{
 *   opname: ReturnType<typeof leesOpname>, doel: Doel, klok: Klok, snelheid?: number, beginstand?: boolean,
 *   naloopMs?: number, aanwezig?: Set<string>|null, bijStap?: (i: number, n: number) => void,
 * }} o
 * @returns {Promise<Resultaat>}
 */
export function herhaal({ opname, doel, klok, snelheid = 1, beginstand = true, naloopMs = 300, aanwezig = null, bijStap = () => {} }) {
  if (!(snelheid > 0) || !Number.isFinite(snelheid)) throw new Error(`snelheid moet een getal > 0 zijn (kreeg ${snelheid})`);
  if (beginstand) herstelBeginstand(doel, opname.beginstand, aanwezig);
  let ontleder = LPD8.maakOntleder(opname.kop.lpd8 ?? LPD8.standaardProfiel(null));
  const stappen = opname.stappen;
  const n = stappen.filter((s) => 'dev' in s).length;
  /** @type {Record<string, number>} */
  const overgeslagen = {};
  let gespeeld = 0, i = 0, gedaan = 0;
  const t0 = klok.nu();
  const ms0 = stappen.find((s) => 'dev' in s)?.ms ?? 0;
  return new Promise((goed, fout) => {
    const eind = async () => {
      try {
        const staat = await doel.eindstaat();
        const verschillen = opname.eind ? vergelijkEindstaat(opname.eind.apps, staat) : null;
        goed({ gespeeld, overgeslagen, verschillen, eindstaat: staat, duurMs: klok.nu() - t0 });
      } catch (e) { fout(e); }
    };
    const volgende = () => {
      try {
        const nu = klok.nu() - t0;
        while (i < stappen.length && (stappen[i].ms - ms0) / snelheid <= nu) {
          const s = stappen[i++];
          if ('profiel' in s) { if (s.profiel) ontleder = LPD8.maakOntleder(s.profiel); continue; }
          const v = vertaal(s.dev, s.bytes, ontleder);
          gedaan++;
          if ('overslaan' in v) overgeslagen[v.overslaan] = (overgeslagen[v.overslaan] ?? 0) + 1;
          else { doel.invoer(v.dev, v.bytes); gespeeld++; }
          bijStap(gedaan, n);
        }
        if (i < stappen.length) klok.zet(volgende, Math.max(0, (stappen[i].ms - ms0) / snelheid - (klok.nu() - t0)));
        else klok.zet(eind, naloopMs);
      } catch (e) { fout(e); }
    };
    klok.zet(volgende, 0);
  });
}

/**
 * Doel in hetzelfde proces: een draaiende hub (startHub) of een losse kern (tests).
 * Invoer gaat via de virtuele controllers van de hub (opVirtueel → kern.invoer), of rechtstreeks in kern.invoer.
 * @param {{ kern: any, opVirtueel?: (dev: 'apc40'|'lpd8', bytes: number[]) => void }} hub
 * @returns {Doel}
 */
export function doelVanHub({ kern, opVirtueel }) {
  return {
    invoer(dev, bytes) {
      if (opVirtueel) return opVirtueel(dev, bytes);
      kern.invoer(dev === 'apc40' ? APC.ontleed(bytes) : fabriekOntleder(bytes), bytes);
    },
    cockpit: (b) => kern.cockpit(b),
    eindstaat: () => Object.fromEntries(kern.beeld().apps.map((/** @type {any} */ a) => [a.app, { ...a.waarden }])),
  };
}

/** Leesbaar verslag van een herhaling. @param {Resultaat} r */
export function verslag(r) {
  const regels = [`${r.gespeeld} gebaren afgespeeld in ${(r.duurMs / 1000).toFixed(1)} s`];
  const over = Object.entries(r.overgeslagen);
  if (over.length) regels.push(`overgeslagen: ${over.map(([k, n]) => `${k} ${n}`).join(', ')}`);
  if (r.verschillen === null) regels.push('de opname heeft geen eindstaat (afgebroken?) — niets om te vergelijken');
  else if (!r.verschillen.length) regels.push('eindstaat klopt: elke app heeft dezelfde staat-hash als in de opname');
  else {
    regels.push(`VERSCHILLEN in ${r.verschillen.length} app(s):`);
    for (const v of r.verschillen) {
      if (v.soort === 'ontbreekt') { regels.push(`  ${v.app}: niet verbonden met de hub`); continue; }
      regels.push(`  ${v.app}: hash ${v.hash?.werkelijk} ≠ ${v.hash?.verwacht} (opname)`);
      for (const x of v.ids ?? []) regels.push(`    ${x.id}: ${x.werkelijk ?? '–'} (opname ${x.verwacht ?? '–'})`);
    }
  }
  return regels.join('\n');
}
