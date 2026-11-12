// @ts-check
// De grammatica op de Maschine MK2 (PROTOCOL §19): als de app met focus de Maschine niet zelf speelt (§17) maar wel
// de grammatica volgt, bedient de Maschine die app. Puur: geen I/O en geen klok. De kern geeft door wat de Maschine
// stuurt (virtuele MIDI, docs/MASCHINE.md) en zegt welke app bediend wordt; dit beslist wat het betekent, en tekent
// lampjes en schermen op het speeloppervlak.
//
//   draaiknop 1–8   het parameter-alfabet (plek N), relatief; SHIFT ingedrukt = fijn. Geen pickup (relatief springt
//                   nooit) en geen slew: een hand op een knop is direct, zoals een APC-knop (§12)
//   schermen        per knop het woord van de plek, de naam en waarde van de parameter, een balk
//   groep A–H       focus op app-slot 1–8 (zoals Bank + Track Select)
//   pad 1–8         de momenten (moment.flits … moment.halvetijd): trig met velocity als `v`, aftertouch naar `druk`
//   pad 9–16        vrij per app: maps/<app>.json → "maschine-mk2:pad9" … "maschine-mk2:pad16": { id }
//
// Niets blijft hangen (zoals §11/§17): het loslaten gaat naar waar het indrukken heen ging, ook na een focuswissel,
// en een loslaten van iets wat hier niet ingedrukt werd, is niet van ons (de kern geeft het aan de spelers, §17).
import { ALFABET, MOMENTEN, alfabetPlek, momentPlek, rolWoord, keuzeNaarWaarde, waardeNaarKeuze } from '../protocol/manifest.js';
import * as MK2 from '../devices/maschine-mk2.js';

/** @typedef {import('../protocol/types.js').Manifest} Manifest @typedef {import('../protocol/types.js').Param} Param
 *  @typedef {import('./spelers.js').SpeelOppervlak} SpeelOppervlak
 *  @typedef {{ knoppen: (Param|null)[], momenten: (Param|null)[], vrij: (Param|null)[] }} Grammatica  elk 8 plekken
 *  @typedef {{ app: string, naam: string, waarden: Record<string, number>, kleur: number, dim: number, g: Grammatica }} Bediend
 *  @typedef {{ app: string, kleur: number, dim: number, focus: boolean }|null} SlotInfo
 *  @typedef {{ tellen_vol: number, fijn: number, tellen_stap: number }} Instellingen
 *  @typedef {{ app: string, id: string|null, soort: 'trigger'|'schakelaar'|null, druk: string|null }} Vast
 */

/** Standaard (config.json → apparaten.maschine-mk2.grammatica wint). Eén omwenteling ≈ 1000 tellen (docs/MASCHINE.md). */
export const STANDAARD = Object.freeze({
  /** zoveel tellen = van 0 naar 1 (één omwenteling) */
  tellen_vol: 1000,
  /** met SHIFT ingedrukt zoveel keer fijner */
  fijn: 10,
  /** zoveel tellen = één stap bij een keuze of schakelaar (een achtste omwenteling) */
  tellen_stap: 125,
});

/** Een vrije pad in een kaart (maps/<app>.json): "maschine-mk2:pad9" … "maschine-mk2:pad16". */
export const VRIJE_PAD = /^maschine-mk2:pad(9|1[0-6])$/;

/**
 * Wat een manifest (en zijn kaart) op de Maschine legt: per draaiknop de alfabet-parameter, per pad 1–8 het moment,
 * per pad 9–16 wat de kaart noemt (een trigger of schakelaar). Lege plekken zijn null.
 * @param {Manifest|null|undefined} manifest @param {Record<string, any>|null} [kaart]
 * @returns {Grammatica}
 */
export function grammaticaVan(manifest, kaart = null) {
  /** @type {Grammatica} */
  const g = { knoppen: Array(8).fill(null), momenten: Array(8).fill(null), vrij: Array(8).fill(null) };
  for (const p of manifest?.params ?? []) {
    const a = p.soort !== 'trigger' ? alfabetPlek(p.rol) : 0;
    if (a && !g.knoppen[a - 1]) g.knoppen[a - 1] = p;
    const m = p.soort === 'trigger' ? momentPlek(p.rol) : 0;
    if (m && !g.momenten[m - 1]) g.momenten[m - 1] = p;
  }
  for (const [k, v] of Object.entries(kaart ?? {})) {
    const nr = VRIJE_PAD.exec(k);
    const p = nr && manifest?.params.find((x) => x.id === v?.id && (x.soort === 'trigger' || x.soort === 'schakelaar'));
    if (nr && p) g.vrij[Number(nr[1]) - 9] = p;
  }
  return g;
}

/** Volgt deze app de grammatica (iets op een draaiknop of pad)? @param {Grammatica} g */
export const heeftGrammatica = (g) => [...g.knoppen, ...g.momenten, ...g.vrij].some(Boolean);

