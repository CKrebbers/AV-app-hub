// @ts-check
// De TD-driver (src/drivers/td.js) tegen een nep-bridge: een echte HTTP-server die zich gedraagt als de
// exec-bridge van td-lab (td-lab/bridge/td_bridge.py): POST /exec met Python-tekst, antwoord ALTIJD 200 met
// JSON {ok, stdout, result, error}. De nep-bridge "voert" de Python van de driver uit op een nep-COMP (/genesis
// met custom parameters) en kan ook kapot, leeg, hangend of helemaal weg zijn. Tijd: NepKlok (huisregel 2).
import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { NepKlok } from '../src/core/klok.js';
import { valideerManifest } from '../src/protocol/manifest.js';
import { leesVanApp, leesNaarApp } from '../src/protocol/berichten.js';
import { maakDriver, valideerStatisch, startDrivers, laadStatisch, APPS_MAP, DRIVER_SOORTEN, TdDriver, tdBatch, tdCheck, tdToewijzing, tdUrl } from '../src/drivers/index.js';
import { TD_CHECK_TIMEOUT_MS, TD_EXEC_TIMEOUT_MS, TD_BACKOFF_MAX_MS, kort } from '../src/drivers/td.js';
import { laadConfig } from '../src/config.js';
import { Kern } from '../src/core/kern.js';
import { wachtOp } from './nepkern.js';
import { CONFIG as KERN_CONFIG, nepOppervlak } from './kern-hulp.js';

const leesApp = (/** @type {string} */ n) => JSON.parse(readFileSync(join(APPS_MAP, n), 'utf8'));
const TD = leesApp('td-lab.json');
const rust = () => new Promise((r) => setImmediate(r));
/** Echte tijd laten lopen (voor "er gebeurt niets meer"). @param {number} ms */
const slaap = (ms) => new Promise((r) => setTimeout(r, ms));

/** Nep-kern volgens het contract (src/core/kern.js), met replay bij hallo zoals truth:"hub". */
class NepKern {
  constructor() {
    /** @type {any[]} */ this.verbindingen = [];
    /** @type {[string|null, any][]} */ this.ontvangen = [];
    /** @type {(string|null)[]} */ this.verbroken = [];
    /** @type {Record<string, Record<string, number>>} */ this.waarden = {};
  }
  /** @param {any} v */
  verbind(v) { this.verbindingen.push(v); }
  /** @param {any} v @param {any} ruw */
  ontvang(v, ruw) {
    const r = leesVanApp(ruw);
    if (!r.ok || r.onbekend) throw new Error(`ongeldig bericht van driver: ${JSON.stringify(ruw)}`);
    const b = /** @type {any} */ (r.bericht);
    if (b.t === 'hallo') v.app = b.app;
    if (b.t === 'manifest') {
      const m = valideerManifest(b.manifest);
      if (!m.ok) throw new Error(m.fouten.join('; '));
      if ('driver' in b.manifest) throw new Error('driver-veld lekt naar de kern');
    }
    if (b.t === 'zet') (this.waarden[v.app] ??= {})[b.id] = b.v;
    this.ontvangen.push([v.app, b]);
    if (b.t === 'hallo') for (const [id, w] of Object.entries(this.waarden[b.app] ?? {})) v.stuur({ t: 'zet', id, v: w, bron: 'replay' });
  }
  /** @param {any} v */
  verbreek(v) { this.verbroken.push(v.app); }
  /** zoals de kern naar een app stuurt; controleert de vorm @param {any} v @param {any} b */
  stuur(v, b) {
    const r = leesNaarApp(b);
    if (!r.ok) throw new Error(r.fout);
    if (b.t === 'zet') (this.waarden[v.app] ??= {})[b.id] = b.v;
    v.stuur(b);
  }
  soorten() { return this.ontvangen.map(([, b]) => b.t); }
  /** @param {string} t */
  tel(t) { return this.soorten().filter((x) => x === t).length; }
}

/** De custom parameters van /genesis (td-lab/scripts/genesis.py:82-110), met hun TD-standaard. */
const GENESIS = () => ({
  Speed: 1, Flow: 1, Climb: 0.6, Wander: 0.5, Size: 1, Trails: 0.75, Hue: 0.55, Restless: 1,
  Auto: true, Feed: 0.0367, Kill: 0.0649, Fert: 0, Cruel: 0, Seedamt: 0, Seedthresh: 0.56, Seedsoft: 0.03, Grain: 0.15,
  Fieldmix: 0.45, Bright: 1, Glow: 0.7, Bg: 0.8, Reseed: 0, Hud: true,
});

/**
 * Nep-bridge: een HTTP-server die doet wat td_bridge.py doet. Voert de twee vormen Python uit die de driver
 * stuurt (de check-expressie en een batch); al het andere is een NameError. Modi:
 * goed · kapot (geen JSON: tikfout in td_bridge.py) · leeg (200 zonder body) · hang (geen antwoord).
 */
