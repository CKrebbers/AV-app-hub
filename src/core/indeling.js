// @ts-check
// Automatische APC-indeling voor een manifest-app (PROTOCOL.md §7). Puur: manifest in, toewijzingen uit.
//   Faders 1–8      hint "fader", daarna overige waarden (behalve hint "knop") in manifestvolgorde
//   Device-knoppen  hint "knop"; meer dan 8 → pagina's per groep (Device ◄/► bladert)
//   Track-knoppen   de volgende 8 waarden die nog geen plek hebben
//   Grid            keuze → één kolom per keuze (optie 0 bovenaan); trigger/schakelaar → kolommen per groep
//   Scene 1–5       manifest.scenes · Stop All: trigger "paniek"
// Overschrijven per app met een kaart { <control-id>: { id, takeover? } } (maps/<app>.json).
import { OP_ID, padId } from '../devices/apc40mk2.js';

/** @typedef {import('../protocol/types.js').Manifest} Manifest @typedef {import('../protocol/types.js').Param} Param
 *  @typedef {import('./pickup.js').Modus} Modus
 *  @typedef {'fader'|'ring'|'keuze'|'schakelaar'|'trigger'|'stap'} Rol
 *  @typedef {{ id: string, rol: Rol, takeover: Modus, optie?: number, n?: number }} Toewijzing
 *  @typedef {Record<string, Toewijzing>} Toewijzingen
 *  @typedef {{ vast: Toewijzingen, paginas: Toewijzingen[], paginaNamen: string[], scenes: number, paniek: string|null, niet: string[] }} Indeling
 *  @typedef {Record<string, { id: string, takeover?: Modus }>} Kaart */

export const RIJEN = 5;
export const KOLOMMEN = 8;

/** @param {Param} p @returns {Modus} */
const overname = (p) => p.takeover ?? 'pickup';

/**
 * @param {Manifest} manifest
 * @param {Kaart|null} [kaart] overschrijvingen per control-id
 * @returns {Indeling}
 */
