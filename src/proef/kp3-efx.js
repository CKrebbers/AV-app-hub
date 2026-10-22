// @ts-check
// Proeven "kp3plus" en "efx500" (PROTOCOL §20, §21, docs/HARDWARE-AVOND.md blok 9). Wat alleen het echte apparaat kan
// zeggen, wordt hier gemeten en gaat als bevinding (en golden test) naar proef/:
//   KP3+     welke ingang (achter de USB-MIDI-interface) · welke CC's bij X, bij Y, bij aanraken · kanaal · wat de
//            programmageheugens sturen (Program Change, of noten/CC in Ext.Ctrl) · FX Depth · Hold
//   EFX-500  welke ingang · de klok: tempo, stabiliteit (spreiding van het getoonde tempo, jitter per tik), klopt het met
//            het display · een tempowissel · tikt hij door zonder muziek · sturen knoppen of Start/Stop MIDI
// De proef leest de ruwe bytes, niet wat config.json nu aanneemt: zo meet hij ook een KP3+ met andere CC's. Aan het
// eind staat wat er in config.json hoort (de hub leest daar, huisregel 6).
// Alles wat Clay moet doen, meldt de proef ook met h.verwacht(...), zodat de gesimuleerde gebruiker (test/gesimuleerd.js)
// hem in CI doorloopt.
import { KlokMeter, meetBpm, spreiding, PPQN } from '../core/klokbron.js';

/** @typedef {import('./runner.js').Hulp} Hulp @typedef {import('./runner.js').Stap} Stap */

/** Zoveel kloktikken meet de proef per meting (acht tellen). */
export const KLOK_TIKKEN = 8 * PPQN;

/** Wacht (geschaald) tot `klaar()` of de tijd om is. @param {Hulp} h @param {() => boolean} klaar @param {number} ms */
async function wachtTot(h, klaar, ms) {
  for (let t = 0; t < ms && !klaar(); t += 100) await h.pauze(100);
  return klaar();
}

/**
 * Alle berichten van een apparaat vanaf de eerste die aan `filter` voldoet, tot `ms` (geschaald) daarna. Tikken van de
 * klok tellen nooit mee.
 * @param {Hulp} h @param {'kp3plus'|'efx500'} dev @param {(b: number[]) => boolean} filter @param {number} ms @param {Record<string, unknown>} verwacht
 */
async function verzamel(h, dev, filter, ms, verwacht) {
  /** @type {number[][]} */
  const alles = [];
  let bezig = false;
  const s = dev === 'kp3plus' ? h.kp3 : h.efx;
  const stop = s.bij('gebeurtenis', (/** @type {any} */ _g, /** @type {number[]} */ b) => {
    if (b[0] === 0xf8) return;
    if (bezig || filter(b)) { bezig = true; alles.push([...b]); }
  });
  const r = await h.eerste({ dev, filter: (_g, b) => b[0] !== 0xf8 && filter(b), verwacht });
  if (r) await h.pauze(ms);
  stop();
  return { gezien: !!r, berichten: alles };
}

/**
 * Per CC (en kanaal): hoeveel berichten, welke waarden. Gesorteerd: de meeste verschillende waarden eerst.
 * @param {number[][]} berichten
 */
export function perCc(berichten) {
  /** @type {Map<string, { cc: number, kanaal: number, n: number, waarden: Set<number>, min: number, max: number, wissels: number, vorig: number|null }>} */
  const m = new Map();
  for (const b of berichten) {
    if ((b[0] & 0xf0) !== 0xb0) continue;
    const k = `${b[0] & 0x0f}:${b[1]}`;
    const x = m.get(k) ?? { cc: b[1], kanaal: (b[0] & 0x0f) + 1, n: 0, waarden: new Set(), min: 127, max: 0, wissels: 0, vorig: null };
    x.n++; x.waarden.add(b[2]); x.min = Math.min(x.min, b[2]); x.max = Math.max(x.max, b[2]);
    if (x.vorig !== null && (x.vorig >= 64) !== (b[2] >= 64)) x.wissels++;
    x.vorig = b[2];
    m.set(k, x);
  }
  return [...m.values()].map(({ vorig, waarden, ...x }) => ({ ...x, verschillend: waarden.size })).sort((a, b) => b.verschillend - a.verschillend || b.n - a.n);
}