async function nepBridge() {
  const b = {
    /** @type {'goed'|'kapot'|'leeg'|'hang'} */ modus: 'goed',
    /** @type {{ id: number, pars: Record<string, any> } | null} */ comp: { id: 101, pars: GENESIS() },
    /** @type {{ url: string, methode: string, body: string }[]} */ verzoeken: [],
    /** @type {{ zetten: Record<string, any>, pulsen: string[] }[]} */ batches: [],
    /** @type {Record<string, number>} */ pulsen: {},
    poort: 0,
    checks() { return this.verzoeken.filter((v) => v.body.startsWith('(lambda c:')).length; },
    batchVerzoeken() { return this.verzoeken.filter((v) => v.body.startsWith('_hub_c =')); },
    /** @type {import('node:http').Server} */ server: /** @type {any} */ (null),
  };
  /** @param {string} code */
  const voerUit = (code) => {
    const check = /^\(lambda c: c\.id if c is not None else None\)\(op\('([^']+)'\)\)$/.exec(code);
    if (check) return { ok: true, stdout: '', result: check[1] === '/genesis' && b.comp ? b.comp.id : null, error: null };
    const regels = code.split('\n');
    const kop = /^_hub_c = op\('([^']+)'\)$/.exec(regels[0] ?? '');
    if (!kop) return { ok: false, stdout: '', result: null, error: 'Traceback (most recent call last):\nNameError: name is not defined' };
    if (kop[1] !== '/genesis' || !b.comp) return { ok: false, stdout: '', result: null, error: `Traceback (most recent call last):\n  File "<claude>", line 2\nRuntimeError: varve-hub: geen COMP ${kop[1]}` };
    const comp = b.comp, fout = [], zetten = /** @type {Record<string, any>} */ ({}), pulsen = [];
    for (const r of regels) {
      const z = /^try: _hub_par\('([A-Za-z0-9]+)'\)\.(val|menuIndex) = (.+)$/.exec(r);
      const p = /^try: _hub_par\('([A-Za-z0-9]+)'\)\.pulse\(\)$/.exec(r);
      const naam = z?.[1] ?? p?.[1];
      if (!naam) continue;
      if (!(naam in comp.pars)) { fout.push(naam); continue; }
      if (z) { const v = z[3] === 'True' ? true : z[3] === 'False' ? false : Number(z[3]); comp.pars[naam] = v; zetten[naam] = v; }
      else { b.pulsen[naam] = (b.pulsen[naam] ?? 0) + 1; pulsen.push(naam); }
    }
    b.batches.push({ zetten, pulsen });
    if (fout.length) return { ok: false, stdout: '', result: null, error: `Traceback (most recent call last):\n  File "<claude>", line 40\nRuntimeError: varve-hub: niet gezet: ${fout.join(',')}` };
    return { ok: true, stdout: '', result: null, error: null };
  };
  b.server = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      b.verzoeken.push({ url: String(req.url), methode: String(req.method), body });
      if (b.modus === 'hang') return; // geen antwoord
      if (b.modus === 'leeg') { res.writeHead(200); res.end(); return; }
      if (b.modus === 'kapot') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('Traceback (most recent call last):\n  File "td_bridge.py", line 9\nSyntaxError: invalid syntax'); return; }
      const uri = String(req.url).split('?')[0];
      const payload = uri === '/ping' ? { ok: true, version: '2023.12230', project: 'nep', build: '12230' }
        : uri === '/exec' ? voerUit(body) : { ok: false, error: `unknown route: ${uri}` };
      res.writeHead(200, { 'content-type': 'application/json' }); // de echte bridge: altijd 200 (td_bridge.py:146)
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((r) => b.server.listen(0, '127.0.0.1', () => r(null)));
  b.poort = /** @type {import('node:net').AddressInfo} */ (b.server.address()).port;
  bridges.push(b);
  return b;
}
/** @type {Awaited<ReturnType<typeof nepBridge>>[]} */
const bridges = [];
/** @type {{ stop: () => void }[]} */
const drivers = [];
afterEach(async () => {
  for (const d of drivers.splice(0)) d.stop();
  for (const b of bridges.splice(0)) { b.server.closeAllConnections(); await new Promise((r) => b.server.close(() => r(null))); }
});

/** Een vrije poort waar (nu) niemand luistert. */
async function vrijePoort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', () => r(null)));
  const p = /** @type {import('node:net').AddressInfo} */ (s.address()).port;
  await new Promise((r) => s.close(() => r(null)));
  return p;
}

/** Driver tegen een nep-bridge (of een poort zonder bridge). @param {{ poort: number, statisch?: any }} o */
function opzet({ poort, statisch = TD }) {
  const klok = new NepKlok(), kern = new NepKern();
  /** @type {string[]} */
  const log = [];
  const d = maakDriver(statisch, { klok, config: { apps: { 'td-lab': { poort } } }, log: (...a) => log.push(a.join(' ')) });
  drivers.push(d);
  d.start(kern);
  return { klok, kern, d, v: d.verbinding, td: /** @type {TdDriver} */ (d.driver), log };
}

/** Wacht tot de check van nu klaar is (de driver plant dan de volgende). @param {TdDriver} td */
const checkKlaar = (td) => wachtOp(() => !td.checkBezig && td.checkTimer !== null);
/**
 * Laat de nep-klok lopen tot de volgende check begint, en wacht tot hij klaar is. Niet in één grote stap: dan liepen
 * ook de time-outs van de nep-klok af voordat het echte antwoord van de nep-bridge binnen is.
 * @param {NepKlok} klok @param {TdDriver} td
 */
async function volgendeCheck(klok, td) {
  while (!td.checkBezig) klok.loop(100);
  await checkKlaar(td);
}
/** Wacht tot er geen batch meer onderweg is. @param {TdDriver} td */
const batchKlaar = (td) => wachtOp(() => td.inVlucht === 0);

// ───────────────────────── puur ─────────────────────────

