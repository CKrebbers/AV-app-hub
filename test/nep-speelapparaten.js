// Nep-Maschine MK2 (HID-rapporten zoals het echte toestel ze stuurt) en hulp voor de nep-Xboard49.
// Voor de sessie-, kern- en proeftests en de gesimuleerde gebruiker: geen hardware nodig.
import * as MS from '../src/devices/maschine-mk2.js';

export const VID = 0x17cc, PID = 0x1140;
export const XBOARD_NAAM = 'E-MU Xboard49';
export const MASCHINE_PRODUCT = 'Maschine Controller MK2';

/**
 * Een padrapport (0x20, 65 bytes zoals gemeten): 16 drukwaarden per plek, hoge nibble = plek.
 * @param {number[]} drukken 16 waarden 0..4095 (per plek, 0 = linksboven)
 */
export function padFrame(drukken) {
  const f = new Array(65).fill(0);
  f[0] = MS.RAPPORT.pads;
  for (let s = 0; s < 16; s++) {
    const p = Math.max(0, Math.min(4095, Math.round(drukken[s] ?? 0)));
    f[1 + 2 * s] = p & 0xff;
    f[2 + 2 * s] = (s << 4) | ((p >> 8) & 0x0f);
  }
  return f;
}

/**
 * Een knoppenrapport (0x01, 25 bytes).
 * @param {{ knoppen: Set<string>, wiel: number, encoders: number[] }} st
 */
export function knopFrame(st) {
  const f = new Array(25).fill(0);
  f[0] = MS.RAPPORT.knoppen;
  for (const k of st.knoppen) { const i = /** @type {number} */ (MS.KNOP_NR.get(k)); f[1 + (i >> 3)] |= 1 << (i & 7); }
  f[8] = st.wiel & 0x0f;
  st.encoders.forEach((w, k) => { f[9 + 2 * k] = w & 0xff; f[10 + 2 * k] = (w >> 8) & 0xff; });
  return f;
}

/** Rust: alle pads 0..2 (de ruisvloer die maschine-code mat). @param {number} i */
export const rustFrame = (i = 0) => padFrame(Array.from({ length: 16 }, (_, s) => (i + s) % 3));

/** Drukverloop van één slag (per frame), zacht of hard. */
export const SLAG = Object.freeze({
  gewoon: [0, 400, 1200, 1800, 1900, 1900, 1900, 1800, 600, 60, 0],
  zacht: [0, 150, 230, 260, 280, 260, 200, 90, 0],
  hard: [0, 3000, 4000, 4095, 4095, 4095, 4095, 4095, 4095, 2000, 40, 0],
});

/**
 * Een nep-Maschine op een NepHidSysteem. Houdt de stand van knoppen, wiel en draaiknoppen bij (het echte toestel
 * stuurt in elk knoppenrapport alles), en stuurt op verzoek rapporten.
 * @param {import('../src/ports/nep.js').NepHidSysteem} hid
 */
export function nepMaschine(hid) {
  const st = { knoppen: new Set(), wiel: 3, encoders: [100, 200, 300, 400, 500, 600, 700, 998] };
  let poort = hid.voegToe({ vid: VID, pid: PID, product: MASCHINE_PRODUCT });
  let i = 0;
  const m = {
    get poort() { return poort; },
    get naam() { return poort.naam; },
    /** @param {ArrayLike<number>} f */
    stuur(f) { poort.injecteer(f); },
    rust(n = 1) { for (let k = 0; k < n; k++) poort.injecteer(rustFrame(i++)); },
    /** Eén slag op pad `pad` (1..16, zoals opgedrukt). @param {number} pad @param {keyof typeof SLAG} [kracht] */
    pad(pad, kracht = 'gewoon') {
      const plek = MS.plekVanPad(pad);
      for (const p of SLAG[kracht]) poort.injecteer(padFrame(Array.from({ length: 16 }, (_, s) => (s === plek ? p : 0))));
    },
    /** Een slag op een plek (0 = linksboven). @param {number} plek */
    plek(plek) { m.pad(MS.padVanPlek(plek)); },
    /** @param {string} knop */
    druk(knop) { st.knoppen.add(knop); poort.injecteer(knopFrame(st)); },
    /** @param {string} knop */
    los(knop) { st.knoppen.delete(knop); poort.injecteer(knopFrame(st)); },
    /** @param {string} knop */
    tik(knop) { m.druk(knop); m.los(knop); },
    /** Draai knop k (0..7) `tellen` verder (rondlopend 0..999), in stapjes van 4 zoals het echte toestel. @param {number} k @param {number} tellen */
    draai(k, tellen) {
      const stap = Math.sign(tellen) * 4;
      for (let t = 0; Math.abs(t) < Math.abs(tellen); t += stap) {
        st.encoders[k] = (((st.encoders[k] + stap) % MS.ENCODER_ROND) + MS.ENCODER_ROND) % MS.ENCODER_ROND;
        poort.injecteer(knopFrame(st));
      }
    },
    /** @param {number} d */
    wiel(d) { st.wiel = (((st.wiel + d) % 16) + 16) % 16; poort.injecteer(knopFrame(st)); },
    uittrekken() { hid.verwijder(poort.naam); },
    insteken() { poort = hid.voegToe({ vid: VID, pid: PID, product: MASCHINE_PRODUCT }); return poort; },
    /** De laatste rapporten die de hub naar de Maschine schreef, per soort. */
    laatste() {
      /** @type {Record<string, number[]>} */
      const uit = {};
      for (const r of poort.verstuurd) uit[(r[0] & 0xfe) === 0xe0 ? `e${r[0] & 1}:${r[3] / 8}` : r[0].toString(16)] = r;
      return uit;
    },
  };
  return m;
}