/** Een waarde zoals het scherm en de cockpit hem tonen. @param {Param} p @param {number} v */
export function waardeTekst(p, v) {
  if (p.soort === 'keuze') return p.keuzes?.[waardeNaarKeuze(v, p.keuzes.length)] ?? '';
  if (p.soort === 'schakelaar') return v >= 0.5 ? 'aan' : 'uit';
  return `${Math.round(v * 100)}%`;
}

/** @param {unknown} x @param {number} d */
const getal = (x, d) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : d);

export class MaschineBediening {
  /**
   * @param {{
   *   bediend: () => Bediend|null, actief: () => boolean, slots: () => SlotInfo[],
   *   zet: (app: string, id: string, v: number) => void,
   *   trig: (app: string, id: string, aan: boolean, kracht?: number) => void,
   *   focusSlot: (nr: number) => void,
   *   oppervlak?: SpeelOppervlak, instellingen?: Partial<Instellingen>,
   * }} o
   *   bediend: de app die de Maschine nu bedient (null = de Maschine speelt voor een lease-app of niemand, §17);
   *   actief: de spelers hebben de Maschine vrijgegeven voor de grammatica (src/core/spelers.js `bezet`)
   */
  constructor(o) {
    this.o = o;
    const i = o.instellingen ?? {};
    /** @type {Instellingen} */
    this.inst = { tellen_vol: getal(i.tellen_vol, STANDAARD.tellen_vol), fijn: getal(i.fijn, STANDAARD.fijn), tellen_stap: getal(i.tellen_stap, STANDAARD.tellen_stap) };
    /** Wat er hier ingedrukt is (knopnaam → waar het heen ging). @type {Map<string, Vast>} */
    this.vast = new Map();
    /** Opgespaarde tellen voor een keuze of schakelaar op een draaiknop, per app+id. @type {Map<string, number>} */
    this.rest = new Map();
  }

  get shift() { return this.vast.has('shift'); }

  /**
   * Eén virtueel MIDI-bericht van de Maschine. true = het is van de grammatica (de kern stuurt het niet naar een
   * speler); false = niet van ons (geen bediende app, of het loslaten van iets dat een speler indrukte).
   * @param {number[]} bytes
   */
  invoer(bytes) {
    const g = MK2.ontleedMidi(bytes);
    const el = g.el;
    if (!el) return this.#bezig();
    if (g.kind === 'los') {
      const h = this.vast.get(el);
      if (!h) return false;
      this.vast.delete(el);
      if (h.id && h.soort === 'trigger') this.o.trig(h.app, h.id, false);
      if (h.druk) this.o.zet(h.app, h.druk, 0);
      this.teken();
      return true;
    }
    if (g.kind === 'waarde') { // polyfone aftertouch van een pad: volgt de pad naar waar hij heen ging
      const h = this.vast.get(el);
      if (!h) return false;
      if (h.druk) this.o.zet(h.app, h.druk, Math.max(0, Math.min(1, g.v ?? 0)));
      return true;
    }
    const b = this.#bezig() ? this.o.bediend() : null;
    if (!b) return false;
    if (g.kind === 'druk') { this.#druk(b, el, g.v ?? 1); return true; }
    if (g.kind === 'delta') {
      const n = /^enc([1-8])$/.exec(el);
      if (n) this.#draai(b, Number(n[1]), g.delta ?? 0);
      return true; // ook het masterwiel: hier (nog) niets
    }
    return true;
  }

  #bezig() { return this.o.actief() && this.o.bediend() !== null; }

  /** @param {Bediend} b @param {string} el @param {number} kracht velocity 0..1 */
  #druk(b, el, kracht) {
    /** @type {Vast} */
    const h = { app: b.app, id: null, soort: null, druk: null };
    const pad = /^pad([1-9]|1[0-6])$/.exec(el);
    const groep = /^groep([A-H])$/.exec(el);
    // Een tweede druk zonder loslaten (een verloren noot uit): eerst de eerste los, zoals §11.
    const was = this.vast.get(el);
    if (was?.id && was.soort === 'trigger') this.o.trig(was.app, was.id, false);
    if (was?.druk) this.o.zet(was.app, was.druk, 0);
    if (pad) {
      const nr = Number(pad[1]);
      const p = nr <= 8 ? b.g.momenten[nr - 1] : b.g.vrij[nr - 9];
      if (p?.soort === 'trigger') {
        Object.assign(h, { id: p.id, soort: 'trigger', druk: p.druk ?? null });
        this.o.trig(b.app, p.id, true, Math.max(0, Math.min(1, kracht)));
      } else if (p?.soort === 'schakelaar') {
        Object.assign(h, { id: p.id, soort: 'schakelaar' });
        this.o.zet(b.app, p.id, (b.waarden[p.id] ?? 0) >= 0.5 ? 0 : 1);
      }
    }
    this.vast.set(el, h);
    if (groep) this.o.focusSlot(groep[1].charCodeAt(0) - 64);
    this.teken();
  }

