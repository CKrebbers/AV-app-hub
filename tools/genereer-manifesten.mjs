#!/usr/bin/env node
// @ts-check
// Maakt de statische manifesten van passieve MIDI-apps opnieuw uit hun bronbestanden:
//   apps/av-scene-kit.json  ← av-scene-kit/config.json (+ presets uit td/td_build_hub.py)
//   apps/sediment.json      ← sediment/src/Params.h (+ trigger paniek op CC 123, PANIEK_CC)
// Naam, kleur en MIDI-poort komen uit de config.json van de hub (huisregel 6).
//
//   node tools/genereer-manifesten.mjs [--scene-kit /home/user/av-scene-kit] [--sediment /home/user/sediment] [--uit apps] [--toets]
//   --toets: niets schrijven, alleen controleren dat apps/*.json gelijk is aan wat de bronnen opleveren.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { laadConfig, HUB_MAP } from '../src/config.js';
import { valideerStatisch } from '../src/drivers/index.js';

// ───────────────────────── av-scene-kit (TouchDesigner via "VARVE-HUB TD") ─────────────────────────

/** Rol en hint per knop-naam; wat hier niet staat krijgt geen rol. */
const SCENE_KIT_KNOPPEN = /** @type {Record<string, { naam: string, rol?: string, hint: 'fader'|'knop' }>} */ ({
  feedback: { naam: 'Feedback', hint: 'fader' },
  mix: { naam: 'Mix Blender↔cam', hint: 'fader' },
  glitch: { naam: 'Glitch', hint: 'fader' },
  emission: { naam: 'Emissie', rol: 'macro.intensiteit', hint: 'knop' },
  height: { naam: 'Hoogte', hint: 'knop' },
  orbit: { naam: 'Orbit', rol: 'macro.beweging', hint: 'knop' },
  hue: { naam: 'Kleur', rol: 'macro.kleur', hint: 'knop' },
  master_dim: { naam: 'Master', rol: 'macro.helderheid', hint: 'fader' },
});

/**
 * Presets uit td/td_build_hub.py: [{ naam, knoppen:[8 getallen] }]. Leeg als het niet lukt.
 * @param {string} tekst
 */
export function leesPresets(tekst) {
  const blok = /PRESETS\s*=\s*\[([\s\S]*?)\n\]/.exec(tekst)?.[1] ?? '';
  const uit = [];
  for (const m of blok.matchAll(/\[\s*'([^']+)'\s*,((?:\s*-?[\d.]+\s*,){8})/g)) {
    uit.push({ naam: m[1], knoppen: m[2].split(',').map((x) => x.trim()).filter(Boolean).map(Number) });
  }
  return uit;
}

/**
 * @param {any} kit      av-scene-kit/config.json
 * @param {{ naam: string, kleur?: string, midipoort?: string }} app  config.apps['av-scene-kit'] van de hub
 * @param {{ naam: string, knoppen: number[] }[]} [presets]
 */
