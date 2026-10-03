// @ts-check
// De generale repetitie als draaiboek: één avond spelen tegen een hub, los van HOE de apps draaien.
// tools/repetitie.mjs speelt hem met de echte apps (browser, pseudo-terminal); test/repetitie.test.js met
// nep-apps die de echte manifesten gebruiken. Alles wat het draaiboek nodig heeft, krijgt het via de Regie.
//
// Meten per stap:
//  - kwam het bij de juiste app aan: de berichten die de app ontving (app-zijde gelogd), en de staat die
//    de app zelf terugleest (pagina, proceslog of nep-app), en geen bediening bij een app die het niet hoort;
//  - latency hub→app: elk bericht dat de kern verstuurde ('naarApp') gekoppeld aan het moment dat de app
//    het ontving (zelfde inhoud, eerst-in-eerst-uit per app), p50/p95/max;
//  - fouten: console-fouten van de app tijdens de stap.
import * as APC from '../src/devices/apc40mk2.js';
import * as LPD8 from '../src/devices/lpd8.js';
import { toewijzingen } from '../src/core/indeling.js';
import { ROLLEN, keuzeNaarWaarde } from '../src/protocol/manifest.js';
import { PANIEK_MS, LANG_MS } from '../src/core/kern.js';

/**
 * @typedef {{ t: number, b: any }} Ontvangen  t = wandklok (ms) waarop de app het bericht kreeg
 * @typedef {{ t: number, tekst: string }} Fout
 * @typedef {{
 *   id: string,
 *   soort: string,
 *   lees: () => Promise<Record<string, number>|null>,
 *   ontvangen: () => Promise<Ontvangen[]>,
 *   fouten: () => Promise<Fout[]>,
 *   herstart: () => Promise<void>,
 *   paniek?: (w: Record<string, number>, aan: boolean) => [boolean, string] | null,
 * }} Deelnemer
 *   lees: de staat zoals de app hem zelf kent (0..1 per parameter-id; ontbrekende ids = niet uit te lezen), of null.
 *   ontvangen: alles wat de app ooit van de hub kreeg (ook vóór een herstart), in volgorde.
 *   paniek: optioneel, app-eigen oordeel over wat paniek in de app deed (aan = P1 nog ingedrukt), op basis van lees().
 * @typedef {{
 *   namen: string[], status: string, fouten: () => Promise<Fout[]>,
 *   focus: (app: string) => Promise<void>, sluit: () => Promise<void>,
 * }} Cockpit
 * @typedef {{
 *   kern: any,
 *   apc: { injecteer: (b: number[]) => void, verstuurd: number[][] },
 *   lpd8: { injecteer: (b: number[]) => void },
 *   nu: () => number,
 *   wacht: (ms: number) => Promise<void>,
 *   deelnemers: Map<string, Deelnemer>,
 *   cockpit: () => Promise<Cockpit>,
 *   herstarten?: string[],
 *   opkomstMs?: number,
 *   schuifPauzeMs?: number,
 *   log?: (s: string) => void,
 * }} Regie
 * @typedef {{ wat: string, ok: boolean, detail?: string, opmerking?: boolean }} Controle
 *   opmerking: geen oordeel (telt als ok), maar iets wat opviel en een besluit vraagt — apart in het rapport.
 * @typedef {{ n: number, p50: number|null, p95: number|null, max: number|null }} Latency
 * @typedef {{
 *   naam: string, begin: number, eind: number, ok: boolean, controles: Controle[],
 *   latency?: Latency, perApp?: Record<string, Latency>, fouten?: Record<string, string[]>,
 * }} Stap
 */

/** Wandklok in ms (zelfde bron als performance.timeOrigin + now() in Chromium en time.time() in Python). */
export const wandklok = () => performance.timeOrigin + performance.now();

const LPD8_PROFIEL = LPD8.standaardProfiel('mk2');
/** @param {number} v */
const ruw = (v) => Math.max(0, Math.min(127, Math.round(v * 127)));
/** Wat een fysieke control van v maakt (7 bit). @param {number} v */
export const fysiek = (v) => ruw(v) / 127;
/** @param {string} id */
const ctrl = (id) => { const c = APC.OP_ID.get(id); if (!c) throw new Error(`onbekende control ${id}`); return c; };

/** Hoeveel een teruggelezen waarde mag afwijken (schuifstappen, afronding in de app). */
export const MARGE = 0.03;
/** Na zo lang zonder bericht (ms) telt een bericht als verloren in de latency-koppeling. */
const MAX_LATENCY_MS = 10000;

/** Sleutel om een verzonden en een ontvangen bericht aan elkaar te koppelen. @param {any} b */
export const sleutel = (b) => JSON.stringify(b);

/** p-de percentiel (0..100) van een gesorteerde lijst. @param {number[]} s @param {number} p */
function percentiel(s, p) {
  if (!s.length) return null;
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return Math.round(s[i] * 100) / 100;
}
/** @param {number[]} lijst @returns {Latency} */
export function latencyVan(lijst) {
  const s = [...lijst].sort((a, b) => a - b);
  return { n: s.length, p50: percentiel(s, 50), p95: percentiel(s, 95), max: s.length ? Math.round(s[s.length - 1] * 100) / 100 : null };
}

/**
 * Koppel verzonden berichten (kern → app) aan wat de app ontving: per app, per inhoud, eerst-in-eerst-uit.
 * @param {{ app: string, t: number, b: any }[]} verzonden
 * @param {Map<string, Ontvangen[]>} ontvangen per app
 * @returns {{ app: string, t: number, b: any, ms: number|null }[]} ms = null: nooit aangekomen
 */
