// @ts-check
// Spiekbrief: wat doet welke knop, per set (docs/SPIEKBRIEF.md). Puur: set + config + manifesten in, overzicht uit.
//
// Niets wordt hier zelf bedacht of overgetypt. De indeling per app komt uit een ECHTE Kern (src/core/kern.js):
// de manifesten worden er aangemeld zoals een app of driver dat doet (hallo + manifest), en daarna lezen we wat
// de kern ervan maakte: genormaliseerd manifest, indeling (maakIndeling met de kaart uit config.kaarten), naam,
// kleur, slot, focus, hubtoets. Draait de hub, dan geeft de server zijn eigen kern mee (`uitKern`) en staat er
// wat de hub NU doet, met de echte Track Select-nummers. De LPD8-rollen komen uit ROLLEN (PROTOCOL §6), de tijden
// van P1 (paniek) en P5–P8 (lang = bewaren) uit de kern zelf. Wat de pads doen staat hieronder in woorden;
// test/spiekbrief.test.js drukt elke knop van de spiekbrief op een echte kern en kijkt of dat klopt.
import { Kern, PANIEK_MS, LANG_MS, TAP_RESET_MS } from '../core/kern.js';
import { NepKlok } from '../core/klok.js';
import { toewijzingen, RIJEN, KOLOMMEN } from '../core/indeling.js';
import { ROLLEN } from '../protocol/manifest.js';
import * as APC from '../devices/apc40mk2.js';

/** @typedef {import('../protocol/types.js').Manifest} Manifest @typedef {import('../protocol/types.js').Param} Param
 *  @typedef {import('../core/indeling.js').Indeling} Indeling @typedef {import('../core/indeling.js').Toewijzing} Toewijzing
 *  @typedef {import('../sets/set.js').SetDef} SetDef
 *  @typedef {'live'|'driver'|'vastgelegd'} BronSoort
 *  @typedef {{ manifest: unknown, bron: BronSoort, uitleg: string }} Bron  waar een manifest vandaan komt (bronnen.js)
 *  @typedef {{ app: string, naam: string, kleur: string, manifest: Manifest|null, indeling: Indeling|null,
 *    slot: number|null, status: string, fout: string|null }} KernApp  wat de kern van een app weet
 *  @typedef {{ apps: Map<string, KernApp>, focus: string|null, hubtoets: string, overname: boolean }} KernBeeld
 *  @typedef {{ ctrl: string, id: string, naam: string, soort: string, rol: string, optie?: string, stap?: number, takeover: string }} Vak
 *  @typedef {{ naam: string, dk: (Vak|null)[] }} Pagina
 *  @typedef {{
 *    app: string, naam: string, kleur: string, koppeling: string|null, bron: BronSoort|null, bronUitleg: string,
 *    soort: 'indeling'|'lease'|'volgt'|'fout', fout: string|null, slot: number|null, status: string|null,
 *    beginFocus: boolean, opmerking: string|null,
 *    faders: (Vak|null)[], tk: (Vak|null)[], paginas: Pagina[], grid: (Vak|null)[][], scenes: ({ ctrl: string, naam: string }|null)[],
 *    stopAll: Vak|null, overig: Vak[], niet: string[], macros: { knop: string, rol: string, naam: string }[], paniek: boolean,
 *  }} AppBlad
 *  @typedef {{ knop: string, ctrl: string, rol: string, naam: string, apps: { app: string, naam: string, param: string }[] }} LpdKnop
 *  @typedef {{ pad: string, ctrl: string, kort: string, uitleg: string }} LpdPad
 *  @typedef {{
 *    set: { id: string, naam: string, beschrijving: string, focus: string|null, focusNaam: string|null },
 *    live: boolean, apps: AppBlad[], ookVerbonden: { app: string, naam: string, kleur: string, slot: number|null }[],
 *    lpd8: { knoppen: LpdKnop[], pads: LpdPad[] },
 *    hub: { toets: string, toetsNaam: string, overname: boolean },
 *    fouten: string[],
 *  }} Spiekbrief
 *  `status` van een app: wat de draaiende hub ervan zegt ('actief', 'stil', 'weg', …), null zonder hub of als de
 *  hub de app nog nooit zag. `fouten`: bronbestanden die niet te lezen waren (bronnen.js laadBronnen).
 */

