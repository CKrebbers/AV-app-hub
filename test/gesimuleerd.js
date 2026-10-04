// Gesimuleerde gebruiker + nep-APC40 + nep-LPD8 mk2: doorloopt een proef zonder hardware.
// Luistert naar 'verwacht'-meldingen van de runner en doet wat een mens zou doen.
import { NepSysteem } from '../src/ports/nep.js';
import { Zender } from '../src/core/zender.js';
import * as A from '../src/devices/apc40mk2.js';

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

/**
 * @param {{ antwoorden?: Record<string, string>, schaal?: number, lpd8Toggle?: boolean, padBasis?: number, knopBasis?: number }} o
 *   antwoorden per stap-id (standaard "j"); schaal: dezelfde als de runner (vasthouden duurt houdMs·schaal);
 *   lpd8Toggle: de LPD8-pads staan in TOGGLE-modus, zoals de echte: elke druk wisselt tussen note-on (aan) en
 *   note-off (uit), loslaten stuurt niets. De stand per pad staat in `padAan` en gaat bij opnieuw aansluiten terug naar uit;
 *   padBasis/knopBasis: noot van pad 1 en CC van knop 1 (standaard de mk2-fabrieksstand 36 en 70).
 * Met `onderschep(fn)` vervangt een test wat de gebruiker doet: geeft fn true terug, dan doet de simulatie niets.
 */
export function simulatie({ antwoorden = {}, schaal = 0.01, lpd8Toggle = false, padBasis = 36, knopBasis = 70 } = {}) {
  const systeem = new NepSysteem();
  const poorten = { apc: sluitApcAan(systeem), lpd8: sluitLpd8Aan(systeem, padBasis, knopBasis) };
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
  return { systeem, poorten, gebruiker, io, getoond, typ, padAan, onderschep: (fn) => onderscheppers.push(fn) };
}