describe('TD-driver: Python en adres (puur)', () => {
  it('waarde schaalt naar het bereik, schakelaar is True/False, keuze is menuIndex, buiten 0..1 wordt geklemd', () => {
    expect(tdToewijzing({ par: 'Speed', bereik: [0, 1.4] }, { soort: 'waarde' }, 0.5)).toEqual({ par: 'Speed', attr: 'val', py: '0.7' });
    expect(tdToewijzing({ par: 'Climb', bereik: [-2, 2] }, { soort: 'waarde' }, 0)).toEqual({ par: 'Climb', attr: 'val', py: '-2' });
    expect(tdToewijzing({ par: 'Fert', bereik: [-1, 1] }, { soort: 'waarde' }, 0.5)?.py).toBe('0');
    expect(tdToewijzing({ par: 'Hue' }, { soort: 'waarde' }, 2)?.py).toBe('1');
    expect(tdToewijzing({ par: 'Hud' }, { soort: 'schakelaar' }, 0)?.py).toBe('False');
    expect(tdToewijzing({ par: 'Hud' }, { soort: 'schakelaar' }, 1)?.py).toBe('True');
    expect(tdToewijzing({ par: 'Mode' }, { soort: 'keuze', keuzes: ['a', 'b', 'c'] }, 1)).toEqual({ par: 'Mode', attr: 'menuIndex', py: '2' });
    expect(tdToewijzing({ par: 'speed' }, { soort: 'waarde' }, 0.5)).toBe(null); // geen TD-naam
    expect(tdToewijzing({ puls: 'Reseed' }, { soort: 'trigger' }, 1)).toBe(null);
  });

  it('een batch zet elke parameter in een eigen try en laat niets van buiten in de Python', () => {
    const code = tdBatch('/genesis', [{ par: 'Speed', attr: 'val', py: '0.7' }, { par: "X'); import os; ('", attr: 'val', py: '1' }, { par: 'Hud', attr: 'val', py: 'os.system("rm")' }], ['Reseed', 'kwaad()']);
    expect(code.split('\n')[0]).toBe("_hub_c = op('/genesis')");
    expect(code).toMatch(/if _hub_c is None: raise RuntimeError/);
    expect(code).toContain("try: _hub_par('Speed').val = 0.7\nexcept Exception: _hub_fout.append('Speed')");
    expect(code).toContain("try: _hub_par('Reseed').pulse()");
    expect(code).not.toMatch(/import os|os\.system|kwaad/);
    expect(code.split('\n').at(-1)).toMatch(/^if _hub_fout: raise RuntimeError\('varve-hub: niet gezet: '/);
    expect(() => tdBatch("/genesis'); import os; ('", [], [])).toThrow(/COMP-pad/);
    expect(tdCheck('/genesis')).toBe("(lambda c: c.id if c is not None else None)(op('/genesis'))");
  });

  it('poort: alleen config.json — apps.<app>.poort, dan bekende_apps.<app>.tcp; anders geen url (geen stille terugval)', () => {
    expect(tdUrl('td-lab', { apps: { 'td-lab': { poort: 9982 } }, bekende_apps: { 'td-lab': { tcp: 9981 } } })).toEqual({ url: 'http://127.0.0.1:9982' });
    expect(tdUrl('td-lab', { bekende_apps: { 'td-lab': { tcp: 9983 } } })).toEqual({ url: 'http://127.0.0.1:9983' });
    expect(tdUrl('td-lab', undefined)).toEqual({ url: null, melding: expect.stringMatching(/geen poort in config\.json \(bekende_apps\.td-lab\.tcp of apps\.td-lab\.poort\): driver start niet/) });
    const r = tdUrl('td-lab', { apps: { 'td-lab': { poort: '9982' } }, bekende_apps: { 'td-lab': { tcp: 9981 } } });
    expect(r.url).toBe(null); // niet stil toch 9981
    expect(r.melding).toMatch(/apps\.td-lab\.poort \("9982"\) is geen poort .*driver start niet/);
  });

  it('de echte config.json: koppeling td, de driver staat uit tot Clay hem aanzet, en de poort komt uit config.json', () => {
    const cfg = laadConfig();
    expect(cfg.apps['td-lab'].koppeling).toBe('td');
    expect(cfg.apps['td-lab'].autostart).toBe(false);
    // één plek: bekende_apps.td-lab.tcp (daar kijkt ook doctor); apps.td-lab.poort alleen als hij moet afwijken
    expect(cfg.apps['td-lab'].poort).toBeUndefined();
    expect(tdUrl('td-lab', cfg).url).toBe(`http://127.0.0.1:${cfg.bekende_apps['td-lab'].tcp}`);
    expect(TD.driver.url).toBeUndefined(); // de poort staat niet ook nog in het manifest
  });

  it('kort(): laatste regel, zonder stuurtekens of ANSI uit de andere kant', () => {
    expect(kort('Traceback\n  File "x"\nNameError: \u001b[31mrood\u001b[0m\u0007 en\tzo')).toBe('NameError: rood en zo');
    expect(kort('a'.repeat(500))).toHaveLength(200);
  });
});

// De Python die de driver maakt, echt uitgevoerd: python3 met een nep-TD (op(), COMP, Par). Zo is zeker dat het
// geldige Python is en dat één ontbrekende parameter de rest niet tegenhoudt. Zonder python3: overgeslagen.
const PY = spawnSync('python3', ['--version']).status === 0;
const PY_STUB = String.raw`
import sys, json
class Par:
    def __init__(self, v): self.val = v; self.menuIndex = 0; self.pulsen = 0
    def pulse(self): self.pulsen += 1
class Pars: pass
class Comp:
    def __init__(self, namen):
        self.id = 4242
        self.par = Pars()
        for n in namen: setattr(self.par, n, Par(0))
inp = json.loads(sys.stdin.read())
comp = Comp(inp['pars']) if inp['comp'] else None
ns = {'op': lambda p: comp if p == '/genesis' else None}
uit = {'ok': True, 'result': None, 'error': None}
try:
    try:
        c = compile(inp['code'], '<claude>', 'eval'); modus = 'eval'
    except SyntaxError:
        c = compile(inp['code'], '<claude>', 'exec'); modus = 'exec'
    if modus == 'eval': uit['result'] = eval(c, ns)
    else: exec(c, ns)
except Exception as e:
    uit['ok'] = False; uit['error'] = type(e).__name__ + ': ' + str(e)
uit['pars'] = {n: {'val': getattr(comp.par, n).val, 'menuIndex': getattr(comp.par, n).menuIndex, 'pulsen': getattr(comp.par, n).pulsen} for n in inp['pars']} if comp else None
print(json.dumps(uit))
`;
/** @param {string} code @param {{ comp?: boolean, pars?: string[] }} [o] */
function python(code, { comp = true, pars = ['Speed', 'Hud', 'Mode', 'Reseed'] } = {}) {
  const r = spawnSync('python3', ['-c', PY_STUB], { input: JSON.stringify({ code, comp, pars }), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

describe.skipIf(!PY)('TD-driver: de Python draait echt (python3 met een nep-TD)', () => {
  it('een batch zet waarden, schakelaars, menu en pulsen', () => {
    const r = python(tdBatch('/genesis', [{ par: 'Speed', attr: 'val', py: '0.7' }, { par: 'Hud', attr: 'val', py: 'False' }, { par: 'Mode', attr: 'menuIndex', py: '2' }], ['Reseed']));
    expect(r.ok).toBe(true);
    expect(r.pars).toEqual({ Speed: { val: 0.7, menuIndex: 0, pulsen: 0 }, Hud: { val: false, menuIndex: 0, pulsen: 0 }, Mode: { val: 0, menuIndex: 2, pulsen: 0 }, Reseed: { val: 0, menuIndex: 0, pulsen: 1 } });
  });

  it('een ontbrekende parameter houdt de rest niet tegen, maar de batch telt als mislukt', () => {
    const r = python(tdBatch('/genesis', [{ par: 'Weg', attr: 'val', py: '1' }, { par: 'Speed', attr: 'val', py: '0.3' }], ['Ookweg']));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('RuntimeError: varve-hub: niet gezet: Weg,Ookweg');
    expect(r.pars.Speed.val).toBe(0.3);
  });

  it('zonder COMP: fout, en er wordt niets gezet', () => {
    expect(python(tdBatch('/genesis', [{ par: 'Speed', attr: 'val', py: '0.3' }], []), { comp: false })).toMatchObject({ ok: false, error: 'RuntimeError: varve-hub: geen COMP /genesis' });
  });

  it('de check is één expressie (de bridge eval\'t hem): id van de COMP, of None', () => {
    expect(python(tdCheck('/genesis'))).toMatchObject({ ok: true, result: 4242 });
    expect(python(tdCheck('/genesis'), { comp: false })).toMatchObject({ ok: true, result: null });
  });
});

// ───────────────────────── manifest en validatie ─────────────────────────

describe('apps/td-lab.json en valideerStatisch voor soort td', () => {
  it('td is een driver-soort; apps/td-lab.json is geldig en wordt geladen', () => {
    expect(DRIVER_SOORTEN).toContain('td');
    const r = valideerStatisch(TD);
    expect(r.ok ? [] : r.fouten).toEqual([]);
    expect(laadStatisch().statisch.map((s) => s.app)).toContain('td-lab');
  });

  it('is het voorstel uit docs/VOLGENDE-KOPPELINGEN.md §6.3 (params en driver)', () => {
    const doc = readFileSync(new URL('../docs/VOLGENDE-KOPPELINGEN.md', import.meta.url), 'utf8');
    const voorstel = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => JSON.parse(m[1])).find((x) => x.app === 'td-lab');
    expect(voorstel).toBeDefined();
    const { _bron, ...driver } = TD.driver;
    const { url: _url, ...voorstelDriver } = voorstel.driver; // de url uit het voorstel is config.json → apps.td-lab.poort geworden
    expect(TD.params).toEqual(voorstel.params);
    expect(driver).toEqual(voorstelDriver);
    expect(TD.naam).toBe(voorstel.naam);
  });

  it('naam en kleur komen overeen met config.json (huisregel 6)', () => {
    const cfg = laadConfig();
    expect(TD.naam).toBe(cfg.apps['td-lab'].naam);
    expect(TD.kleur).toBe(cfg.apps['td-lab'].kleur);
  });

  it('vindt fouten: namen die geen TD-naam zijn, puls/par door elkaar, ontbrekende pars, paniek zonder trigger', () => {
    const fouten = (/** @type {any} */ s) => { const r = valideerStatisch(s); return r.ok ? [] : r.fouten; };
    const d = TD.driver;
    expect(fouten({ ...TD, driver: { ...d, pars: { ...d.pars, speed: { par: "Speed'); import os; ('" } } } }).join('\n')).toMatch(/driver\.pars\.speed: TD-parameter moet een naam/);
    expect(fouten({ ...TD, driver: { ...d, pars: { ...d.pars, reseed: { par: 'Reseed' } } } }).join('\n')).toMatch(/reseed: een trigger is een puls/);
    expect(fouten({ ...TD, driver: { ...d, pars: { ...d.pars, hue: { puls: 'Hue' } } } }).join('\n')).toMatch(/hue: een waarde heeft een par nodig/);
    expect(fouten({ ...TD, driver: { ...d, pars: { ...d.pars, flow: { par: 'Speed' } } } }).join('\n')).toMatch(/Speed al gebruikt door speed/);
    const { grain: _g, ...zonderGrain } = d.pars;
    expect(fouten({ ...TD, driver: { ...d, pars: zonderGrain } })).toEqual(['param grain heeft geen TD-parameter in driver.pars']);
    expect(fouten({ ...TD, driver: { ...d, comp: 'genesis' } }).join('\n')).toMatch(/driver\.comp/);
    expect(fouten({ ...TD, driver: { ...d, paniek: { bright: 2, reseed: 0 } } }).join('\n')).toMatch(/paniek\.bright: moet 0\.\.1[\s\S]*paniek\.reseed: een trigger/);
    expect(fouten({ ...TD, params: TD.params.filter((/** @type {any} */ p) => p.id !== 'paniek') }).join('\n')).toMatch(/driver\.paniek zonder trigger "paniek"/);
    const { paniek: _p, ...zonderPaniek } = d;
    expect(fouten({ ...TD, driver: zonderPaniek })).toEqual(['param paniek heeft geen TD-parameter in driver.pars']);
    expect(fouten({ ...TD, driver: { ...d, url: 'http://127.0.0.1:9981' } }).join('\n')).toMatch(/driver\.url hoort niet in het manifest/);
  });

  it('gezond_s past bij hb_s: de hartslag gaat alleen mee met een geslaagde check, dus check + time-out < stil (3 × hb_s)', () => {
    const fouten = (/** @type {any} */ s) => { const r = valideerStatisch(s); return r.ok ? [] : r.fouten; };
    const d = TD.driver;
    expect(fouten({ ...TD, driver: { ...d, gezond_s: 30 } }).join('\n')).toMatch(/gezond_s \(30\) \+ check-time-out \(1 s\) moet onder 6 s blijven/);
    expect(fouten({ ...TD, hb_s: 1, driver: { ...d, gezond_s: 10 } }).join('\n')).toMatch(/moet onder 3 s blijven/);
    expect(fouten({ ...TD, hb_s: 1, driver: { ...d, gezond_s: 2 } }).join('\n')).toMatch(/moet onder 3 s blijven/); // 2 + 1 = 3: te krap
    expect(fouten({ ...TD, driver: { ...d, gezond_s: 4.5 } })).toEqual([]); // hb_s 2: 4.5 + 1 < 6
    expect(fouten({ ...TD, hb_s: 10, driver: { ...d, gezond_s: 20 } })).toEqual([]);
  });

  it('maakDriver maakt een TdDriver; een ongeldig COMP-pad of een ongeldige naam gooit meteen (niet later in een timer)', () => {
    const d = maakDriver(TD, { klok: new NepKlok(), fetch: async () => ({ ok: true }), config: { apps: { 'td-lab': { poort: 9981 } } } });
    expect(d.driver).toBeInstanceOf(TdDriver);
    expect(() => maakDriver({ ...TD, driver: { ...TD.driver, comp: "/genesis'); import os; ('" } }, { klok: new NepKlok() })).toThrow(/ongeldig COMP-pad/);
    expect(() => maakDriver({ ...TD, driver: { ...TD.driver, pars: { ...TD.driver.pars, speed: { par: 'x()' } } } }, { klok: new NepKlok() })).toThrow(/driver\.pars\.speed: ongeldige TD-parameter/);
  });

  it('zonder poort in config.json: niet gestart, één melding, niets naar de kern of het netwerk', () => {
    const klok = new NepKlok(), kern = new NepKern();
    /** @type {string[]} */
    const log = [];
    let fetches = 0;
    const d = maakDriver(TD, { klok, fetch: async () => { fetches++; return { ok: true }; }, config: { apps: { 'td-lab': { poort: '9982' } } }, log: (...a) => log.push(a.join(' ')) });
    drivers.push(d);
    d.start(kern);
    klok.loop(60000);
    expect(fetches).toBe(0);
    expect(kern.ontvangen).toEqual([]);
    expect(log.join('\n')).toMatch(/niet gestart: config\.json → apps\.td-lab\.poort \("9982"\) is geen poort/);
  });
});

// ───────────────────────── tegen de nep-bridge ─────────────────────────

describe('TD-driver tegen een nep-bridge', () => {
  it('meldt zich als app bij de kern, op de poort uit config.json; gezonde check → hartslag', async () => {
    const b = await nepBridge();
    const { kern, td, log } = opzet({ poort: b.poort });
    expect(kern.soorten()).toEqual(['hallo', 'manifest']);
    await checkKlaar(td);
    expect(kern.soorten()).toEqual(['hallo', 'manifest', 'hb']);
    expect(b.verzoeken[0]).toMatchObject({ url: '/exec', methode: 'POST', body: tdCheck('/genesis') });
    expect(td.url).toBe(`http://127.0.0.1:${b.poort}`);
    expect(log).toEqual([`driver td-lab verbonden met /genesis via http://127.0.0.1:${b.poort}`]);
  });

  it('per tik één batch met alle gewijzigde parameters, laatste waarde wint', async () => {
    const b = await nepBridge();
    const { klok, kern, v, td } = opzet({ poort: b.poort });
    await checkKlaar(td);
    kern.stuur(v, { t: 'zet', id: 'speed', v: 0.2 });
    kern.stuur(v, { t: 'zet', id: 'speed', v: 0.5 });
    kern.stuur(v, { t: 'zet', id: 'climb', v: 0.75 });
    kern.stuur(v, { t: 'zet', id: 'hud', v: 0 });
    kern.stuur(v, { t: 'scene', i: 0 }); // niets voor TD
    kern.stuur(v, { t: 'globaal', waarden: { bpm: 120 } });
    expect(b.batchVerzoeken()).toHaveLength(0); // pas op de tik
    klok.loop(0);
    await wachtOp(() => b.batches.length === 1);
    expect(b.batches[0]).toEqual({ zetten: { Speed: 0.7, Climb: 1, Hud: false }, pulsen: [] });
    expect(b.comp?.pars.Speed).toBe(0.7);
  });

  it('een bewegende fader: hooguit max_hz batches per seconde, en de laatste waarde komt aan', async () => {
    const b = await nepBridge();
    const { klok, kern, v, td } = opzet({ poort: b.poort });
    await checkKlaar(td);
    for (let i = 1; i <= 20; i++) { kern.stuur(v, { t: 'zet', id: 'hue', v: i / 20 }); klok.loop(10); await batchKlaar(td); } // 20 waarden in 200 ms
    klok.loop(200);
    await batchKlaar(td);
    const hue = b.batches.map((x) => x.zetten.Hue);
    expect(hue.length).toBeLessThanOrEqual(3); // t=0, t=100, t=200
    expect(hue.at(-1)).toBe(1);
  });

  it('nooit twee batches tegelijk onderweg: hangt TD, dan wacht de volgende (en na de time-out telt het als storing)', async () => {
    const b = await nepBridge();
    const { klok, kern, v, td, log } = opzet({ poort: b.poort });
    await checkKlaar(td);
    b.modus = 'hang';
    kern.stuur(v, { t: 'zet', id: 'speed', v: 0.1 });
    klok.loop(0);
    await wachtOp(() => b.batchVerzoeken().length === 1);
    for (let i = 0; i < 5; i++) { kern.stuur(v, { t: 'zet', id: 'speed', v: i / 5 }); klok.loop(150); await rust(); }
    await slaap(30);
    expect(b.batchVerzoeken()).toHaveLength(1);
    klok.loop(TD_EXEC_TIMEOUT_MS);
    await batchKlaar(td);
    expect(td.gemist).toBe(true);
    expect(td.bereikbaar).toBe(false);
    expect(log.filter((l) => /batch mislukt: geen antwoord binnen/.test(l))).toHaveLength(1);
  });

  it('exec geeft 200 met ok:false (COMP net weg tijdens een rebuild) → gemist, en replay na de volgende gezonde check', async () => {
    const b = await nepBridge();
    const { klok, kern, v, td } = opzet({ poort: b.poort });
    await checkKlaar(td);
    const comp = b.comp;
    b.comp = null;
    kern.stuur(v, { t: 'zet', id: 'bright', v: 0.5 });
    klok.loop(0);
    await batchKlaar(td);
    expect(td.gemist).toBe(true);
    expect(kern.tel('hallo')).toBe(1);
    b.comp = comp; // zelfde COMP (zelfde id): alleen het gemiste moet opnieuw
    klok.loop(2000);
    await checkKlaar(td);
    expect(kern.tel('hallo')).toBe(2);
    const insts = kern.ontvangen.filter(([, x]) => x.t === 'hallo').map(([, x]) => x.inst);
    expect(insts[1]).toBe(insts[0]); // zelfde inst: voor de kern een hapering (geen sprong naar de standaard)
    klok.loop(0);
    await wachtOp(() => b.batches.some((x) => x.zetten.Bright === 1.5));
    expect(td.gemist).toBe(false);
  });

  it('een parameter die niet bestaat: de rest wordt gezet, één melding, geen replay-lus', async () => {
    const b = await nepBridge();
    const { klok, kern, v, td, log } = opzet({ poort: b.poort });
    await checkKlaar(td);
    delete b.comp?.pars.Glow; // hernoemd in genesis.py
    for (let i = 0; i < 3; i++) {
      kern.stuur(v, { t: 'zet', id: 'glow', v: 0.5 });
      kern.stuur(v, { t: 'zet', id: 'bg', v: (i + 1) / 3 });
      klok.loop(500);
      await batchKlaar(td);
      klok.loop(1500);
      await checkKlaar(td);
    }
    expect(b.comp?.pars.Bg).toBe(3);
    expect(log.filter((l) => /parameter Glow niet te zetten/.test(l))).toHaveLength(1);
    expect(kern.tel('hallo')).toBe(1); // opnieuw afspelen helpt niet voor een parameter die er niet is
    expect(td.gemist).toBe(false);
  });

  it('een herbouwde COMP (nieuwe id) → opnieuw aanmelden, de kern speelt alles opnieuw af', async () => {
    const b = await nepBridge();
    const { klok, kern, v, td, log } = opzet({ poort: b.poort });
    await checkKlaar(td);
    kern.stuur(v, { t: 'zet', id: 'speed', v: 0.25 });
    kern.stuur(v, { t: 'zet', id: 'auto', v: 0 });
    klok.loop(0);
    await batchKlaar(td);
    b.comp = { id: 202, pars: GENESIS() }; // ./td run scripts/genesis.py: afgebroken en opnieuw gebouwd, standaardwaarden
    klok.loop(2000);
    await checkKlaar(td);
    expect(kern.tel('hallo')).toBe(2);
    const insts = kern.ontvangen.filter(([, x]) => x.t === 'hallo').map(([, x]) => x.inst);
    expect(insts[1]).not.toBe(insts[0]); // herbouwd: TD staat echt op zijn standaard → nieuwe inst
    expect(log.some((l) => /\/genesis is herbouwd/.test(l))).toBe(true);
    klok.loop(100);
    await wachtOp(() => b.comp?.pars.Speed === 0.35 && b.comp?.pars.Auto === false);
  });

  it('geen COMP: geen hartslag, één melding, en niets gestuurd', async () => {
    const b = await nepBridge();
    b.comp = null;
    const { klok, kern, v, td, log } = opzet({ poort: b.poort });
    await checkKlaar(td);
    kern.stuur(v, { t: 'zet', id: 'speed', v: 0.5 });
    klok.loop(0);
    for (let i = 0; i < 4; i++) await volgendeCheck(klok, td);
    expect(kern.tel('hb')).toBe(0);
    expect(td.verstuurd).toEqual([]); // wat de driver probeerde (de nep-klok kan een verzoek afbreken voor het aankomt)
    expect(b.batchVerzoeken()).toHaveLength(0);
    expect(log.filter((l) => /\/genesis bestaat niet/.test(l))).toHaveLength(1);
    // gebouwd: hartslag, en wat gemist werd komt alsnog (replay)
    b.comp = { id: 7, pars: GENESIS() };
    await volgendeCheck(klok, td);
    expect(kern.tel('hb')).toBe(1);
    expect(kern.tel('hallo')).toBe(2);
    klok.loop(0);
    await wachtOp(() => b.comp?.pars.Speed === 0.7);
  });

  it('kapotte bridge (geen JSON, bv. een tikfout in td_bridge.py) of een leeg antwoord → niet gezond; backoff 2 → 4 → 8 → 10 s', async () => {
    const b = await nepBridge();
    b.modus = 'kapot';
    const { klok, kern, td, log } = opzet({ poort: b.poort });
    await checkKlaar(td);
    /** @type {number[]} */
    const tussen = [];
    for (let i = 0; i < 5; i++) {
      const t0 = klok.nu();
      while (!td.checkBezig) klok.loop(500); // de volgende check begint (synchroon in de klok)
      tussen.push(klok.nu() - t0);
      await checkKlaar(td);
      if (i === 2) b.modus = 'leeg';
    }
    expect(tussen).toEqual([2000, 4000, 8000, TD_BACKOFF_MAX_MS, TD_BACKOFF_MAX_MS]);
    expect(kern.tel('hb')).toBe(0);
    expect(log.filter((l) => /bridge niet bereikbaar/.test(l))).toHaveLength(1);
    expect(log[0]).toMatch(/geen JSON van de bridge/);
    b.modus = 'goed';
    await volgendeCheck(klok, td);
    expect(kern.tel('hb')).toBe(1);
    expect(td.wachtMs).toBe(2000); // terug op het gewone ritme
  });

  it('een hangende check wordt na de time-out afgebroken: geen hartslag, en hij blokkeert de volgende niet', async () => {
    const b = await nepBridge();
    b.modus = 'hang';
    const { klok, kern, td } = opzet({ poort: b.poort });
    await wachtOp(() => b.checks() === 1);
    klok.loop(TD_CHECK_TIMEOUT_MS);
    await checkKlaar(td);
    expect(td.bereikbaar).toBe(false);
    b.modus = 'goed';
    klok.loop(2000);
    await wachtOp(() => b.checks() === 2);
    await checkKlaar(td);
    // na een mislukte check altijd opnieuw aanmelden (TD kan intussen herstart zijn), met dezelfde inst
    expect(kern.soorten()).toEqual(['hallo', 'manifest', 'hallo', 'manifest', 'hb']);
    const insts = kern.ontvangen.filter(([, x]) => x.t === 'hallo').map(([, x]) => x.inst);
    expect(insts[1]).toBe(insts[0]);
  });

  it('TD draait niet: geen fout, geen spam in het log, geen hartslag — en zodra de bridge er is, verbonden', async () => {
    const poort = await vrijePoort();
    const { klok, kern, v, td, log } = opzet({ poort });
    expect(() => kern.stuur(v, { t: 'zet', id: 'speed', v: 0.5 })).not.toThrow();
    klok.loop(0);
    await batchKlaar(td);
    await checkKlaar(td);
    for (let i = 0; i < 14; i++) await volgendeCheck(klok, td); // ruim twee minuten
    expect(klok.nu()).toBeGreaterThan(120000);
    expect(kern.tel('hb')).toBe(0);
    expect(log.filter((l) => /bridge niet bereikbaar/.test(l))).toHaveLength(1);
    expect(log.filter((l) => /batch mislukt/.test(l))).toHaveLength(1);
    expect(log.length).toBe(2);
    expect(log[0]).toMatch(/bridge niet bereikbaar op http:\/\/127\.0\.0\.1:\d+ \(ECONNREFUSED\)/);
    // TouchDesigner gaat open, met de bridge op dezelfde poort
    const b = await nepBridge();
    await new Promise((r) => b.server.close(() => r(null)));
    await new Promise((r) => b.server.listen(poort, '127.0.0.1', () => r(null)));
    await volgendeCheck(klok, td);
    expect(kern.tel('hb')).toBe(1);
    expect(kern.tel('hallo')).toBe(2); // de batch van daarnet ging verloren → opnieuw afspelen
    klok.loop(0);
    await wachtOp(() => b.comp?.pars.Speed === 0.7);
  });

  it('een trigger is een puls, alleen bij indrukken', async () => {
    const b = await nepBridge();
    const { klok, kern, v, td } = opzet({ poort: b.poort });
    await checkKlaar(td);
    kern.stuur(v, { t: 'trig', id: 'reseed', aan: true });
    kern.stuur(v, { t: 'trig', id: 'reseed', aan: false });
    klok.loop(0);
    await wachtOp(() => b.batches.length === 1);
    klok.loop(500);
    await batchKlaar(td);
    expect(b.batches).toEqual([{ zetten: {}, pulsen: ['Reseed'] }]);
    expect(b.pulsen.Reseed).toBe(1);
  });

  it('paniek: meteen (ook binnen het max_hz-venster) zwart en de HUD uit, en als zet aan de kern gemeld', async () => {
    const b = await nepBridge();
    const { klok, kern, v, td } = opzet({ poort: b.poort });
    await checkKlaar(td);
    kern.stuur(v, { t: 'zet', id: 'hue', v: 0.1 });
    klok.loop(0);
    await batchKlaar(td);
    kern.stuur(v, { t: 'zet', id: 'bright', v: 0.9 }); // wacht nog op het max_hz-venster…
    kern.stuur(v, { t: 'trig', id: 'paniek', aan: true }); // …de paniek niet, en hij wint
    await wachtOp(() => b.batches.length === 2);
    expect(b.batches[1]).toEqual({ zetten: { Bright: 0, Glow: 0, Bg: 0, Fieldmix: 0, Hud: false }, pulsen: [] });
    expect(klok.nu()).toBe(0);
    klok.loop(0);
    const zets = kern.ontvangen.filter(([, x]) => x.t === 'zet').map(([, x]) => [x.id, x.v]);
    expect(zets).toEqual([['bright', 0], ['glow', 0], ['bg', 0], ['fieldmix', 0], ['hud', 0]]);
    kern.stuur(v, { t: 'trig', id: 'paniek', aan: false }); // loslaten: terug gaat met een snapshot
    klok.loop(500);
    await batchKlaar(td);
    expect(b.batches).toHaveLength(2);
  });

  it('start() twee keer: één checkketen; stop() ruimt alle timers op, breekt af wat loopt en meldt af', async () => {
    const b = await nepBridge();
    const { klok, kern, v, td, d } = opzet({ poort: b.poort });
    d.start(kern);
    await checkKlaar(td);
    klok.loop(2000);
    await checkKlaar(td);
    expect(b.checks()).toBe(2);
    b.modus = 'hang';
    klok.loop(2000);
    kern.stuur(v, { t: 'zet', id: 'speed', v: 1 });
    klok.loop(0);
    await wachtOp(() => b.checks() === 3 && b.batchVerzoeken().length === 1);
    d.stop();
    expect(klok.timers.size).toBe(0);
    expect(td.lopend.size).toBe(0);
    expect(kern.verbroken).toEqual(['td-lab']);
    klok.loop(60000);
    await slaap(30);
    expect(b.verzoeken).toHaveLength(4);
    expect(() => v.stuur({ t: 'zet', id: 'speed', v: 0 })).not.toThrow();
  });

  it('storing zonder zet, daarna dezelfde id (TD herstart met de opgeslagen .toe) → toch opnieuw aanmelden, zelfde inst', async () => {
    const b = await nepBridge();
    const { klok, kern, v, td } = opzet({ poort: b.poort });
    await checkKlaar(td);
    kern.stuur(v, { t: 'zet', id: 'speed', v: 0.25 });
    klok.loop(0);
    await wachtOp(() => b.comp?.pars.Speed === 0.35);
    await batchKlaar(td);
    b.modus = 'kapot'; // TD dicht…
    for (let i = 0; i < 3; i++) await volgendeCheck(klok, td);
    expect(td.gemist).toBe(false); // er ging geen batch verloren
    if (b.comp) b.comp.pars = GENESIS(); // …en weer open met de opgeslagen .toe: dezelfde id, maar de oude standen
    b.modus = 'goed';
    await volgendeCheck(klok, td);
    expect(kern.tel('hallo')).toBe(2);
    const insts = kern.ontvangen.filter(([, x]) => x.t === 'hallo').map(([, x]) => x.inst);
    expect(insts[1]).toBe(insts[0]);
    klok.loop(0);
    await wachtOp(() => b.comp?.pars.Speed === 0.35);
  });

  it('een antwoord dat geen COMP-id is (iets anders op de poort): niet gezond, en geen aanmelding bij elke check', async () => {
    const b = await nepBridge();
    const { klok, kern, td, log } = opzet({ poort: b.poort });
    await checkKlaar(td);
    // iets anders op de poort dat {ok:true, result:{…}} geeft
    b.server.removeAllListeners('request');
    b.server.on('request', (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: { tools: [] } })); });
    for (let i = 0; i < 4; i++) await volgendeCheck(klok, td);
    expect(kern.tel('hallo')).toBe(1);
    expect(kern.tel('hb')).toBe(1);
    expect(log.some((l) => /herbouwd/.test(l))).toBe(false);
    expect(log.filter((l) => /geen COMP-id/.test(l))).toHaveLength(1);
  });

  it('niet gezet: alleen namen die de driver zelf stuurt komen in het log (begrensd)', async () => {
    const b = await nepBridge();
    const { klok, kern, v, td, log } = opzet({ poort: b.poort });
    await checkKlaar(td);
    b.server.removeAllListeners('request');
    b.server.on('request', (req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(200); res.end(JSON.stringify({ ok: false, result: null, error: `RuntimeError: varve-hub: niet gezet: Glow,${'X'.repeat(160)},Onbekend,glow` })); });
    });
    kern.stuur(v, { t: 'zet', id: 'glow', v: 0.5 });
    klok.loop(0);
    await wachtOp(() => td.kapot.size > 0);
    expect([...td.kapot]).toEqual(['Glow']);
    expect(log.filter((l) => /niet te zetten/.test(l))).toEqual([`driver td-lab /genesis: parameter Glow niet te zetten (hernoemd of weg? kijk apps/td-lab.json → driver.pars na)`]);
  });

  it('paniek als de laatste check misging: toch meteen versturen (niet wachten op de volgende check)', async () => {
    const b = await nepBridge();
    b.modus = 'kapot';
    const { klok, kern, v, td } = opzet({ poort: b.poort });
    await checkKlaar(td);
    expect(td.bereikbaar).toBe(false);
    b.modus = 'goed'; // TD is er weer, de driver weet het nog niet
    kern.stuur(v, { t: 'trig', id: 'paniek', aan: true });
    await wachtOp(() => b.batches.length === 1);
    expect(b.batches[0].zetten).toMatchObject({ Bright: 0, Glow: 0, Bg: 0 });
    expect(klok.nu()).toBe(0);
  });

  it('gooit nooit, ook niet als fetch synchroon gooit', async () => {
    const klok = new NepKlok(), kern = new NepKern();
    const d = maakDriver(TD, { klok, fetch: () => { throw new Error('kapot'); }, config: { apps: { 'td-lab': { poort: 9981 } } } });
    drivers.push(d);
    expect(() => d.start(kern)).not.toThrow();
    expect(() => kern.stuur(d.verbinding, { t: 'zet', id: 'speed', v: 1 })).not.toThrow();
    expect(() => kern.stuur(d.verbinding, { t: 'trig', id: 'paniek', aan: true })).not.toThrow();
    klok.loop(0); await rust();
    klok.loop(4000); await rust();
    expect(kern.soorten().filter((t) => t !== 'zet')).toEqual(['hallo', 'manifest']);
  });
});

