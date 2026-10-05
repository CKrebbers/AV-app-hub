// @ts-check
// Proef "speelapparaten": de E-MU Xboard49 en de Maschine MK2 (PROTOCOL §17, docs/MASCHINE.md). Wat alleen het echte
// toestel kan zeggen, wordt hier gemeten en gaat als bevinding (en golden test) terug naar Claude:
//   Xboard49  poortnaam · toetsenbereik en velocity · de 16 knoppen (CC leren → xboard49-profiel.json, of NRPN?) ·
//             pitchbend en modulatie · aftertouch (aan/uit) · pedaal · de schuif (SysEx Master Volume) · patch wisselen ·
//             paniek (beide octaafknoppen)
//   Maschine  17CC:1140 zichtbaar · openen zonder NI-programma's (bezet?) en macOS-Invoermonitoring · rustopname van
//             rapport 0x20 (ruisvloer, ±750/s; golden) · oriëntatie van de pads · elke pad, knop en draaiknop · zacht
//             en hard (velocity, maximale druk) · lampjes (oriëntatie, RGB-bereik, twee zones per groepknop) ·
//             schermen · USB eruit en erin
// Alles wat Clay moet doen, meldt de proef ook met h.verwacht(...), zodat de gesimuleerde gebruiker
// (test/gesimuleerd.js) hem in CI doorloopt.
import * as XB from '../devices/xboard49.js';
import * as MS from '../devices/maschine-mk2.js';
import { HINT } from '../ports/hid.js';

/** @typedef {import('./runner.js').Hulp} Hulp @typedef {import('./runner.js').Stap} Stap */

const GROEN = 21, ROOD = 5, BLAUW = 45, GRIJS = 1;
const PADS = Array.from({ length: 16 }, (_, i) => `pad${i + 1}`);
const ENCODERS = [...Array.from({ length: 8 }, (_, i) => `enc${i + 1}`), 'masterwiel'];
/** Tijdens de rustopname zoveel padrapporten onverkort in het logboek (±0,2 s): de golden test van de ontleding. */
export const RUST_FRAMES = 150;

/** Wacht (geschaald) tot `klaar()` of de tijd om is. @param {Hulp} h @param {() => boolean} klaar @param {number} ms */
async function wachtTot(h, klaar, ms) {
  for (let t = 0; t < ms && !klaar(); t += 100) await h.pauze(100);
  return klaar();
}

/** Eén toets van de Xboard. @param {Hulp} h @param {string} tekst @param {string} wat */
async function toets(h, tekst, wat) {
  h.toon(`  → ${tekst}`);
  const r = await h.eerste({ dev: 'xboard49', filter: (g) => g.el === 'noot' && g.kind === 'druk', verwacht: { wat } });
  return r ? { noot: r.g.noot, velocity: r.g.raw, kanaal: r.g.ch + 1 } : null;
}

/** Alle berichten van de Xboard tussen de eerste die aan `filter` voldoet en `ms` daarna. @param {Hulp} h @param {(g: any) => boolean} filter @param {number} ms @param {Record<string, unknown>} verwacht */
async function verzamel(h, filter, ms, verwacht) {
  /** @type {number[][]} */
  const alles = [];
  let bezig = false;
  const stop = h.xboard.bij('gebeurtenis', (/** @type {any} */ g, /** @type {number[]} */ b) => { if (bezig || filter(g)) { bezig = true; alles.push([...b]); } });
  const r = await h.eerste({ dev: 'xboard49', filter, verwacht });
  if (r) await h.pauze(ms);
  stop();
  return { gezien: !!r, berichten: alles };
}