/** Hoe een rol op papier heet (PROTOCOL §6). Volgorde = K1..K8 = ROLLEN. */
export const ROL_NAMEN = Object.freeze(/** @type {Record<string, string>} */ ({
  'macro.intensiteit': 'intensiteit',
  'macro.helderheid': 'helderheid',
  'macro.ruimte': 'ruimte',
  'macro.beweging': 'beweging',
  'macro.kleur': 'kleur',
  'macro.dichtheid': 'dichtheid',
  'klok.adem_periode': 'adem-tempo',
  'macro.balans': 'balans klank ↔ beeld',
}));

/** Seconden, op z'n Nederlands (0,6 s; 1 s). @param {number} ms */
export const sec = (ms) => `${String(Math.round(ms / 100) / 10).replace('.', ',')} s`;

/**
 * Wat de LPD8-pads doen (src/core/kern.js #lpd8), met de tijden van de kern. P5–P8 zijn dezelfde snapshots 1–4
 * als Bank + Scene 1–4. test/spiekbrief.test.js drukt ze op een echte kern.
 * @param {string[]} paniekApps namen van de apps die een trigger "paniek" hebben
 * @returns {LpdPad[]}
 */
export function lpdPads(paniekApps) {
  const wie = paniekApps.length ? `${paniekApps.join(', ')}; loslaten = paniek uit` : 'geen app in deze set heeft een paniek (alleen globaal)';
  return [
    { pad: 'P1', ctrl: 'p1', kort: `paniek: ${sec(PANIEK_MS)} vasthouden`, uitleg: wie },
    { pad: 'P2', ctrl: 'p2', kort: 'tap tempo', uitleg: `tik op de tel (vanaf 2 tikken; ${sec(TAP_RESET_MS)} stil = opnieuw)` },
    { pad: 'P3', ctrl: 'p3', kort: 'adem opnieuw', uitleg: 'de ademklok begint bij 0 (inademen)' },
    { pad: 'P4', ctrl: 'p4', kort: 'opname aan/uit', uitleg: 'de avond opnemen in de avondmap (docs/OPNAME.md)' },
    ...[1, 2, 3, 4].map((nr) => ({
      pad: `P${nr + 4}`, ctrl: `p${nr + 4}`, kort: `snapshot ${nr}`,
      uitleg: `kort = laden, langer dan ${sec(LANG_MS)} = bewaren`,
    })),
  ];
}

/** Een oppervlak dat niets tekent: de schaduw-kern rekent alleen. */
const STIL = Object.freeze({ zet() {}, teken() {}, stuur() {}, vergeet() {} });

/**
 * Meld manifesten aan bij een echte Kern (met nep-klok, zonder controllers) en lees terug wat die ervan maakt.
 * In de volgorde van `ids` (zo krijgen ze slots en krijgt de eerste de focus, net als in de hub).
 * @param {any} config @param {string[]} ids @param {Record<string, Bron|undefined>} bronnen
 * @returns {KernBeeld}
 */
export function schaduwKern(config, ids, bronnen) {
  const kern = new Kern({ klok: new NepKlok(), config, oppervlak: STIL });
  /** @type {Map<string, string>} */
  const fouten = new Map();
  try {
    for (const app of ids) {
      const b = bronnen[app];
      if (!b) continue;
      const v = { app: /** @type {string|null} */ (null), stuur(/** @type {any} */ x) { if (x?.t === 'fout') fouten.set(app, String(x.reden)); } };
      kern.verbind(v);
      kern.ontvang(v, { t: 'hallo', app, inst: 'spiekbrief', v: 1 });
      kern.ontvang(v, { t: 'manifest', manifest: b.manifest });
    }
    const beeld = uitKern(kern);
    for (const [app, fout] of fouten) { const a = beeld.apps.get(app); if (a && !a.manifest) a.fout = fout; }
    return beeld;
  } finally {
    kern.stop();
  }
}

/**
 * Wat een (draaiende of schaduw-)kern van zijn apps weet. Leest de publieke velden van src/core/kern.js.
 * @param {any} kern
 * @returns {KernBeeld}
 */
export function uitKern(kern) {
  /** @type {Map<string, KernApp>} */
  const apps = new Map();
  for (const a of kern.apps?.values?.() ?? []) {
    apps.set(a.app, {
      app: a.app, naam: a.naam, kleur: a.kleurHex, manifest: a.manifest ?? null, indeling: a.indeling ?? null,
      slot: a.slot ?? null, status: a.status, fout: null,
    });
  }
  return { apps, focus: kern.focusApp ?? null, hubtoets: kern.hubtoets ?? 'bank', overname: kern.overname !== false };
}

