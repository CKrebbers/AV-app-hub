// @ts-check
// Manifest-validatie (PROTOCOL.md §4). Geeft een genormaliseerd manifest terug (standaardwaarden ingevuld)
// of een lijst fouten in gewone taal — die gaan als {t:"fout"} terug naar de app.

/** @typedef {import('./types.js').Manifest} Manifest @typedef {import('./types.js').Param} Param */

export const APP_ID = /^[a-z0-9-]{1,32}$/;
export const PARAM_ID = /^[a-z0-9_.-]{1,48}$/;
export const SOORTEN = /** @type {const} */ (['waarde', 'schakelaar', 'trigger', 'keuze']);
export const HINTS = /** @type {const} */ (['fader', 'knop', 'pad', 'kolom']);
export const TAKEOVERS = /** @type {const} */ (['pickup', 'direct', 'schaal']);
export const ROLLEN = /** @type {const} */ ([
  'macro.intensiteit', 'macro.helderheid', 'macro.ruimte', 'macro.beweging',
  'macro.kleur', 'macro.dichtheid', 'klok.adem_periode', 'macro.balans',
]);
/**
 * Het parameter-alfabet (§19): acht vaste betekenissen op vaste plekken. Plek = index + 1 = APC device-knop N =
 * Maschine-draaiknop N. Elke app legt dezelfde betekenis op dezelfde plek; zo leer je één keer waar "beweging" zit.
 */
export const ALFABET = /** @type {const} */ ([
  'alfabet.schaal', 'alfabet.dichtheid', 'alfabet.beweging', 'alfabet.vervorming',
  'alfabet.kleur', 'alfabet.helderheid', 'alfabet.variatie', 'alfabet.ruimte',
]);
/** De momenten (§19): pads 1–8 van de Maschine. Alleen op een trigger. Plek = index + 1 = pad N. */
export const MOMENTEN = /** @type {const} */ ([
  'moment.flits', 'moment.stoot', 'moment.omkeren', 'moment.bevriezen',
  'moment.zaad', 'moment.terug', 'moment.wis', 'moment.halvetijd',
]);
/** Plek 1..8 van een alfabet-rol, 0 als het er geen is. @param {unknown} rol */
export const alfabetPlek = (rol) => /** @type {readonly unknown[]} */ (ALFABET).indexOf(rol) + 1;
/** Plek 1..8 van een moment-rol (pad N), 0 als het er geen is. @param {unknown} rol */
export const momentPlek = (rol) => /** @type {readonly unknown[]} */ (MOMENTEN).indexOf(rol) + 1;
/** Het woord achter de punt: 'alfabet.kleur' → 'kleur'. @param {string} rol */
export const rolWoord = (rol) => rol.slice(rol.indexOf('.') + 1);
/**
 * Op welke globale macro (§6) een parameter met deze rol reageert (§19). Een macro-rol op zichzelf; een alfabet-rol
 * op de macro met hetzelfde woord als die bestaat (`alfabet.kleur` → `macro.kleur`); verder niets (null).
 * @param {string|undefined} rol @returns {string|null}
 */
export function macroVan(rol) {
  if (!rol) return null;
  if (/** @type {readonly string[]} */ (ROLLEN).includes(rol)) return rol;
  if (!alfabetPlek(rol)) return null;
  const m = `macro.${rolWoord(rol)}`;
  return /** @type {readonly string[]} */ (ROLLEN).includes(m) ? m : null;
}
export const MAX_PARAMS = 128;
/** Speelapparaten die een lease-app in `speelt` kan noemen (§17). Een onbekende naam valt weg (grondregel 5). */
export const SPEELAPPARATEN = /** @type {const} */ (['xboard49', 'maschine-mk2']);
/** Groepen die een app aan de globale laag kan leveren (`levert`, §18). Een onbekende groep valt weg (grondregel 5). */
export const GROEPEN = /** @type {const} */ (['sectie']);

