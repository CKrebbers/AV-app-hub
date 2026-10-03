// @ts-check
// Generale repetitie in CI: hetzelfde draaiboek als tools/repetitie.mjs (tools/repetitie-avond.mjs), maar met
// nep-apps die de ECHTE manifesten van de vijf koppelingen sturen (test/fixtures/manifesten, vastgelegd met
// `node tools/repetitie.mjs --fixtures`). De hele hub draait (startHub: apparaten, kern, server), met een
// nep-APC40 en een nep-LPD8 en een NepKlok: de avond duurt in nep-tijd ruim een minuut, echt een paar seconden.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startHub } from '../src/hub.js';
import { NepSysteem } from '../src/ports/nep.js';
import { NepKlok } from '../src/core/klok.js';
import { laadConfig } from '../src/config.js';
import { valideerManifest, keuzeNaarWaarde } from '../src/protocol/manifest.js';
import { NepApp } from '../tools/nep-app.mjs';
import { speelAvond, wandklok, koppel, latencyVan, rapportMd, fysiek } from '../tools/repetitie-avond.mjs';
import { totUiterlijk } from '../tools/repetitie-proces.mjs';

const MAP = fileURLToPath(new URL('./fixtures/manifesten/', import.meta.url));
/** @type {Record<string, { manifest: any, staat: Record<string, number> }>} */
const FIXTURES = Object.fromEntries(readdirSync(MAP).filter((f) => f.endsWith('.json')).map((f) => [f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(MAP, f), 'utf8'))]));
const VIJF = ['formula-lab', 'waterschaal', 'medisynth', 'flux', 'varve-dj'];
const echt = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Bekende problemen in de HUB die de repetitie vindt (open vragen, niet in de apps op te lossen). Deze controles
 * tellen niet mee in "stap: …", maar staan in een eigen it.fails: wordt de hub gerepareerd, dan slaagt die test
 * en meldt vitest dat it.fails onterecht faalt — haal de regel dan hier weg.
 *
 * K1 na paniek: Waterschaal zet bij paniek volume op 0 en meldt dat (zet). De pickup van de LPD8 neemt als doel
 * de waarde van de EERSTE app met de rol (kern.#macroDoel, PROTOCOL §10), dus waterschaal.volume = 0; K1 staat op
 * 0,283 en doet daarna voor álle apps met macro.intensiteit niets meer (ook medisynth.niveau) tot hij voorbij 0
 * draait. Repro: deze test, of `node tools/repetitie.mjs` (rapport: "na paniek: K1 twee tikjes verder → … geen zet").
 * Open vraag (hub/PROTOCOL): pickup-doel uit de laatste fysieke stand of het globale doel, niet uit de eerste app?
 */
const BEKEND = [
  { stap: 'paniek: P1 vasthouden en loslaten', wat: /^na paniek: K1 twee tikjes verder → /, waarom: 'K1 na paniek (pickup-doel uit de eerste app met de rol)' },
];
const isBekend = (/** @type {string} */ stap, /** @type {string} */ wat) => BEKEND.some((b) => b.stap === stap && b.wat.test(wat));

/**
 * Nep-app met het echte manifest en de echte beginstaat, die alles logt wat hij ontvangt (met wandklok).
 * Een lease-app speelt Varve DJ na: de masterfader (CC 14) zet `master` en meldt dat terug; bij focus stuurt hij LEDs.
 */
class RepetitieApp extends NepApp {
  /** @param {{ url: string, fixture: { manifest: any, staat: Record<string, number> }, log: { t: number, b: any }[] }} o */
  constructor({ url, fixture, log }) {
    super({ url, manifest: structuredClone(fixture.manifest) });
    Object.assign(this.waarden, fixture.staat);
    this.bij('open', () => {
      // Ruw loggen (precies wat de hub stuurde), naast de eigen verwerking van NepApp.
      this.ws?.on('message', (d) => { try { log.push({ t: wandklok(), b: JSON.parse(String(d)) }); } catch { /* geen JSON */ } });
    });
    this.bij('bericht', (/** @type {any} */ b) => {
      // De echte Waterschaal: paniek = "zachte stilte", volume naar 0, en dat meldt hij terug (zet).
      if (this.manifest.app === 'waterschaal' && b.t === 'trig' && b.id === 'paniek' && b.aan) this.zelfZetten('volume', 0);
      if (!this.manifest.lease) return;
      if (b.t === 'midi' && b.bytes[0] === 0xb0 && b.bytes[1] === 14 && 'master' in this.waarden) {
        this.zelfZetten('master', b.bytes[2] / 127);
      }
      if (b.t === 'focus' && b.aan) this.ws?.send(JSON.stringify({ t: 'led', bytes: [[0x90, 0, 5], [0x90, 1, 9]] }));
    });
  }
  hartslag() { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send('{"t":"hb"}'); }
}

describe('generale repetitie (nep-apps met de echte manifesten)', () => {
  /** @type {any} */ let hub;
  /** @type {NepKlok} */ let klok;
  /** @type {Awaited<ReturnType<typeof speelAvond>>} */ let uitslag;
  /** @type {Map<string, RepetitieApp>} */ const apps = new Map();

  beforeAll(async () => {
    klok = new NepKlok();
    const systeem = new NepSysteem();
    const apc = systeem.voegToe('APC40 mkII');
    const lpd8 = systeem.voegToe('LPD8 mk2');
    lpd8.antwoord = (b) => { if (b[1] === 0x7e) setTimeout(() => lpd8.injecteer([0xf0, 0x7e, 0, 6, 2, 0x47, 0x4c, 0, 0xf7]), 1); };
    hub = await startHub({ config: { ...laadConfig(), hotplug_ms: 50 }, systeem, klok, poort: 0, drivers: false });
    const url = hub.adres.replace('http', 'ws') + '/app';

    // Nep-tijd: in stappen van 50 ms, met echte pauzes ertussen zodat de WebSockets bijblijven;
    // elke 500 ms nep-tijd een hartslag van elke app (hun eigen interval loopt op de echte klok).
    let laatsteHb = 0;
    const wacht = async (/** @type {number} */ ms) => {
      for (let rest = ms; rest > 0; rest -= 50) {
        klok.loop(Math.min(50, rest));
        if (klok.nu() - laatsteHb >= 500) { laatsteHb = klok.nu(); for (const a of apps.values()) a.hartslag(); }
        await echt(2);
      }
    };
    await totUiterlijk(() => hub.apparaten.apc.verbonden && hub.apparaten.lpd8.model === 'mk2', 10000, 'nep-APC40/LPD8 melden zich niet', wacht);

    /** @type {Map<string, import('../tools/repetitie-avond.mjs').Deelnemer>} */
    const deelnemers = new Map();
    for (const id of VIJF) {
      /** @type {{ t: number, b: any }[]} */
      const log = [];
      const start = () => { const a = new RepetitieApp({ url, fixture: FIXTURES[id], log }).start(); apps.set(id, a); return a; };
      start();
      // Eén voor één verbinden, zodat de slots de volgorde van de avond hebben.
      for (let i = 0; i < 200 && !hub.kern.apps.get(FIXTURES[id].manifest.app)?.manifest; i++) await wacht(50);
      const appId = FIXTURES[id].manifest.app;
      deelnemers.set(appId, {
        id: appId, soort: 'nep',
        lees: async () => ({ ...(/** @type {RepetitieApp} */ (apps.get(id)).waarden) }),
        ontvangen: async () => log,
        fouten: async () => [],
        herstart: async () => {
          const oud = /** @type {RepetitieApp} */ (apps.get(id));
          oud.stop();
          await echt(20);
          start();
        },
      });
    }

    const cockpit = async () => {
      const ws = new WebSocket(hub.adres.replace('http', 'ws') + '/cockpit');
      /** @type {any[]} */
      const beelden = [];
      ws.on('message', (d) => { const b = JSON.parse(String(d)); if (b.t === 'beeld') beelden.push(b); });
      await new Promise((r) => ws.once('open', r));
      for (let i = 0; i < 100 && !beelden.length; i++) await wacht(50);
      return {
        namen: beelden.at(-1)?.apps.map((/** @type {any} */ a) => a.naam) ?? [],
        status: ws.readyState === WebSocket.OPEN ? 'verbonden' : 'dicht',
        fouten: async () => [],
        focus: async (/** @type {string} */ app) => { ws.send(JSON.stringify({ t: 'focus', app })); await wacht(100); },
        sluit: async () => { ws.close(); await wacht(50); },
      };
    };

    uitslag = await speelAvond({
      kern: hub.kern, apc, lpd8, nu: wandklok, wacht, deelnemers, cockpit,
      herstarten: ['formula-lab', 'varve-dj', 'flux'], opkomstMs: 10000,
    });
    if (!uitslag.totaal.ok) console.log(rapportMd({ datum: 'test', omgeving: {}, uitslag }).split('## Alle controles')[0]);
  }, 120000);

  afterAll(async () => {
    for (const a of apps.values()) a.stop();
    if (!hub) return;
    let klaar = false;
    const p = hub.stop().finally(() => { klaar = true; });
    while (!klaar) { klok.loop(50); await echt(1); }
    await p;
  });

  it('de vijf echte manifesten zijn er en zijn geldig', () => {
    for (const id of VIJF) {
      expect(FIXTURES[id], `fixture ${id}`).toBeTruthy();
      const r = valideerManifest(FIXTURES[id].manifest);
      expect(r.ok, `${id}: ${r.ok ? '' : r.fouten.join('; ')}`).toBe(true);
    }
    expect(FIXTURES['varve-dj'].manifest.lease).toBe(true);
  });

  const stappen = [
    'opkomst: alle apps melden zich',
    'focus: Bank + Track Select door alle apps',
    'bediening: formula-lab', 'bediening: waterschaal', 'bediening: medisynth', 'bediening: flux', 'bediening: varve-dj',
    "LPD8: macro's K1–K8 over alle apps tegelijk",
    'LPD8: verder draaien — de knoppen blijven gevangen',
    'snapshot: bewaren (P5 lang), veranderen, laden (P5 kort)',
    'paniek: P1 vasthouden en loslaten',
    'herstart: formula-lab halverwege',
    'herstart: varve-dj halverwege (met focus)',
    'herstart: flux halverwege',
    'eindstand: hub en apps zijn het eens',
    'cockpit open',
    'afsluiting: iedereen nog actief',
  ];
  for (const naam of stappen) {
    it(`stap: ${naam}`, () => {
      const s = uitslag.stappen.find((x) => x.naam === naam);
      expect(s, `stap "${naam}" liep niet`).toBeTruthy();
      const mis = /** @type {any} */ (s).controles.filter((/** @type {any} */ x) => !x.ok && !isBekend(naam, x.wat)).map((/** @type {any} */ x) => `${x.wat}${x.detail ? ` — ${x.detail}` : ''}`);
      expect(mis).toEqual([]);
      expect(/** @type {any} */ (s).controles.length).toBeGreaterThan(0);
    });
  }

  for (const b of BEKEND) {
    // Faalt zolang het probleem in de hub zit; slaagt deze test, dan is het opgelost: haal hem uit BEKEND.
    it.fails(`bekend probleem in de hub (open vraag): ${b.waarom}`, () => {
      const s = uitslag.stappen.find((x) => x.naam === b.stap);
      const hier = s?.controles.filter((x) => b.wat.test(x.wat)) ?? [];
      expect(hier.length).toBeGreaterThan(0);
      expect(hier.filter((x) => !x.ok).map((x) => `${x.wat} — ${x.detail}`)).toEqual([]);
    });
  }

  it('de nep-Waterschaal doet bij paniek wat de echte doet: volume naar 0, en meldt dat', () => {
    const s = uitslag.stappen.find((x) => x.naam === 'paniek: P1 vasthouden en loslaten');
    expect(s?.controles.find((x) => x.wat === 'waterschaal kreeg trig paniek aan')?.ok).toBe(true);
    // De hub kent volume 0 omdat de app het terugmeldde (niet omdat de hub het zelf zette).
    expect(hub.kern.apps.get('waterschaal')?.waarden.volume).toBe(0);
  });

  it('elke app kreeg zijn berichten: latency gemeten, niets verloren buiten een herstart', () => {
    for (const [id, a] of Object.entries(uitslag.perApp)) {
      expect(a.latency.n, id).toBeGreaterThan(50);
      const buitenHerstart = Object.entries(a.verlorenPerStap).filter(([s]) => !s.startsWith('herstart')).reduce((n, [, x]) => n + x, 0);
      expect(buitenHerstart, `${id}: ${JSON.stringify(a.verlorenPerStap)}`).toBe(0);
    }
    expect(uitslag.totaal.latency.p95).not.toBeNull();
  });

  it('LPD8-macro K5 (macro.kleur) bereikt beide keuze-parameters met een gekwantiseerde waarde', () => {
    const s = uitslag.stappen.find((x) => x.naam.startsWith("LPD8: macro's"));
    const doel = fysiek(0.2 + 0.07 * 5); // wat K5 in het draaiboek opdraait
    for (const [app, id] of [['formula-lab', 'palette'], ['flux', 'palet']]) {
      const p = FIXTURES[app].manifest.params.find((/** @type {any} */ x) => x.id === id);
      expect(p?.soort, `${app}.${id}`).toBe('keuze');
      const n = p.keuzes.length;
      const verwacht = keuzeNaarWaarde(Math.round(doel * (n - 1)), n);
      // De controle zelf: de laatste zet die de app kreeg, is precies die gekwantiseerde waarde (en kwam van de LPD8).
      const ctl = s?.controles.find((x) => x.wat.startsWith(`macro.kleur → ${app}.${id} `));
      expect(ctl?.wat).toBe(`macro.kleur → ${app}.${id} eindigt op ${verwacht.toFixed(3)}`);
      expect(ctl?.ok, ctl?.detail).toBe(true);
      expect(verwacht).not.toBeCloseTo(doel, 3); // anders toetst dit niets over quantiseren
    }
  });

  it('het rapport noemt elke stap en elke app', () => {
    const md = rapportMd({ datum: 'test', omgeving: { hub: 'test' }, uitslag });
    for (const naam of stappen) expect(md).toContain(naam);
    for (const id of VIJF) expect(md).toContain(`| ${id} |`);
  });
});

describe('repetitie: latency koppelen', () => {
  it('koppelt per app en per inhoud, eerst-in-eerst-uit; wat nooit aankwam is null', () => {
    const v = [
      { app: 'a', t: 100, b: { t: 'zet', id: 'x', v: 1 } },
      { app: 'a', t: 110, b: { t: 'zet', id: 'x', v: 1 } },
      { app: 'b', t: 120, b: { t: 'zet', id: 'x', v: 1 } },
      { app: 'a', t: 130, b: { t: 'trig', id: 'y', aan: true } },
    ];
    const o = new Map([
      ['a', [{ t: 101, b: { t: 'zet', id: 'x', v: 1 } }, { t: 115, b: { t: 'zet', id: 'x', v: 1 } }]],
      ['b', [{ t: 123, b: { t: 'zet', id: 'x', v: 1 } }]],
    ]);
    expect(koppel(v, o).map((x) => x.ms)).toEqual([1, 5, 3, null]);
  });
  it('een verloren bericht krijgt niet de ontvangst van een later, gelijk bericht', () => {
    // Herstart: globaal@100 gaat verloren, de app krijgt wel zet@200 en daarna een gelijk globaal@300.
    const g = { t: 'globaal', waarden: { paniek: 0 } };
    const v = [
      { app: 'a', t: 100, b: g },
      { app: 'a', t: 200, b: { t: 'zet', id: 'x', v: 0.5 } },
      { app: 'a', t: 300, b: g },
    ];
    const o = new Map([['a', [{ t: 202, b: { t: 'zet', id: 'x', v: 0.5 } }, { t: 303, b: g }]]]);
    expect(koppel(v, o).map((x) => x.ms)).toEqual([null, 2, 3]);
  });
  it('een ontvangst zonder verzonden tegenhanger (welkom) verschuift niets', () => {
    const v = [{ app: 'a', t: 100, b: { t: 'zet', id: 'x', v: 1 } }];
    const o = new Map([['a', [{ t: 90, b: { t: 'welkom' } }, { t: 104, b: { t: 'zet', id: 'x', v: 1 } }]]]);
    expect(koppel(v, o).map((x) => x.ms)).toEqual([4]);
  });
  it('percentielen', () => {
    expect(latencyVan([5, 1, 3, 2, 4])).toEqual({ n: 5, p50: 3, p95: 5, max: 5 });
    expect(latencyVan([])).toEqual({ n: 0, p50: null, p95: null, max: null });
  });
});
