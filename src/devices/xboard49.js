// @ts-check
// E-MU Xboard49: MIDI-keyboard, class-compliant op de Mac (geen driver). Alleen invoer: het keyboard ontvangt niets
// (geen lampjes, geen scherm). Puur: herkennen op naam (patroon uit config.json) en invoer ontleden.
//
// Wat het stuurt (handleiding E-MU; de proef "speelapparaten" meet het op Clay's toestel):
//   noten met velocity · kanaal-aftertouch (aan/uit in het keyboard) · pitchbend · CC1 (modulatie) · CC64 (pedaal)
//   bank select (CC0/CC32) + programmawissel · paniek (beide octaafknoppen): CC120/CC123 op alle 16 kanalen
//   16 toewijsbare knoppen (CC of NRPN; de fabrieks-CC's zijn ONBEKEND, Ardour neemt 21–28 en 31–38 aan: dat is de
//   gok tot de proef ze leert) · de schuif: SysEx Master Volume F0 7F <dev> 04 01 ll mm F7.
// De hub geeft de bytes ongewijzigd door aan de lease-app (PROTOCOL §17); dit profiel geeft ze alleen een naam
// (logboek, cockpit, proef, golden test).

/**
 * @typedef {{ n: number, ch?: number }} KnopBron
 * @typedef {{ bron: string, knoppen: KnopBron[], nrpn?: boolean }} Profiel
 * @typedef {{ dev: 'xboard49', el: string|null, kind: 'druk'|'los'|'waarde'|'keuze'|'paniek'|'onbekend', v?: number, raw?: number,
 *             noot?: number, ch?: number, cc?: number, bytes?: number[] }} Gebeurtenis
 */

export const NAAM = 'E-MU Xboard49';
export const AANTAL_KNOPPEN = 16;
/** CC's met een vaste betekenis: die leert de proef nooit als knop. */
export const VASTE_CC = Object.freeze({ mod: 1, sustain: 64, bankMsb: 0, bankLsb: 32, geluidUit: 120, notenUit: 123 });
/** NRPN/RPN-kiezers en data entry: een knop in NRPN-modus stuurt deze. */
export const NRPN_CC = Object.freeze([99, 98, 101, 100, 6, 38, 96, 97]);

/**
 * Het naampatroon van de poort uit config.json (`apparaten.xboard49.naam`, een stukje van de poortnaam), of null
 * zonder die sleutel: dan doet de Xboard niet mee. De hub opent alleen de ingang (`zoekIngang`, src/ports/poort.js).
 * @param {any} config
 */
export function patroon(config) {
  const n = config?.apparaten?.xboard49?.naam;
  return typeof n === 'string' && n.trim() ? new RegExp(n, 'i') : null;
}

/** Tot de proef ze leert: wat Ardour aanneemt (knop 1–8 = CC 21–28, 9–16 = CC 31–38). @returns {Profiel} */
export function standaardProfiel() {
  return { bron: 'gok', knoppen: [...Array.from({ length: 8 }, (_, i) => ({ n: 21 + i })), ...Array.from({ length: 8 }, (_, i) => ({ n: 31 + i }))] };
}

/** SysEx Master Volume (Universal Real Time): F0 7F <dev> 04 01 ll mm F7. @param {ArrayLike<number>} b */
export const isMasterVolume = (b) => b.length === 8 && b[0] === 0xf0 && b[1] === 0x7f && b[3] === 0x04 && b[4] === 0x01 && b[7] === 0xf7;

/**
 * Een bericht tijdens het leren van een knop → bron, of null als het geen knop kan zijn (noten, de vaste CC's).
 * Een NRPN-kiezer (CC 98/99/100/101) geeft `{ nrpn: true }`: dan staat de knop in NRPN-modus.
 * @param {number[]} b @returns {(KnopBron & { nrpn?: boolean })|null}
 */
export function knopUitBericht(b) {
  if ((b[0] & 0xf0) !== 0xb0) return null;
  const ch = b[0] & 0x0f;
  if (Object.values(VASTE_CC).includes(b[1])) return null;
  if (NRPN_CC.includes(b[1])) return { n: b[1], ch, nrpn: true };
  return { n: b[1], ch };
}

/**
 * Ontleder voor een profiel. Kanaal telt alleen als het profiel er een noemt.
 * @param {Profiel} profiel @returns {(b: number[]) => Gebeurtenis}
 */
export function maakOntleder(profiel) {
  const knoppen = profiel?.knoppen ?? [];
  return (b) => {
    const st = b[0] & 0xf0, ch = b[0] & 0x0f;
    if (isMasterVolume(b)) {
      const raw = (b[6] << 7) | b[5];
      return { dev: 'xboard49', el: 'schuif', kind: 'waarde', v: raw / 16383, raw };
    }
    if (st === 0x90 || st === 0x80) {
      const druk = st === 0x90 && b[2] > 0;
      return { dev: 'xboard49', el: 'noot', kind: druk ? 'druk' : 'los', noot: b[1], ch, v: druk ? b[2] / 127 : 0, raw: b[2] };
    }
    if (st === 0xd0) return { dev: 'xboard49', el: 'aftertouch', kind: 'waarde', ch, v: b[1] / 127, raw: b[1] };
    if (st === 0xa0) return { dev: 'xboard49', el: 'polydruk', kind: 'waarde', noot: b[1], ch, v: b[2] / 127, raw: b[2] };
    if (st === 0xe0) {
      const raw = (b[2] << 7) | b[1];
      return { dev: 'xboard49', el: 'buiging', kind: 'waarde', ch, v: raw / 16383, raw };
    }
    if (st === 0xc0) return { dev: 'xboard49', el: 'programma', kind: 'keuze', ch, raw: b[1] };
    if (st === 0xb0) {
      const cc = b[1], w = b[2];
      if (cc === VASTE_CC.mod) return { dev: 'xboard49', el: 'mod', kind: 'waarde', ch, v: w / 127, raw: w };
      if (cc === VASTE_CC.sustain) return { dev: 'xboard49', el: 'sustain', kind: w >= 64 ? 'druk' : 'los', ch, v: w >= 64 ? 1 : 0, raw: w };
      if (cc === VASTE_CC.bankMsb || cc === VASTE_CC.bankLsb) return { dev: 'xboard49', el: 'bank', kind: 'keuze', ch, cc, raw: w };
      if (cc === VASTE_CC.geluidUit || cc === VASTE_CC.notenUit) return { dev: 'xboard49', el: 'paniek', kind: 'paniek', ch, cc, raw: w };
      const k = knoppen.findIndex((x) => x.n === cc && (x.ch === undefined || x.ch === ch));
      if (k >= 0) return { dev: 'xboard49', el: `k${k + 1}`, kind: 'waarde', ch, v: w / 127, raw: w };
      if (NRPN_CC.includes(cc)) return { dev: 'xboard49', el: 'nrpn', kind: 'waarde', ch, cc, raw: w };
      return { dev: 'xboard49', el: null, kind: 'onbekend', bytes: [...b] };
    }
    return { dev: 'xboard49', el: null, kind: 'onbekend', bytes: [...b] };
  };
}
