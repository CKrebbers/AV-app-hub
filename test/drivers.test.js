import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NepKlok } from '../src/core/klok.js';
import { NepSysteem } from '../src/ports/nep.js';
import { valideerManifest } from '../src/protocol/manifest.js';
import { leesVanApp, leesNaarApp } from '../src/protocol/berichten.js';
import { maakDriver, valideerStatisch, laadStatisch, startDrivers, midiBytes, verbBericht, APPS_MAP } from '../src/drivers/index.js';
import { CHECK_TIMEOUT_MS, POST_TIMEOUT_MS } from '../src/drivers/http.js';
import { genereer, opmaak, leesParamsH, leesPresets, naarGenormaliseerd, sedimentManifest, sceneKitManifest, VERBODEN_CC } from '../tools/genereer-manifesten.mjs';
import { laadConfig } from '../src/config.js';

/** Kleine nep-kern volgens het contract (src/core/kern.js): verbind / ontvang / verbreek. */
class NepKern {
  constructor() {
    this.verbindingen = [];
    this.ontvangen = []; // [app, bericht]
    this.verbroken = [];
    this.waarden = {}; // truth:"hub": laatst bekende waarden per app
  }
  verbind(v) { this.verbindingen.push(v); }
  ontvang(v, ruw) {
    const r = leesVanApp(ruw);
    if (!r.ok || r.onbekend) throw new Error(`ongeldig bericht van driver: ${JSON.stringify(ruw)}`);
    const b = r.bericht;
    if (b.t === 'hallo') v.app = b.app;
    if (b.t === 'manifest') {
      const m = valideerManifest(b.manifest);
      if (!m.ok) { v.stuur({ t: 'fout', reden: m.fouten.join('; ') }); return; }
      if ('driver' in b.manifest) throw new Error('driver-veld lekt naar de kern');
      this.manifest = m.manifest;
    }
    this.ontvangen.push([v.app, b]);
    // replay bij hallo (truth:"hub")
    if (b.t === 'hallo') for (const [id, w] of Object.entries(this.waarden[b.app] ?? {})) v.stuur({ t: 'zet', id, v: w, bron: 'replay' });
  }
  verbreek(v) { this.verbroken.push(v.app); }
  /** zoals de kern naar een app stuurt; controleert de vorm */
  stuur(v, b) {
    const r = leesNaarApp(b);
    if (!r.ok) throw new Error(r.fout);
    if (b.t === 'zet') (this.waarden[v.app] ??= {})[b.id] = b.v;
    v.stuur(b);
  }
  soorten() { return this.ontvangen.map(([, b]) => b.t); }
}

const leesApp = (naam) => JSON.parse(readFileSync(join(APPS_MAP, naam), 'utf8'));

// ───────────────────────── statische manifesten ─────────────────────────

describe('statische manifesten (apps/*.json)', () => {
  const bestanden = readdirSync(APPS_MAP).filter((n) => n.endsWith('.json'));
  it('er zijn er minstens drie: av-scene-kit, sediment, uurwerk', () => {
    expect(bestanden).toEqual(expect.arrayContaining(['av-scene-kit.json', 'sediment.json', 'uurwerk.json']));
  });
  for (const naam of bestanden) {
    it(`${naam} is een geldig manifest met een passende driver`, () => {
      const s = leesApp(naam);
      const { driver, ...m } = s;
      expect(valideerManifest(m)).toMatchObject({ ok: true });
      const r = valideerStatisch(s);
      expect(r.ok ? [] : r.fouten).toEqual([]);
      expect(s.app + '.json').toBe(naam);
      expect(s.truth).toBe('hub');
      expect(driver).toBeTruthy();
    });
  }
  it('laadStatisch leest ze allemaal zonder fouten', () => {
    const { statisch, fouten } = laadStatisch();
    expect(fouten).toEqual([]);
    expect(statisch.map((s) => s.app).sort()).toEqual(bestanden.map((b) => b.replace('.json', '')).sort());
  });
  it('kleur, naam en MIDI-poort komen overeen met config.json (huisregel 6)', () => {
    const cfg = laadConfig();
    for (const s of laadStatisch().statisch) {
      const c = cfg.apps[s.app];
      expect(c, s.app).toBeTruthy();
      expect(s.naam).toBe(c.naam);
      expect(s.kleur).toBe(c.kleur);
      if (s.driver.soort === 'midi') expect(s.driver.poort).toBe(c.midipoort);
      if (s.driver.soort === 'http') expect(s.driver.url).toBe(`http://127.0.0.1:${c.poort}`);
    }
  });
  it('valideerStatisch vindt fouten in de driver', () => {
    const s = leesApp('av-scene-kit.json');
    const kapot = { ...s, driver: { ...s.driver, map: { ...s.driver.map, feedback: { cc: 200 }, mix: { cc: 22 }, onbekend: { noot: 1 } } } };
    const r = valideerStatisch(kapot);
    expect(r.ok).toBe(false);
    expect(r.fouten.join('\n')).toMatch(/feedback: cc moet 0..127/);
    expect(r.fouten.join('\n')).toMatch(/al gebruikt door/);
    expect(r.fouten.join('\n')).toMatch(/onbekend: geen param/);
    expect(valideerStatisch({ ...s, truth: 'app' }).ok).toBe(false);
    expect(valideerStatisch({ ...s, driver: { soort: 'osc' } }).ok).toBe(false);
    const u = leesApp('uurwerk.json');
    const r2 = valideerStatisch({ ...u, driver: { ...u.driver, verbs: { ...u.driver.verbs, onrust: { verb: 'macro' } } } });
    expect(r2.ok ? [] : r2.fouten).toEqual(['driver.verbs.onrust: waarde (naam van het argument) nodig voor een waarde']);
  });
  it('laadStatisch slaat kapotte bestanden over in plaats van te gooien', () => {
    const map = mkdtempSync(join(tmpdir(), 'apps-'));
    writeFileSync(join(map, 'kapot.json'), '{ niet json');
    writeFileSync(join(map, 'leeg.json'), '{}');
    writeFileSync(join(map, 'uurwerk.json'), JSON.stringify(leesApp('uurwerk.json')));
    const r = laadStatisch(map);
    expect(r.statisch.map((s) => s.app)).toEqual(['uurwerk']);
    expect(r.fouten.map((f) => f.bestand)).toEqual(['kapot.json', 'leeg.json']);
    expect(laadStatisch(join(map, 'bestaat-niet')).fouten).toHaveLength(1);
  });
});

