// @ts-check
// Korg Kaoss Pad KP3+: het gebaar (PROTOCOL §21). Puur: herkennen op naam (patroon uit config.json), invoer ontleden
// en van X, Y en aanraken één gebaar `{ x, y, aan }` maken (0..1). Geen I/O, geen klok.
//
// De KP3+ hangt met MIDI-DIN aan een USB-MIDI-interface: de poortnaam is die van de interface (bv. "UM-ONE" of
// "USB MIDI Interface MIDI 1"), niet "KP3+". Daarom komt het patroon uit config.json → apparaten.kp3plus.poort_patroon
// en zegt doctor welke ingangen er zijn.
//
// Wat hij stuurt (Korg, KAOSS PAD KP3 MIDI Implementation rev 1.1; de KP3+ is de opvolger, TE METEN met
// `node src/cli.js proef kp3plus`):
//   Control Change (Panel Control): X, Y, aanraken, FX Depth, Hold (en de slider) hebben elk een VRIJ TOEWIJSBAAR
//   CC-nummer in de Global-instellingen (128+ = uit). Bronnen noemen X = CC 12, Y = CC 13, aanraken = CC 92 (of 74):
//   dat is de gok hieronder tot de proef het meet.
//   Program Change (Panel Control): een programmageheugen (1–8) stuurt het effectprogramma dat erin staat (0–127),
//   niet het nummer van de knop. In Ext.Ctrl-modus kunnen de knoppen ook noten of CC's sturen.
//   Timing Clock (F8) als Clock op Internal staat; de hub opent de KP3+ zonder klok (de klok komt van de EFX-500).
//   Kanaal: de Global MIDI Channel van de KP3+ (instelbaar; config.json → apparaten.kp3plus.kanaal, null = elk).

/**
 * @typedef {{ x: number, y: number, aanraak: number|null, diepte: number|null, hold: number|null }} CcIndeling
 * @typedef {{ kanaal: number|null, cc: CcIndeling, xy: { x: string, y: string }, hold: boolean }} Instellingen
 * @typedef {{ dev: 'kp3plus', el: string|null, kind: 'waarde'|'druk'|'los'|'keuze'|'tik'|'onbekend', v?: number, raw?: number,
 *             ch?: number, cc?: number, nr?: number, bytes?: number[] }} Gebeurtenis
 * @typedef {{ x: number|null, y: number|null, aan: boolean }} Gebaar
 */

export const DEV = 'kp3plus';
export const NAAM = 'Korg Kaoss Pad KP3+';
/** De gok tot de proef het meet (bronnen; Korg zegt alleen dat ze vrij toewijsbaar zijn). */
export const STANDAARD_CC = Object.freeze({ x: 12, y: 13, aanraak: 92, diepte: null, hold: null });
/** Standaard stuurt het XY-vlak vervorming (X) en ruimte (Y) van de app met focus (SYSTEEM §3.4). */
export const STANDAARD_XY = Object.freeze({ x: 'alfabet.vervorming', y: 'alfabet.ruimte' });
/** Een rol of parameter-id in `xy` (manifest, maps/<app>.json, config.json). */
export const XY_NAAM = /^[a-z0-9_.-]{1,48}$/;

const isCc = (/** @type {unknown} */ n) => Number.isInteger(n) && /** @type {number} */ (n) >= 0 && /** @type {number} */ (n) <= 127;

/**
 * Het naampatroon van de MIDI-ingang uit config.json (`apparaten.kp3plus.poort_patroon`), of null zonder die sleutel:
 * dan doet de KP3+ niet mee. Een ongeldige regex telt als gewone tekst.
 * @param {any} config
 */