export function koppel(verzonden, ontvangen) {
  /** @type {Map<string, Map<string, number[]>>} */
  const rijen = new Map();
  for (const [app, lijst] of ontvangen) {
    /** @type {Map<string, number[]>} */
    const m = new Map();
    for (const x of lijst) { const k = sleutel(x.b); if (!m.has(k)) m.set(k, []); /** @type {number[]} */ (m.get(k)).push(x.t); }
    rijen.set(app, m);
  }
  return verzonden.map((v) => {
    const rij = rijen.get(v.app)?.get(sleutel(v.b));
    // Een ontvangst ruim vóór het versturen hoort bij een eerder, gelijk bericht dat zelf verloren ging.
    while (rij && rij.length && rij[0] < v.t - 50) rij.shift();
    if (!rij || !rij.length || rij[0] - v.t > MAX_LATENCY_MS) return { ...v, ms: null };
    const t = /** @type {number} */ (rij.shift());
    return { ...v, ms: Math.max(0, t - v.t) };
  });
}

/**
 * Speel de avond. Geeft de stappen terug met controles, latency en fouten.
 * @param {Regie} r
 */
export async function speelAvond(r) {
  const { kern } = r;
  const log = r.log ?? (() => {});
  /** @type {{ app: string, t: number, b: any }[]} */
  const verzonden = [];
  const afmelden = kern.bij('naarApp', (/** @type {string|null} */ app, /** @type {any} */ b) => {
    if (app) verzonden.push({ app, t: r.nu(), b: JSON.parse(JSON.stringify(b)) });
  });
  /** Statuswissels die niet bij een herstart horen (stil/weg midden in de avond). */
  /** @type {{ t: number, app: string, van: string, naar: string, verwacht: boolean }[]} */
  const wissels = [];
  /** @type {Set<string>} */
  const herstartend = new Set();
  /** @type {Set<string>} */
  const herstart = new Set();
  /** @type {Map<string, string>} */
  const laatsteStatus = new Map();
  const kijkStatus = () => {
    for (const a of kern.beeld().apps) {
      const oud = laatsteStatus.get(a.app);
      if (oud !== undefined && oud !== a.status) wissels.push({ t: r.nu(), app: a.app, van: oud, naar: a.status, verwacht: herstartend.has(a.app) });
      laatsteStatus.set(a.app, a.status);
    }
  };
  const afmeldenBeeld = kern.bij('beeld', kijkStatus);

  /** @type {Stap[]} */
  const stappen = [];
  /** @param {string} naam @param {(c: ((wat: string, ok: unknown, detail?: string) => void) & { opmerking: (wat: string, detail?: string) => void }) => Promise<void>} fn */
  async function stap(naam, fn) {
    log(`▶ ${naam}`);
    const begin = r.nu();
    /** @type {Controle[]} */
    const controles = [];
    const c = Object.assign((/** @type {string} */ wat, /** @type {unknown} */ ok, /** @type {string=} */ detail) => {
      controles.push({ wat, ok: !!ok, ...(detail ? { detail } : {}) });
      if (!ok) log(`   ✗ ${wat}${detail ? ` — ${detail}` : ''}`);
    }, {
      /** @param {string} wat @param {string} [detail] */
      opmerking: (wat, detail) => { controles.push({ wat, ok: true, opmerking: true, ...(detail ? { detail } : {}) }); log(`   ! ${wat}${detail ? ` — ${detail}` : ''}`); },
    });
    try { await fn(c); } catch (e) { c('stap liep zonder uitzondering', false, String(/** @type {any} */ (e)?.stack ?? e)); }
    const s = { naam, begin, eind: r.nu(), ok: controles.every((x) => x.ok), controles };
    stappen.push(s);
    log(`  ${s.ok ? '✔' : '✗'} ${naam} (${controles.filter((x) => x.ok).length}/${controles.length})`);
  }

  // ── hulpjes ───────────────────────────────────────────────────────────────────────────────────────
  /** Wacht tot fn waar is, in stappen van 50 ms (r.wacht: echte of nep-tijd). @param {() => unknown} fn @param {number} ms */
  const tot = async (fn, ms) => {
    for (let i = 0; i <= ms / 50; i++) { if (await fn()) return true; await r.wacht(50); }
    return !!(await fn());
  };
  const D = (/** @type {string} */ app) => /** @type {Deelnemer} */ (r.deelnemers.get(app));
  /** Berichten die app ontving sinds t0. @param {string} app @param {number} t0 @param {(b: any) => boolean} [f] */
  const sinds = async (app, t0, f = () => true) => (await D(app).ontvangen()).filter((x) => x.t >= t0 && f(x.b)).map((x) => x.b);
  const appStaat = (/** @type {string} */ app) => kern.apps.get(app);
  const beeldApp = (/** @type {string} */ app) => kern.beeld().apps.find((/** @type {any} */ a) => a.app === app);
  const schuifPauze = r.schuifPauzeMs ?? 0;

  const apcBytes = (/** @type {string} */ id, /** @type {boolean} */ aan) => {
    const c = ctrl(id);
    return c.t === 'cc' ? [0xb0 | c.ch, c.n, aan ? 127 : 0] : [(aan ? 0x90 : 0x80) | c.ch, c.n, aan ? 127 : 0];
  };
  const druk = (/** @type {string} */ id) => r.apc.injecteer(apcBytes(id, true));
  const los = (/** @type {string} */ id) => r.apc.injecteer(apcBytes(id, false));
  const tik = async (/** @type {string} */ id) => { druk(id); await r.wacht(60); los(id); };
  /** Fader of draaiknop van a naar b in stappen van 1/127, zoals een hand. @param {string} id @param {number} a @param {number} b */
  const schuif = async (id, a, b) => {
    const c = ctrl(id);
    const ra = ruw(a), rb = ruw(b), s = rb >= ra ? 1 : -1;
    for (let x = ra; x !== rb + s; x += s) {
      r.apc.injecteer([0xb0 | c.ch, c.n, x]);
      if (schuifPauze && x % 8 === 0) await r.wacht(schuifPauze);
    }
  };
  /** Pickup altijd vangen: eerst helemaal naar boven (kruist elke doelwaarde), dan naar het doel. @param {string} id @param {number} doel */
  const zetControl = async (id, doel) => { await schuif(id, 0, 1); await schuif(id, 1, doel); };
  const lpdKnop = async (/** @type {number} */ k, /** @type {number} */ a, /** @type {number} */ b) => {
    const n = LPD8_PROFIEL.knoppen[k - 1].n;
    const ra = ruw(a), rb = ruw(b), s = rb >= ra ? 1 : -1;
    for (let x = ra; x !== rb + s; x += s) {
      r.lpd8.injecteer([0xb0, n, x]);
      if (schuifPauze && x % 8 === 0) await r.wacht(schuifPauze);
    }
  };
  const lpdPad = (/** @type {number} */ p, /** @type {boolean} */ aan) => r.lpd8.injecteer(aan ? [0x99, LPD8_PROFIEL.pads[p - 1].n, 100] : [0x89, LPD8_PROFIEL.pads[p - 1].n, 0]);
  const hubtoets = () => /** @type {string} */ (kern.hubtoets ?? 'bank');

  /** Focus via Bank + Track Select (slot). @param {string} app */
  const kiesFocus = async (app) => {
    const slot = beeldApp(app)?.slot;
    if (!slot) return false;
    druk(hubtoets()); await r.wacht(30);
    await tik(`sel${slot}`);
    await r.wacht(30); los(hubtoets());
    return tot(() => kern.beeld().focus === app, 2000);
  };

  /** Verwachte waarde na quantiseren (keuze: index/(n-1)). @param {any} p @param {number} v */
  const naQuant = (p, v) => (p?.soort === 'keuze' ? keuzeNaarWaarde(Math.round(v * ((p.keuzes?.length ?? 2) - 1)), p.keuzes?.length ?? 2) : p?.soort === 'schakelaar' ? (v >= 0.5 ? 1 : 0) : v);
  /**
   * Leest de app zelf `verwacht` terug? Geeft [ok, detail]; ok = null als de app deze waarde niet laat lezen.
   * @param {string} app @param {string} id @param {number} verwacht
   */
  const leesTerug = async (app, id, verwacht) => {
    const w = await D(app).lees();
    if (!w || typeof w[id] !== 'number') return /** @type {[null, string, number]} */ ([null, 'niet uit te lezen', Infinity]);
    const p = appStaat(app)?.manifest?.params.find((/** @type {any} */ x) => x.id === id);
    const marge = p?.soort === 'keuze' || p?.soort === 'schakelaar' ? 0.001 : MARGE;
    const d = Math.abs(w[id] - naQuant(p, verwacht));
    return /** @type {[boolean, string, number]} */ ([d <= marge, `app leest ${w[id].toFixed(3)}, verwacht ${naQuant(p, verwacht).toFixed(3)}`, d]);
  };
  /**
   * Wacht (max ms) tot de app de waarde zelf terugleest (binnen 0,005: hij kan nog glijden of afronden),
   * en oordeel dan met MARGE. Apps die deze waarde niet laten lezen, slaan we over.
   */
  const controleerTerug = async (/** @type {any} */ c, /** @type {string} */ app, /** @type {string} */ id, /** @type {number} */ v, ms = 3000) => {
    /** @type {[boolean|null, string, number]} */
    let uit = [null, '', Infinity];
    await tot(async () => { uit = await leesTerug(app, id, v); return uit[0] === null || uit[2] <= 0.005; }, ms);
    if (uit[0] === null) return;
    c(`${app} leest ${id} zelf terug`, uit[0], uit[1]);
  };

  // ── de avond ──────────────────────────────────────────────────────────────────────────────────────
  const deelnemers = [...r.deelnemers.keys()];

  await stap('opkomst: alle apps melden zich', async (c) => {
    await tot(() => deelnemers.every((id) => beeldApp(id)?.status === 'actief'), r.opkomstMs ?? 30000);
    for (const id of deelnemers) {
      const a = beeldApp(id);
      c(`${id} is actief in de hub`, a?.status === 'actief', a ? `status ${a.status}, slot ${a.slot}` : 'nooit verbonden');
    }
    const slots = kern.beeld().apps.map((/** @type {any} */ a) => a.slot).filter(Boolean);
    c('elke app een eigen slot', new Set(slots).size === slots.length, slots.join(','));
  });

  const opVolgorde = () => kern.beeld().apps.filter((/** @type {any} */ a) => deelnemers.includes(a.app) && a.slot).sort((/** @type {any} */ a, /** @type {any} */ b) => a.slot - b.slot);

  await stap('focus: Bank + Track Select door alle apps', async (c) => {
    let vorige = kern.beeld().focus;
    for (const a of opVolgorde()) {
      const t0 = r.nu();
      const ok = await kiesFocus(a.app);
      c(`Bank + Track Select ${a.slot} → focus ${a.app}`, ok, `focus is ${kern.beeld().focus}`);
      const kreeg = await tot(async () => (await sinds(a.app, t0, (b) => b.t === 'focus' && b.aan === true)).length > 0, 2000);
      if (vorige !== a.app) c(`${a.app} kreeg {focus aan:true}`, kreeg);
      if (vorige && vorige !== a.app && r.deelnemers.has(vorige)) {
        const pv = /** @type {string} */ (vorige);
        const uit = await tot(async () => (await sinds(pv, t0, (b) => b.t === 'focus' && b.aan === false)).length > 0, 2000);
        c(`${vorige} kreeg {focus aan:false}`, uit);
      }
      vorige = a.app;
    }
  });

  /** Eén app bespelen met faders, knoppen en pads (manifest) of ruwe MIDI (lease). @param {string} app */
  async function bespeel(app) {
    await stap(`bediening: ${app}`, async (c) => {
      c(`focus op ${app}`, await kiesFocus(app));
      const a = appStaat(app);
      if (!a?.manifest) { c(`${app} heeft een manifest`, false); return; }
      if (a.manifest.lease) {
        const apcVoor = r.apc.verstuurd.length;
        const t0 = r.nu();
        await zetControl('master', 0.6);
        await tot(async () => (await sinds(app, t0, (b) => b.t === 'midi')).some((b) => b.bytes[1] === 14 && b.bytes[2] === ruw(0.6)), 2000);
        const midi = await sinds(app, t0, (b) => b.t === 'midi');
        c('lease: masterfader komt als ruwe MIDI aan', midi.some((b) => b.bytes[0] === 0xb0 && b.bytes[1] === 14 && b.bytes[2] === ruw(0.6)), `${midi.length} midi-berichten`);
        const p = a.manifest.params.find((/** @type {any} */ x) => x.id === 'master');
        if (p) {
          await controleerTerug(c, app, 'master', fysiek(0.6));
          const meld = await tot(() => Math.abs((appStaat(app)?.waarden.master ?? -1) - fysiek(0.6)) < MARGE, 3000);
          c('lease: de app meldt master terug aan de hub (zet)', meld, `hub kent ${appStaat(app)?.waarden.master}`);
        }
        const t1 = r.nu();
        await schuif('dk1', 0.2, 0.5);
        await tik('pad1-1');
        await tot(async () => (await sinds(app, t1, (b) => b.t === 'midi')).length >= 3, 2000);
        const m2 = await sinds(app, t1, (b) => b.t === 'midi');
        c('lease: device-knop en pad komen als MIDI aan', m2.some((b) => b.bytes[1] === 16) && m2.some((b) => (b.bytes[0] & 0xf0) === 0x90 && b.bytes[1] === 0), `${m2.length} midi-berichten`);
        await tot(() => r.apc.verstuurd.length > apcVoor, 1500);
        c('lease: LEDs van de app bereiken de APC', r.apc.verstuurd.length > apcVoor, `${r.apc.verstuurd.length - apcVoor} berichten naar de APC`);
        const anderen = [];
        for (const x of deelnemers) if (x !== app) anderen.push(...(await sinds(x, t0, (b) => b.t === 'midi' || (b.t === 'zet' && b.bron === 'apc40'))));
        c('niemand anders kreeg deze bediening', anderen.length === 0, anderen.length ? JSON.stringify(anderen.slice(0, 3)) : undefined);
        return;
      }
      const tw = toewijzingen(a.indeling, a.pagina);
      const paren = Object.entries(tw);
      const fader = paren.find(([el, t]) => /^fader\d$/.test(el) && t.rol === 'fader');
      const ring = paren.find(([el, t]) => /^(dk|tk)\d$/.test(el) && t.rol === 'ring');
      const pad = paren.find(([, t]) => t.rol === 'trigger' && t.id !== 'dice' && t.id !== 'paniek')
        ?? paren.find(([, t]) => t.rol === 'keuze' || t.rol === 'schakelaar' || t.rol === 'stap');
      const t0 = r.nu();
      for (const [el, t] of [fader, ring].filter(Boolean).map((x) => /** @type {[string, any]} */ (x))) {
        const nu = a.waarden[t.id] ?? 0;
        const doel = nu < 0.5 ? 0.7 : 0.3;
        const tx = r.nu();
        await zetControl(el, doel);
        const kwam = await tot(async () => Math.abs(((await sinds(app, tx, (b) => b.t === 'zet' && b.id === t.id)).at(-1)?.v ?? -1) - fysiek(doel)) < 1e-6, 3000);
        const z = await sinds(app, tx, (b) => b.t === 'zet' && b.id === t.id);
        c(`${el} → zet ${t.id} ${fysiek(doel).toFixed(3)} komt aan (als laatste)`, kwam, `${z.length} zet(s), laatste ${z.at(-1)?.v?.toFixed?.(3)}`);
        await controleerTerug(c, app, t.id, fysiek(doel));
      }
      if (!fader) c(`${app}: geen fader in de indeling (overgeslagen)`, true);
      if (pad) {
        const [el, t] = pad;
        const tx = r.nu();
        await tik(el);
        if (t.rol === 'trigger') {
          await tot(async () => (await sinds(app, tx, (b) => b.t === 'trig' && b.id === t.id)).length >= 2, 2000);
          const tr = await sinds(app, tx, (b) => b.t === 'trig' && b.id === t.id);
          c(`${el} → trig ${t.id} aan en uit`, tr.map((b) => b.aan).join() === 'true,false', tr.map((b) => b.aan).join() || 'niets');
        } else {
          const kwam = await tot(async () => (await sinds(app, tx, (b) => b.t === 'zet' && b.id === t.id)).length > 0, 2000);
          c(`${el} → zet ${t.id} komt aan`, kwam);
          const v = appStaat(app)?.waarden[t.id];
          if (typeof v === 'number') await controleerTerug(c, app, t.id, v);
        }
      }
      if (a.indeling.scenes > 0) {
        const tx = r.nu();
        await tik('scene1');
        const kwam = await tot(async () => (await sinds(app, tx, (b) => b.t === 'scene' && b.i === 0)).length > 0, 2000);
        c('Scene 1 → {scene i:0} komt aan', kwam);
      }
      const anderen = [];
      for (const x of deelnemers) if (x !== app) anderen.push(...(await sinds(x, t0, (b) => (b.t === 'zet' && b.bron === 'apc40') || b.t === 'trig' || b.t === 'scene' || b.t === 'midi')));
      c('niemand anders kreeg deze bediening', anderen.length === 0, anderen.length ? JSON.stringify(anderen.slice(0, 3)) : undefined);
    });
  }
  for (const a of opVolgorde()) await bespeel(a.app);

  /** Parameters met een rol, per app. @param {string} rol */
  const metRol = (rol) => {
    /** @type {{ app: string, p: any }[]} */
    const uit = [];
    for (const id of deelnemers) for (const p of appStaat(id)?.manifest?.params ?? []) if (p.rol === rol && p.soort !== 'trigger') uit.push({ app: id, p });
    return uit;
  };
  const maxSlew = (/** @type {{ p: any }[]} */ l) => Math.max(0, ...l.map((x) => x.p.slew_s ?? 0)) * 1000;

  await stap("LPD8: macro's K1–K8 over alle apps tegelijk", async (c) => {
    const t0 = r.nu();
    /** @type {Record<string, number>} */
    const doelen = {};
    for (let k = 1; k <= 8; k++) {
      const doel = fysiek(0.2 + 0.07 * k);
      doelen[ROLLEN[k - 1]] = doel;
      await lpdKnop(k, 0, 1);
      await lpdKnop(k, 1, doel);
    }
    const alle = ROLLEN.flatMap((rol) => metRol(rol));
    await r.wacht(maxSlew(alle) + 800);
    for (const [rol, doel] of Object.entries(doelen)) {
      const l = metRol(rol);
      for (const { app, p } of l) {
        const z = await sinds(app, t0, (b) => b.t === 'zet' && b.id === p.id);
        const laatste = z.at(-1);
        const verwacht = naQuant(p, doel);
        c(`${rol} → ${app}.${p.id} eindigt op ${verwacht.toFixed(3)}`, laatste && Math.abs(laatste.v - verwacht) < 1e-6 && laatste.bron === 'lpd8',
          laatste ? `${z.length} zet(s), laatste ${laatste.v.toFixed(3)} (${laatste.bron})` : 'geen zet');
        await controleerTerug(c, app, p.id, doel, 1500);
      }
      if (!l.length) c(`${rol}: geen app met deze rol (alleen globaal)`, true);
      for (const id of deelnemers) {
        const g = await sinds(id, t0, (b) => b.t === 'globaal' && rol in b.waarden);
        c(`${id} kreeg globaal ${rol}`, g.length > 0 && Math.abs(g.at(-1).waarden[rol] - doel) < 1e-6, g.length ? `laatste ${g.at(-1).waarden[rol]}` : 'niets');
      }
    }
  });

  await stap("LPD8: verder draaien — de knoppen blijven gevangen", async (c) => {
    // Een speler draait door. Na de vorige stap staat elke knop op zijn doel; twee tikjes verder moet
    // elke app met die rol weer een zet krijgen. Zo niet, dan heeft iets (bv. een app die een afgeronde
    // waarde terugmeldt) de pickup van de LPD8 losgemaakt.
    for (let k = 1; k <= 8; k++) {
      const rol = ROLLEN[k - 1];
      const l = metRol(rol).filter((x) => x.p.soort === 'waarde');
      if (!l.length) continue;
      const van = fysiek(0.2 + 0.07 * k), naar = fysiek(van + 2 / 127);
      const hub = Object.fromEntries(l.map(({ app, p }) => [`${app}.${p.id}`, appStaat(app)?.waarden[p.id]]));
      const t0 = r.nu();
      await lpdKnop(k, van + 1 / 127, naar);
      await r.wacht(maxSlew(l) + 500);
      for (const { app, p } of l) {
        const z = await sinds(app, t0, (b) => b.t === 'zet' && b.id === p.id);
        c(`K${k} twee tikjes verder → ${app}.${p.id} volgt`, z.length > 0 && Math.abs(z.at(-1).v - naar) < 1e-6,
          z.length ? `laatste ${z.at(-1).v.toFixed(3)}` : `geen zet (hub kende ${Number(hub[`${app}.${p.id}`]).toFixed(3)}, knop stond op ${van.toFixed(3)})`);
      }
    }
  });

  await stap('snapshot: bewaren (P5 lang), veranderen, laden (P5 kort)', async (c) => {
    lpdPad(5, true); await r.wacht(LANG_MS + 300); lpdPad(5, false);
    await r.wacht(100);
    const bewaard = kern.snapshots?.get?.(1);
    c('snapshot 1 is bewaard', !!bewaard, bewaard ? Object.keys(bewaard).join(', ') : 'niets');
    if (!bewaard) return;
    // Verander: K2 en K6 ver weg, en een fader van de app met focus.
    await lpdKnop(2, fysiek(0.2 + 0.14), 0.95);
    await lpdKnop(6, fysiek(0.2 + 0.42), 0.05);
    const f = kern.beeld().focus;
    const fa = f ? appStaat(f) : null;
    if (fa?.indeling && !fa.manifest.lease) {
      const fd = Object.entries(toewijzingen(fa.indeling, fa.pagina)).find(([el, t]) => /^fader\d$/.test(el) && t.rol === 'fader');
      if (fd) await zetControl(fd[0], 0.1);
    }
    await r.wacht(maxSlew([...metRol('macro.helderheid'), ...metRol('macro.dichtheid')]) + 500);
    /** @type {{ app: string, id: string, v: number }[]} */
    const veranderd = [];
    for (const [app, w] of Object.entries(bewaard)) {
      for (const [id, v] of Object.entries(/** @type {Record<string, number>} */ (w))) if (Math.abs((appStaat(app)?.waarden[id] ?? v) - v) > 1e-6) veranderd.push({ app, id, v });
    }
    c('er is iets veranderd om terug te zetten', veranderd.length > 0, `${veranderd.length} waarden`);
    const t0 = r.nu();
    lpdPad(5, true); await r.wacht(100); lpdPad(5, false);
    await r.wacht(1000);
    for (const { app, id, v } of veranderd) {
      const z = await sinds(app, t0, (b) => b.t === 'zet' && b.id === id && b.bron === 'snapshot');
      c(`snapshot → ${app}.${id} terug op ${v.toFixed(3)}`, z.length > 0 && Math.abs(z.at(-1).v - v) < 1e-6, z.length ? `kreeg ${z.at(-1).v.toFixed(3)}` : 'geen zet');
      await controleerTerug(c, app, id, v, 1500);
    }
  });

  await stap('paniek: P1 vasthouden en loslaten', async (c) => {
    const t0 = r.nu();
    lpdPad(1, true);
    await r.wacht(PANIEK_MS + 300);
    const metPaniek = deelnemers.filter((id) => appStaat(id)?.manifest?.params.some((/** @type {any} */ p) => p.id === 'paniek' && p.soort === 'trigger'));
    for (const id of metPaniek) {
      const kwam = await tot(async () => (await sinds(id, t0, (b) => b.t === 'trig' && b.id === 'paniek' && b.aan === true)).length > 0, 1500);
      c(`${id} kreeg trig paniek aan`, kwam);
      const oordeel = D(id).paniek;
      if (oordeel) { const w = await D(id).lees(); const o = w && oordeel(w, true); if (o) c(`${id}: paniek werkt in de app`, o[0], o[1]); }
    }
    for (const id of deelnemers) {
      const kwam = await tot(async () => (await sinds(id, t0, (b) => b.t === 'globaal' && b.waarden.paniek === 1)).length > 0, 1500);
      c(`${id} kreeg globaal paniek 1`, kwam);
    }
    const t1 = r.nu();
    lpdPad(1, false);
    await r.wacht(300);
    for (const id of metPaniek) {
      const kwam = await tot(async () => (await sinds(id, t1, (b) => b.t === 'trig' && b.id === 'paniek' && b.aan === false)).length > 0, 1500);
      c(`${id} kreeg trig paniek uit`, kwam);
      const oordeel = D(id).paniek;
      if (oordeel) { const w = await D(id).lees(); const o = w && oordeel(w, false); if (o) c(`${id}: na paniek weer normaal`, o[0], o[1]); }
    }
    for (const id of deelnemers) {
      const kwam = await tot(async () => (await sinds(id, t1, (b) => b.t === 'globaal' && b.waarden.paniek === 0)).length > 0, 1500);
      c(`${id} kreeg globaal paniek 0`, kwam);
    }
    // Na de paniek draait de speler K1 (intensiteit) weer open: twee tikjes vanaf waar de knop staat.
    const l = metRol('macro.intensiteit').filter((x) => x.p.soort === 'waarde');
    const k1 = kern.fysiek?.get?.('lpd8:k1');
    if (l.length && typeof k1 === 'number' && k1 < 0.9) {
      await r.wacht(300);
      const t2 = r.nu();
      await lpdKnop(1, k1 + 1 / 127, k1 + 3 / 127);
      await r.wacht(maxSlew(l) + 500);
      for (const { app, p } of l) {
        const z = await sinds(app, t2, (b) => b.t === 'zet' && b.id === p.id);
        c(`na paniek: K1 twee tikjes verder → ${app}.${p.id} volgt`, z.length > 0,
          z.length ? `laatste ${z.at(-1).v.toFixed(3)}` : `geen zet (K1 staat op ${k1.toFixed(3)}, hub kent ${l.map((x) => `${x.app}.${x.p.id} ${Number(appStaat(x.app)?.waarden[x.p.id]).toFixed(3)}`).join(', ')})`);
      }
    }
  });

  for (const [i, app] of (r.herstarten ?? []).filter((x) => r.deelnemers.has(x)).entries()) {
    // De eerste herstart zonder focus, de tweede terwijl de app de focus heeft.
    const metFocus = i % 2 === 1;
    await stap(`herstart: ${app} halverwege${metFocus ? ' (met focus)' : ''}`, async (c) => {
      if (metFocus) c(`focus op ${app} vóór de herstart`, await kiesFocus(app));
      const voor = { slot: beeldApp(app)?.slot, inst: appStaat(app)?.inst, focus: kern.beeld().focus };
      const t0 = r.nu();
      const apcVoor = r.apc.verstuurd.length;
      herstartend.add(app);
      herstart.add(app);
      await D(app).herstart();
      const terug = await tot(() => appStaat(app)?.inst !== voor.inst && beeldApp(app)?.status === 'actief', 30000);
      await r.wacht(300); // het laatste beeld (weg → actief) hoort nog bij de herstart
      kijkStatus();
      herstartend.delete(app);
      c(`${app} is terug met een nieuwe inst`, terug, `status ${beeldApp(app)?.status}`);
      c(`${app} houdt slot ${voor.slot}`, beeldApp(app)?.slot === voor.slot, `slot ${beeldApp(app)?.slot}`);
      c('de focus bleef staan', kern.beeld().focus === voor.focus, `focus ${kern.beeld().focus}`);
      if (metFocus) c(`${app} kreeg na de herstart weer {focus aan:true}`, await tot(async () => (await sinds(app, t0, (b) => b.t === 'focus' && b.aan === true)).length > 0, 2000));
      if (metFocus && appStaat(app)?.manifest?.lease) {
        c(`lease: ${app} tekent na de herstart weer LEDs op de APC`, await tot(() => r.apc.verstuurd.length > apcVoor, 3000), `${r.apc.verstuurd.length - apcVoor} berichten`);
      }
      c('geen dubbele app in de hub', kern.beeld().apps.filter((/** @type {any} */ a) => a.app === app).length === 1);
      // Na de herstart: weer bespelen (pickup begint opnieuw "wachtend").
      c(`focus op ${app}`, await kiesFocus(app));
      const a = appStaat(app);
      const fd = a?.indeling ? Object.entries(toewijzingen(a.indeling, a.pagina)).find(([el, t]) => /^fader\d$/.test(el) && t.rol === 'fader') : undefined;
      if (fd) {
        const [el, t] = fd;
        const doel = (a.waarden[t.id] ?? 0) < 0.5 ? 0.8 : 0.2;
        const tx = r.nu();
        await zetControl(el, doel);
        const kwam = await tot(async () => Math.abs(((await sinds(app, tx, (b) => b.t === 'zet' && b.id === t.id)).at(-1)?.v ?? -1) - fysiek(doel)) < 1e-6, 3000);
        c(`na herstart: ${el} → ${t.id} komt aan`, kwam);
        await controleerTerug(c, app, t.id, fysiek(doel));
      }
    });
  }

  await stap('eindstand: hub en apps zijn het eens', async (c) => {
    await r.wacht(1000);
    for (const id of deelnemers) {
      const a = appStaat(id);
      const w = await D(id).lees();
      if (!a?.manifest || !w) continue;
      const oneens = [];
      let n = 0;
      for (const p of a.manifest.params) {
        if (p.soort === 'trigger' || typeof w[p.id] !== 'number' || typeof a.waarden[p.id] !== 'number') continue;
        n++;
        const marge = p.soort === 'keuze' || p.soort === 'schakelaar' ? 0.001 : MARGE;
        if (Math.abs(w[p.id] - naQuant(p, a.waarden[p.id])) > marge) oneens.push(`${p.id}: hub ${a.waarden[p.id].toFixed(3)}, app ${w[p.id].toFixed(3)}`);
      }
      if (n) c(`${id}: hub en app eens over ${n} waarden`, oneens.length === 0, oneens.join('; ') || undefined);
    }
    // Na de LPD8-stap stonden alle apps met dezelfde rol gelijk (een snapshot zet ze samen terug). Lopen ze nu
    // uiteen, dan komt dat door een herstart: de app begon weer bij zijn eigen waarden (truth "app").
    for (let k = 1; k <= 8; k++) {
      const l = metRol(ROLLEN[k - 1]).filter((x) => x.p.soort === 'waarde' && typeof appStaat(x.app)?.waarden[x.p.id] === 'number');
      if (l.length < 2) continue;
      const w = l.map((x) => /** @type {number} */ (appStaat(x.app)?.waarden[x.p.id]));
      if (Math.max(...w) - Math.min(...w) <= MARGE) continue;
      c.opmerking(`K${k} (${ROLLEN[k - 1]}): apps met deze rol lopen uiteen`,
        l.map((x, i) => `${x.app}.${x.p.id} ${w[i].toFixed(3)}${herstart.has(x.app) ? ' (herstart)' : ''}`).join(', '));
    }
  });

  await stap('cockpit open', async (c) => {
    const ck = await r.cockpit();
    try {
      const verwacht = kern.beeld().apps.filter((/** @type {any} */ a) => deelnemers.includes(a.app)).map((/** @type {any} */ a) => a.naam);
      const mist = verwacht.filter((n) => !ck.namen.includes(n));
      c('cockpit toont alle apps', mist.length === 0, mist.length ? `mist: ${mist.join(', ')}` : ck.namen.join(', '));
      c('cockpit is verbonden met de hub', ck.status === 'verbonden', ck.status);
      const doel = opVolgorde().find((a) => a.app !== kern.beeld().focus)?.app;
      if (doel) {
        const t0 = r.nu();
        await ck.focus(doel);
        const ok = await tot(() => kern.beeld().focus === doel, 2000);
        c(`focus vanuit de cockpit → ${doel}`, ok, `focus ${kern.beeld().focus}`);
        c(`${doel} kreeg {focus aan:true}`, await tot(async () => (await sinds(doel, t0, (b) => b.t === 'focus' && b.aan)).length > 0, 2000));
      }
      const f = await ck.fouten();
      c('cockpit zonder console-fouten', f.length === 0, f.map((x) => x.tekst).slice(0, 3).join(' | '));
    } finally { await ck.sluit(); }
  });

  await stap('afsluiting: iedereen nog actief', async (c) => {
    await r.wacht(2000);
    for (const id of deelnemers) c(`${id} actief`, beeldApp(id)?.status === 'actief', beeldApp(id)?.status);
    kijkStatus();
    const onverwacht = wissels.filter((w) => !w.verwacht && (w.naar === 'stil' || w.naar === 'weg'));
    c('geen app viel onverwacht stil of weg', onverwacht.length === 0, onverwacht.map((w) => `${w.app} ${w.van}→${w.naar}`).join(', '));
  });

  afmelden?.();
  afmeldenBeeld?.();
  await r.wacht(300); // wat net verstuurd is, nog laten aankomen

  // ── meten: latency en fouten per stap ─────────────────────────────────────────────────────────────
  /** @type {Map<string, Ontvangen[]>} */
  const ontvangen = new Map();
  /** @type {Map<string, Fout[]>} */
  const fouten = new Map();
  for (const id of deelnemers) { ontvangen.set(id, await D(id).ontvangen()); fouten.set(id, await D(id).fouten()); }
  const gekoppeld = koppel(verzonden.filter((v) => r.deelnemers.has(v.app)), ontvangen);
  for (const s of stappen) {
    const hier = gekoppeld.filter((x) => x.t >= s.begin && x.t <= s.eind && x.ms !== null);
    s.latency = latencyVan(hier.map((x) => /** @type {number} */ (x.ms)));
    s.perApp = Object.fromEntries(deelnemers.map((id) => [id, latencyVan(hier.filter((x) => x.app === id).map((x) => /** @type {number} */ (x.ms)))]));
    s.fouten = Object.fromEntries(deelnemers.map((id) => [id, (fouten.get(id) ?? []).filter((f) => f.t >= s.begin && f.t <= s.eind).map((f) => f.tekst)]).filter(([, l]) => l.length));
  }
  /** @type {Record<string, { latency: Latency, latencyBediening: Latency, verzonden: number, verloren: number, verlorenSoorten: Record<string, number>, verlorenPerStap: Record<string, number>, herhaaldeZets: Record<string, number>, fouten: string[] }>} */
  const perApp = {};
  const bediening = (/** @type {any} */ b) => b.t !== 'globaal' && b.t !== 'welkom';
  /** Zets die precies dezelfde waarde nog eens sturen (per parameter): werk voor de app zonder verandering. @param {{ b: any }[]} l */
  const herhaald = (l) => {
    /** @type {Record<string, number>} */
    const n = {};
    /** @type {Map<string, number>} */
    const vorige = new Map();
    for (const { b } of l) {
      if (b.t !== 'zet') continue;
      if (vorige.get(b.id) === b.v) n[b.id] = (n[b.id] ?? 0) + 1;
      vorige.set(b.id, b.v);
    }
    return n;
  };
  for (const id of deelnemers) {
    const l = gekoppeld.filter((x) => x.app === id);
    const verloren = l.filter((x) => x.ms === null);
    /** @type {Record<string, number>} */
    const soorten = {};
    /** @type {Record<string, number>} */
    const perStap = {};
    for (const x of verloren) {
      soorten[x.b.t] = (soorten[x.b.t] ?? 0) + 1;
      const s = stappen.find((y) => x.t >= y.begin && x.t <= y.eind)?.naam ?? 'tussen de stappen';
      perStap[s] = (perStap[s] ?? 0) + 1;
    }
    perApp[id] = {
      latency: latencyVan(l.filter((x) => x.ms !== null).map((x) => /** @type {number} */ (x.ms))),
      latencyBediening: latencyVan(l.filter((x) => x.ms !== null && bediening(x.b)).map((x) => /** @type {number} */ (x.ms))),
      verzonden: l.length, verloren: verloren.length, verlorenSoorten: soorten, verlorenPerStap: perStap, herhaaldeZets: herhaald(l),
      fouten: (fouten.get(id) ?? []).map((f) => f.tekst),
    };
  }
  const alle = gekoppeld.filter((x) => x.ms !== null);
  return {
    stappen, perApp, wissels,
    totaal: {
      ok: stappen.every((s) => s.ok),
      controles: stappen.reduce((n, s) => n + s.controles.length, 0),
      geslaagd: stappen.reduce((n, s) => n + s.controles.filter((x) => x.ok).length, 0),
      opmerkingen: stappen.reduce((n, s) => n + s.controles.filter((x) => x.opmerking).length, 0),
      latency: latencyVan(alle.map((x) => /** @type {number} */ (x.ms))),
      latencyBediening: latencyVan(alle.filter((x) => bediening(x.b)).map((x) => /** @type {number} */ (x.ms))),
    },
  };
}

