// @ts-check
// Akai LPD8 (mk1) en LPD8 mk2: model herkennen, programma's uitlezen, invoer ontleden.
// De pads en knoppen sturen wat het actieve programma zegt; dat verschilt per toestel.
// Daarom werkt de hub met een PROFIEL: welke noot/CC is pad 1..8 en knop 1..8.
// Een profiel komt uit (1) de proef "leren" (betrouwbaarst), (2) een programma-dump,
// of (3) de fabrieksstandaard van het model.
//
// Bronnen (community, niet officieel — de proef controleert dit):
//   mk1: https://github.com/bennigraf/lpd8-web-editor/blob/main/lpd8-protocol.md
//   mk2: https://github.com/stephensrmmartin/lpd8mk2 · https://github.com/nimblemachines/akai-lpd8

/**
 * @typedef {'mk1'|'mk2'} Model
 * @typedef {{ t: 'note'|'cc'|'pc', n: number, ch?: number }} PadBron
 * @typedef {{ n: number, ch?: number }} KnopBron
 * @typedef {{ model?: Model|null, bron: string, pads: PadBron[], knoppen: KnopBron[] }} Profiel
 * @typedef {{ dev: 'lpd8', el: string|null, kind: 'druk'|'los'|'waarde'|'onbekend', v?: number, raw?: number, bytes?: number[] }} Gebeurtenis
 */