export function sceneKitManifest(kit, app, presets = []) {
  const kanaal = Math.max(0, Number(kit.midi?.channel ?? 1) - 1); // config telt 1..16, MIDI-bytes 0..15
  const cc = /** @type {number[]} */ (kit.midi.knob_cc);
  const pads = /** @type {Record<string, number>} */ (kit.midi.pads);
  const basis = presets[0]?.knoppen ?? [];
  /** @type {any[]} */
  const params = [];
  /** @type {Record<string, any>} */
  const map = {};
  /** @type {(string|null)[]} param-id per knop 1..8 (index 0..7) */
  const knopIds = [];
  for (let i = 1; i <= 8; i++) {
    const k = kit.knobs?.[String(i)];
    if (!k || cc[i - 1] === undefined) { knopIds.push(null); continue; }
    const id = String(k.name).toLowerCase().replace(/[^a-z0-9_.-]/g, '_');
    knopIds.push(id);
    const extra = SCENE_KIT_KNOPPEN[id] ?? { naam: k.name, hint: 'knop' };
    params.push({
      id, naam: extra.naam, soort: 'waarde', standaard: basis[i - 1] ?? 0, hint: extra.hint, groep: k.target,
      ...(extra.rol ? { rol: extra.rol } : {}),
    });
    map[id] = { cc: cc[i - 1] };
  }
  const presetNaam = (/** @type {number} */ i) => presets[i - 1]?.naam;
  for (let i = 1; i <= 4; i++) {
    const noot = pads[`preset${i}`];
    if (noot === undefined) continue;
    const id = `preset${i}`;
    params.push({ id, naam: presetNaam(i) ? `Preset ${i} · ${presetNaam(i)}` : `Preset ${i}`, soort: 'trigger', hint: 'pad', groep: 'presets' });
    map[id] = { noot };
  }
  // TD togglet opname en take-log zelf bij elke note-on (td_build_hub.py onOffToOn): dus triggers, geen schakelaars.
  if (pads.record !== undefined) { params.push({ id: 'record', naam: 'Opname aan/uit', soort: 'trigger', hint: 'pad', groep: 'opname' }); map.record = { noot: pads.record }; }
  if (pads.takelog !== undefined) { params.push({ id: 'takelog', naam: 'Take-log aan/uit', soort: 'trigger', hint: 'pad', groep: 'opname' }); map.takelog = { noot: pads.takelog }; }
  // Paniek (LPD8-P1 vasthouden, of Stop All met TD in focus): alleen als de kit er een noot voor heeft
  // (config.json → midi.pads.paniek, docs/VOLGENDE-KOPPELINGEN.md §4.4). TD zet dan zelf knob8 (master-dim)
  // op 0 en houdt hem daar tot de fader 0 kruist; zonder die noot in de kit stuurt de hub hem niet (TD zou
  // hem negeren en de hub zou ten onrechte denken dat de master dicht is).
  const masterId = knopIds[7] ?? null;
  const paniekNoot = pads.paniek;
  if (paniekNoot !== undefined) { params.push({ id: 'paniek', naam: 'Paniek: master dicht', soort: 'trigger', hint: 'pad', groep: 'veilig' }); map.paniek = { noot: paniekNoot }; }
  const scenes = presets.slice(0, 4).map((p) => p.naam.slice(0, 32));
  // Een preset-noot laat TD zelf alle knoppen op de presetwaarden zetten (apply_preset); de driver meldt
  // die waarden dan aan de kern, zodat ringen en pickup TD volgen.
  const presetWaarden = presets.slice(0, 4).map((p, i) => ({
    noot: pads[`preset${i + 1}`],
    waarden: Object.fromEntries(knopIds.map((id, k) => [id, p.knoppen[k]]).filter(([id, v]) => id !== null && Number.isFinite(v))),
  })).filter((p) => p.noot !== undefined);
  // De paniek-noot zet in TD de master op 0: de driver meldt dat aan de kern (zoals een preset), zodat de hub
  // weet dat de master dicht is. Alleen de APC-pickup van master_dim wacht dan op 0; de LPD8-knop K2 houdt (§14)
  // zijn doel van vóór de paniek. TD neemt na een paniek de eerste nieuwe CC van de master meteen over (de patch
  // in koppelingen/av-scene-kit), dus wat de hub daarna stuurt (K2, cockpit, snapshot, fader) volgt TD ook.
  if (paniekNoot !== undefined && masterId !== null) presetWaarden.push({ noot: paniekNoot, waarden: { [masterId]: 0 } });
  return {
    v: 1, app: 'av-scene-kit', naam: app.naam, ...(app.kleur ? { kleur: app.kleur } : {}), truth: 'hub', hb_s: 1, lease: false,
    scenes,
    params,
    driver: {
      soort: 'midi', poort: app.midipoort ?? 'VARVE-HUB TD', kanaal,
      map,
      ...(scenes.length ? { scenes: scenes.map((_, i) => ({ noot: pads[`preset${i + 1}`] })) } : {}),
      ...(presetWaarden.length ? { presets: presetWaarden } : {}),
      _bron: 'tools/genereer-manifesten.mjs ← av-scene-kit/config.json + td/td_build_hub.py (PRESETS)',
    },
  };
}

