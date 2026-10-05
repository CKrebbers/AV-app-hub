// Gesimuleerde gebruiker + nep-APC40 + nep-LPD8 mk2: doorloopt een proef zonder hardware.
// Luistert naar 'verwacht'-meldingen van de runner en doet wat een mens zou doen.
import { NepSysteem, NepHidSysteem } from '../src/ports/nep.js';
import { Zender } from '../src/core/zender.js';
import * as A from '../src/devices/apc40mk2.js';
import { nepMaschine, rustFrame, XBOARD_NAAM } from './nep-speelapparaten.js';

const later = (fn) => setTimeout(fn, 1);

export function mk2Dump(prog, padBasis = 36, knopBasis = 70) {
  const b = [0xf0, 0x47, 0x7f, 0x4c, 0x03, 0x01, 0x29, prog, 0, 0, 0, 0];
  for (let i = 0; i < 8; i++) b.push(padBasis + i, 12 + i, i, 9, ...Array(12).fill(0));
  for (let i = 0; i < 8; i++) b.push(knopBasis + i, 0, 0, 127);
  return [...b, 0xf7];
}

/** Nep-APC: antwoordt op identiteit en intro zoals de echte. */
function sluitApcAan(systeem) {
  const p = systeem.voegToe('APC40 mkII');
  p.antwoord = (b) => {
    if (b[0] === 0xf0 && b[1] === 0x7e) later(() => p.injecteer([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x29, 0x00, 0x19, 0x00, 0x01, 0x00, 0xf7]));
    if (b[0] === 0xf0 && b[4] === 0x60) later(() => p.injecteer([0xf0, 0x47, 0x7f, 0x29, 0x61, 0x00, 0x04, 127, 0, 0, 0, 0, 0, 0, 0, 0, 0xf7]));
  };
  return p;
}
function sluitLpd8Aan(systeem, padBasis, knopBasis) {
  const p = systeem.voegToe('LPD8 mk2');
  p.antwoord = (b) => {
    if (b[0] === 0xf0 && b[1] === 0x7e) later(() => p.injecteer([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x4c, 0x00, 0x19, 0x00, 0xf7]));
    if (b[0] === 0xf0 && b[3] === 0x4c && b[4] === 0x03) later(() => p.injecteer(mk2Dump(b[7], padBasis, knopBasis)));
  };
  return p;
}

/** Berichten die een control op de echte APC zou sturen voor "bedienen". */
function apcBerichten(id, extra = {}) {
  const c = A.OP_ID.get(id);
  if (c.t === 'note') return extra.alleenLos ? [[0x80 | c.ch, c.n, 127]] : extra.vasthouden ? [[0x90 | c.ch, c.n, 127]] : [[0x90 | c.ch, c.n, 127], [0x80 | c.ch, c.n, 127]];
  if (c.soort === 'rel') return [[0xb0, c.n, 1], [0xb0, c.n, 127]];
  if (c.soort === 'voet') return [[0xb0, c.n, 127], [0xb0, c.n, 0]];
  if (c.soort === 'fader') return [[0xb0 | c.ch, c.n, 0], [0xb0 | c.ch, c.n, 127]];
  if (extra.gezet !== undefined) return [[0xb0, c.n, extra.richting === 'rechts' ? extra.gezet + 1 : extra.gezet - 1]];
  return [0, 20, 40, 60, 80, 100, 127].map((v) => [0xb0, c.n, v]); // draaiknop: veel verschillende waarden
}

/** Berichten voor een akkoord: de eerste knop vast, de rest erbij, dan in omgekeerde volgorde los. */
function akkoordBerichten(ids) {
  const c = ids.map((id) => A.OP_ID.get(id));
  return [...c.map((x) => [0x90 | x.ch, x.n, 127]), ...[...c].reverse().map((x) => [0x80 | x.ch, x.n, 127])];
}

/** SysEx Master Volume van de Xboard-schuif. @param {number} w 0..16383 */
const masterVolume = (w) => [0xf0, 0x7f, 0x7f, 0x04, 0x01, w & 0x7f, (w >> 7) & 0x7f, 0xf7];

