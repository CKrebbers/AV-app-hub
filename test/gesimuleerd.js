// Gesimuleerde gebruiker + nep-APC40 + nep-LPD8 mk2: doorloopt een proef zonder hardware.
// Luistert naar 'verwacht'-meldingen van de runner en doet wat een mens zou doen.
import { NepSysteem } from '../src/ports/nep.js';
import { Zender } from '../src/core/zender.js';
import * as A from '../src/devices/apc40mk2.js';

const later = (fn) => setTimeout(fn, 1);

export function mk2Dump(prog) {
  const b = [0xf0, 0x47, 0x7f, 0x4c, 0x03, 0x01, 0x29, prog, 0, 0, 0, 0];
  for (let i = 0; i < 8; i++) b.push(36 + i, 12 + i, i, 9, ...Array(12).fill(0));
  for (let i = 0; i < 8; i++) b.push(70 + i, 0, 0, 127);
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
function sluitLpd8Aan(systeem) {
  const p = systeem.voegToe('LPD8 mk2');
  p.antwoord = (b) => {
    if (b[0] === 0xf0 && b[1] === 0x7e) later(() => p.injecteer([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x4c, 0x00, 0x19, 0x00, 0xf7]));
    if (b[0] === 0xf0 && b[3] === 0x4c && b[4] === 0x03) later(() => p.injecteer(mk2Dump(b[7])));
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
 * @param {{ antwoorden?: Record<string, string>, schaal?: number, lpd8Toggle?: boolean }} o
 *   antwoorden per stap-id (standaard "j"); schaal: dezelfde als de runner (vasthouden duurt houdMs·schaal);
 *   lpd8Toggle: de LPD8-pads staan in TOGGLE-modus (geen note-off bij loslaten)
 */
export function simulatie({ antwoorden = {}, schaal = 0.01, lpd8Toggle = false } = {}) {
  const systeem = new NepSysteem();
  const poorten = { apc: sluitApcAan(systeem), lpd8: sluitLpd8Aan(systeem) };
  const gebruiker = new Zender();
  const getoond = [];
  const wachters = [];
  const io = {
    toon: (t) => getoond.push(t),
    regel() { let los; const p = new Promise((r) => { los = r; wachters.push(r); }); return { p, annuleer: () => { const i = wachters.indexOf(los); if (i >= 0) wachters.splice(i, 1); } }; },
  };
  const typ = (r) => later(() => wachters.shift()?.(r));

  gebruiker.bij('verwacht', (w) => {
    if (w.soort === 'vraag') return typ(antwoorden[w.stap] ?? 'j');
    if (w.soort === 'controls') {
      later(() => {
        for (const id of w.ids) {
          if (w.dev === 'apc40') for (const b of apcBerichten(id)) poorten.apc.injecteer(b);
          else { const i = +id.slice(1) - 1; poorten.lpd8.injecteer(id[0] === 'p' ? [0x99, 36 + i, 100] : [0xb0, 70 + i, 64]); }
        }
      });
      return;
    }
    if (w.soort === 'eerste') {
      if (w.akkoord) return later(() => { for (const b of akkoordBerichten(w.akkoord)) poorten.apc.injecteer(b); });
      if (w.pad) {
        if (w.loslaten) return; // het loslaten is al gepland bij het indrukken
        const n = 35 + w.pad;
        const los = () => { if (!lpd8Toggle) poorten.lpd8.injecteer([0x89, n, 0]); };
        return later(() => {
          poorten.lpd8.injecteer([0x99, n, 100]);
          if (!w.houdMs) return los(); // kort tikken: los in dezelfde tik
          setTimeout(() => poorten.lpd8.injecteer([0xa9, n, 60]), (w.houdMs * schaal) / 2); // mk2: aftertouch tijdens vasthouden
          setTimeout(los, w.houdMs * schaal);
        });
      }
      if (w.wat) return later(() => poorten.lpd8.injecteer(w.wat === 'pad' ? [0x99, 35 + w.nr, 100] : [0xb0, 69 + w.nr, 64]));
      if (w.id) return later(() => { for (const b of apcBerichten(w.id, w)) poorten.apc.injecteer(b); });
      return; // identiteit/intro: het nep-apparaat antwoordt zelf
    }
    if (w.soort === 'melding' && w.dev === 'apc40') {
      if (w.wat === 'weg') later(() => systeem.verwijder('APC40 mkII'));
      if (w.wat === 'verbonden') later(() => { poorten.apc = sluitApcAan(systeem); });
    }
    if (w.soort === 'melding' && w.dev === 'lpd8') {
      if (w.wat === 'weg') later(() => systeem.verwijder('LPD8 mk2'));
      if (w.wat === 'verbonden') later(() => { poorten.lpd8 = sluitLpd8Aan(systeem); });
    }
  });
  return { systeem, poorten, gebruiker, io, getoond, typ };
}