// ───────────────────────── Sediment (Logic via "VARVE-HUB Logic") ─────────────────────────

/**
 * Vrije CC's: de MIDI-spec noemt 20–31 en 102–119 "ongedefinieerd". Zo botsen we niet met
 * CC 1 (modwiel = filter in Sediment), 7 (volume), 10 (pan), 64 (sustain) of 32–63 (LSB's).
 */
export const SEDIMENT_CC = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115, 116, 117, 118, 119];
export const VERBODEN_CC = [0, 1, 7, 10, 11, 32, 64, 120, 121, 122, 123, 124, 125, 126, 127];
/**
 * De ene bewuste uitzondering op VERBODEN_CC: CC 123 (All Notes Off) is een kanaalmodus-bericht, nooit een
 * parameter, maar wel precies wat een paniek moet doen. Alleen de trigger `paniek` krijgt hem
 * (docs/VOLGENDE-KOPPELINGEN.md §5.4, docs/LOGIC.md). De driver stuurt bij indrukken CC 123 = 127 en bij
 * loslaten CC 123 = 0; All Notes Off kijkt niet naar de waarde, dus beide laten alle noten los. Sediment
 * (juce::Synthesiser) laat ze dan uitklinken met hun eigen Release (standaard 7 s, tot 30 s): geen harde stop.
 */
export const PANIEK_CC = 123;

const EENHEID = /** @type {Record<string, string>} */ ({ Percent: '%', Cents: 'ct', Hz: 'Hz', Seconds: 's', Ms: 'ms', Db: 'dB' });
const SEDIMENT_EXTRA = /** @type {Record<string, { rol?: string, hint?: 'fader'|'knop' }>} */ ({
  cutoff: { rol: 'macro.helderheid', hint: 'fader' },
  motion: { rol: 'macro.beweging', hint: 'fader' },
  air: { hint: 'fader' },
  shimmer: { hint: 'fader' },
  echo_mix: { hint: 'fader' },
  space_mix: { rol: 'macro.ruimte', hint: 'fader' },
  tone: { hint: 'fader' },
  output: { hint: 'fader' },
});

/**
 * De parameterlijst uit Params.h (`specs`).
 * @param {string} tekst
 * @returns {{ id: string, naam: string, label: string, min: number, max: number, standaard: number, centre: number, eenheid: string, groep: string }[]}
 */
export function leesParamsH(tekst) {
  const blok = /specs\s*\{\{([\s\S]*?)\}\};/.exec(tekst)?.[1] ?? '';
  const getal = '(-?[\\d.]+)f?';
  const re = new RegExp(`\\{\\s*"([^"]+)",\\s*"([^"]+)",\\s*"([^"]+)",\\s*${getal},\\s*${getal},\\s*${getal},\\s*${getal},\\s*Unit::(\\w+),\\s*Group::(\\w+)\\s*\\}`, 'g');
  return [...blok.matchAll(re)].map((m) => ({
    id: m[1], naam: m[2], label: m[3], min: +m[4], max: +m[5], standaard: +m[6], centre: +m[7], eenheid: m[8], groep: m[9],
  }));
}

/**
 * JUCE NormalisableRange met setSkewForCentre: wat de host (Logic) als 0..1 ziet.
 * @param {number} v @param {number} min @param {number} max @param {number} centre  (< 0 = lineair)
 */
export function naarGenormaliseerd(v, min, max, centre) {
  const prop = Math.max(0, Math.min(1, (v - min) / (max - min)));
  if (!(centre > 0)) return prop;
  const skew = Math.log(0.5) / Math.log((centre - min) / (max - min));
  return Math.pow(prop, skew);
}

/** camelCase → snake_case (param-ids zijn kleine letters). @param {string} s */
const slang = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const rond = (/** @type {number} */ x, n = 4) => Math.round(x * 10 ** n) / 10 ** n;