// ───────────────────────── MIDI-driver ─────────────────────────

describe('MIDI-bytes', () => {
  it('CC: round(v·127) op het juiste kanaal', () => {
    expect(midiBytes({ cc: 20 }, 'waarde', 0, 0)).toEqual([0xb0, 20, 0]);
    expect(midiBytes({ cc: 20 }, 'waarde', 1, 0)).toEqual([0xb0, 20, 127]);
    expect(midiBytes({ cc: 27 }, 'waarde', 0.5, 0)).toEqual([0xb0, 27, 64]);
    expect(midiBytes({ cc: 21, kanaal: 3 }, 'waarde', 0.25, 0)).toEqual([0xb3, 21, 32]);
    expect(midiBytes({ cc: 21 }, 'waarde', 0.25, 9)).toEqual([0xb9, 21, 32]);
  });
  it('noot: trigger aan/uit en schakelaar 1/0', () => {
    expect(midiBytes({ noot: 36 }, 'trigger', true, 0)).toEqual([0x90, 36, 127]);
    expect(midiBytes({ noot: 36 }, 'trigger', false, 0)).toEqual([0x80, 36, 0]);
    expect(midiBytes({ noot: 40 }, 'schakelaar', 1, 0)).toEqual([0x90, 40, 127]);
    expect(midiBytes({ noot: 40 }, 'schakelaar', 0, 0)).toEqual([0x80, 40, 0]);
    expect(midiBytes({ cc: 64 }, 'schakelaar', 1, 0)).toEqual([0xb0, 64, 127]);
    expect(midiBytes({}, 'waarde', 1, 0)).toBe(null);
  });
});