/**
 * Rapport in Markdown.
 * @param {{ datum: string, omgeving: Record<string, unknown>, uitslag: Awaited<ReturnType<typeof speelAvond>> }} o
 */
export function rapportMd({ datum, omgeving, uitslag }) {
  const L = (/** @type {Latency|undefined} */ l) => (l && l.n ? `${l.p50} / ${l.p95} / ${l.max} ms (n=${l.n})` : '—');
  const r = [];
  r.push(`# Generale repetitie — ${datum}`, '');
  r.push(`**Uitslag:** ${uitslag.totaal.ok ? 'alles groen' : 'NIET alles groen'} · ${uitslag.totaal.geslaagd}/${uitslag.totaal.controles} controles${uitslag.totaal.opmerkingen ? ` (waarvan ${uitslag.totaal.opmerkingen} opmerking${uitslag.totaal.opmerkingen > 1 ? 'en' : ''})` : ''} · latency hub→app (p50/p95/max) ${L(uitslag.totaal.latency)}; alleen bediening (zonder globaal/adem) ${L(uitslag.totaal.latencyBediening)}`, '');
  r.push('## Omgeving', '');
  for (const [k, v] of Object.entries(omgeving)) r.push(`- **${k}**: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
  r.push('', '## Stappen', '', '| stap | controles | latency p50 / p95 / max | console-fouten |', '|---|---|---|---|');
  for (const s of uitslag.stappen) {
    const nf = Object.values(s.fouten ?? {}).reduce((n, l) => n + l.length, 0);
    r.push(`| ${s.ok ? '✔' : '✗'} ${s.naam} | ${s.controles.filter((x) => x.ok).length}/${s.controles.length} | ${L(s.latency)} | ${nf || '—'} |`);
  }
  r.push('', '## Per app', '', '| app | latency alles (p50 / p95 / max) | alleen bediening | verzonden | niet aangekomen | herhaalde zets (zelfde waarde) | console-fouten |', '|---|---|---|---|---|---|---|');
  for (const [id, a] of Object.entries(uitslag.perApp)) {
    const soorten = [Object.entries(a.verlorenSoorten).map(([t, n]) => `${t}×${n}`).join(', '), Object.entries(a.verlorenPerStap).map(([t, n]) => `${n} in "${t}"`).join(', ')].filter(Boolean).join('; ');
    const dubbel = Object.entries(a.herhaaldeZets).map(([id2, n]) => `${id2}×${n}`).join(', ');
    r.push(`| ${id} | ${L(a.latency)} | ${L(a.latencyBediening)} | ${a.verzonden} | ${a.verloren}${soorten ? ` (${soorten})` : ''} | ${dubbel || '—'} | ${a.fouten.length} |`);
  }
  const mis = uitslag.stappen.flatMap((s) => s.controles.filter((x) => !x.ok).map((x) => ({ stap: s.naam, ...x })));
  const opm = uitslag.stappen.flatMap((s) => s.controles.filter((x) => x.opmerking).map((x) => ({ stap: s.naam, ...x })));
  r.push('', '## Mislukte controles', '');
  if (!mis.length) r.push('Geen.');
  for (const m of mis) r.push(`- **${m.stap}** — ${m.wat}${m.detail ? `: ${m.detail}` : ''}`);
  r.push('', '## Opmerkingen (geen fout, wel een besluit waard)', '');
  if (!opm.length) r.push('Geen.');
  for (const m of opm) r.push(`- **${m.stap}** — ${m.wat}${m.detail ? `: ${m.detail}` : ''}`);
  r.push('', '## Console-fouten', '');
  const metFouten = Object.entries(uitslag.perApp).filter(([, a]) => a.fouten.length);
  if (!metFouten.length) r.push('Geen.');
  for (const [id, a] of metFouten) {
    r.push(`- **${id}** (${a.fouten.length}):`);
    for (const f of [...new Set(a.fouten)].slice(0, 8)) r.push(`  - \`${f.replace(/`/g, "'").slice(0, 300)}\``);
  }
  r.push('', '## Statuswissels', '');
  if (!uitslag.wissels.length) r.push('Geen.');
  for (const w of uitslag.wissels) r.push(`- ${w.app}: ${w.van} → ${w.naar}${w.verwacht ? ' (tijdens herstart, verwacht)' : ''}`);
  r.push('', '## Alle controles', '');
  for (const s of uitslag.stappen) {
    r.push(`### ${s.ok ? '✔' : '✗'} ${s.naam}`, '');
    for (const x of s.controles) r.push(`- ${x.opmerking ? '!' : x.ok ? '✔' : '✗'} ${x.wat}${x.detail ? ` — ${x.detail}` : ''}`);
    r.push('');
  }
  return r.join('\n');
}
