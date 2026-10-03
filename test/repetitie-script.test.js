// @ts-check
// tools/repetitie.mjs en tools/repetitie-proces.mjs: wat er gebeurt als de repetitie NIET netjes afloopt.
// Ctrl-C, SIGTERM, een ontbrekend programma, een app-server die meteen stopt, een pagina die vastloopt,
// een pad met een spatie, een tikfout in de paden. De echte apps zijn hier niet nodig.
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { Opruimer, start, wachtOpUrl, metTijd, poortBezet, totUiterlijk, staart } from '../tools/repetitie-proces.mjs';
import { leesPaden, appLijst, leesPagina, TE_LAAT } from '../tools/repetitie.mjs';
import { laadConfig } from '../src/config.js';

const HUB = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(HUB, 'tools/repetitie.mjs');
const tmp = mkdtempSync(join(tmpdir(), 'repetitie-script-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
/** Een leeg paden-bestand: geen sets/paden.json van deze machine in de test. */
const GEEN_PADEN = join(tmp, 'geen-paden.json');
writeFileSync(GEEN_PADEN, '{}');

/** Leeft dit proces nog? @param {number} pid */
const leeft = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const wacht = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @param {() => boolean} fn @param {number} ms */
const totWaar = async (fn, ms) => { const eind = Date.now() + ms; while (!fn() && Date.now() < eind) await wacht(50); return fn(); };

/**
 * Start een node-script, verzamel uitvoer; `einde` is de exitcode (of het signaal).
 * @param {string[]} a @param {NodeJS.ProcessEnv} [env]
 */
function draai(a, env = process.env) {
  const p = spawn(process.execPath, a, { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: HUB });
  let uit = '', fout = '';
  p.stdout.on('data', (d) => { uit += d; });
  p.stderr.on('data', (d) => { fout += d; });
  const einde = new Promise((r) => p.on('exit', (code, sig) => r(code ?? sig)));
  return { p, einde, uit: () => uit, fout: () => fout };
}

/** Chromium: zoals test/ui.test.js. */
const uitvoerbaar = process.env.PW_CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
let heeftBrowser = true;
try { heeftBrowser = uitvoerbaar ? existsSync(uitvoerbaar) : existsSync(chromium.executablePath()); } catch { heeftBrowser = false; }
if (process.env.CI) heeftBrowser = true;

describe('opruimen als de repetitie onderbroken wordt (tools/repetitie-proces.mjs)', () => {
  for (const [modus, signaal, code] of /** @type {[string, NodeJS.Signals|null, number][]} */ ([
    ['SIGINT', 'SIGINT', 130], ['SIGTERM', 'SIGTERM', 143], ['SIGHUP', 'SIGHUP', 129],
    ['waakhond', null, 1], ['belofte', null, 1], ['fout', null, 1],
  ])) {
    it(`${modus}: het kindproces (eigen procesgroep) stopt, opruimen en voorAf lopen, exitcode ${code}`, async () => {
      const map = mkdtempSync(join(tmp, `${modus}-`));
      const r = draai([join(HUB, 'test/repetitie-signaal.mjs'), map, signaal ? '' : modus]);
      expect(await totWaar(() => r.uit().includes('\n'), 5000), r.fout()).toBe(true);
      const kind = JSON.parse(r.uit().split('\n')[0]).kind;
      expect(leeft(kind)).toBe(true);
      if (signaal) r.p.kill(signaal);
      expect(await metTijd(r.einde, 10000, 'hangt')).toBe(code);
      expect(await totWaar(() => !leeft(kind), 2000), `kind ${kind} leeft nog`).toBe(true);
      expect(readFileSync(join(map, 'opgeruimd'), 'utf8')).toBe('ja');
      expect(existsSync(join(map, 'voorAf'))).toBe(true);
    }, 20000);
  }

  it('opruimen loopt één keer, in omgekeerde volgorde (wat later kwam — de browser — gaat eerst)', async () => {
    const o = new Opruimer();
    /** @type {string[]} */
    const volgorde = [];
    o.voeg('tijdelijke map', () => { volgorde.push('map'); });
    o.voeg('server', () => { volgorde.push('server'); });
    o.voeg('Chromium', () => { volgorde.push('browser'); });
    await Promise.all([o.draai(), o.draai()]);
    await o.draai();
    expect(volgorde).toEqual(['browser', 'server', 'map']);
  });

  it('een opruimstap die blijft hangen, houdt de rest niet tegen', async () => {
    const o = new Opruimer();
    o.stapMs = 100;
    let verder = false;
    o.voeg('daarna', () => { verder = true; });
    o.voeg('hangt', () => new Promise(() => {}));
    const fout = console.error;
    console.error = () => {};
    try { await o.draai(); } finally { console.error = fout; }
    expect(verder).toBe(true);
  });
});

describe('processen starten (start / wachtOpUrl)', () => {
  it('een programma dat niet bestaat laat node niet crashen; wachtOpUrl meldt ENOENT meteen', async () => {
    const o = new Opruimer();
    const pr = start('bestaat-niet-repetitie-xyz', [], {}, 'nep', o);
    const t0 = Date.now();
    await expect(wachtOpUrl('http://127.0.0.1:9/', { ms: 20000, proces: pr })).rejects.toThrow(/nep: starten mislukt: .*ENOENT/);
    expect(Date.now() - t0).toBeLessThan(3000);
    await o.draai();
  });

  it('een server die meteen stopt: wachtOpUrl stopt meteen, met de laatste uitvoer erbij', async () => {
    const o = new Opruimer();
    const pr = start(process.execPath, ['-e', 'console.error("Cannot find module vite"); process.exit(3)'], {}, 'medisynth', o);
    const t0 = Date.now();
    await expect(wachtOpUrl('http://127.0.0.1:9/', { ms: 20000, proces: pr })).rejects.toThrow(/medisynth: het proces stopte \(code 3\)[\s\S]*Cannot find module vite/);
    expect(Date.now() - t0).toBeLessThan(3000);
    await o.draai();
  });

  it('een verwachte stop (herstart) wordt niet als onverwacht gemeld; de uitvoer komt zonder terminal-opmaak', async () => {
    const o = new Opruimer();
    /** @type {string[]} */
    const log = [];
    const pr = start(process.execPath, ['-e', 'process.stdout.write("\\x1b[38;2;1;2;3mflux\\x1b[0m\\x1b[?25h\\x1b[2J klaar\\n"); setInterval(() => {}, 1000)'], {}, 'flux', o, (s) => log.push(s));
    await totWaar(() => pr.uitvoer().includes('klaar'), 3000);
    expect(staart(pr)).toContain('flux klaar');
    expect(staart(pr)).not.toContain('\x1b');
    pr.verwachtStop();
    pr.p.kill('SIGTERM');
    await new Promise((r) => pr.p.once('exit', r));
    const onverwacht = start(process.execPath, ['-e', 'process.exit(4)'], {}, 'ander', o, (s) => log.push(s));
    await new Promise((r) => onverwacht.p.once('exit', r));
    expect(log).toEqual([expect.stringMatching(/^ander: proces stopte onverwacht \(code 4\)/)]);
    await o.draai();
  });

  it('totUiterlijk: een lus met een deadline en een duidelijke melding', async () => {
    await expect(totUiterlijk(() => false, 100, 'de LPD8 meldt zich niet als mk2')).rejects.toThrow('de LPD8 meldt zich niet als mk2');
  });
});

describe('tools/repetitie.mjs als script', () => {
  it('Ctrl-C midden in de repetitie: servers, browser en tijdelijke map zijn weg, exitcode 130', { timeout: 60000, skip: !heeftBrowser }, async () => {
    const config = laadConfig();
    const poortWater = Number(config.apps.waterschaal.poort);
    if (await poortBezet(poortWater)) return; // poort van waterschaal bezet op deze machine: niet te toetsen
    const leeg = mkdtempSync(join(tmp, 'waterschaal-'));
    const uit = mkdtempSync(join(tmp, 'uit-'));
    const tmpVoor = new Set(readdirSync(tmpdir()).filter((x) => x.startsWith('repetitie-') && !x.startsWith('repetitie-script')));
    const r = draai([SCRIPT, '--zonder', 'formula-lab,medisynth,flux,varve-dj', '--hub-poort', '0', '--uit', uit, '--paden', GEEN_PADEN], {
      ...process.env, REPETITIE_WATERSCHAAL: leeg, ...(uitvoerbaar ? { CHROMIUM: uitvoerbaar } : {}),
    });
    const python = () => { try { return execFileSync('pgrep', ['-f', `http.server ${poortWater}`], { encoding: 'utf8' }).trim(); } catch { return ''; } };
    const nieuweTmp = () => readdirSync(tmpdir()).filter((x) => x.startsWith('repetitie-') && !x.startsWith('repetitie-script') && !tmpVoor.has(x));
    try {
      // Wachten tot de app-pagina open is en de avond loopt (opkomst wacht dan op een app die nooit komt).
      expect(await totWaar(() => r.uit().includes('▶ opkomst'), 40000), r.uit() + r.fout()).toBe(true);
      expect(await poortBezet(poortWater)).toBe(true);
      r.p.kill('SIGINT');
      expect(await metTijd(r.einde, 30000, 'hangt'), r.fout()).toBe(130);
      expect(await poortBezet(poortWater), 'python http.server antwoordt nog').toBe(false);
      expect(await totWaar(() => python() === '', 2000), `python http.server draait nog (pid ${python()})`).toBe(true);
      expect(nieuweTmp(), 'tijdelijke map bleef staan').toEqual([]);
    } finally {
      // Ging het mis, dan niets laten slingeren (de poort was vóór de test vrij, dus dit is van ons).
      r.p.kill('SIGKILL');
      for (const pid of python().split('\n').filter(Boolean)) { try { process.kill(Number(pid), 'SIGKILL'); } catch { /* al weg */ } }
      for (const x of nieuweTmp()) rmSync(join(tmpdir(), x), { recursive: true, force: true });
    }
  });

  it('python3 ontbreekt: een duidelijke melding en exitcode 1, geen crash op een onafgehandelde error', async () => {
    const bin = mkdtempSync(join(tmp, 'bin-'));
    const git = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    symlinkSync(git, join(bin, 'git'));
    const leeg = mkdtempSync(join(tmp, 'waterschaal-'));
    const r = draai([SCRIPT, '--zonder', 'formula-lab,medisynth,flux,varve-dj', '--hub-poort', '0', '--uit', join(tmp, 'uit-py'), '--paden', GEEN_PADEN], {
      ...process.env, PATH: bin, REPETITIE_WATERSCHAAL: leeg,
    });
    const code = await metTijd(r.einde, 30000, 'hangt');
    expect(r.fout()).not.toMatch(/Emitted 'error' event|Unhandled 'error' event/);
    expect(r.fout()).toMatch(/waterschaal: starten mislukt: spawn python3 ENOENT/);
    expect(code).toBe(1);
  }, 40000);

  it('een Vite-app zonder node_modules: meteen "eerst npm install", niet 30 s wachten', async () => {
    const leeg = mkdtempSync(join(tmp, 'medisynth-'));
    const t0 = Date.now();
    const r = draai([SCRIPT, '--zonder', 'formula-lab,waterschaal,flux,varve-dj', '--hub-poort', '0', '--uit', join(tmp, 'uit-ms'), '--paden', GEEN_PADEN], {
      ...process.env, REPETITIE_MEDISYNTH: leeg,
    });
    expect(await metTijd(r.einde, 20000, 'hangt')).toBe(1);
    expect(r.fout()).toContain(`medisynth: eerst \`npm install\` in ${leeg}`);
    expect(Date.now() - t0).toBeLessThan(15000);
  }, 30000);

  it('draait ook vanuit een pad met een spatie of via een symlink (en zegt dan iets, niet stil exitcode 0)', async () => {
    const map = join(tmp, 'met spatie');
    mkdirSync(map, { recursive: true });
    symlinkSync(HUB, join(map, 'hub'));
    const r = draai([join(map, 'hub/tools/repetitie.mjs'), '--paden', join(tmp, 'bestaat-niet.json')]);
    expect(await metTijd(r.einde, 20000, 'hangt')).toBe(1);
    expect(r.fout()).toMatch(/paden: .*bestaat-niet\.json bestaat niet \(--paden\)/);
    // En een echte map met een spatie erin (geen symlink): isHoofdmodule ziet het script.
    const echt = join(tmp, 'nog een spatie');
    mkdirSync(join(echt, 'tools'), { recursive: true });
    copyFileSync(join(HUB, 'tools/repetitie-proces.mjs'), join(echt, 'tools/repetitie-proces.mjs'));
    writeFileSync(join(echt, 'tools/probeer.mjs'), "import { isHoofdmodule } from './repetitie-proces.mjs';\nconsole.log(isHoofdmodule(import.meta.url));\n");
    const p = draai([join(echt, 'tools/probeer.mjs')]);
    await p.einde;
    expect(p.uit().trim()).toBe('true');
  }, 30000);
});

describe('paden en opties (leesPaden, appLijst)', () => {
  const config = laadConfig();
  it('een opgegeven paden-bestand dat niet bestaat is een fout (niet stil terugvallen op ../<repo>)', () => {
    expect(() => leesPaden(config, { bestand: join(tmp, 'weg.json'), env: {} })).toThrow(/weg\.json bestaat niet \(--paden\)/);
    expect(() => leesPaden(config, { env: { VARVE_HUB_PADEN: join(tmp, 'weg2.json') } })).toThrow(/bestaat niet \(\$VARVE_HUB_PADEN\)/);
  });
  it('ongeldige JSON noemt het bestand', () => {
    const f = join(tmp, 'kapot.json');
    writeFileSync(f, '{ "formula-lab": ');
    expect(() => leesPaden(config, { bestand: f, env: {} })).toThrow(/kapot\.json is geen geldige JSON/);
  });
  it('geen bestand opgegeven en geen sets/paden.json: de repo\'s naast de hub', () => {
    const p = leesPaden(config, { env: {}, hubMap: join(tmp, 'hub') });
    expect(p['formula-lab']).toBe(join(tmp, config.apps['formula-lab'].repo));
    expect(p['varve-dj']).toBeUndefined();
  });
  it('sleutel = repo-naam, ~ = thuismap, $REPETITIE_<APP> wint', () => {
    const f = join(tmp, 'paden.json');
    writeFileSync(f, JSON.stringify({ 'flux-screensaver': '~/x/flux', 'youtube-mixer': '/ergens/ym' }));
    const p = leesPaden(config, { bestand: f, env: { REPETITIE_MEDISYNTH: '/m' } });
    expect(p.flux).toMatch(/\/x\/flux$/);
    expect(p['youtube-mixer']).toBe('/ergens/ym');
    expect(p.medisynth).toBe('/m');
  });
  it('--zonder/--herstart: onbekende app-ids geven een waarschuwing en vallen weg', () => {
    /** @type {string[]} */
    const w = [];
    expect(appLijst('flux,fromula-lab', '--zonder', (s) => w.push(s))).toEqual(['flux']);
    expect(w.join()).toMatch(/--zonder kent fromula-lab niet/);
  });
});

describe.skipIf(!heeftBrowser)('teruglezen uit een vastgelopen pagina', () => {
  it('leesPagina geeft na de time-out TE_LAAT, ook als de hoofdthread vastzit', async () => {
    const browser = await chromium.launch({ ...(uitvoerbaar ? { executablePath: uitvoerbaar } : {}), headless: true });
    try {
      const page = await browser.newPage();
      expect(await leesPagina(page, () => 1, 2000)).toBe(1);
      await page.evaluate(() => { setTimeout(() => { for (;;) { /* vast */ } }, 0); });
      const t0 = Date.now();
      expect(await leesPagina(page, () => 1, 300)).toBe(TE_LAAT);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally { await browser.close(); }
  }, 30000);
});
