// @ts-check
// Berichten parsen en controleren (PROTOCOL.md §3, §8). Onbekende types → { ok:true, onbekend:true }:
// negeren, nooit crashen. Waarden worden geklemd op 0..1.

/** @typedef {import('./types.js').VanApp} VanApp @typedef {import('./types.js').NaarApp} NaarApp */

export const VAN_APP = /** @type {const} */ (['hallo', 'manifest', 'staat', 'zet', 'hb', 'led', 'scherm']);
export const NAAR_APP = /** @type {const} */ (['welkom', 'zet', 'trig', 'scene', 'focus', 'globaal', 'midi', 'fout']);
export const VAN_COCKPIT = /** @type {const} */ (['virtueel', 'focus', 'zet', 'snapshot']);

export const klem01 = (/** @type {number} */ v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
const isByte = (/** @type {unknown} */ b) => Number.isInteger(b) && /** @type {number} */ (b) >= 0 && /** @type {number} */ (b) <= 255;
const isBytes = (/** @type {unknown} */ b) => Array.isArray(b) && b.length > 0 && b.length <= 512 && b.every(isByte);

/** Apparaten waar een app LED's naar kan sturen (§5, §17); de Xboard49 ontvangt niets (bewaard, nooit getoond). */
export const LED_DEVS = /** @type {const} */ (['apc40', 'xboard49', 'maschine-mk2']);
/** Eén scherm van de Maschine: 256×64 pixels, 1 bit per pixel. */
export const SCHERM_BYTES = 2048;

/**
 * Strikte base64 → bytes, of null als het geen base64 is of niet precies `lengte` bytes geeft.
 * @param {unknown} s @param {number} lengte
 */
function leesBase64(s, lengte) {
  if (typeof s !== 'string' || s.length > Math.ceil(lengte / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, 'base64');
  return b.length === lengte ? new Uint8Array(b) : null;
}

/** Mode-SysEx van de APC40 — apps mogen die nooit sturen. @param {number[]} b */
export const isModeSysex = (b) => b[0] === 0xf0 && b[1] === 0x47 && b[3] === 0x29 && b[4] === 0x60;

/** Een geldig LED-bericht van een lease-app: precies één note-off, note-on of CC van 3 bytes. Al het andere
 *  (SysEx — ook mode-SysEx verstopt achter een ander bericht — realtime-bytes, losse statusbytes) valt weg.
 *  @param {unknown} m */
export const isLedBericht = (m) => Array.isArray(m) && m.length === 3 && m.every((x) => Number.isInteger(x) && x >= 0)
  && [0x80, 0x90, 0xb0].includes(m[0] & 0xf0) && m[0] <= 0xff && m[1] <= 0x7f && m[2] <= 0x7f;

/**
 * Een bericht van een app (tekst of object) → gecontroleerd bericht.
 * @param {unknown} ruw
 * @returns {{ ok: true, bericht: VanApp } | { ok: true, onbekend: true, t: unknown } | { ok: false, fout: string }}
 */
export function leesVanApp(ruw) {
  let x = ruw;
  if (typeof ruw === 'string') { try { x = JSON.parse(ruw); } catch { return { ok: false, fout: 'geen geldige JSON' }; } }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, fout: 'bericht is geen object' };
  const b = /** @type {Record<string, any>} */ (x);
  switch (b.t) {
    case 'hallo':
      if (typeof b.app !== 'string' || !/^[a-z0-9-]{1,32}$/.test(b.app)) return { ok: false, fout: 'hallo: app ontbreekt of ongeldig' };
      if (typeof b.inst !== 'string' || !b.inst) return { ok: false, fout: 'hallo: inst ontbreekt' };
      // inst komt in het geheugenbestand (golf 4): begrensd, zodat een client het niet kan opblazen.
      if (b.inst.length > 64) return { ok: false, fout: 'hallo: inst is te lang (max 64 tekens)' };
      return { ok: true, bericht: { t: 'hallo', app: b.app, inst: b.inst, v: 1, ...(typeof b.token === 'string' ? { token: b.token } : {}) } };
    case 'manifest':
      if (!b.manifest || typeof b.manifest !== 'object') return { ok: false, fout: 'manifest ontbreekt' };
      return { ok: true, bericht: { t: 'manifest', manifest: b.manifest } };
    case 'staat': {
      if (!b.waarden || typeof b.waarden !== 'object' || Array.isArray(b.waarden)) return { ok: false, fout: 'staat: waarden ontbreekt' };
      /** @type {Record<string, number>} */
      const w = {};
      for (const [k, v] of Object.entries(b.waarden)) if (typeof v === 'number') w[k] = klem01(v);
      return { ok: true, bericht: { t: 'staat', waarden: w } };
    }
    case 'zet':
      if (typeof b.id !== 'string' || typeof b.v !== 'number') return { ok: false, fout: 'zet: id en v nodig' };
      return { ok: true, bericht: { t: 'zet', id: b.id, v: klem01(b.v) } };
    case 'hb':
      return { ok: true, bericht: { t: 'hb' } };
    case 'led': {
      if (!Array.isArray(b.bytes) || !b.bytes.every(isBytes)) return { ok: false, fout: 'led: bytes moet een lijst MIDI-berichten zijn' };
      // Zonder dev: de APC (zoals altijd). Een apparaat dat deze hub niet kent: negeren (grondregel 5).
      if (b.dev !== undefined && !LED_DEVS.includes(b.dev)) return { ok: true, onbekend: true, t: 'led' };
      const dev = b.dev === undefined || b.dev === 'apc40' ? {} : { dev: b.dev };
      return { ok: true, bericht: { t: 'led', ...dev, bytes: b.bytes.filter(isLedBericht) } };
    }
    case 'scherm': {
      // §17: alleen de Maschine heeft schermen. Een ander (of onbekend) apparaat: negeren.
      if (b.dev !== 'maschine-mk2') return { ok: true, onbekend: true, t: 'scherm' };
      if (b.nr !== 0 && b.nr !== 1) return { ok: false, fout: 'scherm: nr moet 0 (links) of 1 (rechts) zijn' };
      const data = leesBase64(b.data, SCHERM_BYTES);
      if (!data) return { ok: false, fout: `scherm: data moet base64 van precies ${SCHERM_BYTES} bytes zijn (256×64 pixels, 1 bit, rij voor rij)` };
      return { ok: true, bericht: { t: 'scherm', dev: 'maschine-mk2', nr: b.nr, data } };
    }
    default:
      return { ok: true, onbekend: true, t: b.t };
  }
}

/**
 * Een bericht van de hub naar een app controleren (voor nep-apps en tests).
 * @param {unknown} ruw
 * @returns {{ ok: true, bericht: NaarApp } | { ok: true, onbekend: true, t: unknown } | { ok: false, fout: string }}
 */
export function leesNaarApp(ruw) {
  let x = ruw;
  if (typeof ruw === 'string') { try { x = JSON.parse(ruw); } catch { return { ok: false, fout: 'geen geldige JSON' }; } }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, fout: 'bericht is geen object' };
  const b = /** @type {Record<string, any>} */ (x);
  const ok = (/** @type {any} */ bericht) => ({ ok: /** @type {const} */ (true), bericht });
  switch (b.t) {
    case 'welkom': return b.hub === 'varve-hub' ? ok(b) : { ok: false, fout: 'welkom: hub ontbreekt' };
    case 'zet': return typeof b.id === 'string' && typeof b.v === 'number' && b.v >= 0 && b.v <= 1 ? ok(b) : { ok: false, fout: 'zet: id + v (0..1) nodig' };
    case 'trig': return typeof b.id === 'string' && typeof b.aan === 'boolean' ? ok(b) : { ok: false, fout: 'trig: id + aan nodig' };
    case 'scene': return Number.isInteger(b.i) && b.i >= 0 ? ok(b) : { ok: false, fout: 'scene: i nodig' };
    case 'focus': return typeof b.aan === 'boolean' ? ok(b) : { ok: false, fout: 'focus: aan nodig' };
    case 'globaal': return b.waarden && typeof b.waarden === 'object' ? ok(b) : { ok: false, fout: 'globaal: waarden nodig' };
    case 'midi': return isBytes(b.bytes) && typeof b.dev === 'string' ? ok(b) : { ok: false, fout: 'midi: dev en bytes nodig' };
    case 'fout': return typeof b.reden === 'string' ? ok(b) : { ok: false, fout: 'fout: reden nodig' };
    default: return { ok: true, onbekend: true, t: b.t };
  }
}

/** Willekeurige instantie-id voor `hallo`. */
export const nieuweInst = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
