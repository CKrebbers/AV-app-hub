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
export const MAX_PARAMS = 128;

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
  const lease = x.lease === true;
  if (!Array.isArray(x.params)) { if (!lease) f.push('params moet een lijst zijn'); }
  else if (x.params.length > MAX_PARAMS) f.push(`max ${MAX_PARAMS} params`);

  /** @type {Param[]} */
  const params = [];
  const ids = new Set();
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
    if (p.rol !== undefined && !ROLLEN.includes(p.rol)) f.push(`${waar}: onbekende rol ${p.rol}`);
    if (p.slew_s !== undefined && !(typeof p.slew_s === 'number' && p.slew_s >= 0 && p.slew_s <= 120)) f.push(`${waar}: slew_s 0..120`);
    if (p.takeover !== undefined && !TAKEOVERS.includes(p.takeover)) f.push(`${waar}: takeover moet ${TAKEOVERS.join('|')} zijn`);
    params.push({ ...p, standaard: p.standaard ?? 0 });
  }
  if (f.length) return { ok: false, fouten: f };
  return {
    ok: true,
    manifest: {
      v: 1, app: x.app, naam: x.naam, ...(x.kleur ? { kleur: x.kleur.toLowerCase() } : {}),
      truth: x.truth ?? 'app', hb_s: x.hb_s ?? 1, lease, ...(lease ? { rings: x.rings ?? 'host' } : {}),
      scenes: x.scenes ?? [], params,
    },
  };
}

/** Waarde op de draad voor een keuze-index. @param {number} i @param {number} n */
export const keuzeNaarWaarde = (i, n) => (n <= 1 ? 0 : i / (n - 1));
/** Keuze-index uit een draadwaarde. @param {number} v @param {number} n */
export const waardeNaarKeuze = (v, n) => Math.max(0, Math.min(n - 1, Math.round(v * (n - 1))));
