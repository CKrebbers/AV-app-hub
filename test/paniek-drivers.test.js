// Paniek voor de driver-apps (golf 6): LPD8-P1 (1 s vasthouden) en Stop All bereiken ook uurwerk (HTTP),
// Sediment (Logic, MIDI) en Scene Kit (TouchDesigner, MIDI). Getoetst met de echte kern, de echte drivers
// (src/drivers/midi.js, http.js via startDrivers) en de manifesten uit apps/ en uit de generator; de klok is
// een NepKlok. Achtergrond: docs/VOLGENDE-KOPPELINGEN.md §3.4, §4.4, §5.4; PROTOCOL.md §14.
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { NepSysteem } from '../src/ports/nep.js';
import { startDrivers, valideerStatisch, APPS_MAP } from '../src/drivers/index.js';
import { PANIEK_MS } from '../src/core/kern.js';
import { sceneKitManifest, opmaak, genereer } from '../tools/genereer-manifesten.mjs';
import { CONFIG, opzet, lpdDruk, lpdLos, lpdKnop, druk, los, draai } from './kern-hulp.js';

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
async function avond({ pads = padsUitPatch(), fetch = undefined } = {}) {
  const config = { ...CONFIG, apps: { ...CONFIG.apps, ...APPS } };
  const h = opzet(config);
  const map = mkdtempSync(join(tmpdir(), 'paniek-drivers-'));
  writeFileSync(join(map, 'uurwerk.json'), readFileSync(join(APPS_MAP, 'uurwerk.json')));
  writeFileSync(join(map, 'sediment.json'), readFileSync(join(APPS_MAP, 'sediment.json')));
  writeFileSync(join(map, 'av-scene-kit.json'), opmaak(sceneKitManifest(kit(pads), APPS['av-scene-kit'], PRESETS)));
  const systeem = new NepSysteem();
  const brug = nepBrug();
  if (fetch) { const echt = brug.fetch; brug.fetch = fetch(echt); }
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
    const midi = a.d.drivers.map((x) => x.driver).filter((x) => x.klinkt);
    expect(midi.map((x) => x.manifest.app).sort()).toEqual(['av-scene-kit', 'sediment']);
    for (const drv of midi) expect([...drv.klinkt.keys()], drv.manifest.app).toEqual([]);

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

const KIT = '/home/user/av-scene-kit';
let python = false;
try { execFileSync('python3', ['--version'], { stdio: 'ignore' }); python = true; } catch { /* geen python */ }
const kitHier = existsSync(join(KIT, '.git')) && python;

/** Eén kloon van av-scene-kit met de TD-patch erop (gedeeld door de tests hieronder). */
let kloon = /** @type {string|null} */ (null);
function kitMetPatch() {
  if (kloon) return kloon;
  const kopie = mkdtempSync(join(tmpdir(), 'ask-paniek-'));
  execFileSync('git', ['clone', '-q', KIT, kopie]);
  const patch = new URL(patchNaam(), KOPPELING).pathname;
  let alToegepast = false;
  try { execFileSync('git', ['-C', kopie, 'apply', '--check', patch], { stdio: 'pipe' }); } catch {
    execFileSync('git', ['-C', kopie, 'apply', '--reverse', '--check', patch], { stdio: 'pipe' }); // anders: past niet meer
    alToegepast = true;
  }
  if (!alToegepast) execFileSync('git', ['-C', kopie, 'apply', patch]);
  kloon = kopie;
  return kopie;
}
afterAll(() => { if (kloon) rmSync(kloon, { recursive: true, force: true }); });

/**
 * Speel alles wat de hub naar "VARVE-HUB TD" stuurde af op de echte TD-code (test/td-master.py op de kloon met
 * de patch) en geef ctrl.knob8 (de master die TD laat zien) na elk bericht.
 * @param {number[][]} berichten @returns {number[]}
 */
function tdMaster(berichten) {
  const uit = execFileSync('python3', [new URL('td-master.py', import.meta.url).pathname, kitMetPatch()], {
    input: JSON.stringify(berichten), encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 1 << 24,
  });
  return JSON.parse(uit);
}

describe.runIf(kitHier)('na een TD-paniek lopen hub en TD niet uit de pas (echte TD-code uit de patch)', () => {
  /** Paniek met P1 (1 s), loslaten, de naloop voorbij. */
  async function paniek(a) {
    lpdDruk(a.kern, 1);
    a.klok.loop(PANIEK_MS);
    a.klok.loop(1);
    await rust();
    lpdLos(a.kern, 1);
    await verder(a.klok, 6000);
  }
  /** master_dim volgens de hub en volgens TD (na alles wat de hub tot nu toe naar TD stuurde). */
  const meesters = (a) => ({ hub: a.waarden('av-scene-kit').master_dim, td: tdMaster(a.td.verstuurd).at(-1) });
  const gelijk = (m, v) => { expect(m.hub).toBeCloseTo(v, 2); expect(m.td).toBeCloseTo(v, 2); };

  it('de paniek zelf: hub en TD allebei 0', async () => {
    const a = await avond();
    gelijk(meesters(a), 1); // preset 1
    await paniek(a);
    gelijk(meesters(a), 0);
  });

  it('K2 (macro.helderheid) op 1.0, paniek, dan K2 naar 0.7: TD gaat mee open (§14: de eerste tik zet alle apps)', async () => {
    const a = await avond();
    // K2 pakt eerst uurwerk-licht op (0,5: de eerste app met macro.helderheid), dan omhoog naar 1.0
    for (const v of [0.4, 0.6, 0.8, 1.0]) { lpdKnop(a.kern, 2, v); a.klok.loop(50); }
    await verder(a.klok, 6000);
    gelijk(meesters(a), 1);
    await paniek(a);
    gelijk(meesters(a), 0);
    for (const v of [0.9, 0.8, 0.7]) { lpdKnop(a.kern, 2, v); a.klok.loop(50); }
    gelijk(meesters(a), 0.7);
  });

  it('cockpit zet master_dim op 0,6 na de paniek: TD volgt (toont niet open terwijl het beeld zwart is)', async () => {
    const a = await avond();
    await paniek(a);
    a.kern.cockpit({ t: 'zet', app: 'av-scene-kit', id: 'master_dim', v: 0.6 });
    await verder(a.klok, 6000);
    gelijk(meesters(a), 0.6);
  });

  it('snapshot laden na de paniek: TD volgt de snapshotwaarde', async () => {
    const a = await avond();
    a.kern.cockpit({ t: 'zet', app: 'av-scene-kit', id: 'master_dim', v: 0.8 });
    await verder(a.klok, 6000);
    a.kern.bewaar(1);
    await paniek(a);
    const n = a.td.verstuurd.length;
    a.kern.laad(1);
    await verder(a.klok, 6000);
    // de snapshot springt terug naar precies de bytes die TD vóór de paniek al had (CC 27 = 102): een MIDI In
    // CHOP ziet dan geen verandering. De driver stuurt eerst een stapje ernaast (midi.js #zet).
    expect(a.td.verstuurd.slice(n)).toEqual([[0xb0, 27, 101], [0xb0, 27, 102]]);
    gelijk(meesters(a), 0.8);
  });

  it('APC-fader in sprongen 1.0 → 0 → 0,5 na de paniek: CC 27 = 0 gaat naar TD, daarna volgen hub en TD 0,5', async () => {
    const a = await avond();
    a.kern.focus('av-scene-kit');
    draai(a.kern, 'fader4', 0.99); draai(a.kern, 'fader4', 1.0); a.klok.loop(10);
    await paniek(a);
    const n = a.td.verstuurd.length;
    draai(a.kern, 'fader4', 0); a.klok.loop(50);
    // de dubbelfilter vergat master_dim bij de paniek-preset (midi.js #meldPreset): de 0 gaat echt over de draad
    expect(a.td.verstuurd.slice(n)).toEqual([[0xb0, 27, 0]]);
    gelijk(meesters(a), 0);
    draai(a.kern, 'fader4', 0.5); a.klok.loop(50);
    gelijk(meesters(a), 0.5);
  });

  it('een preset-pad na de paniek: hub en TD op de presetwaarde', async () => {
    const a = await avond();
    await paniek(a);
    a.kern.cockpit({ t: 'zet', app: 'av-scene-kit', id: 'preset3', v: 1 });
    a.klok.loop(1);
    a.kern.cockpit({ t: 'zet', app: 'av-scene-kit', id: 'preset3', v: 0 });
    a.klok.loop(1);
    gelijk(meesters(a), PRESETS[2].knoppen[7]);
  });
});

describe('uurwerk: paniek als de brug net onbereikbaar leek', () => {
  it('de check liep over zijn time-out, de tab speelt gewoon: P1 stuurt pas_toe toch (en logt het)', async () => {
    let ziek = false;
    const a = await avond({
      fetch: (echt) => async (url, init = {}) => {
        if (!url.endsWith('/verb') && ziek) throw new Error('time-out');
        return echt(url, init);
      },
    });
    ziek = true;
    await verder(a.klok, 2500); // een mislukte gezondheidscheck: de driver denkt 'onbereikbaar'
    const uw = a.d.drivers.map((x) => x.driver).find((x) => x.manifest.app === 'uurwerk');
    expect(uw.bereikbaar).toBe(false);
    const nu = a.sinds();
    lpdDruk(a.kern, 1);
    a.klok.loop(PANIEK_MS);
    await rust();
    expect(nu().uurwerk.map((v) => v.args.diff)).toEqual(['+master 0.00']);
    expect(a.log.some((r) => /onbereikbaar; trigger pas_toe toch verstuurd/.test(r))).toBe(true);
    lpdLos(a.kern, 1);
  });
});

describe('generator: een bronmap die er niet is', () => {
  it('geeft een leesbare melding met de vlag die het pad zet, geen stacktrace (exit 2)', () => {
    const gen = new URL('../tools/genereer-manifesten.mjs', import.meta.url).pathname;
    const leeg = mkdtempSync(join(tmpdir(), 'geen-kit-'));
    opgeruimd.push(() => rmSync(leeg, { recursive: true, force: true }));
    for (const [vlag, repo] of [['--scene-kit', 'av-scene-kit'], ['--sediment', 'sediment']]) {
      let fout;
      try { execFileSync('node', [gen, vlag, leeg, '--toets'], { stdio: 'pipe', encoding: 'utf8' }); } catch (e) { fout = e; }
      expect(fout?.status, vlag).toBe(2);
      expect(fout.stderr).toContain(`${repo} niet gevonden op ${leeg}`);
      expect(fout.stderr).toContain(`geef ${vlag} <pad naar ${repo}>`);
      expect(fout.stderr).not.toMatch(/^\s+at /m);
    }
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

  it.runIf(kitHier)('past op av-scene-kit; daarna is de TD-mocktest groen en geeft de generator paniek op noot 42', () => {
    const kopie = kitMetPatch();
    const uit = execFileSync('python3', [join(kopie, 'td', '_mock_td_test.py')], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    expect(uit).toMatch(/pad 42 → paniek: knob8 vast op 0/);
    expect(uit).toMatch(/\n0 fouten\s*$/);
    const m = genereer({ sceneKit: kopie })['av-scene-kit.json'];
    expect(valideerStatisch(m).ok).toBe(true);
    expect(m.driver.map.paniek).toEqual({ noot: 42 });
    expect(m.driver.presets.at(-1)).toEqual({ noot: 42, waarden: { master_dim: 0 } });
  }, 30000);
});
