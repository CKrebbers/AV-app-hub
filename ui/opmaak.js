// @ts-check
// Kleine pure hulpjes voor de cockpit: waarden tonen, invoer beschrijven, beeld lezen.
// Geen DOM, zodat het in Node te toetsen is.

/** @typedef {import('../src/protocol/types.js').Param} Param */

/**
 * Hoe een draadwaarde (0..1) eruitziet voor een parameter.
 * keuze → naam; schakelaar → aan/uit; met min/max → geschaald met eenheid; anders procent.
 * @param {Partial<Param>} p @param {number|undefined} v
 */
export function toonWaarde(p, v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  if (p.soort === 'keuze' && Array.isArray(p.keuzes) && p.keuzes.length) {
    const n = p.keuzes.length;
    return p.keuzes[Math.max(0, Math.min(n - 1, Math.round(v * (n - 1))))];
  }
  if (p.soort === 'schakelaar') return v >= 0.5 ? 'aan' : 'uit';
  if (p.soort === 'trigger') return v >= 0.5 ? '●' : '○';
  if (typeof p.min === 'number' && typeof p.max === 'number') {
    const x = p.min + v * (p.max - p.min);
    const span = Math.abs(p.max - p.min);
    const dec = span >= 100 ? 0 : span >= 10 ? 1 : 2;
    return `${x.toFixed(dec)}${p.eenheid ? ` ${p.eenheid}` : ''}`;
  }
  return `${Math.round(v * 100)}%${p.eenheid ? ` ${p.eenheid}` : ''}`;
}

/** Eén regel voor het invoerlog. @param {any} g */
export function invoerTekst(g) {
  if (!g || typeof g !== 'object') return String(g);
  const wie = `${g.dev ?? '?'} ${g.el ?? '(onbekend)'}`;
  switch (g.kind) {
    case 'druk': return `${wie} ▼${typeof g.raw === 'number' && g.dev === 'lpd8' ? ` ${g.raw}` : ''}`;
    case 'los': return `${wie} ▲`;
    case 'waarde': return `${wie} = ${typeof g.raw === 'number' ? g.raw : typeof g.v === 'number' ? Math.round(g.v * 127) : '?'}`;
    case 'delta': return `${wie} ${g.delta > 0 ? '+' : ''}${g.delta}`;
    default: return `${wie} ${g.kind ?? ''}${Array.isArray(g.bytes) ? ` [${g.bytes.map((/** @type {number} */ b) => b.toString(16).padStart(2, '0')).join(' ')}]` : ''}`.trim();
  }
}

/** Welke app heeft focus volgens het beeld (veld `focus`, anders de app met focus:true). @param {any} beeld */
export function focusVan(beeld) {
  if (!beeld) return null;
  if (typeof beeld.focus === 'string') return beeld.focus;
  const a = Array.isArray(beeld.apps) ? beeld.apps.find((/** @type {any} */ x) => x && x.focus) : null;
  return a ? a.app : null;
}

/** Is een apparaat verbonden? Het contract zegt alleen `apparaten:{apc40,lpd8}`; we accepteren boolean of object. @param {unknown} x */
export function isVerbonden(x) {
  if (typeof x === 'boolean') return x;
  if (x && typeof x === 'object') {
    const o = /** @type {Record<string, unknown>} */ (x);
    if (typeof o.verbonden === 'boolean') return o.verbonden;
    if (typeof o.aangesloten === 'boolean') return o.aangesloten;
    if (typeof o.status === 'string') return o.status === 'verbonden';
  }
  if (typeof x === 'string') return x === 'verbonden';
  return false;
}

/** Ademperiode in seconden uit K7 (0..1 → 4..16 s, standaard 10 s). @param {unknown} k7 */
export const ademPeriode = (k7) => (typeof k7 === 'number' && Number.isFinite(k7) ? 4 + 12 * Math.max(0, Math.min(1, k7)) : 10);

/** Schaal van de ademcirkel voor een fase 0..1: klein bij 0, groot halverwege. @param {number} fase */
export const ademSchaal = (fase) => 0.5 + 0.5 * (0.5 - 0.5 * Math.cos(2 * Math.PI * fase));

/** Kleur van een app: manifestkleur, anders afgeleid van de naam (stabiel). @param {{ app?: string, kleur?: string }} a */
export function appKleur(a) {
  if (typeof a?.kleur === 'string' && /^#[0-9a-f]{6}$/i.test(a.kleur)) return a.kleur;
  let h = 0;
  for (const ch of String(a?.app ?? '')) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 55% 55%)`;
}

/** Handtekening van een parameterlijst: verandert alleen als het manifest verandert. @param {string|null} app @param {any[]|undefined} params */
export const paramSleutel = (app, params) => `${app}|${(Array.isArray(params) ? params : [])
  .filter((p) => p && typeof p === 'object')
  .map((p) => `${p.id}:${p.soort}:${Array.isArray(p.keuzes) ? p.keuzes.length : 0}`).join(',')}`;
