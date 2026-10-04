// Paniek voor de driver-apps (golf 6): LPD8-P1 (1 s vasthouden) en Stop All bereiken ook uurwerk (HTTP),
// Sediment (Logic, MIDI) en Scene Kit (TouchDesigner, MIDI). Getoetst met de echte kern, de echte drivers
// (src/drivers/midi.js, http.js via startDrivers) en de manifesten uit apps/ en uit de generator; de klok is
// een NepKlok. Achtergrond: docs/VOLGENDE-KOPPELINGEN.md §3.4, §4.4, §5.4; PROTOCOL.md §14.
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { NepSysteem } from '../src/ports/nep.js';
import { startDrivers, valideerStatisch, APPS_MAP } from '../src/drivers/index.js';
import { PANIEK_MS } from '../src/core/kern.js';
import { sceneKitManifest, opmaak, genereer } from '../tools/genereer-manifesten.mjs';
import { CONFIG, opzet, lpdDruk, lpdLos, druk, los } from './kern-hulp.js';

const KOPPELING = new URL('../koppelingen/av-scene-kit/', import.meta.url);
const patchNaam = () => readdirSync(KOPPELING).find((n) => n.endsWith('.patch'));
const patchTekst = () => readFileSync(new URL(patchNaam(), KOPPELING), 'utf8');

/** midi.pads zoals de TD-patch ze in av-scene-kit/config.json zet (uit de patch zelf gelezen). */
function padsUitPatch() {
  const m = /^\+\s*"pads":\s*(\{.*\}),?\s*$/m.exec(patchTekst());
  if (!m) throw new Error('de patch zet geen midi.pads in config.json');
  return JSON.parse(m[1]);
}

/** av-scene-kit/config.json (midi + knobs), zoals in de kit. */
const kit = (pads) => ({
  midi: { channel: 1, knob_cc: [20, 21, 22, 23, 24, 25, 26, 27], pads },
  knobs: {
    1: { name: 'feedback', target: 'td' }, 2: { name: 'mix', target: 'td' }, 3: { name: 'glitch', target: 'td' },
    4: { name: 'emission', target: 'blender' }, 5: { name: 'height', target: 'blender' }, 6: { name: 'orbit', target: 'blender' },
    7: { name: 'hue', target: 'blender' }, 8: { name: 'master_dim', target: 'td' },
  },
});
const PRESETS = [
  { naam: 'spiegel', knoppen: [0.85, 0.5, 0.1, 0.35, 0.3, 0.15, 0.55, 1] },
  { naam: 'datamosh', knoppen: [0.96, 0.7, 0.8, 0.7, 0.6, 0.5, 0.9, 1] },
  { naam: 'pixelregen', knoppen: [0.6, 0.3, 0.45, 0.9, 0.85, 0.7, 0.15, 0.95] },
  { naam: 'stil', knoppen: [0.3, 0.9, 0, 0.2, 0.1, 0.05, 0.6, 0.8] },
];
const ZONDER_PANIEK = { preset1: 36, preset2: 37, preset3: 38, preset4: 39, record: 40, takelog: 41 };

const APPS = {
  uurwerk: { naam: 'Uurwerk', kleur: '#ffb000', koppeling: 'http', poort: 8766 },
  sediment: { naam: 'Sediment', kleur: '#ffffff', koppeling: 'midi', midipoort: 'VARVE-HUB Logic' },
  'av-scene-kit': { naam: 'Scene Kit (TD)', kleur: '#ff2bd6', koppeling: 'midi', midipoort: 'VARVE-HUB TD' },
};

const rust = () => new Promise((r) => setImmediate(r));
/**
 * Laat de nep-klok in stapjes lopen en de beloftes daartussen afhandelen: zo slagen de gezondheidschecks van
 * de uurwerk-driver binnen hun time-out (anders lijkt de brug weg en speelt de kern bij herstel alles opnieuw af).
 */
async function verder(klok, ms, stap = 100) {
  for (let t = 0; t < ms; t += stap) { klok.loop(Math.min(stap, ms - t)); await rust(); }
}