export function patroon(config) {
  const p = config?.apparaten?.kp3plus?.poort_patroon;
  if (typeof p !== 'string' || !p.trim()) return null;
  try { return new RegExp(p, 'i'); } catch { return new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
}

/**
 * De instellingen uit config.json → apparaten.kp3plus, met de standaarden ingevuld. `kanaal` is 1..16 zoals op het
 * display (hier 0..15), null = elk kanaal. Een CC die geen 0..127 is, telt als "niet toegewezen" (null), behalve X
 * en Y: die vallen terug op de gok.
 * @param {any} config @returns {Instellingen}
 */
export function instellingen(config) {
  const c = config?.apparaten?.kp3plus ?? {};
  const k = Number(c.kanaal);
  const cc = c.cc ?? {};
  const of = (/** @type {unknown} */ n, /** @type {number|null} */ s) => (n === null ? null : isCc(n) ? /** @type {number} */ (n) : s);
  const xy = c.xy ?? {};
  return {
    kanaal: Number.isInteger(k) && k >= 1 && k <= 16 ? k - 1 : null,
    cc: {
      x: of(cc.x, STANDAARD_CC.x) ?? STANDAARD_CC.x,
      y: of(cc.y, STANDAARD_CC.y) ?? STANDAARD_CC.y,
      aanraak: of(cc.aanraak, STANDAARD_CC.aanraak),
      diepte: of(cc.diepte, STANDAARD_CC.diepte),
      hold: of(cc.hold, STANDAARD_CC.hold),
    },
    xy: { x: XY_NAAM.test(xy.x ?? '') ? xy.x : STANDAARD_XY.x, y: XY_NAAM.test(xy.y ?? '') ? xy.y : STANDAARD_XY.y },
    hold: c.hold === true,
  };
}

/**
 * Ontleder voor deze instellingen. Een bericht op een ander kanaal (als er een gekozen is) of met een onbekende CC is
 * 'onbekend' (met de bytes): de proef en het logboek zien het wel, de hub doet er niets mee.
 * @param {Instellingen} inst @returns {(b: number[]) => Gebeurtenis}
 */
export function maakOntleder(inst) {
  return (b) => {
    if (b[0] === 0xf8) return { dev: DEV, el: 'klok', kind: 'tik' };
    const st = b[0] & 0xf0, ch = b[0] & 0x0f;
    const onbekend = () => /** @type {Gebeurtenis} */ ({ dev: DEV, el: null, kind: 'onbekend', bytes: [...b] });
    if (b[0] >= 0xf0 || (inst.kanaal !== null && ch !== inst.kanaal)) return onbekend();
    if (st === 0xb0) {
      const cc = b[1], w = b[2];
      if (cc === inst.cc.x) return { dev: DEV, el: 'x', kind: 'waarde', v: w / 127, raw: w, ch };
      if (cc === inst.cc.y) return { dev: DEV, el: 'y', kind: 'waarde', v: w / 127, raw: w, ch };
      if (cc === inst.cc.aanraak) return { dev: DEV, el: 'aanraak', kind: w >= 64 ? 'druk' : 'los', raw: w, ch };
      if (cc === inst.cc.diepte) return { dev: DEV, el: 'diepte', kind: 'waarde', v: w / 127, raw: w, ch };
      if (cc === inst.cc.hold) return { dev: DEV, el: 'hold', kind: w >= 64 ? 'druk' : 'los', raw: w, ch };
      return onbekend();
    }
    // Een programmageheugen: het effectprogramma dat erin staat (0–127). Doorgeven als trigger `kp3.p<nr>` (§21).
    if (st === 0xc0) return { dev: DEV, el: `p${b[1] + 1}`, kind: 'druk', nr: b[1] + 1, raw: b[1], ch };
    return onbekend();
  };
}

/** Een gebaar dat nog niets weet. @returns {Gebaar} */
export const nieuwGebaar = () => ({ x: null, y: null, aan: false });

/**
 * Eén gebeurtenis verder. Geeft het nieuwe gebaar terug als het veranderde (anders null):
 * - X of Y beweegt: de nieuwe stand; zonder aanraak-CC (of als die nog niet kwam) telt bewegen als aanraken.
 * - aanraken (CC ≥ 64): `aan` true, met de laatst bekende X en Y (null = nog niet bekend).
 * - loslaten (CC < 64): `aan` false, X en Y blijven staan (wat ermee gebeurt, beslist de kern: terugveren of hold).
 * @param {Gebaar} staat @param {Gebeurtenis} g @returns {{ staat: Gebaar, gebaar: Gebaar|null }}
 */
export function gebaarStap(staat, g) {
  if (g.dev !== DEV) return { staat, gebaar: null };
  if ((g.el === 'x' || g.el === 'y') && typeof g.v === 'number') {
    const nieuw = { ...staat, [g.el]: g.v, aan: true };
    return { staat: nieuw, gebaar: { ...nieuw } };
  }
  if (g.el === 'aanraak' && (g.kind === 'druk' || g.kind === 'los')) {
    const aan = g.kind === 'druk';
    if (aan === staat.aan) return { staat, gebaar: null };
    const nieuw = { ...staat, aan };
    return { staat: nieuw, gebaar: { ...nieuw } };
  }
  return { staat, gebaar: null };
}

/**
 * Welke parameter van een app een as stuurt: eerst een parameter (soort waarde) met die rol, anders een parameter met
 * die id. Null als de app hem niet heeft (dan doet die as niets).
 * @param {{ params: { id: string, soort: string, rol?: string }[] }|null|undefined} manifest @param {string} naam
 * @returns {string|null}
 */
export function asDoel(manifest, naam) {
  const params = manifest?.params ?? [];
  return params.find((p) => p.soort === 'waarde' && p.rol === naam)?.id ?? params.find((p) => p.soort === 'waarde' && p.id === naam)?.id ?? null;
}

/**
 * De XY-indeling voor een app: maps/<app>.json (`"xy": { "x", "y" }`, Clay's keuze) gaat voor het manifest (`xy`),
 * dat voor config.json (apparaten.kp3plus.xy). Per as apart: een kaart mag alleen X noemen.
 * @param {{ x?: string, y?: string }|null|undefined} kaart @param {{ x?: string, y?: string }|null|undefined} manifestXy
 * @param {{ x: string, y: string }} standaard
 */
export function xyVoor(kaart, manifestXy, standaard) {
  const kies = (/** @type {'x'|'y'} */ as) => [kaart?.[as], manifestXy?.[as]].find((n) => typeof n === 'string' && XY_NAAM.test(n)) ?? standaard[as];
  return { x: kies('x'), y: kies('y') };
}
