// @ts-check
// APC40 mkII: indeling, MIDI-nummers, invoer ontleden en LED-berichten maken.
// Bron: Akai APC40 Mk2 Communications Protocol v1.2 (jan 2015).
// Control-ids zijn die van av-kern (src/kern/apc40.ts), zodat er één naamgeving is —
// met één correctie: volgens het protocol is RIGHT = 0x60 (96) en LEFT = 0x61 (97).
// Grid: pad{rij}-{kolom}, rij 1 = ONDERSTE rij (note 0-7), rij 5 = bovenste (note 32-39).

/**
 * @typedef {'pad'|'scene'|'knop'|'fader'|'draai'|'rel'|'voet'} Soort
 * @typedef {'rgb'|'aan'|'clipstop'|'ab'|'ring'|'geen'} LedSoort
 * @typedef {{ id: string, soort: Soort, t: 'note'|'cc', n: number, ch: number, led: LedSoort, label: string }} Control
 * @typedef {{ dev: 'apc40', el: string|null, kind: 'druk'|'los'|'waarde'|'delta'|'intro-antwoord'|'identiteit'|'onbekend',
 *             v?: number, raw?: number, delta?: number, bytes?: number[] }} Gebeurtenis
 * @typedef {{ kleur?: number, anim?: { soort: 'oneshot'|'puls'|'knipper', snelheid?: number, kleur2?: number },
 *             aan?: boolean, knipper?: boolean, stand?: 0|1|2, waarde?: number }} LedStaat
 */

export const NAAM = 'APC40 mkII';
export const MODUS = Object.freeze({ generiek: 0x40, ableton: 0x41, alternatief: 0x42 });

/** Introductie: zet de modus. In 0x42 tekent de host álle LEDs, ook de ringen. */
export const intro = (modus = MODUS.alternatief) => [0xf0, 0x47, 0x7f, 0x29, 0x60, 0x00, 0x04, modus, 0x00, 0x00, 0x00, 0xf7];
export const IDENTITEIT_VRAAG = Object.freeze([0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7]);

/** @type {Control[]} */
export const CONTROLS = [];
/** @param {string} id @param {Soort} soort @param {'note'|'cc'} t @param {number} n @param {number} ch @param {LedSoort} led @param {string} label */
const K = (id, soort, t, n, ch, led, label) => { CONTROLS.push(Object.freeze({ id, soort, t, n, ch, led, label })); };

for (let r = 1; r <= 5; r++) for (let c = 1; c <= 8; c++) K(`pad${r}-${c}`, 'pad', 'note', (r - 1) * 8 + (c - 1), 0, 'rgb', `pad ${r}·${c}`);
for (let r = 1; r <= 5; r++) K(`scene${r}`, 'scene', 'note', 81 + r, 0, 'rgb', `scene ${r}`);
for (let c = 1; c <= 8; c++) {
  K(`rec${c}`, 'knop', 'note', 48, c - 1, 'aan', `rec arm ${c}`);
  K(`solo${c}`, 'knop', 'note', 49, c - 1, 'aan', `solo ${c}`);
  K(`act${c}`, 'knop', 'note', 50, c - 1, 'aan', `activator ${c}`);
  K(`sel${c}`, 'knop', 'note', 51, c - 1, 'aan', `track select ${c}`);
  K(`stop${c}`, 'knop', 'note', 52, c - 1, 'clipstop', `clip stop ${c}`);
  K(`ab${c}`, 'knop', 'note', 66, c - 1, 'ab', `A|B ${c}`);
  K(`fader${c}`, 'fader', 'cc', 7, c - 1, 'geen', `fader ${c}`);
  K(`dk${c}`, 'draai', 'cc', 15 + c, 0, 'ring', `device knop ${c}`);
  K(`tk${c}`, 'draai', 'cc', 47 + c, 0, 'ring', `track knop ${c}`);
}
/** @type {[string, Soort, 'note'|'cc', number, LedSoort, string][]} */
const LOS = [
  ['devL', 'knop', 'note', 58, 'aan', '◄ device'], ['devR', 'knop', 'note', 59, 'aan', 'device ►'],
  ['bankL', 'knop', 'note', 60, 'aan', '◄ bank'], ['bankR', 'knop', 'note', 61, 'aan', 'bank ►'],
  ['devOn', 'knop', 'note', 62, 'aan', 'device on/off'], ['lock', 'knop', 'note', 63, 'aan', 'device lock'],
  ['clipdev', 'knop', 'note', 64, 'aan', 'clip/device view'], ['detail', 'knop', 'note', 65, 'aan', 'detail view'],
  ['mastersel', 'knop', 'note', 80, 'aan', 'master'], ['stopall', 'knop', 'note', 81, 'geen', 'stop all clips'],
  ['pan', 'knop', 'note', 87, 'aan', 'pan'], ['sends', 'knop', 'note', 88, 'aan', 'sends'], ['user', 'knop', 'note', 89, 'aan', 'user'],
  ['metro', 'knop', 'note', 90, 'aan', 'metronome'], ['play', 'knop', 'note', 91, 'aan', 'play'],
  ['record', 'knop', 'note', 93, 'aan', 'record'],
  ['up', 'knop', 'note', 94, 'geen', '▲'], ['down', 'knop', 'note', 95, 'geen', '▼'],
  ['right', 'knop', 'note', 96, 'geen', '►'], ['left', 'knop', 'note', 97, 'geen', '◄'],
  ['shift', 'knop', 'note', 98, 'geen', 'shift'], ['tap', 'knop', 'note', 99, 'geen', 'tap tempo'],
  ['nudgeM', 'knop', 'note', 100, 'geen', 'nudge −'], ['nudgeP', 'knop', 'note', 101, 'geen', 'nudge +'],
  ['session', 'knop', 'note', 102, 'aan', 'session record'], ['bank', 'knop', 'note', 103, 'geen', 'bank'],
  ['master', 'fader', 'cc', 14, 'geen', 'master fader'], ['xf', 'fader', 'cc', 15, 'geen', 'crossfader'],
  ['tempo', 'rel', 'cc', 13, 'geen', 'tempo'], ['cue', 'rel', 'cc', 47, 'geen', 'cue level'],
  ['voet', 'voet', 'cc', 64, 'geen', 'footswitch'],
];
for (const [id, soort, t, n, led, label] of LOS) K(id, soort, t, n, 0, led, label);
Object.freeze(CONTROLS);