describe('MIDI-driver (av-scene-kit → "VARVE-HUB TD")', () => {
  const opzet = () => {
    const klok = new NepKlok(), systeem = new NepSysteem(), kern = new NepKern();
    const d = maakDriver(leesApp('av-scene-kit.json'), { systeem, klok });
    d.start(kern);
    const poort = systeem.apparaten.get('VARVE-HUB TD');
    return { klok, systeem, kern, d, poort, v: d.verbinding };
  };

  it('opent de virtuele poort en meldt zich aan: verbind, hallo, manifest', () => {
    const { kern, poort, v } = opzet();
    expect(poort).toBeTruthy();
    expect(kern.verbindingen).toEqual([v]);
    expect(kern.soorten()).toEqual(['hallo', 'manifest']);
    expect(v.app).toBe('av-scene-kit');
    expect(kern.manifest.params.map((p) => p.id)).toContain('master_dim');
  });

  it('hartslag elke seconde, altijd bereikbaar', () => {
    const { klok, kern } = opzet();
    klok.loop(3500);
    expect(kern.soorten().filter((t) => t === 'hb')).toHaveLength(3);
  });

  it('zet → CC 20-27, ook CC 24-27 die de echte APC nooit stuurt (ONDERZOEK §3.7)', () => {
    const { kern, poort, v } = opzet();
    kern.stuur(v, { t: 'zet', id: 'feedback', v: 1 });
    kern.stuur(v, { t: 'zet', id: 'height', v: 0.5 });
    kern.stuur(v, { t: 'zet', id: 'master_dim', v: 0 });
    expect(poort.verstuurd).toEqual([[0xb0, 20, 127], [0xb0, 24, 64], [0xb0, 27, 0]]);
  });

  it('stuurt dubbele waarden niet opnieuw', () => {
    const { kern, poort, v } = opzet();
    kern.stuur(v, { t: 'zet', id: 'mix', v: 0.5 });
    kern.stuur(v, { t: 'zet', id: 'mix', v: 0.501 }); // zelfde CC-waarde 64
    kern.stuur(v, { t: 'zet', id: 'mix', v: 0.5 });
    kern.stuur(v, { t: 'zet', id: 'mix', v: 0.6 });
    expect(poort.verstuurd).toEqual([[0xb0, 21, 64], [0xb0, 21, 76]]);
  });

  it('trigger → note-on bij aan, note-off bij uit (TD togglet opname op note-on)', () => {
    const { kern, poort, v } = opzet();
    kern.stuur(v, { t: 'trig', id: 'record', aan: true });
    kern.stuur(v, { t: 'trig', id: 'record', aan: false });
    kern.stuur(v, { t: 'trig', id: 'preset2', aan: true });
    kern.stuur(v, { t: 'trig', id: 'preset2', aan: false });
    expect(poort.verstuurd).toEqual([[0x90, 40, 127], [0x80, 40, 0], [0x90, 37, 127], [0x80, 37, 0]]);
  });

  it('scène i → korte aanslag op de preset-noot (note-off na 100 ms via de klok)', () => {
    const { klok, kern, poort, v } = opzet();
    kern.stuur(v, { t: 'scene', i: 3 });
    expect(poort.verstuurd).toEqual([[0x90, 39, 127]]);
    klok.loop(99); expect(poort.verstuurd).toHaveLength(1);
    klok.loop(1); expect(poort.verstuurd).toEqual([[0x90, 39, 127], [0x80, 39, 0]]);
    kern.stuur(v, { t: 'scene', i: 7 }); // bestaat niet
    expect(poort.verstuurd).toHaveLength(2);
  });

  it('negeert berichten die niets voor MIDI zijn, en onbekende params', () => {
    const { kern, poort, v } = opzet();
    for (const b of [{ t: 'welkom', hub: 'varve-hub', v: 1 }, { t: 'focus', aan: true }, { t: 'globaal', waarden: { adem: 0.3 } }, { t: 'fout', reden: 'x' }, { t: 'zet', id: 'bestaat_niet', v: 1 }]) kern.stuur(v, b);
    v.stuur({ t: 'raar' });
    expect(poort.verstuurd).toEqual([]);
  });

  it('truth:"hub" — na herstart van de hub-kant speelt de kern de waarden opnieuw af als CC', () => {
    const { kern, d, systeem, klok } = opzet();
    kern.stuur(d.verbinding, { t: 'zet', id: 'hue', v: 1 });
    d.stop();
    expect(kern.verbroken).toEqual(['av-scene-kit']);
    const d2 = maakDriver(leesApp('av-scene-kit.json'), { systeem, klok });
    d2.start(kern);
    expect(systeem.apparaten.get('VARVE-HUB TD').verstuurd).toEqual([[0xb0, 26, 127]]);
  });

  it('stop() laat geen noten hangen en ruimt timers op', () => {
    const { klok, kern, poort, v, d } = opzet();
    kern.stuur(v, { t: 'trig', id: 'preset1', aan: true });
    kern.stuur(v, { t: 'scene', i: 1 });
    d.stop();
    expect(poort.verstuurd.slice(0, 2)).toEqual([[0x90, 36, 127], [0x90, 37, 127]]);
    expect(poort.verstuurd.slice(2)).toEqual(expect.arrayContaining([[0x80, 37, 0], [0x80, 36, 0]]));
    expect(poort.verstuurd).toHaveLength(4);
    expect(klok.timers.size).toBe(0);
    expect(poort.open).toBe(false);
  });

  it('config.json wint voor de poortnaam', () => {
    const klok = new NepKlok(), systeem = new NepSysteem(), kern = new NepKern();
    const d = maakDriver(leesApp('av-scene-kit.json'), { systeem, klok, config: { apps: { 'av-scene-kit': { midipoort: 'ANDERS' } } } });
    d.start(kern);
    expect([...systeem.apparaten.keys()]).toEqual(['ANDERS']);
  });

  it('zonder virtuele poort: geen hartslag; komt de poort later, dan opnieuw aanmelden', () => {
    const klok = new NepKlok(), kern = new NepKern();
    let mag = false;
    const nep = new NepSysteem();
    const systeem = { soort: 'test', lijst: () => nep.lijst(), open: (n) => nep.open(n), virtueel: (n) => { if (!mag) throw new Error('geen ALSA'); return nep.virtueel(n); } };
    const d = maakDriver(leesApp('sediment.json'), { systeem, klok });
    d.start(kern);
    klok.loop(3000);
    expect(kern.soorten()).toEqual(['hallo', 'manifest']);
    mag = true;
    klok.loop(1000);
    expect(kern.soorten()).toEqual(['hallo', 'manifest', 'hallo', 'manifest', 'hb']);
  });

  it('poort komt later: de replay na de nieuwe aanmelding komt echt als CC op de poort', () => {
    const klok = new NepKlok(), kern = new NepKern();
    let mag = false;
    const nep = new NepSysteem();
    const systeem = { soort: 'test', lijst: () => nep.lijst(), open: (n) => nep.open(n), virtueel: (n) => { if (!mag) throw new Error('geen ALSA'); return nep.virtueel(n); } };
    const s = leesApp('sediment.json');
    const d = maakDriver(s, { systeem, klok });
    d.start(kern);
    kern.stuur(d.verbinding, { t: 'zet', id: 'cutoff', v: 0.5 }); // nog geen poort: gaat nergens heen
    mag = true;
    klok.loop(1000);
    expect(nep.apparaten.get('VARVE-HUB Logic').verstuurd).toEqual([[0xb0, s.driver.map.cutoff.cc, 64]]);
  });

  it('opnieuw(): nieuwe aanmelding, de kern speelt alles opnieuw af en niets wordt weggefilterd', () => {
    const { kern, d, poort, v } = opzet();
    kern.stuur(v, { t: 'zet', id: 'glitch', v: 0.5 });
    d.opnieuw();
    expect(kern.soorten()).toEqual(['hallo', 'manifest', 'hallo', 'manifest']);
    expect(poort.verstuurd).toEqual([[0xb0, 22, 64], [0xb0, 22, 64]]);
  });

  it('snapshot en replay gaan altijd door de dubbelfilter (herstel na een herstart van TD)', () => {
    const { kern, poort, v } = opzet();
    kern.stuur(v, { t: 'zet', id: 'feedback', v: 0.3 });
    kern.stuur(v, { t: 'zet', id: 'feedback', v: 0.3, bron: 'snapshot' });
    kern.stuur(v, { t: 'zet', id: 'feedback', v: 0.3, bron: 'replay' });
    kern.stuur(v, { t: 'zet', id: 'feedback', v: 0.3, bron: 'apc40' });
    expect(poort.verstuurd).toEqual([[0xb0, 20, 38], [0xb0, 20, 38], [0xb0, 20, 38]]);
  });

  it('twee keer trig aan zonder uit (los ingeslikt door de hubtoets): toch een nieuwe aanslag, met note-off ertussen', () => {
    const { kern, poort, v } = opzet();
    kern.stuur(v, { t: 'trig', id: 'record', aan: true });
    kern.stuur(v, { t: 'trig', id: 'record', aan: true });
    kern.stuur(v, { t: 'trig', id: 'record', aan: false });
    kern.stuur(v, { t: 'trig', id: 'record', aan: false }); // dubbele uit: niets
    expect(poort.verstuurd).toEqual([[0x90, 40, 127], [0x80, 40, 0], [0x90, 40, 127], [0x80, 40, 0]]);
  });

  it('twee scènes binnen 100 ms: elke aanslag is een echte uit → aan, de oude note-off vervalt', () => {
    const { klok, kern, poort, v } = opzet();
    kern.stuur(v, { t: 'scene', i: 0 });
    klok.loop(50);
    kern.stuur(v, { t: 'scene', i: 0 });
    klok.loop(60); // de note-off van de eerste scène zou nu vallen
    expect(poort.verstuurd).toEqual([[0x90, 36, 127], [0x80, 36, 0], [0x90, 36, 127]]);
    klok.loop(40);
    expect(poort.verstuurd).toEqual([[0x90, 36, 127], [0x80, 36, 0], [0x90, 36, 127], [0x80, 36, 0]]);
  });

  it('scène terwijl de preset-pad ingedrukt is: geen dubbele note-on, loslaten daarna stuurt niets extra', () => {
    const { klok, kern, poort, v } = opzet();
    kern.stuur(v, { t: 'trig', id: 'preset1', aan: true });
    kern.stuur(v, { t: 'scene', i: 0 });
    klok.loop(100);
    kern.stuur(v, { t: 'trig', id: 'preset1', aan: false });
    expect(poort.verstuurd).toEqual([[0x90, 36, 127], [0x80, 36, 0], [0x90, 36, 127], [0x80, 36, 0]]);
  });

  it('preset-noot: de driver meldt de presetwaarden van TD als zet aan de kern', () => {
    const { klok, kern, poort, v } = opzet();
    const s = leesApp('av-scene-kit.json');
    kern.stuur(v, { t: 'trig', id: 'preset2', aan: true });
    expect(kern.soorten()).toEqual(['hallo', 'manifest']); // niet midden in het bericht van de kern
    klok.loop(0);
    const zets = kern.ontvangen.filter(([, b]) => b.t === 'zet').map(([, b]) => [b.id, b.v]);
    expect(Object.fromEntries(zets)).toEqual(s.driver.presets[1].waarden);
    kern.stuur(v, { t: 'scene', i: 3 });
    klok.loop(0);
    expect(kern.ontvangen.filter(([, b]) => b.t === 'zet').slice(-8).map(([, b]) => b.v)).toEqual(Object.values(s.driver.presets[3].waarden));
    // TD staat nu op de presetwaarde: dezelfde waarde van de APC hoeft niet nog eens
    const voor = poort.verstuurd.length;
    kern.stuur(v, { t: 'zet', id: 'glitch', v: s.driver.presets[3].waarden.glitch, bron: 'apc40' });
    expect(poort.verstuurd).toHaveLength(voor);
  });

  it('start() twee keer: één timerketen, stop() ruimt alles op en de poort blijft dicht', () => {
    const { klok, kern, d } = opzet();
    d.start(kern);
    expect(kern.verbindingen).toHaveLength(1);
    d.stop();
    klok.loop(3000);
    expect(klok.timers.size).toBe(0);
    expect(d.driver.poort).toBe(null);
  });

  it('NaN wordt nooit een databyte', () => {
    expect(midiBytes({ cc: 21 }, 'waarde', NaN, 0)).toEqual([0xb0, 21, 0]);
    const { poort, v } = opzet();
    v.stuur({ t: 'zet', id: 'mix', v: NaN });
    expect(poort.verstuurd).toEqual([]);
  });

  it('kan de poort niet open, dan logt hij dat één keer, niet elke seconde', () => {
    const klok = new NepKlok(), kern = new NepKern(), log = [];
    const systeem = { soort: 'test', lijst: () => [], open: () => null, virtueel: () => { throw new Error('geen ALSA'); } };
    const d = maakDriver(leesApp('sediment.json'), { systeem, klok, log: (...a) => log.push(a.join(' ')) });
    d.start(kern);
    klok.loop(10000);
    expect(log.filter((m) => /niet te openen/.test(m))).toHaveLength(1);
  });

  it('valideerStatisch: een waarde op een noot mag niet; presets worden gecontroleerd', () => {
    const s = leesApp('av-scene-kit.json');
    const r = valideerStatisch({ ...s, driver: { ...s.driver, map: { ...s.driver.map, feedback: { noot: 50 } } } });
    expect(r.ok ? [] : r.fouten).toEqual(['driver.map.feedback: een waarde kan niet op een noot (alleen trigger of schakelaar)']);
    const r2 = valideerStatisch({ ...s, driver: { ...s.driver, presets: [{ noot: 36, waarden: { feedback: 2, record: 1, bestaat_niet: 0.5 } }, { noot: 37 }] } });
    expect(r2.ok ? [] : r2.fouten).toEqual([
      'driver.presets[0].waarden.feedback: moet 0..1 zijn',
      'driver.presets[0].waarden.record: een trigger heeft geen waarde',
      'driver.presets[0].waarden.bestaat_niet: geen param met die id',
      'driver.presets[1].waarden ontbreekt',
    ]);
  });

  it('sediment: alle 22 parameters op eigen CC, geen botsing met CC 1/7/10/64', () => {
    const s = leesApp('sediment.json');
    const ccs = Object.values(s.driver.map).map((d) => d.cc);
    expect(ccs).toHaveLength(22);
    expect(new Set(ccs).size).toBe(22);
    for (const cc of ccs) expect(VERBODEN_CC).not.toContain(cc);
    const klok = new NepKlok(), systeem = new NepSysteem(), kern = new NepKern();
    const d = maakDriver(s, { systeem, klok });
    d.start(kern);
    kern.stuur(d.verbinding, { t: 'zet', id: 'cutoff', v: 1 });
    kern.stuur(d.verbinding, { t: 'zet', id: 'output', v: 0 });
    expect(systeem.apparaten.get('VARVE-HUB Logic').verstuurd).toEqual([[0xb0, s.driver.map.cutoff.cc, 127], [0xb0, s.driver.map.output.cc, 0]]);
  });
});