describe('startDrivers met td-lab', () => {
  it('de TD-driver start alleen als config.json hem aanzet (autostart: true), en meldt zich dan aan', async () => {
    const b = await nepBridge();
    const klok = new NepKlok();
    /** @type {string[]} */
    const log = [];
    const nepFetch = async () => ({ ok: false, status: 503, text: async () => '' });
    const uit = startDrivers({ kern: new NepKern(), klok, systeem: null, fetch: nepFetch, config: { apps: { 'td-lab': { autostart: false } } }, uitstel_ms: 0, log: (...a) => log.push(a.join(' ')) });
    expect(uit.drivers.map((d) => d.driver.manifest.app)).not.toContain('td-lab');
    expect(log.some((l) => /td-lab: TD-driver staat uit — zet config\.json → apps\.td-lab\.autostart op true/.test(l))).toBe(true);
    uit.stop();
    const zonder = startDrivers({ kern: new NepKern(), klok, systeem: null, fetch: nepFetch, uitstel_ms: 0 });
    expect(zonder.drivers.map((d) => d.driver.manifest.app)).not.toContain('td-lab');
    zonder.stop();
    const kern = new NepKern();
    const aan = startDrivers({ kern, klok, systeem: null, fetch: globalThis.fetch, config: { apps: { 'td-lab': { autostart: true, poort: b.poort }, uurwerk: { autostart: false } } }, uitstel_ms: 0 });
    drivers.push(aan);
    const td = /** @type {TdDriver} */ (aan.drivers.find((d) => d.driver.manifest.app === 'td-lab')?.driver);
    expect(td).toBeInstanceOf(TdDriver);
    await checkKlaar(td);
    expect(kern.ontvangen.filter(([app]) => app === 'td-lab').map(([, x]) => x.t)).toEqual(['hallo', 'manifest', 'hb']);
  });
});