/** Nep-uurwerk-brug: gezond met één tab; houdt elke POST /verb bij. */
function nepBrug() {
  const verbs = [];
  const fetch = async (url, init = {}) => {
    if (url.endsWith('/verb')) { verbs.push(JSON.parse(init.body)); return { ok: true, status: 200, text: async () => '{}' }; }
    return { ok: true, status: 200, text: async () => 'uurwerk-brug · tabs: 1' };
  };
  return { fetch, verbs };
}

const opgeruimd = [];
afterEach(() => { while (opgeruimd.length) opgeruimd.pop()(); });

/**
 * Een avond met de drie driver-apps aan de echte kern: uurwerk en Sediment uit apps/, Scene Kit uit de
 * generator met de midi.pads van de kit (standaard: zoals na de TD-patch).
 */
async function avond({ pads = padsUitPatch() } = {}) {
  const config = { ...CONFIG, apps: { ...CONFIG.apps, ...APPS } };
  const h = opzet(config);
  const map = mkdtempSync(join(tmpdir(), 'paniek-drivers-'));
  writeFileSync(join(map, 'uurwerk.json'), readFileSync(join(APPS_MAP, 'uurwerk.json')));
  writeFileSync(join(map, 'sediment.json'), readFileSync(join(APPS_MAP, 'sediment.json')));
  writeFileSync(join(map, 'av-scene-kit.json'), opmaak(sceneKitManifest(kit(pads), APPS['av-scene-kit'], PRESETS)));
  const systeem = new NepSysteem();
  const brug = nepBrug();
  const log = [];
  const d = startDrivers({ kern: h.kern, klok: h.klok, systeem, fetch: brug.fetch, config, map, uitstel_ms: 0, log: (...a) => log.push(a.join(' ')) });
  opgeruimd.push(() => { d.stop(); h.kern.stop(); rmSync(map, { recursive: true, force: true }); });
  await rust(); // de eerste gezondheidscheck van uurwerk
  const td = systeem.apparaten.get('VARVE-HUB TD');
  const logic = systeem.apparaten.get('VARVE-HUB Logic');
  expect(td && logic, 'beide virtuele poorten open').toBeTruthy();
  /** Alles wat de drie apps vanaf nu krijgen. */
  const sinds = () => {
    const n = { td: td.verstuurd.length, logic: logic.verstuurd.length, uurwerk: brug.verbs.length };
    return () => ({ td: td.verstuurd.slice(n.td), logic: logic.verstuurd.slice(n.logic), uurwerk: brug.verbs.slice(n.uurwerk) });
  };
  const waarden = (app) => h.kern.beeld().apps.find((a) => a.app === app)?.waarden ?? {};
  return { ...h, d, td, logic, brug, sinds, waarden, log };
}