/** Een CC uit een stap: de eerste (meeste verschillende waarden) die nog niet gebruikt is. @param {ReturnType<typeof perCc>} lijst @param {number[]} bezet */
const kiesCc = (lijst, bezet) => lijst.find((x) => !bezet.includes(x.cc)) ?? null;
const hex = (/** @param {number[]} b */ b) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

/** @type {Stap} */
const EINDE = { id: 'einde', titel: 'Klaar', async doe(h) { h.toon('  Dank! De samenvatting staat hieronder; het volledige logboek is opgeslagen.'); } };

// ── KP3+ ───────────────────────────────────────────────────────────────────────

/** @type {Stap[]} */
const kp3Stappen = [
  {
    id: 'welkom', titel: 'Voorbereiding',
    async doe(h) {
      h.toon([
        '  Nodig: de KP3+ aan, zijn MIDI OUT met een DIN-kabel naar de MIDI IN van de USB-MIDI-interface, de interface via USB in de pc.',
        '  Op de KP3+ (Global): MIDI Control Change aan; Program Change aan als je de programmageheugens wilt meten.',
        '  Dicht: de hub zelf (npm start): de proef opent de interface. Duur: ±5 min. Alles komt in proef/…jsonl.',
      ].join('\n'));
      await h.enter('Klaar om te beginnen?');
    },
  },
  {
    id: 'kp3-poort', titel: 'KP3+: welke MIDI-ingang?',
    async doe(h) {
      if (!h.kp3) { h.toon('  Geen KP3+ in config.json (apparaten.kp3plus.poort_patroon): dit blok wordt overgeslagen.'); h.bevinding('kp3-poort', { inConfig: false }); return; }
      h.toon('  → Sluit de interface aan; de KP3+ hangt met DIN aan zijn MIDI IN.');
      h.verwacht({ soort: 'aansluiten', dev: 'kp3plus' });
      await wachtTot(h, () => h.kp3.verbonden, 10000);
      const ingangen = h.systemen.midi?.lijst().ingangen ?? [];
      const naam = h.kp3.poort?.naam ?? null;
      h.toon(naam ? `  ✓ gevonden: ${naam}` : `  ✗ niet gevonden. MIDI-ingangen: ${ingangen.join(' · ') || '(geen)'}`);
      const welke = naam ? null : await h.vraag('Welke ingang is de interface waar de KP3+ aan hangt? (typ de naam; Enter als hij er niet tussen staat)');
      if (welke) h.toon('    Zet een stukje van die naam in config.json → apparaten.kp3plus.poort_patroon en draai de proef opnieuw.');
      h.bevinding('kp3-poort', { naam, ingangen, welke: welke || null, patroon: h.config.apparaten?.kp3plus?.poort_patroon ?? null });
    },
  },
  {
    id: 'kp3-x', titel: 'KP3+: X (links → rechts)', vereist: ['kp3plus'],
    async doe(h) {
      h.toon('  → Raak het vlak aan en beweeg je vinger langzaam van helemaal LINKS naar helemaal RECHTS (zo recht mogelijk), en laat los.');
      const r = await verzamel(h, 'kp3plus', (b) => (b[0] & 0xf0) === 0xb0, 3000, { wat: 'x' });
      const lijst = perCc(r.berichten);
      const x = kiesCc(lijst, []);
      h.toon(x ? `  ✓ X lijkt CC ${x.cc} (kanaal ${x.kanaal}, ${x.min}–${x.max}, ${x.verschillend} waarden)` : '  ✗ geen CC gezien: staat Control Change aan in de Global-instellingen van de KP3+?');
      h.bevinding('kp3-x', { gezien: r.gezien, ccs: lijst, x: x?.cc ?? null, kanaal: x?.kanaal ?? null, bereik: x ? [x.min, x.max] : null });
    },
  },
  {
    id: 'kp3-y', titel: 'KP3+: Y (onder → boven)', vereist: ['kp3plus'],
    async doe(h) {
      const x = /** @type {any} */ (h.bevindingen['kp3-x'])?.x ?? null;
      h.toon('  → Raak het vlak aan en beweeg je vinger langzaam van helemaal ONDER naar helemaal BOVEN, en laat los.');
      const r = await verzamel(h, 'kp3plus', (b) => (b[0] & 0xf0) === 0xb0, 3000, { wat: 'y' });
      const lijst = perCc(r.berichten);
      const y = kiesCc(lijst, x === null ? [] : [x]);
      h.toon(y ? `  ✓ Y lijkt CC ${y.cc} (kanaal ${y.kanaal}, ${y.min}–${y.max})` : '  ✗ geen tweede CC gezien');
      h.bevinding('kp3-y', { gezien: r.gezien, ccs: lijst, y: y?.cc ?? null, bereik: y ? [y.min, y.max] : null });
    },
  },
  {
    id: 'kp3-aanraak', titel: 'KP3+: aanraken en loslaten', vereist: ['kp3plus'],
    async doe(h) {
      const bezet = [/** @type {any} */ (h.bevindingen['kp3-x'])?.x, /** @type {any} */ (h.bevindingen['kp3-y'])?.y].filter((n) => typeof n === 'number');
      h.toon('  → Tik drie keer kort op het MIDDEN van het vlak (aanraken, loslaten).');
      const r = await verzamel(h, 'kp3plus', (b) => (b[0] & 0xf0) === 0xb0, 3000, { wat: 'aanraak' });
      const lijst = perCc(r.berichten).filter((x) => !bezet.includes(x.cc));
      // Aanraken: een CC die tussen ≥64 en <64 wisselt (aan/los), niet X of Y.
      const t = lijst.filter((x) => x.wissels >= 2).sort((a, b) => b.wissels - a.wissels)[0] ?? null;
      h.toon(t ? `  ✓ aanraken lijkt CC ${t.cc} (${t.wissels} wissels aan/los)` : '  ! geen aparte aanraak-CC: dan telt bewegen als aanraken (zet apparaten.kp3plus.cc.aanraak op null)');
      h.bevinding('kp3-aanraak', { gezien: r.gezien, ccs: lijst, aanraak: t?.cc ?? null });
    },
  },
  {
    id: 'kp3-programmas', titel: 'KP3+: de programmageheugens 1–8', vereist: ['kp3plus'],
    async doe(h) {
      const bezet = ['kp3-x', 'kp3-y', 'kp3-aanraak'].map((id, i) => /** @type {any} */ (h.bevindingen[id])?.[['x', 'y', 'aanraak'][i]]).filter((n) => typeof n === 'number');
      /** @type {{ knop: number, bytes: number[]|null }[]} */
      const knoppen = [];
      for (let nr = 1; nr <= 8; nr++) {
        h.toon(`  → Druk op programmageheugen ${nr}`);
        const r = await h.eerste({ dev: 'kp3plus', verwacht: { wat: 'programma', nr }, filter: (_g, b) => b[0] !== 0xf8 && !((b[0] & 0xf0) === 0xb0 && bezet.includes(b[1])) });
        knoppen.push({ knop: nr, bytes: r ? [...r.bytes] : null });
        if (r) h.toon(`    ${hex(r.bytes)}`);
      }
      const soort = knoppen.every((k) => k.bytes && (k.bytes[0] & 0xf0) === 0xc0) ? 'program-change' : knoppen.some((k) => k.bytes) ? 'gemengd' : 'niets';
      h.bevinding('kp3-programmas', { knoppen, soort });
      if (soort === 'program-change') h.toon('  ✓ Program Change: de hub geeft ze door als trigger kp3.p<effectprogramma+1> (PROTOCOL §21)');
    },
  },
  {
    id: 'kp3-diepte', titel: 'KP3+: FX DEPTH', vereist: ['kp3plus'],
    async doe(h) {
      const bezet = [/** @type {any} */ (h.bevindingen['kp3-x'])?.x, /** @type {any} */ (h.bevindingen['kp3-y'])?.y, /** @type {any} */ (h.bevindingen['kp3-aanraak'])?.aanraak].filter((n) => typeof n === 'number');
      h.toon('  → Draai de FX DEPTH-knop helemaal open en weer dicht.');
      const r = await verzamel(h, 'kp3plus', (b) => (b[0] & 0xf0) === 0xb0 && !bezet.includes(b[1]), 2000, { wat: 'diepte' });
      const d = kiesCc(perCc(r.berichten), bezet);
      h.toon(d ? `  ✓ FX DEPTH lijkt CC ${d.cc}` : '  ! geen CC (dan stuurt de knop niets; dat mag)');
      h.bevinding('kp3-diepte', { gezien: r.gezien, diepte: d?.cc ?? null, berichten: r.berichten.slice(0, 40) });
    },
  },
  {
    id: 'kp3-hold', titel: 'KP3+: HOLD', vereist: ['kp3plus'],
    async doe(h) {
      const bezet = ['kp3-x', 'kp3-y', 'kp3-aanraak', 'kp3-diepte'].map((id) => /** @type {any} */ (h.bevindingen[id])).map((b, i) => b?.[['x', 'y', 'aanraak', 'diepte'][i]]).filter((n) => typeof n === 'number');
      h.toon('  → Druk twee keer op HOLD (aan, en weer uit).');
      const r = await verzamel(h, 'kp3plus', (b) => b[0] !== 0xf8 && !((b[0] & 0xf0) === 0xb0 && bezet.includes(b[1])), 2000, { wat: 'hold' });
      const k = kiesCc(perCc(r.berichten), bezet);
      h.toon(k ? `  ✓ HOLD lijkt CC ${k.cc}` : '  ! HOLD stuurt niets (dan gebruikt de hub alleen apparaten.kp3plus.hold)');
      h.bevinding('kp3-hold', { gezien: r.gezien, hold: k?.cc ?? null, berichten: r.berichten.slice(0, 20) });
    },
  },
  {
    id: 'kp3-uitslag', titel: 'KP3+: wat in config.json hoort',
    async doe(h) {
      const b = /** @type {Record<string, any>} */ (h.bevindingen);
      const gemeten = { kanaal: b['kp3-x']?.kanaal ?? null, cc: { x: b['kp3-x']?.x ?? null, y: b['kp3-y']?.y ?? null, aanraak: b['kp3-aanraak']?.aanraak ?? null, diepte: b['kp3-diepte']?.diepte ?? null, hold: b['kp3-hold']?.hold ?? null } };
      const nu = h.config.apparaten?.kp3plus ?? {};
      const klopt = gemeten.cc.x === (nu.cc?.x ?? 12) && gemeten.cc.y === (nu.cc?.y ?? 13) && gemeten.cc.aanraak === (nu.cc?.aanraak === undefined ? 92 : nu.cc.aanraak);
      h.bevinding('kp3plus-meting', { gemeten, config: { kanaal: nu.kanaal ?? null, cc: nu.cc ?? null }, klopt });
      if (gemeten.cc.x === null) { h.toon('  Niets gemeten (geen KP3+ of overgeslagen).'); return; }
      h.toon(klopt ? '  ✓ config.json klopt met wat de KP3+ stuurt.'
        : `  ⇒ zet in config.json → apparaten.kp3plus:\n     "cc": ${JSON.stringify(gemeten.cc)}${gemeten.kanaal ? `, "kanaal": ${gemeten.kanaal}` : ''}`);
    },
  },
];

