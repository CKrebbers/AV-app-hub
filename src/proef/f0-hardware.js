// @ts-check
// Proef F0: bezit de hub de APC40 en de LPD8 echt? Elke control, het palet, animaties,
// hotplug, en de vijf open hardwarevragen uit ONDERZOEK.md §10:
//   V1 nemen ringknoppen een host-waarde over?   V2 volgen animaties MIDI-clock?
//   V3 negeert de APC LEDs terwijl je een pad vasthoudt?   V4 geeft het intro-antwoord faderstanden?
//   V5 welke LPD8, wat zit in de programma's, werken pad-LEDs?
// Plus drie metingen voor wat de hub sinds golf 1 van de hardware vraagt:
//   hubtoets-akkoord  BANK vasthouden + Track Select / + Shift + Scene (focus wisselen, snapshot bewaren)
//   lpd8-vasthouden   sturen de LPD8-pads een loslaat-bericht? (lang drukken P5–P8, paniek P1 1 s)
//   lpd8-replug       LPD8 eruit en erin: herkent de hub hem daarna nog met het geleerde profiel?
import * as A from '../devices/apc40mk2.js';
import * as L from '../devices/lpd8.js';
import { LANG_MS, PANIEK_MS } from '../core/kern.js';

/** @typedef {import('./runner.js').Hulp} Hulp @typedef {import('./runner.js').Stap} Stap */

const GROEN = 21, ROOD = 5, BLAUW = 45, ORANJE = 9;
const reeks = (/** @type {string} */ p, n = 8) => Array.from({ length: n }, (_, i) => `${p}${i + 1}`);
const PADS = Array.from({ length: 40 }, (_, i) => A.padId(Math.floor(i / 8) + 1, (i % 8) + 1));

/** Losse knoppen, één voor één — zo zien we meteen of iets verwisseld is (zoals ◄/► in av-kern). */
const LOSSE = /** @type {const} */ ([
  ['pan', 'PAN'], ['sends', 'SENDS'], ['user', 'USER'], ['play', 'PLAY'], ['record', 'RECORD (●)'], ['session', 'SESSION (opnemen)'],
  ['metro', 'METRONOME'], ['tap', 'TAP TEMPO'], ['nudgeM', 'NUDGE −'], ['nudgeP', 'NUDGE +'],
  ['devL', '◄ DEVICE'], ['devR', 'DEVICE ►'], ['bankL', '◄ BANK'], ['bankR', 'BANK ►'],
  ['devOn', 'DEVICE ON/OFF'], ['lock', 'DEVICE LOCK'], ['clipdev', 'CLIP/DEVICE VIEW'], ['detail', 'DETAIL VIEW'],
  ['up', 'pijl ▲ OMHOOG'], ['down', 'pijl ▼ OMLAAG'], ['left', 'pijl ◄ LINKS'], ['right', 'pijl ► RECHTS'],
  ['shift', 'SHIFT'], ['bank', 'BANK (de losse knop, niet ◄/►)'],
]);

/** Regenboog over alles: gebruikt na repaint en replug. @param {Hulp} h */
function regenboog(h) {
  PADS.forEach((id, i) => h.apc.zet(id, { kleur: [5, 9, 13, 21, 37, 45, 49, 53][i % 8] }));
  reeks('scene', 5).forEach((id, i) => h.apc.zet(id, { kleur: [5, 13, 21, 45, 53][i] }));
  for (const c of A.MET_LED) {
    if (c.led === 'aan') h.apc.zet(c.id, { aan: true });
    if (c.led === 'clipstop') h.apc.zet(c.id, { aan: true });
    if (c.led === 'ab') h.apc.zet(c.id, { stand: 2 });
    if (c.led === 'ring') h.apc.zet(c.id, { waarde: 0.5 });
  }
}

/** Kleurvoorbeeld in de terminal, in dezelfde indeling als het grid (bovenste rij eerst). @param {(note: number) => number|null} kleurVan */
function terminalGrid(kleurVan) {
  const regels = [];
  for (let r = 5; r >= 1; r--) {
    let s = '    ';
    for (let c = 1; c <= 8; c++) {
      const k = kleurVan((r - 1) * 8 + (c - 1));
      if (k === null) { s += '      '; continue; }
      const [R, G, B] = A.rgb(A.PALET[k]);
      s += `\x1b[48;2;${R};${G};${B}m${String(k).padStart(4)}  \x1b[0m`;
    }
    regels.push(s);
  }
  return regels.join('\n');
}