const is01 = (/** @type {unknown} */ x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
const isTekst = (/** @type {unknown} */ x, max = 64) => typeof x === 'string' && x.length > 0 && x.length <= max;

/**
 * @param {unknown} m
 * @returns {{ ok: true, manifest: Manifest } | { ok: false, fouten: string[] }}
 */
export function valideerManifest(m) {
  /** @type {string[]} */
  const f = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, fouten: ['manifest is geen object'] };
  const x = /** @type {Record<string, any>} */ (m);
  if (x.v !== 1) f.push('v moet 1 zijn');
  if (typeof x.app !== 'string' || !APP_ID.test(x.app)) f.push('app moet [a-z0-9-]{1,32} zijn');
  if (!isTekst(x.naam)) f.push('naam ontbreekt (max 64 tekens)');
  if (x.kleur !== undefined && !(typeof x.kleur === 'string' && /^#[0-9a-fA-F]{6}$/.test(x.kleur))) f.push('kleur moet #rrggbb zijn');
  if (x.truth !== undefined && x.truth !== 'app' && x.truth !== 'hub') f.push('truth moet "app" of "hub" zijn');
  if (x.hb_s !== undefined && !(typeof x.hb_s === 'number' && x.hb_s >= 0.2 && x.hb_s <= 10)) f.push('hb_s moet tussen 0.2 en 10 liggen');
  if (x.lease !== undefined && typeof x.lease !== 'boolean') f.push('lease moet true/false zijn');
  if (x.rings !== undefined && x.rings !== 'host' && x.rings !== 'auto') f.push('rings moet "host" of "auto" zijn');
  if (x.scenes !== undefined && !(Array.isArray(x.scenes) && x.scenes.length <= 5 && x.scenes.every((s) => isTekst(s, 32)))) f.push('scenes: max 5 namen');
  if (x.speelt !== undefined) {
    if (!(Array.isArray(x.speelt) && x.speelt.length <= 8 && x.speelt.every((d) => typeof d === 'string' && APP_ID.test(d)))) f.push('speelt moet een lijst apparaatnamen zijn (max 8), bv. ["xboard49", "maschine-mk2"]');
    else if (x.lease !== true && x.speelt.length) f.push('speelt kan alleen met lease: true (de app krijgt ruwe MIDI van die apparaten)');
  }
  if (x.levert !== undefined && !(Array.isArray(x.levert) && x.levert.length <= 8 && x.levert.every((g) => typeof g === 'string' && APP_ID.test(g)))) {
    f.push('levert moet een lijst groepen zijn (max 8), bv. ["sectie"]');
  }
  // §21: welke parameters het XY-vlak van de KP3+ stuurt (een rol of een parameter-id per as); maps/<app>.json gaat voor.
  const isXy = (/** @type {any} */ v) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => k === 'x' || k === 'y')
    && ['x', 'y'].every((k) => v[k] === undefined || (typeof v[k] === 'string' && PARAM_ID.test(v[k])));
  if (x.xy !== undefined && !isXy(x.xy)) f.push('xy moet { "x": …, "y": … } zijn, met per as een rol of parameter-id ([a-z0-9_.-]{1,48}), bv. { "x": "alfabet.vervorming", "y": "galm" }');
  const lease = x.lease === true;
  if (!Array.isArray(x.params)) { if (!lease) f.push('params moet een lijst zijn'); }
  else if (x.params.length > MAX_PARAMS) f.push(`max ${MAX_PARAMS} params`);

  /** @type {Param[]} */
  const params = [];
  const ids = new Set();
  /** Alfabet- en moment-rollen die al vergeven zijn → id (§19). @type {Map<string, string>} */
  const alfabet = new Map();
  /** Triggers met `druk` (§19): [waar, id van de waarde]. Pas na de lus te controleren. @type {[string, string][]} */
  const druk = [];
  for (const [i, p] of (Array.isArray(x.params) ? x.params : []).entries()) {
    const waar = `params[${i}]${p && typeof p.id === 'string' ? ` (${p.id})` : ''}`;
    if (!p || typeof p !== 'object') { f.push(`${waar}: geen object`); continue; }
    if (typeof p.id !== 'string' || !PARAM_ID.test(p.id)) f.push(`${waar}: id moet [a-z0-9_.-]{1,48} zijn`);
    else if (ids.has(p.id)) f.push(`${waar}: id komt dubbel voor`);
    else ids.add(p.id);
    if (!isTekst(p.naam, 48)) f.push(`${waar}: naam ontbreekt`);
    if (!SOORTEN.includes(p.soort)) f.push(`${waar}: soort moet ${SOORTEN.join('|')} zijn`);
    if (p.standaard !== undefined && !is01(p.standaard)) f.push(`${waar}: standaard moet 0..1 zijn`);
    if (p.soort === 'keuze' && !(Array.isArray(p.keuzes) && p.keuzes.length >= 2 && p.keuzes.length <= 8 && p.keuzes.every((k) => isTekst(k, 32)))) f.push(`${waar}: keuze heeft 2..8 keuzes nodig`);
    if (p.hint !== undefined && !HINTS.includes(p.hint)) f.push(`${waar}: hint moet ${HINTS.join('|')} zijn`);
    if (p.groep !== undefined && !isTekst(p.groep, 32)) f.push(`${waar}: groep max 32 tekens`);
    if (p.rol !== undefined) {
      if (alfabetPlek(p.rol)) {
        if (p.soort === 'trigger') f.push(`${waar}: ${p.rol} kan niet op een trigger (het alfabet is voor draaiknoppen)`);
        else if (alfabet.has(p.rol)) f.push(`${waar}: ${p.rol} staat al op ${alfabet.get(p.rol)} (één parameter per alfabet-plek)`);
        else alfabet.set(p.rol, p.id);
      } else if (momentPlek(p.rol)) {
        if (p.soort !== 'trigger') f.push(`${waar}: ${p.rol} kan alleen op een trigger`);
        else if (alfabet.has(p.rol)) f.push(`${waar}: ${p.rol} staat al op ${alfabet.get(p.rol)} (één trigger per moment)`);
        else alfabet.set(p.rol, p.id);
      } else if (typeof p.rol === 'string' && /^(alfabet|moment)\./.test(p.rol)) {
        f.push(`${waar}: onbekende rol ${p.rol} (het ${p.rol.startsWith('alfabet.') ? `alfabet: ${ALFABET.map(rolWoord).join(', ')}` : `momenten: ${MOMENTEN.map(rolWoord).join(', ')}`})`);
      } else if (!ROLLEN.includes(p.rol)) f.push(`${waar}: onbekende rol ${p.rol}`);
    }
    if (p.druk !== undefined) {
      if (p.soort !== 'trigger') f.push(`${waar}: druk kan alleen op een trigger`);
      else if (typeof p.druk !== 'string' || !PARAM_ID.test(p.druk)) f.push(`${waar}: druk moet de id van een waarde-parameter zijn`);
      else druk.push([waar, p.druk]);
    }
    if (p.slew_s !== undefined && !(typeof p.slew_s === 'number' && p.slew_s >= 0 && p.slew_s <= 120)) f.push(`${waar}: slew_s 0..120`);
    if (p.takeover !== undefined && !TAKEOVERS.includes(p.takeover)) f.push(`${waar}: takeover moet ${TAKEOVERS.join('|')} zijn`);
    params.push({ ...p, standaard: p.standaard ?? 0 });
  }
  for (const [waar, id] of druk) {
    const doel = params.find((x) => x.id === id);
    if (!doel || doel.soort !== 'waarde') f.push(`${waar}: druk ${id} is geen waarde-parameter van deze app`);
  }
  if (f.length) return { ok: false, fouten: f };
  return {
    ok: true,
    manifest: {
      v: 1, app: x.app, naam: x.naam, ...(x.kleur ? { kleur: x.kleur.toLowerCase() } : {}),
      truth: x.truth ?? 'app', hb_s: x.hb_s ?? 1, lease, ...(lease ? { rings: x.rings ?? 'host' } : {}),
      // Alleen de apparaten die de hub kent, elk één keer (een nieuwere app mag er een noemen die deze hub niet kent).
      ...(lease && Array.isArray(x.speelt) ? { speelt: [...new Set(x.speelt.filter((/** @type {any} */ d) => SPEELAPPARATEN.includes(d)))] } : {}),
      // §18: alleen de groepen die de hub kent, elk één keer.
      ...(Array.isArray(x.levert) ? { levert: [...new Set(x.levert.filter((/** @type {any} */ g) => GROEPEN.includes(g)))] } : {}),
      ...(x.xy && (x.xy.x || x.xy.y) ? { xy: { ...(x.xy.x ? { x: x.xy.x } : {}), ...(x.xy.y ? { y: x.xy.y } : {}) } } : {}),
      scenes: x.scenes ?? [], params,
    },
  };
}

/** Waarde op de draad voor een keuze-index. @param {number} i @param {number} n */
export const keuzeNaarWaarde = (i, n) => (n <= 1 ? 0 : i / (n - 1));
/** Keuze-index uit een draadwaarde. @param {number} v @param {number} n */
export const waardeNaarKeuze = (v, n) => Math.max(0, Math.min(n - 1, Math.round(v * (n - 1))));