describe('paniek voor de driver-apps: LPD8-P1 vasthouden met de echte drivers', () => {
  it('alle drie de driver-apps hebben een trigger paniek (anders stuurt de kern hem niet, kern.js #paniek)', async () => {
    const a = await avond();
    for (const app of ['uurwerk', 'sediment', 'av-scene-kit']) {
      const p = a.kern.beeld().apps.find((x) => x.app === app)?.params.find((x) => x.id === 'paniek');
      expect(p, app).toMatchObject({ soort: 'trigger' });
    }
  });

  it('P1 korter dan 1 s: niets naar TD, Logic of uurwerk', async () => {
    const a = await avond();
    const nu = a.sinds();
    lpdDruk(a.kern, 1);
    a.klok.loop(PANIEK_MS - 1);
    lpdLos(a.kern, 1);
    await verder(a.klok, 2000);
    expect(nu()).toEqual({ td: [], logic: [], uurwerk: [] });
    expect(a.kern.beeld().globaal.paniek ?? 0).toBe(0);
  });

  it('P1 1 s vasthouden: TD krijgt noot 42, Logic CC 123 (alle noten uit), uurwerk pas_toe "+master 0.00" zonder wachten', async () => {
    const a = await avond();
    const nu = a.sinds();
    lpdDruk(a.kern, 1);
    a.klok.loop(PANIEK_MS - 1);
    expect(nu()).toEqual({ td: [], logic: [], uurwerk: [] }); // nog geen paniek
    a.klok.loop(1);
    await rust();
    const r = nu();
    expect(r.td).toEqual([[0x90, 42, 127]]);
    expect(r.logic).toEqual([[0xb0, 123, 127]]);
    expect(r.uurwerk).toEqual([{ verb: 'pas_toe', args: { diff: '+master 0.00', meet_seconden: -1 }, auteur: 'varve-hub' }]);
    expect(a.kern.beeld().globaal.paniek).toBe(1);
  });

  it('TD: de hub weet dat de master dicht is (master_dim 0, zoals een preset); de andere knoppen blijven', async () => {
    const a = await avond();
    const voor = a.waarden('av-scene-kit');
    expect(voor.master_dim).toBe(1); // standaard = preset 1
    lpdDruk(a.kern, 1);
    a.klok.loop(PANIEK_MS);
    a.klok.loop(1); // de driver meldt de preset uitgesteld (klok, 0 ms)
    const na = a.waarden('av-scene-kit');
    expect(na.master_dim).toBe(0);
    expect({ ...na, master_dim: voor.master_dim }).toEqual(voor);
    // de hub stuurt CC 27 = 0 niet zelf nog eens (TD deed het al): alleen de noot ging naar TD
    expect(a.td.verstuurd.filter((b) => b[0] === 0xb0 && b[1] === 27)).toEqual([]);
  });

  it('P1 loslaten: TD note-off 42, Logic nog eens CC 123, uurwerk niets; niets blijft hangen en alles werkt daarna', async () => {
    const a = await avond();
    lpdDruk(a.kern, 1);
    a.klok.loop(PANIEK_MS);
    await rust();
    const nu = a.sinds();
    lpdLos(a.kern, 1);
    await verder(a.klok, 6000); // voorbij paniek.naloop_s
    const r = nu();
    expect(r.td).toEqual([[0x80, 42, 0]]);
    expect(r.logic).toEqual([[0xb0, 123, 0]]); // All Notes Off kijkt niet naar de waarde: nogmaals noten uit
    expect(r.uurwerk).toEqual([]); // werkwoorden alleen bij indrukken (http.js); terug met master_terug
    expect(a.kern.beeld().globaal.paniek).toBe(0);
    for (const drv of a.d.drivers) if (drv.klinkt) expect([...drv.klinkt.keys()], drv.manifest.app).toEqual([]);

    // daarna gewoon verder spelen: een Sediment-parameter, de uurwerk-master terug, en een tweede paniek
    const daarna = a.sinds();
    a.kern.cockpit({ t: 'zet', app: 'sediment', id: 'cutoff', v: 1 });
    a.kern.cockpit({ t: 'zet', app: 'uurwerk', id: 'master_terug', v: 1 });
    await verder(a.klok, 5000); // slew_s van de cockpit
    expect(daarna().logic.at(-1)).toEqual([0xb0, 26, 127]); // cutoff = CC 26 (apps/sediment.json)
    expect(daarna().uurwerk).toEqual([{ verb: 'pas_toe', args: { diff: '+master 0.80', meet_seconden: -1 }, auteur: 'varve-hub' }]);
    const tweede = a.sinds();
    lpdDruk(a.kern, 1);
    a.klok.loop(PANIEK_MS);
    await rust();
    expect(tweede().td).toEqual([[0x90, 42, 127]]); // een echte overgang uit → aan, geen dubbele note-off ervoor
    expect(tweede().logic).toEqual([[0xb0, 123, 127]]);
    expect(tweede().uurwerk.map((v) => v.args.diff)).toEqual(['+master 0.00']);
    lpdLos(a.kern, 1);
  });

  it('Stop All met Sediment in focus: CC 123 bij indrukken en loslaten, alleen naar Sediment', async () => {
    const a = await avond();
    a.kern.focus('sediment');
    const nu = a.sinds();
    druk(a.kern, 'stopall');
    expect(nu().logic).toEqual([[0xb0, 123, 127]]);
    los(a.kern, 'stopall');
    await rust();
    expect(nu()).toEqual({ td: [], logic: [[0xb0, 123, 127], [0xb0, 123, 0]], uurwerk: [] });
  });

  it('TD zonder paniek-noot in de kit (patch nog niet toegepast): de hub stuurt TD niets en denkt niet dat de master dicht is', async () => {
    const a = await avond({ pads: ZONDER_PANIEK });
    const nu = a.sinds();
    lpdDruk(a.kern, 1);
    a.klok.loop(PANIEK_MS + 1);
    await rust();
    const r = nu();
    expect(r.td).toEqual([]);
    expect(r.logic).toEqual([[0xb0, 123, 127]]);
    expect(r.uurwerk).toHaveLength(1);
    expect(a.waarden('av-scene-kit').master_dim).toBe(1);
    lpdLos(a.kern, 1);
  });
});