// ───────────────────────── HTTP-driver ─────────────────────────

/** Nep-fetch: houdt bij wat er gevraagd wordt; gezond/ziek/hangend instelbaar. */
function nepFetch() {
  const f = async (url, init = {}) => {
    f.oproepen.push({ url, methode: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    if (f.gooit) throw new Error('ECONNREFUSED');
    if (url.endsWith('/verb')) return { ok: f.verbOk, status: f.verbOk ? 200 : 503, text: async () => '{}' };
    return { ok: f.gezond, status: f.gezond ? 200 : 500, text: async () => `Uurwerk-brug. tabs: ${f.tabs}\n` };
  };
  f.oproepen = [];
  f.gezond = true;
  f.gooit = false;
  f.verbOk = true;
  f.tabs = 1;
  f.verbs = () => f.oproepen.filter((o) => o.methode === 'POST').map((o) => o.body);
  f.checks = () => f.oproepen.filter((o) => o.methode === 'GET').length;
  return f;
}
const rust = () => new Promise((r) => setImmediate(r));

describe('verb-berichten', () => {
  it('waarde met bereik, schakelaar als boolean, trigger met vaste args', () => {
    expect(verbBericht({ verb: 'macro', args: { naam: 'licht' }, waarde: 'waarde', bereik: [-1, 1] }, 'waarde', 0.75))
      .toEqual({ verb: 'macro', args: { naam: 'licht', waarde: 0.5 }, auteur: 'varve-hub' });
    expect(verbBericht({ verb: 'macro', args: { naam: 'dicht' }, waarde: 'waarde' }, 'waarde', 1 / 3).args.waarde).toBe(0.3333);
    expect(verbBericht({ verb: 'bevries', waarde: 'aan' }, 'schakelaar', 1)).toEqual({ verb: 'bevries', args: { aan: true }, auteur: 'varve-hub' });
    expect(verbBericht({ verb: 'bevries', waarde: 'aan' }, 'schakelaar', 0).args).toEqual({ aan: false });
    expect(verbBericht({ verb: 'uur', args: { actie: 'stop' } }, 'trigger', true)).toEqual({ verb: 'uur', args: { actie: 'stop' }, auteur: 'varve-hub' });
  });
});

describe('HTTP-driver (uurwerk)', () => {
  const opzet = (o = {}) => {
    const klok = new NepKlok(), kern = new NepKern(), fetch = nepFetch();
    Object.assign(fetch, o);
    const d = maakDriver(leesApp('uurwerk.json'), { klok, fetch });
    d.start(kern);
    return { klok, kern, fetch, d, v: d.verbinding };
  };

  it('meldt zich aan en POST zet naar /verb volgens driver.verbs', async () => {
    const { kern, fetch, v } = opzet();
    expect(kern.soorten().slice(0, 2)).toEqual(['hallo', 'manifest']);
    kern.stuur(v, { t: 'zet', id: 'onrust', v: 0.4 });
    kern.stuur(v, { t: 'zet', id: 'licht', v: 0 });
    kern.stuur(v, { t: 'zet', id: 'bevries', v: 1 });
    await rust();
    expect(fetch.oproepen.filter((o) => o.methode === 'POST').every((o) => o.url === 'http://127.0.0.1:8766/verb')).toBe(true);
    expect(fetch.verbs()).toEqual([
      { verb: 'macro', args: { naam: 'onrust', waarde: 0.4 }, auteur: 'varve-hub' },
      { verb: 'macro', args: { naam: 'licht', waarde: -1 }, auteur: 'varve-hub' },
      { verb: 'bevries', args: { aan: true }, auteur: 'varve-hub' },
    ]);
  });

  it('coalescing: max 10 per seconde per param, laatste waarde wint', async () => {
    const { klok, kern, fetch, v } = opzet();
    for (let i = 1; i <= 20; i++) { kern.stuur(v, { t: 'zet', id: 'dicht', v: i / 20 }); klok.loop(10); } // 20 waarden in 200 ms
    kern.stuur(v, { t: 'zet', id: 'onrust', v: 0.9 }); // andere param: eigen ritme, meteen
    klok.loop(500);
    await rust();
    const dicht = fetch.verbs().filter((b) => b.args.naam === 'dicht').map((b) => b.args.waarde);
    expect(dicht).toEqual([0.05, 0.5, 1]); // t=0, t=100 (laatste tot dan), t=200 (de allerlaatste)
    expect(fetch.verbs().filter((b) => b.args.naam === 'onrust')).toHaveLength(1);
  });

  it('een losse zet na rust gaat meteen', async () => {
    const { klok, kern, fetch, v } = opzet();
    kern.stuur(v, { t: 'zet', id: 'samenhang', v: 0.1 });
    klok.loop(150);
    kern.stuur(v, { t: 'zet', id: 'samenhang', v: 0.2 });
    await rust();
    expect(fetch.verbs().map((b) => b.args.waarde)).toEqual([0.1, 0.2]);
  });

  it('triggers: alleen bij indrukken, met de vaste args', async () => {
    const { kern, fetch, v } = opzet();
    kern.stuur(v, { t: 'trig', id: 'uur_rust', aan: true });
    kern.stuur(v, { t: 'trig', id: 'uur_rust', aan: false });
    kern.stuur(v, { t: 'trig', id: 'bewaar', aan: true });
    kern.stuur(v, { t: 'scene', i: 0 });
    kern.stuur(v, { t: 'globaal', waarden: { bpm: 120 } });
    await rust();
    expect(fetch.verbs()).toEqual([
      { verb: 'uur', args: { actie: 'start', naam: 'Rust' }, auteur: 'varve-hub' },
      { verb: 'bewaar', args: { bron: 'varve-hub' }, auteur: 'varve-hub' },
    ]);
  });

  it('gezondheidscheck elke 2 s: gelukt → hb, mislukt → geen hb', async () => {
    const { klok, kern, fetch } = opzet();
    await rust();
    expect(fetch.checks()).toBe(1);
    expect(kern.soorten()).toEqual(['hallo', 'manifest', 'hb']);
    klok.loop(2000); await rust();
    expect(kern.soorten().filter((t) => t === 'hb')).toHaveLength(2);
    fetch.gezond = false;
    klok.loop(2000); await rust();
    fetch.gooit = true;
    klok.loop(2000); await rust();
    expect(fetch.checks()).toBe(4);
    expect(kern.soorten().filter((t) => t === 'hb')).toHaveLength(2);
    expect(fetch.oproepen.filter((o) => o.methode === 'GET').every((o) => o.url === 'http://127.0.0.1:8766/')).toBe(true);
  });

  it('brug draait maar zonder browsertab ("tabs: 0") telt als onbereikbaar', async () => {
    const { kern } = opzet({ tabs: 0 });
    await rust();
    expect(kern.soorten()).toEqual(['hallo', 'manifest']);
  });

  it('terug na storing: opnieuw aanmelden, zodat de kern alles opnieuw afspeelt (truth:"hub")', async () => {
    const { klok, kern, fetch, v } = opzet({ gezond: false });
    kern.stuur(v, { t: 'zet', id: 'licht', v: 1 });
    await rust();
    expect(kern.soorten()).toEqual(['hallo', 'manifest']);
    fetch.gezond = true;
    klok.loop(2000); await rust();
    expect(kern.soorten()).toEqual(['hallo', 'manifest', 'hallo', 'manifest', 'hb']);
    klok.loop(200); await rust();
    expect(fetch.verbs().map((b) => b.args.waarde)).toEqual([1, 1]); // eerste poging + replay
  });

  it('mislukte verb terwijl de check nog groen was → bij de volgende geslaagde check replay', async () => {
    const { klok, kern, fetch, v } = opzet({ verbOk: false });
    await rust();
    kern.stuur(v, { t: 'zet', id: 'onrust', v: 0.7 });
    await rust();
    fetch.verbOk = true;
    klok.loop(2000); await rust();
    expect(kern.soorten().filter((t) => t === 'hallo')).toHaveLength(2);
    klok.loop(200); await rust();
    expect(fetch.verbs().filter((b) => b.args.naam === 'onrust').map((b) => b.args.waarde)).toEqual([0.7, 0.7]);
  });

  it('gooit nooit, ook niet als fetch synchroon gooit', async () => {
    const klok = new NepKlok(), kern = new NepKern();
    const fetch = () => { throw new Error('kapot'); };
    const d = maakDriver(leesApp('uurwerk.json'), { klok, fetch });
    expect(() => d.start(kern)).not.toThrow();
    expect(() => kern.stuur(d.verbinding, { t: 'zet', id: 'dicht', v: 1 })).not.toThrow();
    expect(() => kern.stuur(d.verbinding, { t: 'trig', id: 'bewaar', aan: true })).not.toThrow();
    await rust();
    klok.loop(4000); await rust();
    expect(kern.soorten()).toEqual(['hallo', 'manifest']);
  });

  it('een hangende check wordt na 0,8 s afgebroken en blokkeert de volgende niet', async () => {
    const klok = new NepKlok(), kern = new NepKern();
    let n = 0;
    const fetch = (url, init) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: true });
      n++;
      if (n === 1) return new Promise((_, nee) => init.signal.addEventListener('abort', () => nee(new Error('afgebroken'))));
      return Promise.resolve({ ok: true, text: async () => 'tabs: 1' });
    };
    const d = maakDriver(leesApp('uurwerk.json'), { klok, fetch });
    d.start(kern);
    klok.loop(1500); await rust();
    expect(kern.soorten()).toEqual(['hallo', 'manifest']);
    klok.loop(500); await rust();
    expect(n).toBe(2);
    expect(kern.soorten()).toEqual(['hallo', 'manifest', 'hallo', 'manifest', 'hb']);
  });

  it('een hangende check die het afbreken negeert, blokkeert de volgende checks niet', async () => {
    const klok = new NepKlok(), kern = new NepKern();
    let n = 0;
    const fetch = (url, init) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: true });
      n++;
      if (n === 1) return new Promise(() => {}); // hangt voor altijd, signal of niet
      return Promise.resolve({ ok: true, text: async () => 'tabs: 1' });
    };
    const d = maakDriver(leesApp('uurwerk.json'), { klok, fetch });
    d.start(kern);
    klok.loop(2000); await rust();
    expect(n).toBe(2);
    expect(kern.soorten()).toEqual(['hallo', 'manifest', 'hallo', 'manifest', 'hb']);
    expect(d.driver.checkBezig).toBe(false);
  });

  it('check-periode + time-out blijft onder stil_s: een trage brug knippert niet op "stil"', () => {
    const cfg = laadConfig();
    const u = leesApp('uurwerk.json');
    expect((u.driver.gezond_s ?? 2) * 1000 + CHECK_TIMEOUT_MS).toBeLessThan(cfg.hartslag.stil_s * 1000);
  });

  it('een POST die blijft hangen wordt na 2 s afgebroken, zonder replay', async () => {
    const klok = new NepKlok(), kern = new NepKern();
    const afgebroken = [];
    const fetch = (url, init) => {
      if (init?.method === 'POST') return new Promise((_, nee) => init.signal.addEventListener('abort', () => { afgebroken.push(JSON.parse(init.body).args.naam); nee(new Error('afgebroken')); }));
      return Promise.resolve({ ok: true, text: async () => 'tabs: 1' });
    };
    const d = maakDriver(leesApp('uurwerk.json'), { klok, fetch });
    d.start(kern);
    await rust();
    kern.stuur(d.verbinding, { t: 'zet', id: 'dicht', v: 0.3 });
    klok.loop(POST_TIMEOUT_MS - 1); await rust();
    expect(afgebroken).toEqual([]);
    klok.loop(1); await rust();
    expect(afgebroken).toEqual(['dicht']);
    expect(d.driver.posts.size).toBe(0);
    klok.loop(2000); await rust();
    expect(kern.soorten().filter((t) => t === 'hallo')).toHaveLength(1); // de brug had hem wel: geen replay
  });

  it('onbereikbaar: geen POSTs (geen stapel), bij herstel speelt de kern ze opnieuw af', async () => {
    const { klok, kern, fetch, v } = opzet({ gezond: false });
    await rust();
    kern.stuur(v, { t: 'zet', id: 'samenhang', v: 0.4 });
    kern.stuur(v, { t: 'trig', id: 'bewaar', aan: true });
    await rust();
    expect(fetch.verbs()).toEqual([]);
    fetch.gezond = true;
    klok.loop(2000); await rust();
    expect(fetch.verbs().map((b) => b.args.waarde)).toEqual([0.4]);
  });

  it('NaN: geen verb (en verbBericht klemt NaN naar de ondergrens)', async () => {
    expect(verbBericht({ verb: 'macro', args: { naam: 'licht' }, waarde: 'waarde', bereik: [-1, 1] }, 'waarde', NaN).args.waarde).toBe(-1);
    const { fetch, v } = opzet();
    v.stuur({ t: 'zet', id: 'dicht', v: NaN });
    await rust();
    expect(fetch.verbs()).toEqual([]);
  });

  it('start() twee keer: één checkketen, stop() ruimt alles op', async () => {
    const { klok, kern, fetch, d } = opzet();
    d.start(kern);
    await rust();
    expect(fetch.checks()).toBe(1);
    d.stop();
    klok.loop(10000); await rust();
    expect(klok.timers.size).toBe(0);
    expect(fetch.checks()).toBe(1);
  });

  it('stop(): timers weg, verbreek, daarna niets meer', async () => {
    const { klok, kern, fetch, d, v } = opzet();
    kern.stuur(v, { t: 'zet', id: 'dicht', v: 0.1 });
    kern.stuur(v, { t: 'zet', id: 'dicht', v: 0.2 }); // wacht op coalescing
    d.stop();
    expect(kern.verbroken).toEqual(['uurwerk']);
    expect(klok.timers.size).toBe(0);
    const voor = fetch.oproepen.length;
    klok.loop(5000); await rust();
    v.stuur({ t: 'zet', id: 'dicht', v: 0.9 });
    expect(fetch.oproepen.length).toBe(voor);
  });

  it('config.json-poort wint voor de url', async () => {
    const klok = new NepKlok(), kern = new NepKern(), fetch = nepFetch();
    const d = maakDriver(leesApp('uurwerk.json'), { klok, fetch, config: { apps: { uurwerk: { poort: 9999 } } } });
    d.start(kern);
    await rust();
    expect(fetch.oproepen[0].url).toBe('http://127.0.0.1:9999/');
  });
});