/** @type {Map<string, Control>} */
export const OP_ID = new Map(CONTROLS.map((c) => [c.id, c]));
const OP_MIDI = new Map(CONTROLS.map((c) => [`${c.t}:${c.n}:${c.ch}`, c]));

/** @param {number} rij 1 = onder @param {number} kolom 1..8 */
export const padId = (rij, kolom) => `pad${rij}-${kolom}`;

/** @param {number} n @param {number} ch */
export function vindNoot(n, ch) {
  // Grid en scènes komen altijd binnen op kanaal 0; strip-knoppen dragen de track in het kanaal.
  return OP_MIDI.get(`note:${n}:${ch}`) || OP_MIDI.get(`note:${n}:0`) || null;
}
/** @param {number} n @param {number} ch */
export const vindCC = (n, ch) => OP_MIDI.get(`cc:${n}:${ch}`) || null;

/** Two's complement: 1..63 = +n, 127..64 = −1..−64 (tempo en cue level). @param {number} raw */
export const relatief = (raw) => (raw >= 64 ? raw - 128 : raw);

/**
 * Eén binnenkomend MIDI-bericht → gebeurtenis. Onbekende berichten krijgen el = null.
 * @param {number[]} b
 * @returns {Gebeurtenis}
 */
export function ontleed(b) {
  const st = b[0] & 0xf0, ch = b[0] & 0x0f;
  if (b[0] === 0xf0) {
    if (b[1] === 0x47 && b[3] === 0x29 && b[4] === 0x61) return { dev: 'apc40', el: null, kind: 'intro-antwoord', bytes: [...b] };
    if (b[1] === 0x7e && b[3] === 0x06 && b[4] === 0x02) return { dev: 'apc40', el: null, kind: 'identiteit', bytes: [...b] };
    return { dev: 'apc40', el: null, kind: 'onbekend', bytes: [...b] };
  }
  if (st === 0x90 || st === 0x80) {
    const c = vindNoot(b[1], ch);
    const druk = st === 0x90 && b[2] > 0;
    return { dev: 'apc40', el: c ? c.id : null, kind: druk ? 'druk' : 'los', v: druk ? 1 : 0, raw: b[2], ...(c ? {} : { bytes: [...b] }) };
  }
  if (st === 0xb0) {
    const c = vindCC(b[1], ch);
    if (!c) return { dev: 'apc40', el: null, kind: 'onbekend', bytes: [...b] };
    if (c.soort === 'rel') return { dev: 'apc40', el: c.id, kind: 'delta', delta: relatief(b[2]), raw: b[2] };
    if (c.soort === 'voet') return { dev: 'apc40', el: c.id, kind: b[2] >= 64 ? 'druk' : 'los', v: b[2] >= 64 ? 1 : 0, raw: b[2] };
    return { dev: 'apc40', el: c.id, kind: 'waarde', v: b[2] / 127, raw: b[2] };
  }
  return { dev: 'apc40', el: null, kind: 'onbekend', bytes: [...b] };
}

const ANIM_BASIS = { oneshot: 1, puls: 6, knipper: 11 };
const NOOT_UIT = (/** @type {number} */ ch, /** @type {number} */ n) => [0x80 | ch, n, 0];

/**
 * LED-berichten voor één control. Geeft [] voor controls zonder LED.
 * rgb:      { kleur 0..127, anim?: { soort, snelheid 0..4 (1/24..1/2), kleur2? } }
 *           Met kleur2: eerst kleur op kanaal 0, dan kleur2 op het animatiekanaal (zoals Ableton).
 *           Zonder kleur2: alleen kleur op het animatiekanaal (zoals Varve DJ).
 * aan:      { aan }            clipstop: { aan, knipper }      ab: { stand 0 uit | 1 geel | 2 oranje }
 * ring:     { waarde 0..1 }    (schrijft ook de interne knopwaarde, protocol "Controller Value Update")
 * @param {Control} c @param {LedStaat} s
 * @returns {number[][]}
 */