/**
 * @param {ReturnType<typeof leesParamsH>} specs
 * @param {{ naam: string, kleur?: string, midipoort?: string }} app  config.apps.sediment van de hub
 */
export function sedimentManifest(specs, app) {
  if (specs.length > SEDIMENT_CC.length) throw new Error(`Sediment heeft ${specs.length} parameters, maar er zijn maar ${SEDIMENT_CC.length} vrije CC's`);
  /** @type {any[]} */
  const params = [];
  /** @type {Record<string, any>} */
  const map = {};
  specs.forEach((s, i) => {
    const id = slang(s.id);
    const pct = s.eenheid === 'Percent';
    const extra = SEDIMENT_EXTRA[id] ?? {};
    params.push({
      id, naam: s.naam, soort: 'waarde', standaard: rond(naarGenormaliseerd(s.standaard, s.min, s.max, s.centre)),
      hint: extra.hint ?? 'knop', groep: s.groep.toLowerCase(), ...(extra.rol ? { rol: extra.rol } : {}),
      eenheid: EENHEID[s.eenheid] ?? s.eenheid, min: pct ? rond(s.min * 100, 2) : s.min, max: pct ? rond(s.max * 100, 2) : s.max,
      ...(s.centre > 0 ? { centre: pct ? rond(s.centre * 100, 2) : s.centre } : {}), // log-schaal: de cockpit toont dan wat Sediment toont
    });
    map[id] = { cc: SEDIMENT_CC[i] };
  });
  // Paniek: buiten SEDIMENT_CC om, op de uitzondering PANIEK_CC (zie boven). Een waarde-parameter komt nooit op een verboden CC.
  for (const [id, d] of Object.entries(map)) if (VERBODEN_CC.includes(d.cc)) throw new Error(`sediment: ${id} op verboden CC ${d.cc}`);
  params.push({ id: 'paniek', naam: 'Paniek: alle noten uit', soort: 'trigger', hint: 'pad', groep: 'veilig' });
  map.paniek = { cc: PANIEK_CC };
  return {
    v: 1, app: 'sediment', naam: app.naam, ...(app.kleur ? { kleur: app.kleur } : {}), truth: 'hub', hb_s: 1, lease: false,
    scenes: [],
    params,
    driver: {
      soort: 'midi', poort: app.midipoort ?? 'VARVE-HUB Logic', kanaal: 0, map,
      _bron: 'tools/genereer-manifesten.mjs ← sediment/src/Params.h; paniek = CC 123 (PANIEK_CC); koppelen in Logic: docs/LOGIC.md',
    },
  };
}

// ───────────────────────── schrijven ─────────────────────────

/** JSON met één param of map-regel per regel: leesbaar en goed te diffen. @param {any} m */
export function opmaak(m) {
  const regels = ['{'];
  const sleutels = Object.keys(m);
  sleutels.forEach((k, i) => {
    const komma = i < sleutels.length - 1 ? ',' : '';
    const v = m[k];
    if (k === 'params') {
      regels.push('  "params": [');
      v.forEach((/** @type {any} */ p, j) => regels.push(`    ${JSON.stringify(p)}${j < v.length - 1 ? ',' : ''}`));
      regels.push(`  ]${komma}`);
    } else if (k === 'driver') {
      regels.push('  "driver": {');
      const dk = Object.keys(v);
      dk.forEach((d, j) => {
        const dkomma = j < dk.length - 1 ? ',' : '';
        if (d === 'map') {
          regels.push('    "map": {');
          const ids = Object.keys(v.map);
          ids.forEach((id, n) => regels.push(`      ${JSON.stringify(id)}: ${JSON.stringify(v.map[id])}${n < ids.length - 1 ? ',' : ''}`));
          regels.push(`    }${dkomma}`);
        } else if (d === 'presets') {
          regels.push('    "presets": [');
          v.presets.forEach((/** @type {any} */ x, n) => regels.push(`      ${JSON.stringify(x)}${n < v.presets.length - 1 ? ',' : ''}`));
          regels.push(`    ]${dkomma}`);
        } else regels.push(`    ${JSON.stringify(d)}: ${JSON.stringify(v[d])}${dkomma}`);
      });
      regels.push(`  }${komma}`);
    } else regels.push(`  ${JSON.stringify(k)}: ${JSON.stringify(v)}${komma}`);
  });
  regels.push('}');
  return regels.join('\n') + '\n';
}