describe('maakDriver / startDrivers', () => {
  it('onbekende soort gooit bij maken (programmeerfout), niet tijdens draaien', () => {
    expect(() => maakDriver({ app: 'x', driver: { soort: 'osc' } }, { klok: new NepKlok() })).toThrow(/onbekende driver-soort/);
  });
  it('startDrivers start ze allemaal; MIDI alleen met virtuele poorten', async () => {
    const klok = new NepKlok(), kern = new NepKern(), systeem = new NepSysteem(), fetch = nepFetch();
    const r = startDrivers({ kern, klok, systeem, fetch, uitstel_ms: 0 });
    expect(r.drivers).toHaveLength(3);
    expect([...systeem.apparaten.keys()].sort()).toEqual(['VARVE-HUB Logic', 'VARVE-HUB TD']);
    r.stop();
    expect(kern.verbroken.sort()).toEqual(['av-scene-kit', 'sediment', 'uurwerk']);
    const meldingen = [];
    const r2 = startDrivers({ kern: new NepKern(), klok, systeem: null, fetch, uitstel_ms: 0, log: (...a) => meldingen.push(a.join(' ')) });
    expect(r2.drivers).toHaveLength(1);
    expect(meldingen.filter((m) => /geen MIDI-systeem/.test(m))).toHaveLength(2);
    r2.stop();
  });
});