/**
 * @param {{ antwoorden?: Record<string, string>, schaal?: number, lpd8Toggle?: boolean, padBasis?: number, knopBasis?: number,
 *   speel?: boolean, xbKnopBasis?: number }} o
 *   antwoorden per stap-id (standaard "j"); schaal: dezelfde als de runner (vasthouden duurt houdMs·schaal);
 *   lpd8Toggle: de LPD8-pads staan in TOGGLE-modus, zoals de echte: elke druk wisselt tussen note-on (aan) en
 *   note-off (uit), loslaten stuurt niets. De stand per pad staat in `padAan` en gaat bij opnieuw aansluiten terug naar uit;
 *   padBasis/knopBasis: noot van pad 1 en CC van knop 1 (standaard de mk2-fabrieksstand 36 en 70);
 *   speel: ook de speelapparaten (proef speelapparaten): een Xboard49 (alleen ingang, knoppen op CC xbKnopBasis..+15)
 *   en een Maschine MK2 op een NepHidSysteem (`hid`, `maschine`), die bij openen meteen een rustrapport stuurt.
 * Met `onderschep(fn)` vervangt een test wat de gebruiker doet: geeft fn true terug, dan doet de simulatie niets.
 */
export function simulatie({ antwoorden = {}, schaal = 0.01, lpd8Toggle = false, padBasis = 36, knopBasis = 70, speel = false, xbKnopBasis = 102 } = {}) {
  const systeem = new NepSysteem();
  const poorten = { apc: sluitApcAan(systeem), lpd8: sluitLpd8Aan(systeem, padBasis, knopBasis), xboard: null };
  const hid = speel ? new NepHidSysteem() : null;
  const maschine = hid ? nepMaschine(hid) : null;
  if (hid) hid.bijOpen = (p) => later(() => p.injecteer(rustFrame()));
  if (speel) poorten.xboard = systeem.voegToe(XBOARD_NAAM, { uitgang: false });
  const xb = (/** @type {number[][]} */ ...b) => later(() => { for (const x of b) poorten.xboard?.injecteer(x); });
  /** @type {((w: any) => boolean)[]} */
  const onderscheppers = [];
  /** TOGGLE: welke pads (nootnummer) nu 'aan' staan. */
  const padAan = new Set();
  /** Een pad indrukken; geeft terug of dat een note-on was. MOMENTARY: altijd note-on. */
  const drukPad = (n) => {
    if (lpd8Toggle && padAan.has(n)) { padAan.delete(n); poorten.lpd8.injecteer([0x89, n, 0]); return false; }
    if (lpd8Toggle) padAan.add(n);
    poorten.lpd8.injecteer([0x99, n, 100]);
    return true;
  };
  const gebruiker = new Zender();
  const getoond = [];
  const wachters = [];
  const io = {
    toon: (t) => getoond.push(t),
    regel() { let los; const p = new Promise((r) => { los = r; wachters.push(r); }); return { p, annuleer: () => { const i = wachters.indexOf(los); if (i >= 0) wachters.splice(i, 1); } }; },
  };
  const typ = (r) => later(() => wachters.shift()?.(r));

  gebruiker.bij('verwacht', (w) => {
    if (onderscheppers.some((f) => f(w))) return;
    if (w.soort === 'vraag') return typ(antwoorden[w.stap] ?? 'j');
    if (w.dev === 'xboard49') return xboardDoet(w);
    if (w.dev === 'maschine-mk2') return maschineDoet(w);
    if (w.soort === 'controls') {
      later(() => {
        for (const id of w.ids) {
          if (w.dev === 'apc40') for (const b of apcBerichten(id)) poorten.apc.injecteer(b);
          else {
            const i = +id.slice(1) - 1;
            if (id[0] !== 'p') poorten.lpd8.injecteer([0xb0, knopBasis + i, 64]);
            else if (!drukPad(padBasis + i)) drukPad(padBasis + i); // TOGGLE: de eerste druk zette hem uit, dus nog een keer (zoals een mens)
          }
        }
      });
      return;
    }
    if (w.soort === 'eerste') {
      if (w.akkoord) return later(() => { for (const b of akkoordBerichten(w.akkoord)) poorten.apc.injecteer(b); });
      if (w.pad) {
        if (w.loslaten) return; // het loslaten is al gepland bij het indrukken
        const n = padBasis - 1 + w.pad;
        const los = () => { if (!lpd8Toggle) poorten.lpd8.injecteer([0x89, n, 0]); };
        return later(() => {
          if (!drukPad(n)) return; // TOGGLE en de pad stond aan: deze druk was een note-off
          if (!w.houdMs) return los(); // kort tikken: los in dezelfde tik
          setTimeout(() => poorten.lpd8.injecteer([0xa9, n, 60]), (w.houdMs * schaal) / 2); // mk2: aftertouch tijdens vasthouden
          setTimeout(los, w.houdMs * schaal);
        });
      }
      if (w.wat) return later(() => { if (w.wat === 'pad') drukPad(padBasis - 1 + w.nr); else poorten.lpd8.injecteer([0xb0, knopBasis - 1 + w.nr, 64]); });
      if (w.id) return later(() => { for (const b of apcBerichten(w.id, w)) poorten.apc.injecteer(b); });
      return; // identiteit/intro: het nep-apparaat antwoordt zelf
    }
    if (w.soort === 'melding' && w.dev === 'apc40') {
      if (w.wat === 'weg') later(() => systeem.verwijder('APC40 mkII'));
      if (w.wat === 'verbonden') later(() => { poorten.apc = sluitApcAan(systeem); });
    }
    if (w.soort === 'melding' && w.dev === 'lpd8') {
      if (w.wat === 'weg') later(() => systeem.verwijder('LPD8 mk2'));
      if (w.wat === 'verbonden') later(() => { padAan.clear(); poorten.lpd8 = sluitLpd8Aan(systeem, padBasis, knopBasis); });
    }
  });
  /** De Xboard49: wat een mens doet bij elke vraag van de proef speelapparaten. */
  function xboardDoet(w) {
    if (w.soort === 'controls') {
      for (const id of w.ids) {
        if (id === 'buiging') xb([0xe0, 0, 127], [0xe0, 0, 0], [0xe0, 0, 64]);
        else if (id === 'mod') xb([0xb0, 1, 127], [0xb0, 1, 0]);
        else if (id === 'schuif') xb(masterVolume(0), masterVolume(8000), masterVolume(16383));
        else if (/^k\d+$/.test(id)) xb([0xb0, xbKnopBasis + Number(id.slice(1)) - 1, 64]);
      }
      return;
    }
    if (w.soort !== 'eerste') return;
    const noot = (/** @type {number} */ n, /** @type {number} */ v) => xb([0x90, n, v], [0x80, n, 0]);
    if (w.wat === 'laag') return noot(36, 64);
    if (w.wat === 'hoog') return noot(84, 64);
    if (w.wat === 'zacht') return noot(60, 18);
    if (w.wat === 'hard') return noot(60, 122);
    if (w.wat === 'knop') return xb([0xb0, xbKnopBasis + w.nr - 1, 64], [0xb0, xbKnopBasis + w.nr - 1, 70]);
    if (w.wat === 'aftertouch') return xb([0x90, 60, 90], [0xd0, 80], [0xd0, 0], [0x80, 60, 0]);
    if (w.wat === 'pedaal') return w.loslaten ? undefined : xb([0xb0, 64, 127], [0xb0, 64, 0]);
    if (w.wat === 'patch') return xb([0xb0, 0, 0], [0xb0, 32, 1], [0xc0, 5]);
    if (w.wat === 'paniek') return xb(...Array.from({ length: 16 }, (_, ch) => [[0xb0 | ch, 120, 0], [0xb0 | ch, 123, 0]]).flat());
  }

  /** De Maschine MK2. */
  function maschineDoet(w) {
    if (!maschine) return;
    if (w.soort === 'hid-rust') return later(() => maschine.rust(w.n));
    if (w.soort === 'melding') return later(() => { if (w.wat === 'weg') maschine.uittrekken(); else maschine.insteken(); });
    if (w.soort === 'eerste') {
      if (w.plek === 'linksboven') return later(() => maschine.plek(0));
      if (w.plek === 'rechtsonder') return later(() => maschine.plek(15));
      if (w.kracht) return later(() => maschine.pad(6, w.kracht));
      return;
    }
    if (w.soort !== 'controls') return;
    later(() => {
      for (const id of w.ids) {
        if (/^pad\d+$/.test(id)) maschine.pad(Number(id.slice(3)));
        else if (/^enc\d$/.test(id)) { maschine.draai(Number(id.slice(3)) - 1, 40); maschine.draai(Number(id.slice(3)) - 1, -40); }
        else if (id === 'masterwiel') { maschine.wiel(1); maschine.wiel(-1); }
        else maschine.tik(id);
      }
    });
  }

  return { systeem, poorten, hid, maschine, gebruiker, io, getoond, typ, padAan, onderschep: (fn) => onderscheppers.push(fn) };
}