describe('TD-driver met de echte kern', () => {
  it('paniek, daarna één hangende batch (TD hapert): Bright blijft 0 — geen sprong naar de standaard met slew terug', async () => {
    const klok = new NepKlok();
    const kern = new Kern({ klok, config: KERN_CONFIG, oppervlak: nepOppervlak() });
    /** @type {Record<string, string>} */
    const pars = {};
    /** @type {string[]} Bright-waarden die TD kreeg na de paniek */
    const bright = [];
    let naPaniek = false, hang = false, hallos = 0;
    /** @type {import('../src/drivers/td.js').TdDriver|null} */
    let tdRef = null;
    const fetch = (/** @type {string} */ _url, /** @type {any} */ init) => {
      const code = String(init.body);
      if (code.startsWith('(lambda')) return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: 101 }) });
      if (hang) return new Promise((_res, rej) => { init.signal?.addEventListener('abort', () => rej(new Error('aborted'))); });
      for (const m of code.matchAll(/_hub_par\('(\w+)'\)\.val = ([^\n]+)/g)) { pars[m[1]] = m[2]; if (m[1] === 'Bright' && naPaniek) bright.push(m[2]); }
      return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: null }) });
    };
    const d = maakDriver(TD, { klok, fetch, config: { apps: { 'td-lab': { poort: 9981 } } } });
    tdRef = /** @type {any} */ (d.driver);
    const ontvang = kern.ontvang.bind(kern);
    kern.ontvang = (/** @type {any} */ v, /** @type {any} */ b) => { if (b?.t === 'hallo') hallos++; return ontvang(v, b); };
    const loop = async (/** @type {number} */ ms) => { for (let i = 0; i < ms / 50; i++) { klok.loop(50); await rust(); await rust(); } };
    try {
      d.start(kern);
      await loop(3000);
      expect(tdRef?.bereikbaar).toBe(true);
      naPaniek = true;
      kern.cockpit({ t: 'zet', app: 'td-lab', id: 'paniek', v: 1 });
      await loop(1000);
      expect(pars.Bright).toBe('0');
      hang = true; // TD hapert (de .toe opslaan, een ./td run op een andere COMP)
      kern.cockpit({ t: 'zet', app: 'td-lab', id: 'speed', v: 0.2 });
      await loop(2500);
      expect(tdRef?.gemist || hallos > 1).toBe(true); // de batch ging verloren
      hang = false;
      await loop(8000);
      expect(hallos).toBeGreaterThan(1); // opnieuw aangemeld (replay)
      expect(bright.length).toBeGreaterThan(1); // de replay stuurde Bright opnieuw…
      expect(bright.filter((x) => Number(x) > 0)).toEqual([]); // …maar nooit boven 0
      expect(pars.Speed).toBe('0.28'); // het gemiste komt alsnog
    } finally {
      d.stop();
      kern.stop();
    }
  });
});