// ── EFX-500 ────────────────────────────────────────────────────────────────────

/**
 * Meet de klok: wacht op de eerste tik, dan KLOK_TIKKEN tikken (of tot de tijd om is). Het tempo zoals de hub het
 * toont (KlokMeter) en de jitter per tik.
 * @param {Hulp} h @param {Record<string, unknown>} verwacht
 */
async function meetKlok(h, verwacht) {
  /** @type {number[]} */
  const tijden = [];
  /** @type {number[]} */
  const getoond = [];
  const meter = new KlokMeter();
  const stop = h.efx.bij('gebeurtenis', (/** @type {any} */ g) => {
    if (g.kind !== 'tik' || tijden.length >= KLOK_TIKKEN) return;
    const t = h.klok.nu();
    tijden.push(t);
    const b = meter.tik(t);
    if (b !== null) getoond.push(b);
  });
  const eerste = await h.eerste({ dev: 'efx500', filter: (g) => g.kind === 'tik', verwacht });
  // Acht tellen op 40 BPM duren 12 s; ruim daarboven, en in tests (schaal) niet langer dan een paar seconden.
  if (eerste) await wachtTot(h, () => tijden.length >= KLOK_TIKKEN, Math.max(20000, 4000 / h.schaal));
  stop();
  const d = tijden.slice(1).map((t, i) => t - tijden[i]);
  const med = d.length ? [...d].sort((a, b) => a - b)[d.length >> 1] : null;
  const afwijking = med === null ? [] : d.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  const r1 = (/** @type {number|null} */ x) => (x === null ? null : Math.round(x * 100) / 100);
  return {
    gezien: !!eerste, tikken: tijden.length, bpm: meter.bpm, meting: r1(meetBpm(d)), getoond, spreiding: spreiding(getoond.slice(1)),
    jitterMs: { mediaanInterval: r1(med), p50: r1(afwijking[afwijking.length >> 1] ?? null), p95: r1(afwijking[Math.floor(afwijking.length * 0.95)] ?? null), max: r1(afwijking.at(-1) ?? null) },
  };
}