/** @type {Stap[]} */
const stappen = [
  {
    id: 'welkom', titel: 'Voorbereiding',
    async doe(h) {
      h.toon([
        '  Nodig: APC40 mkII en LPD8 via USB aangesloten.',
        '  Dicht: Chrome-tabs met Varve DJ / av-kern, Ableton, en een APC-control-surface in Logic.',
        '  Ook de hub zelf (npm start, of als dienst na "installeer"): de proef opent de controllers zelf.',
        '  Duur: ±35-45 min. Alles wordt opgenomen in proef/…jsonl — dat bestand push je straks.',
      ].join('\n'));
      await h.enter('Klaar om te beginnen?');
    },
  },
  {
    id: 'apparaten', titel: 'Apparaten zoeken',
    async doe(h) {
      for (let i = 0; i < 20 && !(h.apc.verbonden && h.lpd8.verbonden); i++) await h.pauze(250);
      const r = { apc40: h.apc.poort?.naam ?? null, lpd8: h.lpd8.poort?.naam ?? null };
      h.bevinding('apparaten', r);
      h.toon(`  APC40: ${r.apc40 ?? '✗ niet gevonden'}\n  LPD8:  ${r.lpd8 ?? '✗ niet gevonden'}`);
    },
  },
  {
    id: 'identiteit', titel: 'Identiteit en LPD8-programma\'s (V5)',
    async doe(h) {
      const uit = {};
      if (h.apc.verbonden) {
        h.apc.stuur([...A.IDENTITEIT_VRAAG]);
        const r = await h.eerste({ dev: 'apc40', filter: (g) => g.kind === 'identiteit', timeoutMs: 1500 });
        uit.apc40 = r ? r.bytes : null;
      }
      if (h.lpd8.verbonden) {
        for (let i = 0; i < 6 && !h.lpd8.model; i++) await h.pauze(250);
        uit.lpd8_model = h.lpd8.model;
        if (h.lpd8.model) {
          h.lpd8.vraagProgrammas(h.lpd8.model === 'mk1' ? [1, 2, 3, 4] : [0, 1, 2, 3, 4]);
          await h.pauze(1500);
          uit.lpd8_programmas = Object.fromEntries([...h.lpd8.programmas].map(([n, p]) => [n, p]));
        }
      }
      h.bevinding('identiteit', uit);
      h.toon(`  APC40-identiteit: ${uit.apc40 ? 'ontvangen' : 'geen antwoord'} · LPD8: ${uit.lpd8_model ?? 'model onbekend'}` +
        (uit.lpd8_programmas ? ` · ${Object.keys(uit.lpd8_programmas).length} programma's gelezen` : ''));
    },
  },
  {
    id: 'intro-antwoord', titel: 'Faderstanden bij opstart (V4)', vereist: ['apc40'],
    async doe(h) {
      await h.enter('Zet FADER 1 helemaal OMHOOG en alle andere faders + MASTER helemaal OMLAAG.');
      h.apc.stuur(A.intro(h.apc.modus));
      const r = await h.eerste({ dev: 'apc40', filter: (g) => g.kind === 'intro-antwoord', timeoutMs: 1000 });
      const data = r ? r.bytes.slice(7, -1) : null;
      h.bevinding('V4-intro-antwoord', {
        ontvangen: !!r, bytes: r?.bytes ?? null,
        lijktFaders: data ? data[0] > 100 && data.slice(1).every((/** @type {number} */ x) => x < 30) : null,
      });
      h.toon(r ? `  antwoord: ${data?.join(' ')}` : '  geen antwoord op de intro');
      h.apc.init();
    },
  },
  {
    id: 'grid', titel: 'Alle 40 pads', vereist: ['apc40'],
    async doe(h) {
      h.apc.zwart();
      const r = await h.wachtOp({
        dev: 'apc40', ids: PADS, tekst: 'Druk alle 40 pads, in elke volgorde. Elke pad wordt groen.',
        bijElk: (g) => { h.apc.zet(g.el, { kleur: GROEN }); h.apc.teken(); },
      });
      const pos = await h.jn('Werd steeds precies de pad groen die je indrukte?');
      h.bevinding('grid', { ...r, positieKlopt: pos });
    },
  },
  {
    id: 'scenes', titel: 'Scene launch, clip stop, stop all, master', vereist: ['apc40'],
    async doe(h) {
      h.apc.zwart();
      const ids = [...reeks('scene', 5), ...reeks('stop'), 'stopall', 'mastersel'];
      const r = await h.wachtOp({
        dev: 'apc40', ids, tekst: 'Druk de 5 SCENE-knoppen, de 8 CLIP STOP-knoppen, STOP ALL CLIPS en MASTER.',
        bijElk: (g) => { const c = A.OP_ID.get(g.el); h.apc.zet(g.el, c?.led === 'rgb' ? { kleur: GROEN } : { aan: true }); h.apc.teken(); },
      });
      const pos = await h.jn('Ging steeds het lampje aan van de knop die je indrukte? (STOP ALL heeft geen lampje)');
      h.bevinding('scenes', { ...r, positieKlopt: pos });
    },
  },
  {
    id: 'strips', titel: 'Knoppen per track (5 rijen × 8)', vereist: ['apc40'],
    async doe(h) {
      h.apc.zwart();
      const ids = ['sel', 'act', 'ab', 'solo', 'rec'].flatMap((p) => reeks(p));
      const r = await h.wachtOp({
        dev: 'apc40', ids, tekst: 'Druk per track: TRACK SELECT, het NUMMER (activator), A|B, S (solo) en ● (rec arm).',
        bijElk: (g) => { h.apc.zet(g.el, A.OP_ID.get(g.el)?.led === 'ab' ? { stand: 2 } : { aan: true }); h.apc.teken(); },
      });
      const pos = await h.jn('Ging steeds het lampje van precies die knop aan (A|B wordt oranje)?');
      h.bevinding('strips', { ...r, positieKlopt: pos });
    },
  },
  {
    id: 'faders', titel: 'Faders en crossfader', vereist: ['apc40'],
    async doe(h) {
      const r = await h.wachtOp({
        dev: 'apc40', ids: [...reeks('fader'), 'master', 'xf'], tekst: 'Schuif elke fader, MASTER en de CROSSFADER één keer helemaal van uiterste naar uiterste.',
        klaar: (g, m) => { m.min = Math.min(m.min ?? 1, g.v); m.max = Math.max(m.max ?? 0, g.v); return m.min <= 0.02 && m.max >= 0.98; },
      });
      h.bevinding('faders', r);
    },
  },
  {
    id: 'knoppen', titel: '16 draaiknoppen met lichtring', vereist: ['apc40'],
    async doe(h) {
      for (const id of [...reeks('dk'), ...reeks('tk')]) h.apc.zet(id, { waarde: 0 });
      h.apc.teken();
      // In modus 0x42 tekent de host de ringen: de hub zet elke ring op de waarde van zijn knop.
      const stop = h.apc.bij('gebeurtenis', (/** @type {any} */ g) => { if (/^(dk|tk)\d$/.test(g.el)) { h.apc.zet(g.el, { waarde: g.v }); h.apc.teken(); } });
      const r = await h.wachtOp({
        dev: 'apc40', ids: [...reeks('dk'), ...reeks('tk')], tekst: 'Draai elk van de 8 DEVICE-knoppen en 8 TRACK-knoppen een flink stuk.',
        klaar: (g, m) => { m.w = (m.w ?? new Set()).add(g.raw); return m.w.size >= 6; },
      });
      const ring = await h.jn('Liep de lichtring rond elke knop mee met het draaien?');
      stop();
      h.bevinding('knoppen', { ...r, ringVolgt: ring });
    },
  },
  {
    id: 'relatief', titel: 'TEMPO en CUE LEVEL (relatief)', vereist: ['apc40'],
    async doe(h) {
      const r = await h.wachtOp({
        dev: 'apc40', ids: ['tempo', 'cue'], tekst: 'Draai TEMPO en CUE LEVEL elk een stukje naar rechts én naar links.',
        klaar: (g, m) => { if (g.delta > 0) m.op = true; if (g.delta < 0) m.neer = true; return !!(m.op && m.neer); },
      });
      h.bevinding('relatief', r);
    },
  },
  {
    id: 'losse-knoppen', titel: 'Losse knoppen één voor één', vereist: ['apc40'],
    async doe(h) {
      h.apc.zwart();
      const uit = [];
      for (const [id, naam] of LOSSE) {
        h.toon(`  → Druk ${naam}`);
        const r = await h.eerste({ dev: 'apc40', filter: (g) => g.kind === 'druk' && !!g.el, verwacht: { id } });
        const kreeg = r?.g.el ?? null;
        uit.push({ verwacht: id, kreeg });
        if (kreeg && kreeg !== id) h.toon(`    ⚠ verwacht ${id}, maar binnen kwam ${kreeg}`);
        else if (kreeg) { h.toon('    ✓'); if (A.OP_ID.get(id)?.led === 'aan') { h.apc.zet(id, { aan: true }); h.apc.teken(); } }
      }
      const fout = uit.filter((x) => x.kreeg && x.kreeg !== x.verwacht);
      h.bevinding('losse-knoppen', { uitslag: uit, verwisseld: fout });
      if (!fout.length) h.toon('  alles klopt met protocol v1.2');
    },
  },
  {
    id: 'hubtoets-akkoord', titel: 'De hubtoets vasthouden + een andere knop', vereist: ['apc40'],
    async doe(h) {
      // De hele hublaag rust hierop: hubtoets (standaard BANK) vast + Track Select = focus, + Shift + Scene = bewaren.
      // In modus 0x42 hoort elke knop gewoon zijn eigen noot te sturen, ook als er een andere vastgehouden wordt.
      h.apc.zwart();
      const ht = hubtoetsId(h.config);
      const naam = ht === 'bank' ? 'BANK' : ht.toUpperCase();
      h.toon(`  → Houd ${naam} vast, druk TRACK SELECT 3 (en laat hem los), laat daarna ${naam} los.`);
      const focus = await akkoord(h, [ht, 'sel3']);
      h.toon(focus.klopt ? '    ✓' : `    ⚠ binnen kwam: ${focus.volgorde.map((x) => `${x.el} ${x.kind}`).join(', ') || 'niets'}`);
      h.toon(`  → Houd ${naam} én SHIFT vast, druk SCENE 2 (en laat hem los), laat daarna alles los.`);
      const bewaren = await akkoord(h, [ht, 'shift', 'scene2']);
      h.toon(bewaren.klopt ? '    ✓' : `    ⚠ binnen kwam: ${bewaren.volgorde.map((x) => `${x.el} ${x.kind}`).join(', ') || 'niets'}`);
      h.bevinding('hubtoets-akkoord', { hubtoets: ht, focus, bewaren });
      if (focus.klopt && bewaren.klopt) h.toon(`  ✓ ${naam} + andere knoppen komen netjes binnen: de hublaag werkt op deze APC`);
    },
  },
  {
    id: 'voet', titel: 'Footswitch (optioneel)', vereist: ['apc40'],
    async doe(h) {
      h.toon('  → Footswitch aangesloten? Druk hem in. Geen footswitch: typ o + Enter.');
      const r = await h.eerste({ dev: 'apc40', filter: (g) => g.el === 'voet', verwacht: { id: 'voet' } });
      h.bevinding('voet', { gezien: !!r });
    },
  },
  {
    id: 'ring-overname', titel: 'Nemen de knoppen een waarde van de hub over? (V1)', vereist: ['apc40'],
    async doe(h) {
      h.apc.zet('tk1', { waarde: 100 / 127 });
      h.apc.zet('dk1', { waarde: 20 / 127 });
      h.apc.teken();
      await h.pauze(300);
      h.toon('  → Draai TRACK-knop 1 (bovenste rij, links) één klein tikje naar RECHTS.');
      const t = await h.eerste({ dev: 'apc40', filter: (g) => g.el === 'tk1', verwacht: { id: 'tk1', richting: 'rechts', gezet: 100 } });
      h.toon('  → Draai DEVICE-knop 1 (rechts, links boven) één klein tikje naar LINKS.');
      const d = await h.eerste({ dev: 'apc40', filter: (g) => g.el === 'dk1', verwacht: { id: 'dk1', richting: 'links', gezet: 20 } });
      const tk1 = t?.g.raw ?? null, dk1 = d?.g.raw ?? null;
      const overgenomen = tk1 !== null && dk1 !== null ? tk1 >= 100 && tk1 <= 110 && dk1 >= 10 && dk1 <= 20 : null;
      h.bevinding('V1-ring-overname', { tk1: { gezet: 100, eerste: tk1 }, dk1: { gezet: 20, eerste: dk1 }, overgenomen });
      h.toon(overgenomen === true ? '  ✓ knoppen nemen de hub-waarde over → geen pickup nodig voor ringknoppen'
        : overgenomen === false ? '  ✗ knoppen houden hun eigen waarde → ook ringknoppen krijgen pickup' : '  onbeslist');
    },
  },
  {
    id: 'palet', titel: 'Het kleurenpalet (128 kleuren in 4 pagina\'s)', vereist: ['apc40'],
    async doe(h) {
      const uit = [];
      for (const basis of [0, 40, 80, 120]) {
        h.apc.zwart();
        const kleurVan = (/** @type {number} */ n) => (basis + n < 128 ? basis + n : null);
        PADS.forEach((id) => { const k = kleurVan(/** @type {any} */ (A.OP_ID.get(id)).n); h.apc.zet(id, k === null ? {} : { kleur: k }); });
        h.apc.teken();
        h.toon(`  Kleuren ${basis}–${Math.min(basis + 39, 127)} — zo hoort het eruit te zien (getal = paletindex):\n${terminalGrid(kleurVan)}`);
        uit.push({ basis, ...(await h.jn('Komen de kleuren op de APC ongeveer overeen met dit voorbeeld?')) });
      }
      h.bevinding('palet', uit);
    },
  },
  {
    id: 'animaties', titel: 'Pulseren, knipperen, one-shot', vereist: ['apc40'],
    async doe(h) {
      tekenAnimaties(h);
      h.toon([
        '  Rij 5 (boven): vast groen ter vergelijking.',
        '  Rij 4: pulseren, snelheid 1/24 → 1/2 van links naar rechts (kolom 1-5).',
        '  Rij 3: knipperen, idem.   Rij 2: pulseren groen↔blauw (twee berichten).   Rij 1: one-shot.',
      ].join('\n'));
      const puls = await h.jn('Pulseert rij 4, met verschillende snelheden?');
      const knip = await h.jn('Knippert rij 3?');
      const twee = await h.jn('Wisselt rij 2 tussen groen en blauw?');
      const one = await h.jn('Deed rij 1 iets eenmaligs (flits/overgang) en bleef dan staan?');
      h.bevinding('animaties', { puls, knip, tweeKleuren: twee, oneshot: one });
    },
  },
  {
    id: 'midi-clock', titel: 'Volgen animaties de MIDI-clock? (V2)', vereist: ['apc40'],
    async doe(h) {
      tekenAnimaties(h);
      const uit = {};
      for (const bpm of [60, 140]) {
        let actief = true;
        const tik = () => { if (!actief) return; h.apc.stuur([0xf8]); h.klok.zet(tik, 60000 / bpm / 24); };
        h.apc.stuur([0xfa]);
        tik();
        await h.pauze(1500);
        uit[bpm] = await h.jn(`Nu stuurt de hub MIDI-clock op ${bpm} BPM. Is het tempo van rij 3/4 veranderd${bpm === 60 ? ' (kolom 4 ≈ 1× per seconde)' : ' (duidelijk sneller dan net)'}?`);
        actief = false;
        h.apc.stuur([0xfc]);
      }
      h.bevinding('V2-midi-clock', uit);
    },
  },
  {
    id: 'vasthouden', titel: 'LED veranderen terwijl je een pad vasthoudt (V3)', vereist: ['apc40'],
    async doe(h) {
      h.apc.zwart();
      h.apc.zet('pad3-4', { kleur: BLAUW }); h.apc.teken();
      h.toon('  → Houd de BLAUWE pad (rij 3, kolom 4) ingedrukt en blijf vasthouden.');
      const d = await h.eerste({ dev: 'apc40', filter: (g) => g.el === 'pad3-4' && g.kind === 'druk', verwacht: { id: 'pad3-4', vasthouden: true } });
      if (!d) return;
      await h.pauze(300);
      h.apc.zet('pad3-4', { kleur: ROOD }); h.apc.teken();
      const tijdens = await h.jn('Blijf vasthouden: is de pad nu ROOD?');
      h.toon('  → Laat nu los.');
      await h.eerste({ dev: 'apc40', filter: (g) => g.el === 'pad3-4' && g.kind === 'los', verwacht: { id: 'pad3-4', loslaten: true } });
      await h.pauze(200);
      const na = await h.jn('Is de pad nu ROOD?');
      h.bevinding('V3-vasthouden', { roodTijdens: tijdens, roodNa: na });
    },
  },
  {
    id: 'repaint', titel: 'Volledige repaint: snelheid', vereist: ['apc40'],
    async doe(h) {
      h.apc.zwart();
      await h.apc.rij.leeg();
      await h.pauze(500);
      regenboog(h);
      const t0 = h.klok.nu();
      const n = h.apc.teken();
      await h.apc.rij.leeg();
      const ms = Math.round((h.klok.nu() - t0) * 10) / 10;
      h.toon(`  ${n} berichten in ${ms} ms`);
      const ineens = await h.jn('Verscheen alles in één keer (geen zichtbare veeg)?');
      h.bevinding('repaint', { berichten: n, ms, ineens });
    },
  },
  {
    id: 'replug', titel: 'USB eruit en erin (hotplug)', vereist: ['apc40'],
    async doe(h) {
      h.toon('  → Trek de USB-kabel van de APC40 eruit.');
      const weg = await h.wachtMelding('apc40', 'weg', 120000);
      if (!weg.ok) { h.bevinding('replug', { weg }); return; }
      h.toon('  ✓ weg. → Steek hem er weer in.');
      const terug = await h.wachtMelding('apc40', 'verbonden', 120000);
      await h.pauze(1000);
      const beeld = terug.ok ? await h.jn('Staat het regenboogpatroon er weer helemaal?') : null;
      h.bevinding('replug', { weg, terug, beeldTerug: beeld });
    },
  },
  {
    id: 'lpd8-leren', titel: 'LPD8: pads en knoppen leren', vereist: ['lpd8'],
    async doe(h) {
      /** @type {L.Profiel} */
      const profiel = { model: h.lpd8.model, bron: 'geleerd', pads: [], knoppen: [] };
      for (let i = 1; i <= 8; i++) {
        h.toon(`  → Druk PAD ${i} van de LPD8`);
        const b = await h.leer('pad', i);
        if (b) { profiel.pads.push(b); h.toon(`    ✓ ${b.t} ${b.n} (kanaal ${(b.ch ?? 0) + 1})`); } else profiel.pads.push({ t: 'note', n: -1 });
      }
      for (let i = 1; i <= 8; i++) {
        h.toon(`  → Draai KNOP ${i} van de LPD8`);
        const b = await h.leer('knop', i);
        if (b) { profiel.knoppen.push({ n: b.n, ch: b.ch }); h.toon(`    ✓ CC ${b.n} (kanaal ${(b.ch ?? 0) + 1})`); } else profiel.knoppen.push({ n: -1 });
      }
      const sleutels = [...profiel.pads.map((p) => `${p.t}:${p.n}:${p.ch}`), ...profiel.knoppen.map((k) => `cc:${k.n}:${k.ch}`)];
      const dubbel = sleutels.filter((s, i) => sleutels.indexOf(s) !== i);
      h.lpd8.zetProfiel(profiel);
      h.bevinding('lpd8-profiel', { profiel, dubbel });
      if (dubbel.length) h.toon(`  ⚠ dubbele berichten: ${dubbel.join(', ')} — pas het LPD8-programma aan`);
    },
  },
  {
    id: 'lpd8-test', titel: 'LPD8: herkent de hub alles?', vereist: ['lpd8'],
    async doe(h) {
      const r = await h.wachtOp({
        dev: 'lpd8', ids: [...reeks('p'), ...reeks('k')], tekst: 'Druk alle 8 pads en draai alle 8 knoppen nog één keer.',
      });
      h.bevinding('lpd8-test', r);
    },
  },
  {
    id: 'lpd8-vasthouden', titel: 'LPD8: lang drukken (snapshots P5–P8, paniek P1)', vereist: ['lpd8'],
    async doe(h) {
      // Lang drukken (> LANG_MS = bewaren) en paniek (P1 PANIEK_MS vasthouden) werken alleen als een pad bij
      // het LOSLATEN een bericht stuurt (note-off of CC 0). In TOGGLE- of PC-modus gebeurt dat niet.
      const lang = await meetDruk(h, 8, 'Houd PAD 8 vast terwijl je rustig tot drie telt, en laat dan los.', 2000);
      const kort = await meetDruk(h, 5, 'Tik PAD 5 één keer kort aan.', 0);
      const noteOff = lang.los && kort.los;
      const losBijLoslaten = noteOff && (lang.ms ?? 0) > LANG_MS * h.schaal;
      const langDrukkenWerkt = losBijLoslaten && (kort.ms ?? 0) <= LANG_MS * h.schaal;
      h.bevinding('lpd8-vasthouden', {
        lang, kort, noteOff, losBijLoslaten, langDrukkenWerkt, paniekGehaald: noteOff && (lang.ms ?? 0) >= PANIEK_MS * h.schaal,
        langMs: LANG_MS, paniekMs: PANIEK_MS,
      });
      if (!lang.gedrukt || !kort.gedrukt) h.toon('  onbeslist (overgeslagen)');
      else if (!noteOff) h.toon('  ✗ de pads sturen niets bij loslaten → staan ze in TOGGLE- of PC-modus? Zet ze in de LPD8-editor op MOMENTARY\n    (anders werken lang drukken voor snapshots en de paniek op P1 niet).');
      else if (!losBijLoslaten) h.toon(`  ⚠ het loslaten kwam al na ${Math.round((lang.ms ?? 0) / h.schaal)} ms — hield je echt drie tellen vast? Zo niet: kijk naar de pad-modus.`);
      else h.toon(`  ✓ loslaten komt binnen (${Math.round((lang.ms ?? 0) / h.schaal)} ms vastgehouden): lang drukken en paniek werken`);
    },
  },
  {
    id: 'lpd8-leds', titel: 'LPD8: pad-lampjes vanuit de hub (V5)', vereist: ['lpd8'],
    async doe(h) {
      const msgs = h.lpd8.profiel.pads.map((p) => L.padLed(p, true)).filter(Boolean);
      if (!msgs.length) { h.bevinding('V5-lpd8-leds', { mogelijk: false, reden: 'pads niet in NOTE-modus' }); return; }
      for (const m of msgs) h.lpd8.stuur(/** @type {number[]} */ (m));
      const aan = await h.jn('Gaan de pad-lampjes van de LPD8 aan (zonder dat je drukt)?');
      for (const p of h.lpd8.profiel.pads) { const m = L.padLed(p, false); if (m) h.lpd8.stuur(m); }
      h.bevinding('V5-lpd8-leds', { model: h.lpd8.model, aan });
    },
  },
  {
    id: 'lpd8-replug', titel: 'LPD8: USB eruit en erin (hotplug)', vereist: ['lpd8'],
    async doe(h) {
      h.toon('  → Trek de USB-kabel van de LPD8 eruit.');
      const weg = await h.wachtMelding('lpd8', 'weg', 120000);
      if (!weg.ok) { h.bevinding('lpd8-replug', { weg }); return; }
      h.toon('  ✓ weg. → Steek hem er weer in.');
      const terug = await h.wachtMelding('lpd8', 'verbonden', 120000);
      if (!terug.ok) { h.bevinding('lpd8-replug', { weg, terug }); return; }
      const r = await h.wachtOp({ dev: 'lpd8', ids: ['p1', 'k1'], tekst: 'Druk PAD 1 en draai KNOP 1.' });
      h.bevinding('lpd8-replug', { weg, terug, herkend: !r.overgeslagen && !r.ontbrekend.length, ...r });
    },
  },
  {
    id: 'einde', titel: 'Klaar',
    async doe(h) {
      if (h.apc.verbonden) { regenboog(h); h.apc.teken(); }
      h.toon('  Dank! De samenvatting staat hieronder; het volledige logboek is opgeslagen.');
    },
  },
];