describe('startDrivers: volgorde en moment', () => {
  it('wacht eerst (echte apps krijgen de eerste slots), dan in de volgorde van config.apps; autostart:false slaat over', () => {
    const klok = new NepKlok(), kern = new NepKern(), systeem = new NepSysteem(), fetch = nepFetch();
    const config = { apps: { uurwerk: {}, sediment: {}, 'av-scene-kit': { autostart: false } } };
    const r = startDrivers({ kern, klok, systeem, fetch, config, uitstel_ms: 3000 });
    expect(r.drivers.map((d) => d.driver.manifest.app)).toEqual(['uurwerk', 'sediment']);
    klok.loop(2999);
    expect(kern.verbindingen).toHaveLength(0);
    klok.loop(1);
    expect(kern.ontvangen.filter(([, b]) => b.t === 'hallo').map(([app]) => app)).toEqual(['uurwerk', 'sediment']);
    r.stop();
  });
  it('stop() vóór het starten: er start niets meer', () => {
    const klok = new NepKlok(), kern = new NepKern(), systeem = new NepSysteem(), fetch = nepFetch();
    const r = startDrivers({ kern, klok, systeem, fetch });
    r.stop();
    klok.loop(10000);
    expect(kern.verbindingen).toHaveLength(0);
    expect(klok.timers.size).toBe(0);
  });
});