/** @type {Stap[]} */
const stappen = [
  {
    id: 'welkom', titel: 'Voorbereiding',
    async doe(h) {
      h.toon([
        '  Nodig: de E-MU Xboard49 en de Maschine MK2 via USB, allebei aan. (Eén van de twee? Sla het andere blok over met o.)',
        '  Dicht: Maschine 2 en Controller Editor van Native Instruments, en de hub zelf (npm start): de proef opent de apparaten.',
        '  Duur: ±25 min. Alles wordt opgenomen in proef/…jsonl — dat bestand push je straks (en xboard49-profiel.json).',
      ].join('\n'));
      await h.enter('Klaar om te beginnen?');
    },
  },

  // ── Xboard49 ────────────────────────────────────────────────────────────────
  {
    id: 'xb-poort', titel: 'Xboard49: welke MIDI-poort?',
    async doe(h) {
      if (!h.xboard) { h.toon('  Geen Xboard49 in config.json (apparaten.xboard49): dit blok wordt overgeslagen.'); h.bevinding('xb-poort', { inConfig: false }); return; }
      h.toon('  → Sluit de Xboard49 aan (USB) en zet hem aan.');
      h.verwacht({ soort: 'aansluiten', dev: 'xboard49' });
      await wachtTot(h, () => h.xboard.verbonden, 10000);
      const ingangen = h.systemen.midi?.lijst().ingangen ?? [];
      const naam = h.xboard.poort?.naam ?? null;
      h.toon(naam ? `  ✓ gevonden: ${naam}` : `  ✗ niet gevonden. MIDI-ingangen: ${ingangen.join(' · ') || '(geen)'}`);
      const welke = naam ? null : await h.vraag('Welke ingang is het keyboard? (typ de naam; Enter als hij er niet tussen staat)');
      if (welke) h.toon('    Zet een stukje van die naam in config.json → apparaten.xboard49.naam en draai de proef opnieuw.');
      h.bevinding('xb-poort', { naam, ingangen, welke: welke || null, patroon: h.config.apparaten?.xboard49?.naam ?? null });
    },
  },
  {
    id: 'xb-toetsen', titel: 'Xboard49: toetsen en velocity', vereist: ['xboard49'],
    async doe(h) {
      const laag = await toets(h, 'Speel de LAAGSTE toets (zonder octaafknoppen).', 'laag');
      const hoog = await toets(h, 'Speel de HOOGSTE toets.', 'hoog');
      const zacht = await toets(h, 'Speel een toets zo ZACHT als je kunt.', 'zacht');
      const hard = await toets(h, 'Speel een toets zo HARD als je kunt.', 'hard');
      const bereik = laag && hoog ? hoog.noot - laag.noot + 1 : null;
      h.bevinding('xb-toetsen', { laag, hoog, zacht, hard, bereik });
      h.toon(`  ${bereik ?? '?'} toetsen (49 verwacht) · velocity zacht ${zacht?.velocity ?? '?'}, hard ${hard?.velocity ?? '?'} · kanaal ${laag?.kanaal ?? '?'}`);
    },
  },
  {
    id: 'xb-knoppen', titel: 'Xboard49: de 16 knoppen leren', vereist: ['xboard49'],
    async doe(h) {
      /** @type {XB.Profiel} */
      const profiel = { bron: 'geleerd', knoppen: [] };
      const geleerd = new Set();
      let nrpn = false;
      for (let i = 1; i <= XB.AANTAL_KNOPPEN; i++) {
        if (nrpn) { profiel.knoppen.push({ n: -1 }); continue; }
        h.toon(`  → Draai KNOP ${i}`);
        const r = await h.eerste({
          dev: 'xboard49', verwacht: { wat: 'knop', nr: i },
          filter: (_g, b) => { const k = XB.knopUitBericht(b); return !!k && !geleerd.has(`${k.ch}:${k.n}`); },
        });
        const k = r ? XB.knopUitBericht(r.bytes) : null;
        if (k?.nrpn) {
          nrpn = true;
          h.toon('    ⚠ deze knop stuurt NRPN (CC 99/98 + data). Zet de knoppen in het keyboard-menu op CC als je ze een naam wilt geven;'
            + ' de lease-app krijgt de NRPN-berichten hoe dan ook. Leren stopt hier.');
          profiel.knoppen.push({ n: -1 });
          continue;
        }
        if (!k) { profiel.knoppen.push({ n: -1 }); continue; }
        geleerd.add(`${k.ch}:${k.n}`);
        profiel.knoppen.push({ n: k.n, ch: k.ch });
        h.toon(`    ✓ CC ${k.n} (kanaal ${k.ch + 1})`);
      }
      if (nrpn) profiel.nrpn = true;
      const compleet = !profiel.knoppen.some((k) => k.n < 0);
      if (compleet) h.xboard.zetProfiel(profiel);
      h.bevinding('xboard49-profiel', { profiel, compleet, nrpn, gok: XB.standaardProfiel().knoppen.map((k) => k.n) });
    },
  },
  {
    id: 'xb-wielen', titel: 'Xboard49: pitchbend en modulatie', vereist: ['xboard49'],
    async doe(h) {
      const r = await h.wachtOp({
        dev: 'xboard49', ids: ['buiging', 'mod'], tekst: 'Duw het PITCHBEND-wiel naar boven én naar beneden, en draai het MODULATIE-wiel helemaal open.',
        klaar: (g, m) => {
          if (g.el === 'buiging') { if (g.v > 0.6) m.op = true; if (g.v < 0.4) m.neer = true; return !!(m.op && m.neer); }
          return g.v >= 0.9;
        },
      });
      h.bevinding('xb-wielen', r);
    },
  },
  {
    id: 'xb-aftertouch', titel: 'Xboard49: aftertouch', vereist: ['xboard49'],
    async doe(h) {
      h.toon('  → Druk een toets in en duw hem daarna stevig verder in. (Komt er niets na 15 s, dan gaan we door; o = overslaan.)');
      const r = await h.eerste({ dev: 'xboard49', filter: (g) => g.el === 'aftertouch' || g.el === 'polydruk', timeoutMs: 15000, verwacht: { wat: 'aftertouch' } });
      h.bevinding('xb-aftertouch', { soort: r?.g.el ?? null, overgeslagen: h.laatsteOvergeslagen, voorbeeld: r?.bytes ?? null });
      h.toon(r ? `  ✓ ${r.g.el === 'aftertouch' ? 'kanaal-aftertouch' : 'polyfone aftertouch'}`
        : h.laatsteOvergeslagen ? '  overgeslagen' : '  geen aftertouch gezien: staat hij uit in het keyboard? (Dat mag; de app krijgt dan alleen velocity.)');
    },
  },
  {
    id: 'xb-pedaal', titel: 'Xboard49: pedaal (optioneel)', vereist: ['xboard49'],
    async doe(h) {
      h.toon('  → Pedaal aangesloten? Trap hem in en laat los. Geen pedaal: o + Enter.');
      // Eén luisteraar voor het loslaten, zodat ook een heel snel loslaten (vóór de tweede wachtstap) telt.
      let los = false, ingetrapt = false;
      const stop = h.xboard.bij('gebeurtenis', (/** @type {any} */ g) => {
        if (g.el !== 'sustain') return;
        if (g.kind === 'druk') ingetrapt = true;
        else if (ingetrapt) los = true;
      });
      const in_ = await h.eerste({ dev: 'xboard49', filter: (g) => g.el === 'sustain' && g.kind === 'druk', verwacht: { wat: 'pedaal' } });
      if (in_ && !los) await h.eerste({ dev: 'xboard49', filter: (g) => g.el === 'sustain' && g.kind === 'los', timeoutMs: 10000, verwacht: { wat: 'pedaal', loslaten: true } });
      stop();
      h.bevinding('xb-pedaal', { gezien: !!in_, los, voorbeeld: in_?.bytes ?? null });
      if (in_) h.toon(los ? '  ✓ pedaal in en uit' : '  ⚠ het pedaal ging in, maar het loslaten kwam niet binnen (staat het pedaal omgekeerd?)');
    },
  },
  {
    id: 'xb-schuif', titel: 'Xboard49: de schuif (SysEx Master Volume)', vereist: ['xboard49'],
    async doe(h) {
      /** @type {number[]|null} */
      let voorbeeld = null;
      const stop = h.xboard.bij('gebeurtenis', (/** @type {any} */ g, /** @type {number[]} */ b) => { if (g.el === 'schuif') voorbeeld ??= [...b]; });
      const r = await h.wachtOp({
        dev: 'xboard49', ids: ['schuif'], tekst: 'Schuif de SCHUIF (volume) helemaal naar beneden en helemaal naar boven.',
        klaar: (g, m) => { m.min = Math.min(m.min ?? 1, g.v); m.max = Math.max(m.max ?? 0, g.v); return m.min <= 0.02 && m.max >= 0.98; },
      });
      stop();
      h.bevinding('xb-schuif', { ...r, voorbeeld, sysex: !!voorbeeld && XB.isMasterVolume(voorbeeld) });
      if (r.ontbrekend.length && !r.overgeslagen) h.toon('  ⚠ geen SysEx Master Volume gezien: stuurt de schuif iets anders (zie het logboek)?');
    },
  },
  {
    id: 'xb-patch', titel: 'Xboard49: van patch wisselen', vereist: ['xboard49'],
    async doe(h) {
      h.toon('  → Wissel van patch (programma), zoals je dat op het keyboard doet. Geen idee hoe: o + Enter.');
      const r = await verzamel(h, (g) => g.el === 'programma' || g.el === 'bank', 1000, { wat: 'patch' });
      h.bevinding('xb-patch', r);
      if (r.gezien) h.toon(`  ✓ ${r.berichten.length} bericht(en): ${r.berichten.map((b) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ')).join(' · ')}`);
    },
  },
  {
    id: 'xb-paniek', titel: 'Xboard49: paniek (beide octaafknoppen)', vereist: ['xboard49'],
    async doe(h) {
      h.toon('  → Druk BEIDE octaafknoppen tegelijk in (paniek op het keyboard).');
      const r = await verzamel(h, (g) => g.el === 'paniek', 500, { wat: 'paniek' });
      const cc = (/** @type {number} */ n) => r.berichten.filter((b) => (b[0] & 0xf0) === 0xb0 && b[1] === n);
      const kanalen = [...new Set(r.berichten.filter((b) => (b[0] & 0xf0) === 0xb0).map((b) => (b[0] & 0x0f) + 1))].sort((a, b) => a - b);
      h.bevinding('xb-paniek', { gezien: r.gezien, cc120: cc(120).length, cc123: cc(123).length, kanalen });
      if (r.gezien) h.toon(`  ✓ CC120 ×${cc(120).length}, CC123 ×${cc(123).length} op ${kanalen.length} kana${kanalen.length === 1 ? 'al' : 'len'}`);
    },
  },

  // ── Maschine MK2 ────────────────────────────────────────────────────────────
  {
    id: 'ms-zichtbaar', titel: 'Maschine: is hij zichtbaar (17CC:1140)?',
    async doe(h) {
      const m = h.maschine;
      if (!m) { h.toon('  Geen Maschine in config.json (apparaten.maschine-mk2): dit blok wordt overgeslagen.'); h.bevinding('ms-zichtbaar', { inConfig: false }); return; }
      const hid = h.systemen.hid;
      if (!hid) { h.toon(`  ✗ geen HID: ${m.geenHid} — npm install haalt node-hid binnen.`); h.bevinding('ms-zichtbaar', { hid: false, reden: m.geenHid }); return; }
      h.toon('  → Sluit de Maschine aan (USB) en zet hem aan.');
      h.verwacht({ soort: 'aansluiten', dev: 'maschine-mk2' });
      const vind = () => hid.apparaten().filter((/** @type {any} */ a) => a.vid === m.vid && a.pid === m.pid);
      await wachtTot(h, () => vind().length > 0, 10000);
      const toestellen = vind().map((/** @type {any} */ a) => ({ product: a.product, vid: a.vid, pid: a.pid }));
      const ni = h.niProgrammas?.() ?? [];
      h.bevinding('ms-zichtbaar', { gevonden: toestellen.length > 0, toestellen, ni, vidPid: m.vidPid });
      h.toon(toestellen.length ? `  ✓ ${toestellen[0].product ?? 'gevonden'} (${m.vidPid})` : `  ✗ geen toestel met ${m.vidPid} — USB erin, en aan?`);
      if (ni.length) h.toon(`  ! nu draaien: ${ni.join(', ')}`);
    },
  },
  {
    id: 'ms-openen', titel: 'Maschine: openen (zonder NI-programma\'s) en Invoermonitoring',
    async doe(h) {
      const m = h.maschine;
      if (!m?.hid) { h.toon('  overgeslagen (geen Maschine of geen HID)'); return; }
      const ni = h.niProgrammas?.() ?? [];
      if (ni.length) {
        h.toon(`  Nu draaien: ${ni.join(', ')}. Die kunnen de Maschine vasthouden; dan is hij voor de hub "bezet".`);
        await h.enter('Sluit Maschine 2 en Controller Editor (de agents mag je laten draaien: we kijken of de hub hem toch krijgt).');
      }
      h.verwacht({ soort: 'openen', dev: 'maschine-mk2' });
      await wachtTot(h, () => m.status === 'verbonden' || m.status === 'geen-invoer' || m.status === 'bezet', 15000);
      /** @type {string|null} */
      let antwoord = null;
      if (m.status === 'bezet') {
        h.toon(`  ✗ bezet (${m.statusReden}) — ${HINT.bezet}`);
        antwoord = await h.vraag('Wat draait er nog van Native Instruments? Sluit wat kan en druk Enter (de hub probeert het elke paar seconden opnieuw).');
        await wachtTot(h, () => m.status === 'verbonden' || m.status === 'geen-invoer', 15000);
      }
      // In rust stuurt hij ±750 rapporten per seconde: komt er binnen stil_ms niets, dan houdt macOS het tegen.
      await wachtTot(h, () => m.frames > 0 || m.status === 'geen-invoer', m.inst.stilMs + 1000);
      /** @type {string|null} */
      let tcc = null;
      if (m.status === 'verbonden' && m.frames > 0) h.toon(`  ✓ open, en er komt invoer binnen (${m.frames} rapporten)`);
      else if (m.status === 'geen-invoer') {
        h.toon(`  ✗ open, maar er komt niets binnen — ${HINT.invoer}`);
        tcc = await h.vraag('Vroeg macOS om toegang tot "Invoermonitoring"? Wat heb je gedaan? (daarna: hub/proef opnieuw starten)');
      }
      h.bevinding('ms-openen', {
        status: m.status, reden: m.statusReden, ni, frames: m.frames, bezetAntwoord: antwoord, tcc,
        nietExclusief: h.config.apparaten?.['maschine-mk2']?.niet_exclusief === true,
      });
    },
  },
  {
    id: 'ms-rust', titel: 'Maschine: rustopname (pads niet aanraken)', vereist: ['maschine-mk2'],
    async doe(h) {
      const m = h.maschine;
      await h.enter('Haal je handen van de Maschine (pads, knoppen en draaiknoppen niet aanraken).');
      /** @type {number[][]} */
      const drukken = [];
      const lengtes = new Set();
      let n = 0, nibbleKlopt = true;
      const t0 = h.klok.nu();
      let tEind = t0;
      const stop = m.bij('rapport', (/** @type {ArrayLike<number>} */ f) => {
        if (f[0] !== MS.RAPPORT.pads || n >= RUST_FRAMES) return;
        n++;
        lengtes.add(f.length);
        const p = MS.ontleedPads(f);
        if (p) drukken.push(p);
        for (let s = 0; s < 16 && f.length >= 33; s++) if ((f[2 + 2 * s] >> 4) !== s) nibbleKlopt = false;
        tEind = h.klok.nu();
      });
      m.neemRuwOp(RUST_FRAMES);
      h.verwacht({ soort: 'hid-rust', dev: 'maschine-mk2', n: RUST_FRAMES });
      await wachtTot(h, () => n >= RUST_FRAMES, 4000);
      stop();
      m.neemRuwOp(0);
      const ms = Math.round((tEind - t0) * 10) / 10;
      const perPad = Array.from({ length: 16 }, (_, s) => Math.max(0, ...drukken.map((d) => d[s])));
      const ruisMax = drukken.length ? Math.max(...perPad) : null;
      const perSeconde = n > 1 && ms > 0 ? Math.round((n / ms) * 1000) : null;
      const { drempel, los } = m.inst.pads;
      h.bevinding('maschine-rust', { frames: n, ms, perSeconde, lengtes: [...lengtes], ruisMax, perPad, nibbleKlopt, drempel, los });
      h.toon(`  ${n} rapporten${perSeconde ? `, ±${perSeconde} per seconde` : ''}, lengte ${[...lengtes].join('/') || '?'} · ruis tot ${ruisMax ?? '?'} (loslaten onder ${los}, slag vanaf ${drempel})`);
      if (ruisMax !== null && ruisMax >= los) h.toon(`  ⚠ de ruis komt boven de loslaatdrempel (${los}): pads.los en pads.drempel in config.json moeten omhoog`);
      if (!nibbleKlopt) h.toon('  ⚠ de plek-nibble klopt niet met de volgorde: het logboek laat zien hoe het wel zit');
    },
  },
  {
    id: 'ms-orientatie', titel: 'Maschine: welke pad is welke?', vereist: ['maschine-mk2'],
    async doe(h) {
      const pad = (/** @type {string} */ plek) => h.eerste({ dev: 'maschine-mk2', filter: (g) => /^pad\d+$/.test(g.el) && g.kind === 'druk', verwacht: { plek } });
      h.toon('  → Druk de pad LINKSBOVEN (en laat los).');
      const lb = await pad('linksboven');
      h.toon('  → Druk de pad RECHTSONDER.');
      const ro = await pad('rechtsonder');
      const klopt = lb?.g.el === 'pad13' && ro?.g.el === 'pad4';
      h.bevinding('ms-orientatie', { linksboven: lb?.g.el ?? null, rechtsonder: ro?.g.el ?? null, klopt });
      h.toon(klopt ? '  ✓ linksboven = pad 13, rechtsonder = pad 4 (zoals opgedrukt: pad 1 linksonder)'
        : `  ⚠ de hub las ${lb?.g.el ?? '?'} en ${ro?.g.el ?? '?'} (verwacht pad13 en pad4): de pad-volgorde moet anders (noteer het)`);
    },
  },
  {
    id: 'ms-pads', titel: 'Maschine: alle 16 pads, zacht en hard', vereist: ['maschine-mk2'],
    async doe(h) {
      const m = h.maschine;
      m.leeg();
      let maxDruk = 0, aftertouch = 0;
      const stopR = m.bij('rapport', (/** @type {ArrayLike<number>} */ f) => { const p = MS.ontleedPads(f); if (p) maxDruk = Math.max(maxDruk, ...p); });
      const stopA = m.bij('gebeurtenis', (/** @type {any} */ g, /** @type {number[]} */ b) => { if ((b[0] & 0xf0) === 0xa0) aftertouch++; });
      const r = await h.wachtOp({
        dev: 'maschine-mk2', ids: PADS, tekst: 'Druk elke pad één keer, in elke volgorde. Hij wordt groen.', klaar: (g) => g.kind === 'druk',
        bijElk: (g) => m.led([0x90, MS.padNoot(Number(g.el.slice(3))), GROEN]),
      });
      const pos = await h.jn('Werd steeds precies de pad groen die je indrukte?');
      const slag = (/** @type {string} */ kracht) => h.eerste({ dev: 'maschine-mk2', filter: (g) => /^pad\d+$/.test(g.el) && g.kind === 'druk', verwacht: { kracht } });
      h.toon('  → Tik een pad zo ZACHT als je kunt (net hoorbaar).');
      const zacht = await slag('zacht');
      h.toon('  → Sla een pad zo HARD als je kunt, en houd hem even vast.');
      const hard = await slag('hard');
      await h.pauze(500);
      stopR();
      stopA();
      h.bevinding('ms-pads', { ...r, positieKlopt: pos, zacht: zacht?.g.raw ?? null, hard: hard?.g.raw ?? null, maxDruk, aftertouch, instellingen: m.inst.pads });
      h.toon(`  velocity zacht ${zacht?.g.raw ?? '?'}, hard ${hard?.g.raw ?? '?'} · grootste druk ${maxDruk} (vol = ${m.inst.pads.max}) · ${aftertouch}× aftertouch`);
      m.leeg();
    },
  },
  {
    id: 'ms-knoppen', titel: 'Maschine: alle 48 knoppen', vereist: ['maschine-mk2'],
    async doe(h) {
      const m = h.maschine;
      m.leeg();
      const r = await h.wachtOp({
        dev: 'maschine-mk2', ids: [...MS.KNOPPEN], tekst: 'Druk elke knop één keer (ook F1–F8 boven de schermen, de groepknoppen A–H en het masterwiel zelf). Het lampje gaat aan.',
        klaar: (g) => g.kind === 'druk',
        bijElk: (g) => m.led([0x90 | MS.KNOP_KANAAL, /** @type {number} */ (MS.KNOP_NR.get(g.el)), MS.GROEPEN.includes(g.el) ? GROEN : 127]),
      });
      const lampjes = await h.jn('Ging bij elke knop zijn eigen lampje aan? (het masterwiel heeft er geen)');
      h.bevinding('ms-knoppen', { ...r, lampjes });
      m.leeg();
    },
  },
  {
    id: 'ms-encoders', titel: 'Maschine: de 8 draaiknoppen en het masterwiel', vereist: ['maschine-mk2'],
    async doe(h) {
      /** @type {Record<string, number>} */
      const som = {};
      const stop = h.maschine.bij('gebeurtenis', (/** @type {any} */ g) => { if (g.kind === 'delta') som[g.el] = (som[g.el] ?? 0) + Math.abs(g.delta); });
      const r = await h.wachtOp({
        dev: 'maschine-mk2', ids: ENCODERS, tekst: 'Draai elk van de 8 knoppen onder de schermen, en het masterwiel, een stukje naar rechts én naar links.',
        klaar: (g, mem) => { if (g.delta > 0) mem.op = true; if (g.delta < 0) mem.neer = true; return !!(mem.op && mem.neer); },
      });
      stop();
      h.bevinding('ms-encoders', { ...r, som, drempel: h.maschine.inst.encoder_drempel });
    },
  },
  {
    id: 'ms-leds', titel: 'Maschine: lampjes (oriëntatie, bereik, twee zones)', vereist: ['maschine-mk2'],
    async doe(h) {
      const m = h.maschine, L = m.leds;
      const max = L.max;
      L.max = 255;   // het bereik meten we met ruwe waarden
      L.uit();
      for (let pad = 1; pad <= 16; pad++) L.zetPad(pad, MS.paletRgb(GRIJS));
      L.zetPad(13, MS.paletRgb(ROOD));
      L.zetPad(4, MS.paletRgb(BLAUW));
      m.toon();
      const orientatie = await h.jn('Is de pad LINKSBOVEN rood en de pad RECHTSONDER blauw (de rest zwak grijs)?');
      L.uit();
      for (const pad of [5, 6, 7, 8]) L.zetPad(pad, [0, 127, 0]);
      for (const pad of [1, 2, 3, 4]) L.zetPad(pad, [0, 255, 0]);
      m.toon();
      const bereik = await h.jn('Is de ONDERSTE rij pads duidelijk feller groen dan de rij erboven?');
      L.uit();
      L.zetGroep('groepA', MS.paletRgb(ROOD), MS.paletRgb(BLAUW));
      ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'].forEach((k, i) => L.zetKnop(k, 32 * (i + 1) - 1));
      L.zetKnop('play', 255);
      m.toon();
      const zones = await h.jn('Is groepknop A half rood en half blauw?');
      const verloop = await h.jn('Lopen de lampjes van F1 tot F8 van zwak naar fel, en brandt PLAY?');
      L.max = max;
      m.leeg();
      h.bevinding('ms-leds', { orientatie, bereik, zones, verloop, led_max: max });
      if (bereik.ok === false) h.toon('  ⇒ dan is 127 al het felste: zet apparaten.maschine-mk2.led_max op 127 in config.json');
    },
  },
  {
    id: 'ms-scherm', titel: 'Maschine: de twee schermen', vereist: ['maschine-mk2'],
    async doe(h) {
      const m = h.maschine;
      m.scherm(0, MS.testbeeld('schaak'));
      m.scherm(1, MS.testbeeld('strepen'));
      const beeld = await h.jn('Staat er LINKS een schaakbord en RECHTS liggende strepen, allebei met een rand eromheen?');
      m.leeg();
      await h.pauze(200);
      const leeg = await h.jn('Zijn beide schermen nu leeg (zwart)?');
      h.bevinding('ms-scherm', { beeld, leeg });
    },
  },
  {
    id: 'ms-replug', titel: 'Maschine: USB eruit en erin', vereist: ['maschine-mk2'],
    async doe(h) {
      const m = h.maschine;
      h.toon('  → Trek de USB-kabel van de Maschine eruit.');
      const weg = await h.wachtMelding('maschine-mk2', 'weg', 120000);
      if (!weg.ok) { h.bevinding('ms-replug', { weg }); return; }
      h.toon('  ✓ weg. → Steek hem er weer in.');
      const terug = await h.wachtMelding('maschine-mk2', 'verbonden', 120000);
      if (terug.ok) await wachtTot(h, () => m.frames > 0, 2000);
      h.bevinding('ms-replug', { weg, terug, invoer: terug.ok && m.frames > 0, status: m.status });
    },
  },
  {
    id: 'einde', titel: 'Klaar',
    async doe(h) {
      h.maschine?.leeg();
      h.toon('  Dank! De samenvatting staat hieronder; het volledige logboek is opgeslagen.');
    },
  },
];

/** @type {import('./runner.js').Protocol} */
export const speelapparaten = { naam: 'speelapparaten', titel: 'Proef speelapparaten — Xboard49 en Maschine MK2', stappen };