/** @param {Toewijzing|undefined} t @param {string} ctrl @param {Manifest} m @returns {Vak|null} */
function vak(t, ctrl, m) {
  if (!t) return null;
  const p = m.params.find((x) => x.id === t.id);
  /** @type {Vak} */
  const v = { ctrl, id: t.id, naam: p?.naam ?? t.id, soort: p?.soort ?? '?', rol: t.rol, takeover: t.takeover };
  if (t.rol === 'keuze' && t.optie !== undefined) v.optie = p?.keuzes?.[t.optie] ?? `optie ${t.optie + 1}`;
  if (t.rol === 'stap') v.stap = t.n ?? p?.keuzes?.length ?? 2;
  return v;
}

const VASTE_CTRLS = new Set([
  ...Array.from({ length: 8 }, (_, i) => [`fader${i + 1}`, `tk${i + 1}`, `dk${i + 1}`]).flat(),
  ...Array.from({ length: RIJEN }, (_, r) => Array.from({ length: KOLOMMEN }, (_, c) => APC.padId(r + 1, c + 1))).flat(),
  ...Array.from({ length: 5 }, (_, i) => `scene${i + 1}`),
]);

/**
 * Het blad van één app: wat elke control van de APC doet als deze app focus heeft.
 * @param {string} id @param {KernApp|undefined} k @param {Bron|undefined} bron @param {any} config @param {SetDef} set
 * @param {string|null} bronFout een kapot bronbestand van deze app (`<app>.json: …`), als er geen manifest is
 * @returns {AppBlad}
 */
function appBlad(id, k, bron, config, set, bronFout) {
  const cfg = config?.apps?.[id] ?? {};
  const m = k?.manifest ?? null;
  /** @type {AppBlad} */
  const blad = {
    app: id, naam: k?.naam ?? cfg.naam ?? id, kleur: k?.kleur ?? (typeof cfg.kleur === 'string' ? cfg.kleur : '#ffffff'),
    koppeling: typeof cfg.koppeling === 'string' ? cfg.koppeling : null,
    bron: m ? (bron?.bron ?? null) : null, bronUitleg: m ? (bron?.uitleg ?? '') : '',
    soort: !m ? (k?.fout || bronFout ? 'fout' : 'volgt') : m.lease ? 'lease' : 'indeling', fout: k?.fout ?? (m ? null : bronFout),
    slot: k?.slot ?? null, status: k?.status ?? null, beginFocus: set.focus === id, opmerking: set.apps[id]?.opmerking ?? null,
    faders: [], tk: [], paginas: [], grid: [], scenes: [], stopAll: null, overig: [], niet: [], macros: [], paniek: false,
  };
  if (!m) return blad;
  for (const p of m.params) {
    const i = p.rol ? /** @type {readonly string[]} */ (ROLLEN).indexOf(p.rol) : -1;
    if (i >= 0 && p.soort !== 'trigger') blad.macros.push({ knop: `K${i + 1}`, rol: /** @type {string} */ (p.rol), naam: p.naam });
  }
  blad.paniek = m.params.some((p) => p.id === 'paniek' && p.soort === 'trigger');
  const ind = k?.indeling;
  if (m.lease || !ind) return blad;

  const vast = toewijzingen(ind, 0);
  const acht = (/** @type {string} */ pre, tw = vast) => Array.from({ length: 8 }, (_, i) => vak(tw[`${pre}${i + 1}`], `${pre}${i + 1}`, m));
  blad.faders = acht('fader');
  blad.tk = acht('tk');
  blad.paginas = ind.paginas.map((_, p) => ({ naam: ind.paginaNamen[p] ?? '', dk: acht('dk', toewijzingen(ind, p)) }))
    .filter((p, i, alle) => alle.length > 1 || p.dk.some(Boolean));
  for (let r = RIJEN; r >= 1; r--) blad.grid.push(Array.from({ length: KOLOMMEN }, (_, c) => vak(vast[APC.padId(r, c + 1)], APC.padId(r, c + 1), m)));
  blad.scenes = Array.from({ length: 5 }, (_, i) => {
    const ctrl = `scene${i + 1}`;
    const t = vast[ctrl];
    if (t) return { ctrl, naam: /** @type {Vak} */ (vak(t, ctrl, m)).naam };
    return i < ind.scenes ? { ctrl, naam: m.scenes?.[i] ?? `scène ${i + 1}` } : null;
  });
  if (ind.paniek && !vast.stopall) blad.stopAll = vak({ id: ind.paniek, rol: 'trigger', takeover: 'direct' }, 'stopall', m);
  blad.overig = Object.entries(vast).filter(([c]) => !VASTE_CTRLS.has(c)).map(([c, t]) => /** @type {Vak} */ (vak(t, c, m)));
  blad.niet = ind.niet.map((pid) => m.params.find((p) => p.id === pid)?.naam ?? pid);
  return blad;
}