// ───────────────────────── generator ─────────────────────────

describe('genereer-manifesten', () => {
  it('Params.h: 22 parameters met bereik; genormaliseerde standaard volgt JUCE-skew', () => {
    const tekst = `specs {{
    { "cutoff", "Cutoff", "Cutoff", 30.0f, 18000.0f, 1400.0f, 1000.0f, Unit::Hz, Group::Filter },
    { "echoMix", "Echo Mix", "Mix", 0.0f, 1.0f, 0.18f, -1.0f, Unit::Percent, Group::Echo },
}};`;
    const specs = leesParamsH(tekst);
    expect(specs).toEqual([
      { id: 'cutoff', naam: 'Cutoff', label: 'Cutoff', min: 30, max: 18000, standaard: 1400, centre: 1000, eenheid: 'Hz', groep: 'Filter' },
      { id: 'echoMix', naam: 'Echo Mix', label: 'Mix', min: 0, max: 1, standaard: 0.18, centre: -1, eenheid: 'Percent', groep: 'Echo' },
    ]);
    expect(naarGenormaliseerd(1000, 30, 18000, 1000)).toBeCloseTo(0.5, 6); // centre ligt op 0.5
    expect(naarGenormaliseerd(0.18, 0, 1, -1)).toBeCloseTo(0.18);
    const m = sedimentManifest(specs, { naam: 'Sediment', kleur: '#ffffff', midipoort: 'P' });
    expect(m.params.map((p) => p.id)).toEqual(['cutoff', 'echo_mix']);
    expect(valideerStatisch(m).ok).toBe(true);
  });

  it('presets uit td_build_hub.py → standaardwaarden en scènes', () => {
    const py = `PRESETS = [
    # name k1..k8
    ['spiegel',    0.85, 0.50, 0.10, 0.35, 0.30, 0.15, 0.55, 1.00, 'difference', 0, 1],
    ['stil',       0.30, 0.90, 0.00, 0.20, 0.10, 0.05, 0.60, 0.80, 'over', 0, 1],
]`;
    expect(leesPresets(py)).toEqual([
      { naam: 'spiegel', knoppen: [0.85, 0.5, 0.1, 0.35, 0.3, 0.15, 0.55, 1] },
      { naam: 'stil', knoppen: [0.3, 0.9, 0, 0.2, 0.1, 0.05, 0.6, 0.8] },
    ]);
    expect(leesPresets('niets')).toEqual([]);
    const kit = { midi: { channel: 1, knob_cc: [20, 21, 22, 23, 24, 25, 26, 27], pads: { preset1: 36, preset2: 37, preset3: 38, preset4: 39, record: 40, takelog: 41 } }, knobs: { 1: { name: 'feedback', target: 'td' }, 2: { name: 'mix', target: 'td' } } };
    const zonder = sceneKitManifest(kit, { naam: 'Scene Kit (TD)' });
    expect(zonder.scenes).toEqual([]);
    expect(zonder.driver.scenes).toBeUndefined();
    expect(valideerStatisch(zonder).ok).toBe(true);
  });

  const bronnen = existsSync('/home/user/av-scene-kit/config.json') && existsSync('/home/user/sediment/src/Params.h');
  it.runIf(bronnen)('apps/av-scene-kit.json en apps/sediment.json zijn actueel t.o.v. de bronnen', () => {
    const uit = genereer();
    for (const [naam, m] of Object.entries(uit)) {
      expect(valideerStatisch(m).ok).toBe(true);
      expect(readFileSync(join(APPS_MAP, naam), 'utf8')).toBe(opmaak(m));
    }
    const kit = uit['av-scene-kit.json'];
    expect(Object.values(kit.driver.map).map((d) => d.cc ?? d.noot)).toEqual([20, 21, 22, 23, 24, 25, 26, 27, 36, 37, 38, 39, 40, 41]);
    expect(kit.driver.kanaal).toBe(0);
    expect(kit.params.find((p) => p.id === 'record').soort).toBe('trigger');
    expect(kit.driver.presets.map((p) => p.noot)).toEqual([36, 37, 38, 39]);
    expect(kit.driver.presets[0].waarden).toEqual(Object.fromEntries(kit.params.filter((p) => p.soort === 'waarde').map((p) => [p.id, p.standaard])));
    expect(Object.fromEntries(kit.params.filter((p) => p.rol).map((p) => [p.id, p.rol]))).toMatchObject({ hue: 'macro.kleur', orbit: 'macro.beweging', emission: 'macro.intensiteit' });
    expect(uit['sediment.json'].params).toHaveLength(22);
  });
});