export function maakIndeling(manifest, kaart = null) {
  const params = manifest.params ?? [];
  /** @type {Toewijzingen} */
  const vast = {};
  const geplaatst = new Set();
  const plaats = (/** @type {string} */ ctrl, /** @type {Toewijzing} */ t, doel = vast) => { doel[ctrl] = t; geplaatst.add(t.id); };

  // Faders en track-knoppen: waarden zonder hint "knop", hint "fader" eerst.
  const waarden = params.filter((p) => p.soort === 'waarde');
  const kandidaten = [...waarden.filter((p) => p.hint === 'fader'), ...waarden.filter((p) => p.hint !== 'fader' && p.hint !== 'knop')];
  kandidaten.slice(0, 8).forEach((p, i) => plaats(`fader${i + 1}`, { id: p.id, rol: 'fader', takeover: overname(p) }));
  kandidaten.slice(8, 16).forEach((p, i) => plaats(`tk${i + 1}`, { id: p.id, rol: 'ring', takeover: overname(p) }));

  // Device-knoppen: hint "knop", in pagina's.
  const knoppen = waarden.filter((p) => p.hint === 'knop');
  /** @type {{ naam: string, params: Param[] }[]} */
  let groepen = [{ naam: '', params: knoppen }];
  if (knoppen.length > 8) {
    /** @type {Map<string, Param[]>} */
    const g = new Map();
    for (const p of knoppen) { const n = p.groep ?? ''; if (!g.has(n)) g.set(n, []); /** @type {Param[]} */ (g.get(n)).push(p); }
    groepen = [];
    for (const [naam, ps] of g) for (let i = 0; i < ps.length; i += 8) groepen.push({ naam: i ? `${naam} ${i / 8 + 1}` : naam, params: ps.slice(i, i + 8) });
  }
  /** @type {Toewijzingen[]} */
  const paginas = groepen.map((g) => {
    /** @type {Toewijzingen} */
    const pag = {};
    g.params.forEach((p, i) => plaats(`dk${i + 1}`, { id: p.id, rol: 'ring', takeover: overname(p) }, pag));
    return pag;
  });
  const paginaNamen = groepen.map((g) => g.naam);

  // Grid: keuzes eerst, één kolom per keuze; daarna triggers/schakelaars per groep.
  const paniek = params.find((p) => p.id === 'paniek' && p.soort === 'trigger')?.id ?? null;
  let kolom = 1;
  for (const p of params.filter((x) => x.soort === 'keuze')) {
    if (kolom > KOLOMMEN) break;
    const n = p.keuzes?.length ?? 2;
    for (let i = 0; i < Math.min(n, RIJEN); i++) plaats(padId(RIJEN - i, kolom), { id: p.id, rol: 'keuze', takeover: 'direct', optie: i, n });
    kolom++;
  }
  /** @type {Map<string, Param[]>} */
  const padGroepen = new Map();
  for (const p of params) {
    if ((p.soort !== 'trigger' && p.soort !== 'schakelaar') || p.id === paniek) continue;
    const n = p.groep ?? '';
    if (!padGroepen.has(n)) padGroepen.set(n, []);
    /** @type {Param[]} */ (padGroepen.get(n)).push(p);
  }
  for (const ps of padGroepen.values()) {
    let rij = RIJEN;
    for (const p of ps) {
      if (rij < 1) { rij = RIJEN; kolom++; }
      if (kolom > KOLOMMEN) break;
      plaats(padId(rij, kolom), { id: p.id, rol: p.soort === 'trigger' ? 'trigger' : 'schakelaar', takeover: 'direct' });
      rij--;
    }
    kolom++;
  }

  // Overschrijvingen: haal de parameter weg waar hij automatisch stond en zet hem op de gekozen control.
  for (const [ctrl, k] of Object.entries(kaart ?? {})) {
    const c = OP_ID.get(ctrl);
    const p = params.find((x) => x.id === k?.id);
    if (!c || !p) continue;
    const rol = rolVoor(c.soort, p);
    if (!rol) continue;
    for (const doel of [vast, ...paginas]) {
      for (const [x, t] of Object.entries(doel)) if (t.id === p.id || x === ctrl) delete doel[x];
    }
    vast[ctrl] = { id: p.id, rol, takeover: k.takeover ?? (rol === 'fader' || rol === 'ring' ? overname(p) : 'direct'), ...(p.soort === 'keuze' ? { n: p.keuzes?.length ?? 2 } : {}) };
    geplaatst.add(p.id);
  }

  return {
    vast, paginas: paginas.length ? paginas : [{}], paginaNamen, scenes: Math.min(manifest.scenes?.length ?? 0, 5), paniek,
    niet: params.filter((p) => !geplaatst.has(p.id) && p.id !== paniek).map((p) => p.id),
  };
}

/** @param {string} soort control-soort @param {Param} p @returns {Rol|null} */
function rolVoor(soort, p) {
  if (soort === 'fader') return p.soort === 'trigger' ? null : 'fader';
  if (soort === 'draai') return p.soort === 'trigger' ? null : 'ring';
  if (soort === 'pad' || soort === 'scene' || soort === 'knop') return p.soort === 'trigger' ? 'trigger' : p.soort === 'keuze' ? 'stap' : 'schakelaar';
  return null;
}

/** Alle toewijzingen die nu gelden (vaste + de gekozen device-pagina). @param {Indeling} ind @param {number} pagina */
export const toewijzingen = (ind, pagina) => ({ ...(ind.paginas[pagina] ?? {}), ...ind.vast });

/** Control-ids waar parameter `id` nu op staat. @param {Indeling} ind @param {number} pagina @param {string} id */
export const controlsVoor = (ind, pagina, id) => Object.entries(toewijzingen(ind, pagina)).filter(([, t]) => t.id === id).map(([c]) => c);