describe('generator: paniek voor Scene Kit en Sediment', () => {
  it('Scene Kit: midi.pads.paniek → trigger paniek op die noot + preset master_dim 0; zonder sleutel geen paniek', () => {
    const met = sceneKitManifest(kit({ ...ZONDER_PANIEK, paniek: 42 }), APPS['av-scene-kit'], PRESETS);
    expect(valideerStatisch(met).ok).toBe(true);
    expect(met.params.at(-1)).toEqual({ id: 'paniek', naam: 'Paniek: master dicht', soort: 'trigger', hint: 'pad', groep: 'veilig' });
    expect(met.driver.map.paniek).toEqual({ noot: 42 });
    expect(met.driver.presets.at(-1)).toEqual({ noot: 42, waarden: { master_dim: 0 } });
    expect(met.driver.scenes).toHaveLength(4); // paniek is geen scène
    const zonder = sceneKitManifest(kit(ZONDER_PANIEK), APPS['av-scene-kit'], PRESETS);
    expect(zonder.params.map((p) => p.id)).not.toContain('paniek');
    expect(zonder.driver.presets.map((p) => p.noot)).toEqual([36, 37, 38, 39]);
  });
});

describe('koppelingen/av-scene-kit: de TD-patch', () => {
  it('bestaat met een LEESMIJ, zet midi.pads.paniek = 42 en raakt alleen TD-bestanden en config.json → midi', () => {
    expect(existsSync(new URL('LEESMIJ.md', KOPPELING))).toBe(true);
    expect(patchNaam()).toBeTruthy();
    const pads = padsUitPatch();
    expect(pads.paniek).toBe(42);
    expect(Object.entries(pads).filter(([k]) => k !== 'paniek')).toEqual(Object.entries(ZONDER_PANIEK));
    const bestanden = [...patchTekst().matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]).sort();
    expect(bestanden).toEqual(['config.json', 'td/_mock_td_test.py', 'td/td_build_hub.py']);
    expect(patchTekst()).toMatch(/^\+\s+elif 'paniek' in NOTES and n == /m);
  });

  const KIT = '/home/user/av-scene-kit';
  let python = false;
  try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); python = true; } catch { /* geen python */ }
  it.runIf(existsSync(join(KIT, '.git')) && python)('past op av-scene-kit; daarna is de TD-mocktest groen en geeft de generator paniek op noot 42', () => {
    const kopie = mkdtempSync(join(tmpdir(), 'ask-paniek-'));
    opgeruimd.push(() => rmSync(kopie, { recursive: true, force: true }));
    execFileSync('git', ['clone', '-q', KIT, kopie]);
    const patch = new URL(patchNaam(), KOPPELING).pathname;
    let alToegepast = false;
    try { execFileSync('git', ['-C', kopie, 'apply', '--check', patch], { stdio: 'pipe' }); } catch {
      execFileSync('git', ['-C', kopie, 'apply', '--reverse', '--check', patch], { stdio: 'pipe' }); // anders: past niet meer
      alToegepast = true;
    }
    if (!alToegepast) execFileSync('git', ['-C', kopie, 'apply', patch]);
    const uit = execFileSync('python3', [join(kopie, 'td', '_mock_td_test.py')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    expect(uit).toMatch(/pad 42 → paniek: knob8 vast op 0/);
    expect(uit).toMatch(/\n0 fouten\s*$/);
    const m = genereer({ sceneKit: kopie })['av-scene-kit.json'];
    expect(valideerStatisch(m).ok).toBe(true);
    expect(m.driver.map.paniek).toEqual({ noot: 42 });
    expect(m.driver.presets.at(-1)).toEqual({ noot: 42, waarden: { master_dim: 0 } });
  }, 30000);
});