export function ledBerichten(c, s) {
  switch (c.led) {
    case 'rgb': {
      const kleur = klem(s.kleur ?? 0);
      if (!kleur && !s.anim) return [NOOT_UIT(0, c.n)];
      if (!s.anim) return [[0x90, c.n, kleur]];
      const ch = ANIM_BASIS[s.anim.soort] + Math.max(0, Math.min(4, s.anim.snelheid ?? 3));
      if (s.anim.kleur2 === undefined) return [[0x90 | ch, c.n, kleur]];
      return [[0x90, c.n, kleur], [0x90 | ch, c.n, klem(s.anim.kleur2)]];
    }
    case 'aan': return [s.aan ? [0x90 | c.ch, c.n, 127] : NOOT_UIT(c.ch, c.n)];
    case 'clipstop': return [s.knipper ? [0x90 | c.ch, c.n, 2] : s.aan ? [0x90 | c.ch, c.n, 1] : NOOT_UIT(c.ch, c.n)];
    case 'ab': return [s.stand ? [0x90 | c.ch, c.n, s.stand] : NOOT_UIT(c.ch, c.n)];
    case 'ring': return [[0xb0 | c.ch, c.n, Math.round(Math.max(0, Math.min(1, s.waarde ?? 0)) * 127)]];
    default: return [];
  }
}

export const RING = Object.freeze({ uit: 0, single: 1, volume: 2, pan: 3 });
/** Ring-type voor alle 16 ringknoppen (CC 24-31 en 56-63). @param {number} type */
export const ringTypeBerichten = (type = RING.single) => CONTROLS.filter((c) => c.led === 'ring').map((c) => [0xb0, c.n + 8, type]);

/** Alle controls met een LED, voor zwart maken en volledige repaint. */
export const MET_LED = Object.freeze(CONTROLS.filter((c) => c.led !== 'geen'));

/** @param {number} v */
const klem = (v) => Math.max(0, Math.min(127, Math.round(v)));

// 128 kleuren: velocity → RGB, uit protocol v1.2 pagina 18-22.
export const PALET = Object.freeze([
  '#000000', '#1e1e1e', '#7f7f7f', '#ffffff', '#ff4c4c', '#ff0000', '#590000', '#190000',
  '#ffbd6c', '#ff5400', '#591d00', '#271b00', '#ffff4c', '#ffff00', '#595900', '#191900',
  '#88ff4c', '#54ff00', '#1d5900', '#142b00', '#4cff4c', '#00ff00', '#005900', '#001900',
  '#4cff5e', '#00ff19', '#00590d', '#001902', '#4cff88', '#00ff55', '#00591d', '#001f12',
  '#4cffb7', '#00ff99', '#005935', '#001912', '#4cc3ff', '#00a9ff', '#004152', '#001019',
  '#4c88ff', '#0055ff', '#001d59', '#000819', '#4c4cff', '#0000ff', '#000059', '#000019',
  '#874cff', '#5400ff', '#190064', '#0f0030', '#ff4cff', '#ff00ff', '#590059', '#190019',
  '#ff4c87', '#ff0054', '#59001d', '#220013', '#ff1500', '#993500', '#795100', '#436400',
  '#033900', '#005735', '#00547f', '#0000ff', '#00454f', '#2500cc', '#7f7f7f', '#202020',
  '#ff0000', '#bdff2d', '#afed06', '#64ff09', '#108b00', '#00ff87', '#00a9ff', '#002aff',
  '#3f00ff', '#7a00ff', '#b21a7d', '#402100', '#ff4a00', '#88e106', '#72ff15', '#00ff00',
  '#3bff26', '#59ff71', '#38ffcc', '#5b8aff', '#3151c6', '#877fe9', '#d31dff', '#ff005d',
  '#ff7f00', '#b9b000', '#90ff00', '#835d07', '#392b00', '#144c10', '#0d5038', '#15152a',
  '#16205a', '#693c1c', '#a8000a', '#de513d', '#d86a1c', '#ffe126', '#9ee12f', '#67b50f',
  '#1e1e30', '#dcff6b', '#80ffbd', '#9a99ff', '#8e66ff', '#404040', '#757575', '#e0ffff',
  '#a00000', '#350000', '#1ad000', '#074200', '#b9b000', '#3f3100', '#b35f00', '#4b1502',
]);

/** Dichtstbijzijnde paletindex (1..127, nooit "uit") voor een hexkleur. @param {string} hex */
export function dichtsteKleur(hex) {
  const [r, g, b] = rgb(hex);
  let beste = 1, afstand = Infinity;
  for (let i = 1; i < 128; i++) {
    const [r2, g2, b2] = rgb(PALET[i]);
    const d = (r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2;
    if (d < afstand) { afstand = d; beste = i; }
  }
  return beste;
}
/** @param {string} hex @returns {[number, number, number]} */
export const rgb = (hex) => { const n = parseInt(hex.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