  /** @param {Bediend} b @param {number} n draaiknop 1..8 @param {number} delta tellen (relatief) */
  #draai(b, n, delta) {
    const p = b.g.knoppen[n - 1];
    if (!p || !delta) return;
    const deler = this.shift ? this.inst.fijn : 1;
    const huidig = b.waarden[p.id] ?? p.standaard ?? 0;
    if (p.soort === 'waarde') {
      this.o.zet(b.app, p.id, Math.max(0, Math.min(1, huidig + delta / (this.inst.tellen_vol * deler))));
      return;
    }
    // Keuze of schakelaar: tellen opsparen tot een hele stap, zodat een kleine draai niets verspringt.
    const k = `${b.app}\u0000${p.id}`;
    const n2 = p.soort === 'keuze' ? p.keuzes?.length ?? 2 : 2;
    let rest = (this.rest.get(k) ?? 0) + delta;
    const stap = this.inst.tellen_stap * deler;
    let i = waardeNaarKeuze(huidig, n2);
    while (Math.abs(rest) >= stap) { i += Math.sign(rest); rest -= Math.sign(rest) * stap; }
    i = Math.max(0, Math.min(n2 - 1, i));
    // Aan de rand loopt de rest niet op (anders moet je eerst terugdraaien wat je te ver draaide).
    if ((i === 0 && rest < 0) || (i === n2 - 1 && rest > 0)) rest = 0;
    this.rest.set(k, rest);
    if (i !== waardeNaarKeuze(huidig, n2)) this.o.zet(b.app, p.id, keuzeNaarWaarde(i, n2));
  }

  /** De Maschine viel weg: alles wat hier ingedrukt was, laat los (triggers uit, druk naar 0). */
  apparaatWeg() {
    for (const [el, h] of [...this.vast]) {
      this.vast.delete(el);
      if (h.id && h.soort === 'trigger') this.o.trig(h.app, h.id, false);
      if (h.druk) this.o.zet(h.app, h.druk, 0);
    }
    this.rest.clear();
  }

  /** Een app is vergeten: zijn opgespaarde tellen weg (ingedrukte toetsen laten pas bij loslaten los). @param {string} app */
  vergeetApp(app) { for (const k of [...this.rest.keys()]) if (k.startsWith(`${app}\u0000`)) this.rest.delete(k); }

  /** Wat de Maschine nu laat zien, als tekst en getallen (cockpit, spiekbrief, schermen), of null als hij niet bedient. */
  beeld() {
    const b = this.#bezig() ? this.o.bediend() : null;
    if (!b) return null;
    const ingedrukt = new Set([...this.vast.entries()].filter(([, h]) => h.app === b.app && h.id).map(([el]) => el));
    return {
      app: b.app, naam: b.naam, shift: this.shift,
      knoppen: b.g.knoppen.map((p, i) => {
        const woord = rolWoord(ALFABET[i]);
        if (!p) return { plek: i + 1, woord, id: null, naam: null, tekst: null, v: null };
        const v = b.waarden[p.id] ?? p.standaard ?? 0;
        return { plek: i + 1, woord, id: p.id, naam: p.naam, tekst: waardeTekst(p, v), v };
      }),
      pads: [...b.g.momenten, ...b.g.vrij].map((p, i) => ({
        pad: i + 1, woord: i < 8 ? rolWoord(MOMENTEN[i]) : null, id: p?.id ?? null, naam: p?.naam ?? null,
        ...(p?.druk ? { druk: p.druk } : {}), in: ingedrukt.has(`pad${i + 1}`),
        ...(p?.soort === 'schakelaar' ? { aan: (b.waarden[p.id] ?? 0) >= 0.5 } : {}),
      })),
    };
  }

  /**
   * Lampjes en schermen op het speeloppervlak (alleen als de Maschine voor de grammatica is). De sessie stuurt
   * alleen wat veranderde (MaschineLeds, schermstukken), dus volledig tekenen bij elke wijziging is goedkoop.
   */
  teken() {
    const opp = this.o.oppervlak;
    const bl = opp ? this.beeld() : null;
    const b = bl ? this.o.bediend() : null;
    if (!opp || !bl || !b) return;
    // Pads: momenten en vrije pads die de app heeft zacht in zijn kleur, ingedrukt of aan vol; de rest uit.
    bl.pads.forEach((p, i) => {
      const v = !p.id ? 0 : p.in || p.aan ? b.kleur : b.dim;
      opp.led([0x90, MK2.padNoot(i + 1), v]);
    });
    // Groep A–H: de app-slots (focus vol, verbonden gedimd, leeg uit).
    const slots = this.o.slots();
    for (let i = 0; i < 8; i++) {
      const s = slots[i];
      opp.led([0x90 | MK2.KNOP_KANAAL, /** @type {number} */ (MK2.KNOP_NR.get(`groep${String.fromCharCode(65 + i)}`)), !s ? 0 : s.focus ? s.kleur : s.dim]);
    }
    opp.led([0x90 | MK2.KNOP_KANAAL, /** @type {number} */ (MK2.KNOP_NR.get('shift')), this.shift ? 127 : 0]);
    const [l, r] = MK2.grammaticaSchermen({ app: bl.naam, knoppen: bl.knoppen, onder: this.shift ? 'FIJN' : 'SHIFT = FIJN' });
    opp.scherm(0, l);
    opp.scherm(1, r);
  }
}
