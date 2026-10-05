// Een opgenomen logboek opnieuw door de ontleders halen (de golden test, test/golden.test.js). Dezelfde ruwe bytes
// moeten dezelfde gebeurtenis geven als toen. Per apparaat de ontleder die de hub nu gebruikt:
//   apc40, lpd8          de sessies (het LPD8-profiel uit de bevinding 'lpd8-profiel')
//   xboard49             het Xboard-profiel (uit de bevinding 'xboard49-profiel', anders de gok)
//   maschine-mk2         een HID-rapport, staatloos gelezen (knoppen, pads)
//   maschine-mk2-midi    de virtuele MIDI die de hub ervan maakte (docs/MASCHINE.md)
import { expect } from 'vitest';
import { leesLogboek } from '../src/core/logboek.js';
import { ApcSessie, Lpd8Sessie, XboardSessie } from '../src/apparaten.js';
import { NepSysteem } from '../src/ports/nep.js';
import { NepKlok } from '../src/core/klok.js';
import * as MS from '../src/devices/maschine-mk2.js';

/** Speel een logboek opnieuw af; geef het aantal getoetste gebeurtenissen en de verschillen terug. @param {string} tekst */
export function herspeel(tekst) {
  const { regels } = leesLogboek(tekst);
  const gemeen = { systeem: new NepSysteem(), klok: new NepKlok(), patroon: /x/ };
  const sessies = { apc40: new ApcSessie({ ...gemeen, dev: 'apc40' }), lpd8: new Lpd8Sessie({ ...gemeen, dev: 'lpd8' }), xboard49: new XboardSessie(gemeen) };
  /** @type {Record<string, (b: number[]) => any>} */
  const ontleders = {
    apc40: (b) => sessies.apc40.ontleed(b),
    lpd8: (b) => sessies.lpd8.ontleed(b),
    xboard49: (b) => sessies.xboard49.ontleed(b),
    'maschine-mk2': (b) => MS.ontleedRapport(b),
    'maschine-mk2-midi': (b) => MS.ontleedMidi(b),
  };
  const verschillen = [];
  let getoetst = 0;
  for (let i = 0; i < regels.length; i++) {
    const r = regels[i];
    if (!Array.isArray(r) && r.e === 'bevinding' && r.id === 'lpd8-profiel') sessies.lpd8.zetProfiel(r.data.profiel);
    if (!Array.isArray(r) && r.e === 'bevinding' && r.id === 'xboard49-profiel' && r.data.compleet !== false) sessies.xboard49.zetProfiel(r.data.profiel);
    if (!Array.isArray(r) || r[1] !== 'in' || !ontleders[r[2]]) continue;
    const volgende = regels[i + 1];
    if (!volgende || volgende.e !== 'gebeurtenis') continue;
    const { ms, e, ...toen } = volgende;
    const nu = JSON.parse(JSON.stringify(ontleders[r[2]](r[3])));
    getoetst++;
    try { expect(nu).toEqual(toen); } catch { verschillen.push({ ms: r[0], dev: r[2], bytes: r[3], toen, nu }); }
  }
  return { getoetst, verschillen };
}