/**
 * Het overzicht van één set.
 * @param {{
 *   id: string, set: SetDef, config: any, bronnen: Record<string, Bron|undefined>,
 *   kern?: KernBeeld|null, fouten?: string[],
 * }} o  `bronnen`: manifest per app (bronnen.js); `fouten`: wat laadBronnen niet kon lezen. `kern`: de draaiende hub (uitKern(hub.kern)); zonder rekent
 *   een schaduw-kern de indeling uit en zijn er geen Track Select-nummers (die hangen af van wie zich eerst meldt).
 * @returns {Spiekbrief}
 */
export function maakSpiekbrief({ id, set, config, bronnen, kern = null, fouten = [] }) {
  const ids = Object.keys(set.apps);
  const live = !!kern;
  // Live: wat de hub heeft wint (ook voor apps die nu niet verbonden zijn maar wel een manifest stuurden);
  // de rest (nog nooit gemeld) rekent een schaduw-kern uit de vastgelegde manifesten.
  const ontbreekt = ids.filter((a) => !kern?.apps.get(a)?.manifest);
  const schaduw = schaduwKern(config, ontbreekt, bronnen);
  /** @type {(app: string) => { k: KernApp|undefined, b: Bron|undefined }} */
  const kies = (app) => {
    const echt = kern?.apps.get(app);
    if (echt?.manifest) return { k: echt, b: { manifest: echt.manifest, bron: 'live', uitleg: echt.status === 'weg' ? 'zoals de hub hem kent (nu niet verbonden)' : 'live uit de hub' } };
    const s = schaduw.apps.get(app);
    return { k: s ? { ...s, slot: echt?.slot ?? null, status: echt?.status ?? null } : echt, b: bronnen[app] };
  };
  // Een kapot bronbestand van een app zonder manifest: dan is dát de reden, niet "hij meldde zich nooit".
  const bronFout = (/** @type {string} */ app) => fouten.find((f) => f.startsWith(`${app}.json:`)) ?? null;
  const apps = ids.map((app) => { const { k, b } = kies(app); return appBlad(app, k, b, config, set, bronFout(app)); });
  const naamVan = (/** @type {string|null|undefined} */ app) => (app ? apps.find((a) => a.app === app)?.naam ?? config?.apps?.[app]?.naam ?? app : null);

  const knoppen = ROLLEN.map((rol, i) => ({
    knop: `K${i + 1}`, ctrl: `k${i + 1}`, rol, naam: ROL_NAMEN[rol] ?? rol,
    apps: apps.flatMap((a) => a.macros.filter((x) => x.rol === rol).map((x) => ({ app: a.app, naam: a.naam, param: x.naam }))),
  }));
  const hubtoets = kern?.hubtoets ?? schaduw.hubtoets;
  return {
    set: { id, naam: set.naam, beschrijving: set.beschrijving ?? '', focus: set.focus ?? null, focusNaam: naamVan(set.focus) },
    live,
    apps,
    ookVerbonden: live
      ? [.../** @type {KernBeeld} */ (kern).apps.values()].filter((a) => !ids.includes(a.app) && a.status !== 'weg')
        .map((a) => ({ app: a.app, naam: a.naam, kleur: a.kleur, slot: a.slot }))
      : [],
    lpd8: { knoppen, pads: lpdPads(apps.filter((a) => a.paniek).map((a) => a.naam)) },
    hub: { toets: hubtoets, toetsNaam: APC.OP_ID.get(hubtoets)?.label ?? hubtoets, overname: kern?.overname ?? schaduw.overname },
    fouten: [...fouten],
  };
}