/** De control-id van de hubtoets uit config.json, zoals de kern hem leest (naam of nootnummer op kanaal 0). @param {any} config */
function hubtoetsId(config) {
  const ht = config?.hubtoets ?? 'bank';
  if (typeof ht === 'number') return A.CONTROLS.find((c) => c.t === 'note' && c.n === ht && c.ch === 0)?.id ?? 'bank';
  return A.OP_ID.has(ht) ? ht : 'bank';
}

/**
 * Wacht tot de gebruiker een akkoord heeft gespeeld: ids[0] vast, dan de rest, en ids[0] weer los.
 * Klopt als de laatste knop binnenkwam terwijl alle eerdere nog ingedrukt waren, elk met zijn eigen noot.
 * @param {Hulp} h @param {string[]} ids
 */
async function akkoord(h, ids) {
  /** @type {{ el: string, kind: string }[]} */
  const volgorde = [];
  const laatste = ids[ids.length - 1];
  const r = await h.eerste({
    dev: 'apc40', verwacht: { akkoord: ids },
    filter: (g) => {
      if (!g.el || (g.kind !== 'druk' && g.kind !== 'los')) return false;
      volgorde.push({ el: g.el, kind: g.kind });
      // Klaar zodra de hubtoets loskomt nadat de laatste knop (of een onverwachte) is ingedrukt.
      return g.el === ids[0] && g.kind === 'los' && volgorde.some((x) => x.kind === 'druk' && (x.el === laatste || !ids.includes(x.el)));
    },
  });
  const vreemd = [...new Set(volgorde.map((x) => x.el).filter((el) => !ids.includes(el)))];
  return { volgorde, vreemd, klopt: !!r && !vreemd.length && akkoordKlopt(volgorde, ids) };
}