/** Een bronbestand dat er niet is: een leesbare melding (welk repo, welke vlag), geen stacktrace. */
export class BronOntbreekt extends Error {}

/**
 * Lees een bronbestand; ontbreekt het, dan een BronOntbreekt die zegt met welke vlag je het juiste pad geeft.
 * @param {string} pad @param {string} repo @param {string} map @param {string} vlag
 */
function leesBron(pad, repo, map, vlag) {
  if (!existsSync(pad)) throw new BronOntbreekt(`${repo} niet gevonden op ${map} (${pad} bestaat niet): geef ${vlag} <pad naar ${repo}>`);
  return readFileSync(pad, 'utf8');
}

/**
 * Bouw beide manifesten uit de bronmappen.
 * @param {{ sceneKit?: string, sediment?: string, config?: any }} o
 */
export function genereer({ sceneKit = '/home/user/av-scene-kit', sediment = '/home/user/sediment', config = laadConfig() } = {}) {
  const kit = JSON.parse(leesBron(join(sceneKit, 'config.json'), 'av-scene-kit', sceneKit, '--scene-kit'));
  const hubPy = join(sceneKit, 'td', 'td_build_hub.py');
  const presets = existsSync(hubPy) ? leesPresets(readFileSync(hubPy, 'utf8')) : [];
  const specs = leesParamsH(leesBron(join(sediment, 'src', 'Params.h'), 'sediment', sediment, '--sediment'));
  if (!specs.length) throw new Error(`geen parameters gevonden in ${join(sediment, 'src', 'Params.h')}`);
  const app = (/** @type {string} */ id, /** @type {string} */ naam) => ({ naam, ...(config?.apps?.[id] ?? {}) });
  return {
    'av-scene-kit.json': sceneKitManifest(kit, app('av-scene-kit', 'Scene Kit (TD)'), presets),
    'sediment.json': sedimentManifest(specs, app('sediment', 'Sediment')),
  };
}

/** @param {string[]} argv */
function main(argv) {
  const arg = (/** @type {string} */ naam, /** @type {string} */ std) => { const i = argv.indexOf(naam); return i >= 0 && argv[i + 1] ? argv[i + 1] : std; };
  const uit = resolve(arg('--uit', join(HUB_MAP, 'apps')));
  const toets = argv.includes('--toets');
  let bestanden;
  try {
    bestanden = genereer({ sceneKit: arg('--scene-kit', '/home/user/av-scene-kit'), sediment: arg('--sediment', '/home/user/sediment') });
  } catch (e) {
    if (!(e instanceof BronOntbreekt)) throw e;
    console.error(e.message);
    process.exitCode = 2;
    return;
  }
  let fout = false;
  for (const [naam, m] of Object.entries(bestanden)) {
    const r = valideerStatisch(m);
    if (!r.ok) { console.error(`${naam}: ongeldig\n  ${r.fouten.join('\n  ')}`); fout = true; continue; }
    const pad = join(uit, naam);
    const tekst = opmaak(m);
    if (toets) {
      const nu = existsSync(pad) ? readFileSync(pad, 'utf8') : '';
      if (nu !== tekst) { console.error(`${naam}: verouderd — draai node tools/genereer-manifesten.mjs (met --scene-kit en --sediment als de bronnen elders staan)`); fout = true; } else console.log(`${naam}: actueel (${m.params.length} params)`);
    } else { writeFileSync(pad, tekst); console.log(`${pad}: ${m.params.length} params`); }
  }
  process.exitCode = fout ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