export const MODEL_ID = Object.freeze({ mk1: 0x75, mk2: 0x4c });
export const IDENTITEIT_VRAAG = Object.freeze([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);

/**
 * Model uit een SysEx-bericht (identiteitsantwoord of programma-dump). Null als onbekend.
 * @param {number[]} b
 * @returns {Model|null}
 */
export function modelUit(b) {
  if (b[0] !== 0xf0) return null;
  // Identiteitsantwoord: F0 7E <dev> 06 02 47 <familie...>
  if (b[1] === 0x7e && b[3] === 0x06 && b[4] === 0x02 && b[5] === 0x47) return modelVanId(b[6]);
  // Akai-SysEx: F0 47 7F <model> ...
  if (b[1] === 0x47) return modelVanId(b[3]);
  return null;
}
/** @param {number} id */
const modelVanId = (id) => (id === MODEL_ID.mk1 ? 'mk1' : id === MODEL_ID.mk2 ? 'mk2' : null);

/**
 * Vraag om programma p. mk1: 1..4. mk2: 0 (RAM) .. 4.
 * @param {Model} model @param {number} p
 */
export const vraagProgramma = (model, p) =>
  model === 'mk1' ? [0xf0, 0x47, 0x7f, 0x75, 0x63, 0x00, 0x01, p, 0xf7] : [0xf0, 0x47, 0x7f, 0x4c, 0x03, 0x00, 0x01, p, 0xf7];

/**
 * Programma-dump ontleden. Bij een onverwachte lengte: { fout } met de ruwe bytes,
 * zodat de proef het vastlegt en we de parser kunnen corrigeren.
 * @param {number[]} b
 */
export function ontleedProgramma(b) {
  const model = modelUit(b);
  if (!model) return null;
  if (model === 'mk1') {
    // F0 47 7F 75 63 00 3A <prog> <kanaal> 8×[note, pc, cc, toggle] 8×[cc, laag, hoog] F7
    if (b[4] !== 0x63 && b[4] !== 0x61) return null;
    if (b.length !== 66) return { model, fout: `lengte ${b.length}, verwacht 66`, bytes: [...b] };
    const prog = b[7], ch = b[8];
    const pads = [], knoppen = [];
    for (let i = 0; i < 8; i++) {
      const o = 9 + i * 4;
      pads.push({ note: b[o], pc: b[o + 1], cc: b[o + 2], toggle: b[o + 3] === 1 });
    }
    for (let i = 0; i < 8; i++) {
      const o = 41 + i * 3;
      knoppen.push({ cc: b[o], min: b[o + 1], max: b[o + 2] });
    }
    return { model, prog, kanaal: ch, pads, knoppen };
  }
  // mk2: F0 47 7F 4C 03 01 29 <prog> <kanaal> <druk> <vol niveau> <toggle> 8×16 pad-bytes 8×4 knop-bytes F7
  if (b[4] !== 0x03 && b[4] !== 0x01) return null;
  if (b.length !== 173) return { model, fout: `lengte ${b.length}, verwacht 173`, bytes: [...b] };
  const prog = b[7], ch = b[8];
  const pads = [], knoppen = [];
  for (let i = 0; i < 8; i++) {
    const o = 12 + i * 16;
    pads.push({ note: b[o], cc: b[o + 1], pc: b[o + 2], kanaal: b[o + 3] });
  }
  for (let i = 0; i < 8; i++) {
    const o = 140 + i * 4;
    knoppen.push({ cc: b[o], kanaal: b[o + 1], min: b[o + 2], max: b[o + 3] });
  }
  return { model, prog, kanaal: ch, druk: b[9], toggle: b[11] === 1, pads, knoppen };
}

/**
 * Fabrieksstandaard. mk2 volgens community-dumps; mk1 is NIET geverifieerd (noten 36-43,
 * CC 1-8 zijn een gok) — leren in de proef heeft altijd voorrang.
 * @param {Model|null|undefined} model
 * @returns {Profiel}
 */
export function standaardProfiel(model) {
  const pads = Array.from({ length: 8 }, (_, i) => /** @type {PadBron} */ ({ t: 'note', n: 36 + i }));
  if (model === 'mk2') return { model, bron: 'fabriek-mk2', pads, knoppen: Array.from({ length: 8 }, (_, i) => ({ n: 70 + i })) };
  return { model: model ?? null, bron: 'gok', pads, knoppen: Array.from({ length: 8 }, (_, i) => ({ n: 1 + i })) };
}

/**
 * Profiel uit een ontlede programma-dump: pads in NOTE-modus (de stand die de hub verwacht).
 * @param {ReturnType<typeof ontleedProgramma>} p
 * @returns {Profiel|null}
 */
export function profielUitProgramma(p) {
  if (!p || 'fout' in p) return null;
  return {
    model: p.model, bron: `programma-${p.prog}`,
    pads: p.pads.map((x) => ({ t: 'note', n: x.note })),
    knoppen: p.knoppen.map((x) => ({ n: x.cc })),
  };
}

/**
 * Een geleerd bericht → bron voor een pad of knop. Null als het geen bruikbare "druk" is.
 * @param {number[]} b
 * @returns {PadBron|null}
 */
export function bronUitBericht(b) {
  const st = b[0] & 0xf0, ch = b[0] & 0x0f;
  if (st === 0x90 && b[2] > 0) return { t: 'note', n: b[1], ch };
  if (st === 0xb0) return { t: 'cc', n: b[1], ch };
  if (st === 0xc0) return { t: 'pc', n: b[1], ch };
  return null;
}

/**
 * Maak een ontleder voor een profiel. Kanaal telt alleen als het profiel er een noemt.
 * Pads in CC-modus: waarde > 0 = druk, 0 = los. PC-modus: alleen druk.
 * @param {Profiel} profiel
 * @returns {(b: number[]) => Gebeurtenis}
 */
export function maakOntleder(profiel) {
  /** @param {{ch?: number}} x @param {number} ch */
  const kanaalOk = (x, ch) => x.ch === undefined || x.ch === ch;
  return (b) => {
    const st = b[0] & 0xf0, ch = b[0] & 0x0f;
    if (st === 0x90 || st === 0x80) {
      const i = profiel.pads.findIndex((p) => p.t === 'note' && p.n === b[1] && kanaalOk(p, ch));
      if (i < 0) return { dev: 'lpd8', el: null, kind: 'onbekend', bytes: [...b] };
      const druk = st === 0x90 && b[2] > 0;
      return { dev: 'lpd8', el: `p${i + 1}`, kind: druk ? 'druk' : 'los', v: druk ? b[2] / 127 : 0, raw: b[2] };
    }
    if (st === 0xb0) {
      const k = profiel.knoppen.findIndex((x) => x.n === b[1] && kanaalOk(x, ch));
      if (k >= 0) return { dev: 'lpd8', el: `k${k + 1}`, kind: 'waarde', v: b[2] / 127, raw: b[2] };
      const i = profiel.pads.findIndex((p) => p.t === 'cc' && p.n === b[1] && kanaalOk(p, ch));
      if (i >= 0) return { dev: 'lpd8', el: `p${i + 1}`, kind: b[2] > 0 ? 'druk' : 'los', v: b[2] / 127, raw: b[2] };
    }
    if (st === 0xc0) {
      const i = profiel.pads.findIndex((p) => p.t === 'pc' && p.n === b[1] && kanaalOk(p, ch));
      if (i >= 0) return { dev: 'lpd8', el: `p${i + 1}`, kind: 'druk', v: 1 };
    }
    return { dev: 'lpd8', el: null, kind: 'onbekend', bytes: [...b] };
  };
}

/** Pad-LED aan/uit via de noot van het profiel (werkt op mk1; op mk2 waarschijnlijk niet). @param {PadBron} p @param {boolean} aan */
export const padLed = (p, aan) => (p.t === 'note' ? [aan ? 0x90 | (p.ch ?? 0) : 0x80 | (p.ch ?? 0), p.n, aan ? 127 : 0] : null);
