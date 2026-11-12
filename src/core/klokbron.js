// @ts-check
// MIDI-klok (24 tikken per kwartnoot) → BPM, puur: de tijd van elke tik komt binnen als getal (ms, van de Klok van de
// hub); geen timers, geen I/O. Gebruikt voor de EFX-500 (PROTOCOL §20) en de proef efx500.
//
// Hoe: de laatste `venster` intervallen (standaard 96 = vier tellen). Daaruit de tiktijden zelf (de som van de
// intervallen; er valt er geen weg) en een rechte lijn door die tiktijden (kleinste kwadraten): tiknummer → tijd.
// Een late tik maakt één interval te lang en het volgende te kort; in de tiktijden is dat één punt dat even naast de
// lijn ligt, en het heft zich op. Elke tik is één stap, ook twee tikken op dezelfde ms (een lus die in stappen aflevert).
// Een punt dat meer dan 25 % van een interval naast de lijn ligt (een hapering), telt niet mee: de lijn wordt dan
// zonder opnieuw gelegd. (Een tik die onderweg echt kwijtraakt, trekt het tempo een venster lang ±1,5 % scheef; USB-MIDI
// raakt geen kloktikken kwijt, en raden welk lang interval er twee was, misleidt bij flinke jitter vaker dan het helpt.) Pas vanaf `min` intervallen (24 = één tel)
// komt er een tempo. Het getoonde tempo (`bpm`, op 0,1 afgerond) verandert alleen als de meting er meer dan `stabiel` BPM van
// afwijkt: zo springt globaal.bpm niet heen en weer tussen 119,9 en 120,1.
// Een gat van meer dan `wegMs` tussen twee tikken = de klok stond stil: opnieuw beginnen (een nieuw tempo na Stop).

export const PPQN = 24;
/** De EFX-500 telt 40–250 BPM (handleiding); daarbuiten is het geen klok maar een storing. */
export const BPM_MIN = 20;
export const BPM_MAX = 300;

/**
 * @typedef {{ venster?: number, min?: number, stabiel?: number, wegMs?: number }} KlokOpties
 */

export class KlokMeter {
  /** @param {KlokOpties} [o] */
  constructor({ venster = 96, min = 24, stabiel = 0.2, wegMs = 2000 } = {}) {
    this.venster = Math.max(2, Math.floor(venster));
    this.min = Math.max(1, Math.min(this.venster, Math.floor(min)));
    this.stabiel = Math.max(0, stabiel);
    this.wegMs = wegMs;
    /** @type {number[]} */
    this.intervallen = [];
    /** @type {number|null} */
    this.laatste = null;
    /** Het getoonde (gladgestreken) tempo, null tot er genoeg tikken zijn. @type {number|null} */
    this.bpm = null;
    /** De laatste ruwe meting (niet afgerond, niet gladgestreken). @type {number|null} */
    this.meting = null;
    this.tikken = 0;
    /** Een andere afgeronde meting binnen de drempel, en hoeveel tikken achter elkaar die al zo is. @type {number|null} */
    this.kandidaat = null;
    this.kandidaatTel = 0;
    /** Het tempo van vóór de laatste wis(). @type {number|null} */
    this.vorige = null;
  }

  /**
   * Eén tik op tijdstip `t` (ms). Geeft het nieuwe getoonde tempo terug als dat veranderde, anders null.
   * @param {number} t @returns {number|null}
   */
  tik(t) {
    this.tikken++;
    const vorige = this.laatste;
    this.laatste = t;
    if (vorige === null) return null;
    const d = t - vorige;
    if (d > this.wegMs) { this.intervallen = []; return null; }   // de klok stond stil: opnieuw meten
    if (d < 0) return null;                                        // de tijd liep terug: telt niet
    // d = 0: twee tikken op dezelfde ms (een lus die in stappen aflevert) — wel een tik, de lijn middelt het uit.
    this.intervallen.push(d);
    if (this.intervallen.length > this.venster) this.intervallen.shift();
    if (this.intervallen.length < this.min) return null;
    const m = meetBpm(this.intervallen);
    if (m === null) return null;
    this.meting = m;
    const nieuw = Math.round(m * 10) / 10;
    if (nieuw === this.bpm) { this.kandidaat = null; return null; }
    if (this.bpm !== null && Math.abs(m - this.bpm) <= this.stabiel) {
      // Binnen de drempel: alleen overnemen als de meting een hele tel (min tikken) op dezelfde andere waarde blijft.
      // Anders bleef het getoonde tempo na een tempowissel net naast het echte hangen (90,1 bij 90).
      if (this.kandidaat !== nieuw) { this.kandidaat = nieuw; this.kandidaatTel = 0; }
      if (++this.kandidaatTel < this.min) return null;
    }
    this.kandidaat = null;
    this.bpm = nieuw;
    return nieuw;
  }

  /** Loopt de klok nog op tijdstip `nu` (laatste tik niet langer dan wegMs geleden)? @param {number} nu */
  loopt(nu) { return this.laatste !== null && nu - this.laatste <= this.wegMs; }

  /**
   * Opnieuw beginnen (de klok viel weg): ook het getoonde tempo weg (`bpm` null), zodat een klok die terugkomt pas
   * weer telt na een nieuwe meting van een hele tel. Het laatste tempo blijft leesbaar als `vorige`.
   */
  wis() { if (this.bpm !== null) this.vorige = this.bpm; this.intervallen = []; this.laatste = null; this.bpm = null; this.kandidaat = null; }
}

/**
 * BPM uit klokintervallen (ms): een rechte lijn door de tiktijden (de opgetelde intervallen), niet door een keten van
 * gefilterde intervallen. Null als het buiten BPM_MIN..BPM_MAX valt.
 * @param {number[]} intervallen
 * @returns {number|null}
 */
export function meetBpm(intervallen) {
  if (!intervallen.length) return null;
  // De tiktijden en hun nummer: elke tik één verder.
  /** @type {[number, number][]} */
  const punten = [[0, 0]];
  let t = 0;
  intervallen.forEach((d, i) => { t += d; punten.push([i + 1, t]); });
  let lijn = rechteLijn(punten);
  if (lijn === null) return null;
  // Uitschieters (een hapering van vele ms): op hun afstand tot de lijn, en dan de lijn zonder hen.
  const { a, b } = lijn;
  const goed = punten.filter(([x, y]) => Math.abs(y - (a + b * x)) <= b * 0.25);
  if (goed.length < punten.length && goed.length >= 2) lijn = rechteLijn(goed) ?? lijn;
  const bpm = 60000 / (PPQN * lijn.b);
  return bpm >= BPM_MIN && bpm <= BPM_MAX ? bpm : null;
}

/** Kleinste kwadraten y = a + b·x. @param {[number, number][]} p @returns {{ a: number, b: number }|null} */
function rechteLijn(p) {
  const n = p.length;
  if (n < 2) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of p) { sx += x; sy += y; }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0;
  for (const [x, y] of p) { sxy += (x - mx) * (y - my); sxx += (x - mx) * (x - mx); }
  if (!(sxx > 0)) return null;
  const b = sxy / sxx;
  return b > 0 ? { a: my - b * mx, b } : null;
}

/**
 * Hoe stabiel was een reeks getoonde tempo's (voor de proef): kleinste, grootste, verschil.
 * @param {number[]} bpms
 */
export function spreiding(bpms) {
  if (!bpms.length) return { min: null, max: null, verschil: null };
  const min = Math.min(...bpms), max = Math.max(...bpms);
  return { min, max, verschil: Math.round((max - min) * 100) / 100 };
}
