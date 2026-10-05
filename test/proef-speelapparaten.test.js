// De proef "speelapparaten" (src/proef/speelapparaten.js) met de gesimuleerde gebruiker: een nep-Xboard49 (alleen
// een MIDI-ingang) en een nep-Maschine MK2 (HID). Ook wat er gebeurt als de Maschine bezet is of macOS de invoer
// tegenhoudt, en zonder HID of zonder keyboard.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { echteKlok } from '../src/core/klok.js';
import { Logboek, leesLogboek } from '../src/core/logboek.js';
import { maakApparaten } from '../src/apparaten.js';
import { voerUit } from '../src/proef/runner.js';
import { speelapparaten, RUST_FRAMES } from '../src/proef/speelapparaten.js';
import { PROTOCOLLEN } from '../src/proef/index.js';
import { simulatie } from './gesimuleerd.js';
import { herspeel } from './herspeel.js';

export const SPEEL_CONFIG = {
  hotplug_ms: 5, led: { per_burst: 16, burst_ms: 4 },
  apparaten: { apc40: { naam: 'apc40', modus: 0x42 }, lpd8: { naam: 'lpd8' }, xboard49: { naam: 'xboard' }, 'maschine-mk2': { vid: '17cc', pid: '1140', stil_ms: 50 } },
};

/** Een volledige proef speelapparaten. @param {{ sim?: any, hid?: any, ni?: string[], config?: any }} [o] */
export async function draaiSpeel({ sim = simulatie({ speel: true }), hid = sim.hid, ni = [], config = SPEEL_CONFIG } = {}) {
  const regels = [];
  const logboek = new Logboek({ klok: echteKlok, schrijf: (r) => regels.push(r), kop: { soort: 'proef', naam: 'speelapparaten', synthetisch: true } });
  const apparaten = maakApparaten({ systeem: sim.systeem, hid, hidReden: hid ? null : 'node-hid niet geïnstalleerd (test)', klok: echteKlok, config, logboek });
  apparaten.start();
  const bevindingen = await voerUit(speelapparaten, { apparaten, io: sim.io, klok: echteKlok, logboek, schaal: 0.01, gebruiker: sim.gebruiker, config, niProgrammas: () => ni });
  await apparaten.stop();
  return { bevindingen, regels, sim, apparaten };
}
const stappenVan = (regels) => leesLogboek(regels.join('\n')).regels.filter((x) => x.e === 'stap');

