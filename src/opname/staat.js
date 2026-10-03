// @ts-check
// Staat-hash per app: een korte vingerafdruk van de waarden, om een opname en een herhaling te vergelijken.
// Waarden worden op 6 decimalen afgerond en op id gesorteerd, zodat de volgorde en float-ruis niet tellen.
import { createHash } from 'node:crypto';

/** @typedef {Record<string, Record<string, number>>} Eindstaat app → waarden */

const AFRONDING = 1e6;
/** @param {number} v */
const rond = (v) => Math.round(v * AFRONDING) / AFRONDING;

/** Waarden in vaste vorm: gesorteerd, afgerond, alleen getallen. @param {Record<string, unknown>} waarden */
export function vasteVorm(waarden) {
  return Object.keys(waarden).sort().filter((id) => typeof waarden[id] === 'number').map((id) => [id, rond(/** @type {number} */ (waarden[id]))]);
}

/** @param {Record<string, unknown>} waarden @returns {string} 16 hex-tekens */
export function staatHash(waarden) {
  return createHash('sha256').update(JSON.stringify(vasteVorm(waarden))).digest('hex').slice(0, 16);
}

/** Korte hash van een manifest (of null). @param {unknown} manifest */
export function manifestHash(manifest) {
  if (!manifest) return null;
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 12);
}

/** Waarden per app uit kern.beeld() (of een beeld van de cockpit). @param {{ apps: { app: string, waarden: Record<string, number> }[] }} beeld @returns {Eindstaat} */
export function eindstaatUitBeeld(beeld) {
  return Object.fromEntries((beeld?.apps ?? []).map((a) => [a.app, { ...a.waarden }]));
}

/**
 * Verschillen tussen de opgenomen eindstaat en wat er nu staat. Alleen apps uit de opname tellen;
 * een app die er nu (ook) is maar toen niet, is geen verschil.
 * @param {Record<string, { waarden: Record<string, number>, hash: string }>} verwacht
 * @param {Eindstaat} werkelijk
 * @returns {{ app: string, soort: 'ontbreekt'|'waarden', hash?: { verwacht: string, werkelijk: string }, ids?: { id: string, verwacht: number|null, werkelijk: number|null }[] }[]}
 */
export function vergelijkEindstaat(verwacht, werkelijk) {
  /** @type {ReturnType<typeof vergelijkEindstaat>} */
  const uit = [];
  for (const [app, v] of Object.entries(verwacht ?? {})) {
    const w = werkelijk[app];
    if (!w) { uit.push({ app, soort: 'ontbreekt' }); continue; }
    const hw = staatHash(w);
    if (hw === v.hash) continue;
    const ids = [...new Set([...Object.keys(v.waarden), ...Object.keys(w)])].sort()
      .map((id) => ({ id, verwacht: typeof v.waarden[id] === 'number' ? v.waarden[id] : null, werkelijk: typeof w[id] === 'number' ? w[id] : null }))
      .filter((x) => x.verwacht === null || x.werkelijk === null || rond(x.verwacht) !== rond(x.werkelijk));
    uit.push({ app, soort: 'waarden', hash: { verwacht: v.hash, werkelijk: hw }, ids });
  }
  return uit;
}