/** @type {Stap[]} */
const efxStappen = [
  {
    id: 'welkom', titel: 'Voorbereiding',
    async doe(h) {
      h.toon([
        '  Nodig: de EFX-500 aan, zijn MIDI OUT met een DIN-kabel naar de MIDI IN van de USB-MIDI-interface, en muziek op zijn ingang',
        '  (of TAP). Dicht: de hub zelf (npm start). Duur: ±5 min. Alles komt in proef/…jsonl.',
      ].join('\n'));
      await h.enter('Klaar om te beginnen?');
    },
  },
  {
    id: 'efx-poort', titel: 'EFX-500: welke MIDI-ingang?',
    async doe(h) {
      if (!h.efx) { h.toon('  Geen EFX-500 in config.json (apparaten.efx500.poort_patroon): dit blok wordt overgeslagen.'); h.bevinding('efx-poort', { inConfig: false }); return; }
      h.toon('  → Sluit de interface aan; de EFX-500 hangt met DIN aan zijn MIDI IN.');
      h.verwacht({ soort: 'aansluiten', dev: 'efx500' });
      await wachtTot(h, () => h.efx.verbonden, 10000);
      const ingangen = h.systemen.midi?.lijst().ingangen ?? [];
      const naam = h.efx.poort?.naam ?? null;
      h.toon(naam ? `  ✓ gevonden: ${naam}` : `  ✗ niet gevonden. MIDI-ingangen: ${ingangen.join(' · ') || '(geen)'}`);
      const welke = naam ? null : await h.vraag('Welke ingang is de interface waar de EFX-500 aan hangt? (typ de naam; Enter als hij er niet tussen staat)');
      if (welke) h.toon('    Zet een stukje van die naam in config.json → apparaten.efx500.poort_patroon en draai de proef opnieuw.');
      h.bevinding('efx-poort', { naam, ingangen, welke: welke || null, patroon: h.config.apparaten?.efx500?.poort_patroon ?? null });
    },
  },
  {
    id: 'efx-klok', titel: 'EFX-500: de klok (tempo en stabiliteit)', vereist: ['efx500'],
    async doe(h) {
      h.toon(`  → Zet muziek op de EFX-500 (of tik TAP in een vast tempo) en laat het lopen; de proef meet ${KLOK_TIKKEN} tikken (acht tellen).`);
      const m = await meetKlok(h, { wat: 'klok' });
      if (!m.gezien) { h.bevinding('efx-klok', m); return; }
      h.toon(`  ${m.tikken} tikken · ${m.bpm ?? '?'} BPM · getoond tempo ${m.spreiding.min}–${m.spreiding.max} · jitter per tik p95 ${m.jitterMs.p95} ms (interval ${m.jitterMs.mediaanInterval} ms)`);
      const display = Number((await h.vraag('Welke BPM staat er op het display van de EFX-500? (typ het getal)')).replace(',', '.'));
      const verschil = Number.isFinite(display) && display > 0 && m.bpm !== null ? Math.round((m.bpm - display) * 10) / 10 : null;
      h.bevinding('efx-klok', { ...m, display: Number.isFinite(display) && display > 0 ? display : null, verschil });
      if (verschil !== null) h.toon(Math.abs(verschil) <= 0.5 ? '  ✓ klopt met het display' : `  ! ${verschil} BPM naast het display`);
    },
  },
  {
    id: 'efx-wissel', titel: 'EFX-500: een ander tempo', vereist: ['efx500'],
    async doe(h) {
      h.toon('  → Verander het tempo (andere muziek, of TAP een ander tempo) en laat het weer lopen.');
      const voor = /** @type {any} */ (h.bevindingen['efx-klok'])?.bpm ?? null;
      const m = await meetKlok(h, { wat: 'wissel' });
      h.bevinding('efx-wissel', { voor, na: m.bpm, tikken: m.tikken, spreiding: m.spreiding, jitterMs: m.jitterMs });
      h.toon(`  ${voor ?? '?'} → ${m.bpm ?? '?'} BPM`);
    },
  },
  {
    id: 'efx-stil', titel: 'EFX-500: zonder muziek', vereist: ['efx500'],
    async doe(h) {
      h.toon('  → Haal de muziek weg (bron uit of stil) en raak TAP niet aan. De proef telt 5 s lang de tikken.');
      h.verwacht({ soort: 'stil', dev: 'efx500' });
      await h.pauze(1000);   // de EFX even de tijd
      let tikken = 0;
      const stop = h.efx.bij('gebeurtenis', (/** @type {any} */ g) => { if (g.kind === 'tik') tikken++; });
      await h.pauze(5000);
      stop();
      h.toon(tikken ? `  ! de klok tikt door zonder muziek (${tikken} tikken): de hub houdt de EFX dan als bron (het laatste tempo)` : '  ✓ zonder muziek stopt de klok: de hub valt na weg_ms terug op tap');
      h.bevinding('efx-stil', { tikken, tiktDoor: tikken > 0 });
    },
  },
  {
    id: 'efx-knoppen', titel: 'EFX-500: sturen knoppen MIDI (of Start/Stop)?', vereist: ['efx500'],
    async doe(h) {
      h.toon('  → Druk 10 s lang op de knoppen van de EFX-500 (effect aan/uit, de beat-knoppen, TAP, de effectkiezer) en draai aan de knoppen.');
      h.verwacht({ soort: 'knoppen', dev: 'efx500' });
      /** @type {number[][]} */
      const berichten = [];
      const stop = h.efx.bij('gebeurtenis', (/** @type {any} */ g, /** @type {number[]} */ b) => { if (g.kind !== 'tik') berichten.push([...b]); });
      await h.pauze(10000);
      stop();
      const transport = berichten.filter((b) => b.length === 1 && b[0] >= 0xfa && b[0] <= 0xfc).map((b) => ({ 0xfa: 'start', 0xfb: 'verder', 0xfc: 'stop' })[b[0]]);
      const anders = berichten.filter((b) => !(b.length === 1 && b[0] >= 0xfa && b[0] <= 0xfc));
      h.toon(berichten.length ? `  ${berichten.length} berichten: ${[...new Set(berichten.map(hex))].slice(0, 12).join(' · ')}` : '  geen MIDI van de knoppen (alleen de klok)');
      h.bevinding('efx-knoppen', { aantal: berichten.length, transport, anders: anders.slice(0, 60) });
    },
  },
  EINDE,
];

/** @type {import('./runner.js').Protocol} */
export const kp3plus = { naam: 'kp3plus', titel: 'Proef KP3+ — het gebaar (XY, aanraken, programma\'s)', stappen: [...kp3Stappen, EINDE] };
/** @type {import('./runner.js').Protocol} */
export const efx500 = { naam: 'efx500', titel: 'Proef EFX-500 — de klok', stappen: efxStappen };