describe('proef speelapparaten met gesimuleerde gebruiker', () => {
  it('staat in de lijst van varve-hub proef', () => {
    expect(PROTOCOLLEN.speelapparaten).toBe(speelapparaten);
  });

  it('docs/HARDWARE-AVOND.md (blok 8) noemt elke stap, in dezelfde volgorde en met hetzelfde nummer als de terminal', () => {
    const draaiboek = readFileSync(new URL('../docs/HARDWARE-AVOND.md', import.meta.url), 'utf8');
    const blok = draaiboek.slice(draaiboek.indexOf('## 8. Xboard49 en Maschine MK2'));
    const rijen = [...blok.matchAll(/^\| (\d+) \| ([^|]+?) \|/gm)].map((m) => ({ nr: Number(m[1]), titel: m[2] }));
    expect(rijen).toEqual(speelapparaten.stappen.map((s, i) => ({ nr: i + 1, titel: s.titel })));
    expect(blok).toMatch(/node src\/cli\.js proef speelapparaten/);
    expect(blok).toMatch(/xboard49-profiel\.json/);
  });

  it('loopt alle stappen door zonder fouten en levert de bevindingen', async () => {
    const { bevindingen: b, regels, sim } = await draaiSpeel();
    const stappen = stappenVan(regels);
    expect(stappen.filter((x) => x.status === 'fout')).toEqual([]);
    expect(stappen.filter((x) => x.status === 'klaar').map((x) => x.id)).toEqual(speelapparaten.stappen.map((s) => s.id));
    // Xboard49
    expect(b['xb-poort']).toMatchObject({ naam: 'E-MU Xboard49', patroon: 'xboard' });
    expect(b['xb-toetsen']).toMatchObject({ bereik: 49, zacht: { velocity: 18 }, hard: { velocity: 122 } });
    expect(b['xboard49-profiel']).toMatchObject({ compleet: true, nrpn: false });
    expect(b['xboard49-profiel'].profiel.knoppen.map((k) => k.n)).toEqual(Array.from({ length: 16 }, (_, i) => 102 + i));
    expect(b['xb-wielen'].ontbrekend).toEqual([]);
    expect(b['xb-aftertouch']).toMatchObject({ soort: 'aftertouch' });
    expect(b['xb-pedaal']).toMatchObject({ gezien: true, los: true });
    expect(b['xb-schuif']).toMatchObject({ ontbrekend: [], sysex: true });
    expect(b['xb-patch'].berichten).toEqual([[0xb0, 0, 0], [0xb0, 32, 1], [0xc0, 5]]);
    expect(b['xb-paniek']).toMatchObject({ gezien: true, cc120: 16, cc123: 16, kanalen: Array.from({ length: 16 }, (_, i) => i + 1) });
    // Maschine
    expect(b['ms-zichtbaar']).toMatchObject({ gevonden: true, vidPid: '17cc:1140', ni: [] });
    expect(b['ms-openen']).toMatchObject({ status: 'verbonden', tcc: null });
    expect(b['ms-openen'].frames).toBeGreaterThan(0);
    expect(b['maschine-rust']).toMatchObject({ frames: RUST_FRAMES, lengtes: [65], nibbleKlopt: true });
    expect(b['maschine-rust'].ruisMax).toBeLessThan(b['maschine-rust'].los);
    expect(b['ms-orientatie']).toEqual({ linksboven: 'pad13', rechtsonder: 'pad4', klopt: true });
    expect(b['ms-pads']).toMatchObject({ ontbrekend: [], maxDruk: 4095, hard: 127 });
    expect(b['ms-pads'].zacht).toBeLessThan(20);
    expect(b['ms-knoppen'].ontbrekend).toEqual([]);
    expect(b['ms-encoders'].ontbrekend).toEqual([]);
    expect(b['ms-leds']).toMatchObject({ orientatie: { ok: true }, bereik: { ok: true }, zones: { ok: true }, led_max: 255 });
    expect(b['ms-scherm']).toMatchObject({ beeld: { ok: true }, leeg: { ok: true } });
    expect(b['ms-replug']).toMatchObject({ weg: { ok: true }, terug: { ok: true }, invoer: true, status: 'verbonden' });
    // de schermen kregen het testbeeld (links schaak, rechts strepen) en daarna leeg
    const schermen = sim.maschine.poort.verstuurd.filter((r) => (r[0] & 0xfe) === 0xe0);
    expect(schermen.length).toBeGreaterThanOrEqual(16);
  }, 30000);

  it('het logboek is uitgedund: de rustopname onverkort, verder alleen padrapporten die iets deden', async () => {
    const { regels } = await draaiSpeel();
    const r = leesLogboek(regels.join('\n')).regels;
    const pads = r.filter((x) => Array.isArray(x) && x[1] === 'in' && x[2] === 'maschine-mk2' && x[3][0] === 0x20);
    const virt = r.filter((x) => Array.isArray(x) && x[2] === 'maschine-mk2-midi');
    expect(pads.length).toBeGreaterThanOrEqual(RUST_FRAMES);
    expect(pads.length).toBeLessThan(RUST_FRAMES + 2 * virt.length + 10);
    // en het is een golden test: dezelfde bytes geven nu dezelfde betekenis
    const { getoetst, verschillen } = herspeel(regels.join('\n'));
    expect(getoetst).toBeGreaterThan(RUST_FRAMES);
    expect(verschillen).toEqual([]);
  }, 30000);

  it('Maschine bezet: de proef zegt wat te doen, en zodra het NI-programma dicht is gaat hij open', async () => {
    const sim = simulatie({ speel: true });
    sim.hid.zetBezet(sim.maschine.naam, true);
    sim.onderschep((w) => {
      if (w.stap !== 'ms-openen' || w.soort !== 'vraag' || !w.tekst.startsWith('Wat draait')) return false;
      sim.hid.zetBezet(sim.maschine.naam, false);
      sim.typ('Controller Editor stond nog open');
      return true;
    });
    const { bevindingen: b } = await draaiSpeel({ sim, ni: ['NIHardwareAgent', 'Controller Editor'] });
    expect(b['ms-zichtbaar'].ni).toEqual(['NIHardwareAgent', 'Controller Editor']);
    expect(b['ms-openen']).toMatchObject({ status: 'verbonden', bezetAntwoord: 'Controller Editor stond nog open' });
    expect(sim.getoond.join('\n')).toMatch(/bezet .*Controller Editor/);
  }, 30000);

  it('open maar geen invoer (macOS-Invoermonitoring): de vraag naar de TCC-melding, en de Maschine-stappen worden overgeslagen', async () => {
    const sim = simulatie({ speel: true, antwoorden: { 'ms-openen': 'ja, op Weigeren geklikt' } });
    sim.hid.bijOpen = null;   // dit toestel stuurt niets
    const { bevindingen: b, regels } = await draaiSpeel({ sim });
    expect(b['ms-openen']).toMatchObject({ status: 'geen-invoer', frames: 0, tcc: 'ja, op Weigeren geklikt' });
    expect(sim.getoond.join('\n')).toMatch(/Invoermonitoring/);
    expect(stappenVan(regels).filter((x) => x.status === 'fout')).toEqual([]);
  }, 30000);

  it('zonder HID (node-hid ontbreekt): de Maschine-stappen worden overgeslagen, de Xboard gaat gewoon door', async () => {
    const sim = simulatie({ speel: true });
    const { bevindingen: b, regels } = await draaiSpeel({ sim, hid: null });
    expect(b['ms-zichtbaar']).toEqual({ hid: false, reden: 'node-hid niet geïnstalleerd (test)' });
    const st = stappenVan(regels);
    expect(st.filter((x) => x.status === 'overgeslagen').map((x) => x.id)).toEqual(['ms-rust', 'ms-orientatie', 'ms-pads', 'ms-knoppen', 'ms-encoders', 'ms-leds', 'ms-scherm', 'ms-replug']);
    expect(b['xboard49-profiel'].compleet).toBe(true);
  }, 30000);

  it('geen keyboard aangesloten: de proef toont de ingangen en vraagt welke het is', async () => {
    const sim = simulatie({ speel: true, antwoorden: { 'xb-poort': 'Xboard Mk2 USB' } });
    sim.systeem.verwijder('E-MU Xboard49');
    const { bevindingen: b, regels } = await draaiSpeel({ sim });
    expect(b['xb-poort']).toMatchObject({ naam: null, welke: 'Xboard Mk2 USB', ingangen: ['APC40 mkII', 'LPD8 mk2'] });
    expect(stappenVan(regels).filter((x) => x.status === 'overgeslagen').map((x) => x.id)).toEqual(
      ['xb-toetsen', 'xb-knoppen', 'xb-wielen', 'xb-aftertouch', 'xb-pedaal', 'xb-schuif', 'xb-patch', 'xb-paniek']);
  }, 30000);
});