/** @param {{ el: string, kind: string }[]} volgorde @param {string[]} ids */
function akkoordKlopt(volgorde, ids) {
  const laatste = ids[ids.length - 1];
  let eind = -1;
  volgorde.forEach((x, i) => { if (x.el === laatste && x.kind === 'druk') eind = i; });
  if (eind < 0) return false;
  // Elke eerdere knop: ingedrukt vóór de laatste, en tussen dat indrukken en de laatste niet losgelaten.
  return ids.slice(0, -1).every((id) => {
    let druk = -1;
    for (let i = 0; i < eind; i++) if (volgorde[i].el === id) druk = volgorde[i].kind === 'druk' ? i : -1;
    return druk >= 0;
  });
}

/**
 * Meet hoe lang een LPD8-pad als ingedrukt binnenkomt: van druk tot het loslaat-bericht.
 * @param {Hulp} h @param {number} nr @param {string} tekst @param {number} houdMs  hoe lang een mens ongeveer vasthoudt (voor de simulatie)
 */
async function meetDruk(h, nr, tekst, houdMs) {
  const el = `p${nr}`;
  /** @type {number|null} */
  let tDruk = null;
  /** @type {number|null} */
  let tLos = null;
  let tussendoor = 0;
  /** @type {number[]|null} */
  let voorbeeld = null;
  // Eén luisteraar voor alles, zodat ook een heel snel loslaten (vóór de tweede wachtstap) niet gemist wordt.
  const stop = h.lpd8.bij('gebeurtenis', (/** @type {any} */ g, /** @type {number[]} */ b) => {
    if (g.el === el && g.kind === 'druk' && tDruk === null) tDruk = h.klok.nu();
    else if (g.el === el && g.kind === 'los' && tDruk !== null && tLos === null) tLos = h.klok.nu();
    else if (tDruk !== null && tLos === null) { tussendoor++; voorbeeld ??= [...b]; } // bv. aftertouch van een mk2-pad
  });
  h.toon(`  → ${tekst}  (komt er bij loslaten niets binnen, dan gaan we na 10 s vanzelf door)`);
  const d = await h.eerste({ dev: 'lpd8', filter: (g) => g.el === el && g.kind === 'druk', verwacht: { pad: nr, houdMs } });
  if (d && tLos === null) await h.eerste({ dev: 'lpd8', filter: (g) => g.el === el && g.kind === 'los', timeoutMs: 10000, verwacht: { pad: nr, loslaten: true } });
  stop();
  const los = tDruk !== null && tLos !== null;
  return { gedrukt: !!d, los, ms: los ? Math.round(/** @type {number} */ (tLos) - /** @type {number} */ (tDruk)) : null, tussendoor, voorbeeld };
}

/** @param {Hulp} h */
function tekenAnimaties(h) {
  h.apc.zwart();
  for (let c = 1; c <= 5; c++) {
    const s = c - 1;
    h.apc.zet(A.padId(5, c), { kleur: GROEN });
    h.apc.zet(A.padId(4, c), { kleur: GROEN, anim: { soort: 'puls', snelheid: s } });
    h.apc.zet(A.padId(3, c), { kleur: ORANJE, anim: { soort: 'knipper', snelheid: s } });
    h.apc.zet(A.padId(2, c), { kleur: GROEN, anim: { soort: 'puls', snelheid: s, kleur2: BLAUW } });
    h.apc.zet(A.padId(1, c), { kleur: ROOD, anim: { soort: 'oneshot', snelheid: s } });
  }
  h.apc.teken();
}

/** @type {import('./runner.js').Protocol} */
export const f0Hardware = { naam: 'f0-hardware', titel: 'Proef F0 — hardware', stappen };
