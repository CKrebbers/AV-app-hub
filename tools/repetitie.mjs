#!/usr/bin/env node
// @ts-check
// Generale repetitie: de hub met de ECHTE app-koppelingen, één avond lang (draaiboek: tools/repetitie-avond.mjs).
// Lokaal, niet in CI (daar: test/repetitie.test.js met nep-apps en dezelfde manifesten). Zie docs/REPETITIE.md.
//
//   node tools/repetitie.mjs [--paden paden.json] [--uit tools/uitvoer] [--fixtures] [--zonder flux,…]
//                            [--herstart formula-lab,varve-dj,flux] [--hub-poort 7700] [--zichtbaar] [--max-duur 300]
//
// Wat er draait:
//  - de hub (startHub) met NepSysteem: een nep-APC40 mkII en een nep-LPD8 mk2; poort uit config.json;
//  - Formula Lab en MediSynth op hun Vite-dev-server, Waterschaal statisch (python3 http.server),
//    Varve DJ met zijn eigen server (patch uit koppelingen/varve-dj in een tijdelijke worktree),
//    allemaal in headless Chromium (playwright-core) met ?hub=;
//  - flux in een pseudo-terminal, via tools/repetitie-flux.py (meet wat flux ontvangt en toepast).
// Paden: sets/paden.json (zelfde bestand als de sets, niet in git), $VARVE_HUB_PADEN of --paden (sleutel = repo-naam uit config.json), per app
// te overschrijven met $REPETITIE_<APP>; zonder iets: naast deze repo (../formula-lab, ../flux-screensaver, …).
// Rapport: <uit>/repetitie-<datum>.md en .json. Met --fixtures: de manifesten die de apps echt stuurden naar
// test/fixtures/manifesten/<app>.json.
// Opruimen (servers, browser, tijdelijke worktree en map) gebeurt ook bij Ctrl-C, SIGTERM, SIGHUP, een onverwachte
// fout en na --max-duur (dan met een gedeeltelijk rapport): zie tools/repetitie-proces.mjs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startHub } from '../src/hub.js';
import { NepSysteem } from '../src/ports/nep.js';
import { laadConfig } from '../src/config.js';
import { echteKlok } from '../src/core/klok.js';
import { speelAvond, rapportMd, wandklok, deelUitslag } from './repetitie-avond.mjs';
import { Opruimer, start as startProces, stopProces, wachtOpUrl, poortBezet, poortBezetMelding, metTijd, isHoofdmodule, totUiterlijk, wacht } from './repetitie-proces.mjs';

const HUB_MAP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APPS = ['formula-lab', 'waterschaal', 'medisynth', 'flux', 'varve-dj'];
/** De formule waarmee Formula Lab start (anders begint hij willekeurig en verandert het manifest bij elke herstart). */
const FORMULE = 'sin(x * 4.0 + t * 0.7)';
const CHROMIUM = process.env.CHROMIUM ?? process.env.PW_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
/** Hoe lang één keer teruglezen uit een pagina mag duren (een vastgelopen hoofdthread laat page.evaluate eeuwig wachten). */
export const LEES_MS = 2000;
/** Standaard voor --max-duur (s): daarna breekt de waakhond de repetitie af, ruimt op en schrijft een gedeeltelijk rapport. */
const MAX_DUUR_S = 300;
export const TE_LAAT = Symbol('te laat');
/**
 * Een pagina-evaluatie, maar nooit langer dan `ms`: daarna TE_LAAT (de evaluatie zelf blijft hangen, niemand wacht erop).
 * @param {{ evaluate: (f: () => any) => Promise<any> }} page @param {() => any} lezer
 */
export const leesPagina = (page, lezer, ms = LEES_MS) => metTijd(page.evaluate(lezer).catch(() => null), ms, TE_LAAT);

const args = process.argv.slice(2);
const optie = (/** @type {string} */ n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const vlag = (/** @type {string} */ n) => args.includes(n);
const log = (/** @type {string} */ s) => console.log(s);
const opruimer = new Opruimer();
/** @param {string} cmd @param {string[]} a @param {import('node:child_process').SpawnOptions} o @param {string} naam */
const start = (cmd, a, o, naam) => startProces(cmd, a, o, naam, opruimer, log);

/**
 * Paden van de koppelingen, in hetzelfde formaat als de sets: sets/paden.json (lokaal, niet in git)
 * of $VARVE_HUB_PADEN of --paden, met als sleutel de repo-naam uit config.json → apps.<id>.repo (`~` = thuismap).
 * Per app te overschrijven met $REPETITIE_<APP> (bv. REPETITIE_FORMULA_LAB). Sleutel "varve-dj" (app-id) mag
 * een kant-en-klare Varve DJ-checkout mét de hub-patch zijn; anders maakt de repetitie zelf een tijdelijke
 * worktree van "youtube-mixer" (origin/main) met de patches uit koppelingen/varve-dj.
 * Zonder iets: de repo's naast deze repo (../formula-lab, ../flux-screensaver, …).
 * Een expliciet opgegeven bestand (--paden of $VARVE_HUB_PADEN) moet bestaan; ongeldige JSON is altijd een fout.
 * @param {any} config
 * @param {{ bestand?: string, env?: NodeJS.ProcessEnv, hubMap?: string }} [o] bestand = --paden
 * @returns {Record<string, string>} app-id → map, plus 'youtube-mixer'
 */
export function leesPaden(config, { bestand: opgegeven, env = process.env, hubMap = HUB_MAP } = {}) {
  const expliciet = opgegeven ?? env.VARVE_HUB_PADEN;
  const bestand = expliciet ?? join(hubMap, 'sets/paden.json');
  if (expliciet && !existsSync(bestand)) throw new Error(`paden: ${bestand} bestaat niet (${opgegeven ? '--paden' : '$VARVE_HUB_PADEN'}); zie docs/REPETITIE.md voor een voorbeeld`);
  /** @type {Record<string, string>} */
  let p = {};
  if (existsSync(bestand)) {
    try { p = JSON.parse(readFileSync(bestand, 'utf8')); } catch (e) { throw new Error(`paden: ${bestand} is geen geldige JSON: ${/** @type {any} */ (e)?.message}`); }
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error(`paden: ${bestand} moet een object zijn ({ "repo-naam": "map" })`);
  }
  const thuis = (/** @type {string} */ x) => (x === '~' ? homedir() : x.startsWith('~/') ? join(homedir(), x.slice(2)) : x);
  /** @type {Record<string, string>} */
  const uit = {};
  for (const app of [...APPS, 'youtube-mixer']) {
    const repo = app === 'youtube-mixer' ? app : config.apps[app]?.repo ?? app;
    const e = env[`REPETITIE_${app.toUpperCase().replace(/-/g, '_')}`];
    // varve-dj: alleen een eigen sleutel "varve-dj" (een checkout mét patch); de repo zelf heet youtube-mixer.
    const v = e ?? p[app] ?? (app === 'varve-dj' ? undefined : p[repo]) ?? (app === 'varve-dj' ? undefined : join('..', repo));
    if (v) uit[app] = resolve(hubMap, thuis(v));
  }
  return uit;
}

/** App-ids uit een optie als --zonder of --herstart; onbekende ids geven een waarschuwing. @param {string|undefined} waarde @param {string} optieNaam @param {(s: string) => void} [waarschuw] */
export function appLijst(waarde, optieNaam, waarschuw = (s) => console.warn(s)) {
  const lijst = (waarde ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const onbekend = lijst.filter((x) => !APPS.includes(x));
  if (onbekend.length) waarschuw(`let op: ${optieNaam} kent ${onbekend.join(', ')} niet (wel: ${APPS.join(', ')})`);
  return lijst.filter((x) => APPS.includes(x));
}

/** git-stand van een map, voor het rapport. @param {string} map */
function gitStand(map) {
  try {
    const g = (/** @type {string[]} */ a) => execFileSync('git', ['-C', map, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const vuil = g(['status', '--porcelain']).split('\n').filter(Boolean).length;
    return `${g(['rev-parse', '--abbrev-ref', 'HEAD'])} @ ${g(['rev-parse', '--short', 'HEAD'])}${vuil ? ` (+${vuil} gewijzigd)` : ''}`;
  } catch { return 'geen git'; }
}

/** Basis waarop de patches in koppelingen/varve-dj gemaakt zijn (koppelingen/varve-dj/LEESMIJ.md). */
const VARVE_DJ_BASIS = '99c7fa2';

/**
 * Varve DJ met de hub-patch: een tijdelijke worktree van youtube-mixer op origin/main. Er wordt niets gecommit;
 * alleen git's eigen administratie (.git/worktrees) krijgt een tijdelijke regel, die het opruimen weer weghaalt.
 * @param {string} repo
 */
function varveDjWerkboom(repo) {
  const map = mkdtempSync(join(tmpdir(), 'repetitie-varve-dj-'));
  rmSync(map, { recursive: true });
  execFileSync('git', ['-C', repo, 'worktree', 'add', '--detach', map, 'origin/main'], { stdio: 'ignore' });
  opruimer.voeg('varve-dj-worktree', () => {
    try { execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', map], { stdio: 'ignore' }); } catch { rmSync(map, { recursive: true, force: true }); }
  });
  const basis = execFileSync('git', ['-C', map, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  const patches = readdirSync(join(HUB_MAP, 'koppelingen/varve-dj')).filter((f) => f.endsWith('.patch')).sort();
  for (const f of patches) {
    try {
      execFileSync('git', ['-C', map, 'apply', join(HUB_MAP, 'koppelingen/varve-dj', f)], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      const uit = String(/** @type {any} */ (e)?.stderr ?? '').trim().split('\n').slice(0, 5).join('\n  ');
      throw new Error(`varve-dj: patch ${f} past niet op origin/main @${basis} (gemaakt op ${VARVE_DJ_BASIS}). `
        + `Doe \`git fetch\` in ${repo}, of zet "varve-dj" in paden.json naar een checkout mét de patch.${uit ? `\n  ${uit}` : ''}`);
    }
  }
  return { map, basis, patches };
}

/**
 * WebSocket-spion voor in de pagina: meldt elk bericht van en naar de hub met de wandklok van de pagina.
 * @param {number} hubPoort
 */
const SPION = (hubPoort) => {
  const Echt = window.WebSocket;
  const nu = () => performance.timeOrigin + performance.now();
  // @ts-ignore
  const meld = (x) => { try { window.__repetitieMeld(x); } catch { /* nog niet gebonden */ } };
  // @ts-ignore
  window.WebSocket = class extends Echt {
    /** @param {string|URL} url @param {any} p */
    constructor(url, p) {
      super(url, p);
      if (!String(url).includes(`:${hubPoort}/`)) return;
      this.addEventListener('message', (e) => meld({ r: 'in', t: nu(), d: String(e.data) }));
      const stuur = this.send.bind(this);
      this.send = (d) => { meld({ r: 'uit', t: nu(), d: String(d) }); return stuur(d); };
    }
  };
};

/** Console-melding met de plek (bij "Failed to load resource" is dat de URL die mislukte). @param {any} m */
const metPlek = (m) => { const u = m.location?.()?.url; return u ? `${m.text()} [${u}]` : m.text(); };

/** Wat paniek in een app hoort te doen, gelezen met LEZERS (aan = P1 nog ingedrukt). */
const PANIEK = {
  // waterschaal: "zachte stilte" — volume naar 0 (en het blijft daar tot iemand het weer opdraait)
  waterschaal: (/** @type {Record<string, number>} */ w, /** @type {boolean} */ aan) => (aan ? [w.volume === 0, `volume ${w.volume}`] : null),
  // Varve DJ: eindbeeld zwart zolang P1 vastgehouden wordt, daarna weer de schakelaar
  'varve-dj': (/** @type {Record<string, number>} */ w, /** @type {boolean} */ aan) => (typeof w.__zwart === 'number' ? [w.__zwart === (aan ? 1 : 0), `zwart vast = ${w.__zwart}`] : null),
};

/** Lees de staat terug uit elke app-pagina (0..1 per parameter-id; wat niet te lezen is, ontbreekt). */
const LEZERS = {
  'formula-lab': () => {
    /** @type {Record<string, number>} */
    const w = {};
    for (const rij of document.querySelectorAll('#sliders .slider-row')) {
      const naam = rij.querySelector('.slider-name')?.textContent?.trim();
      const s = /** @type {HTMLInputElement|null} */ (rij.querySelector('input[type=range]'));
      if (naam && s && +s.max > +s.min) w[naam] = (+s.value - +s.min) / (+s.max - +s.min);
    }
    return w;
  },
  waterschaal: () => {
    /** @type {Record<string, number>} */
    const w = {};
    // @ts-ignore — P is een globale const van de pagina
    for (const k of Object.keys(P)) {
      const el = /** @type {HTMLInputElement|null} */ (document.getElementById(`s_${k}`));
      if (!el) continue;
      // @ts-ignore
      w[k] = k === 'tempo' ? (60 / P.tempo - 4) / 12 : (P[k] - +el.min) / (+el.max - +el.min);
    }
    return w;
  },
  medisynth: () => {
    // @ts-ignore — alleen met ?debug en na de eerste klik (main.js)
    const m = window.medisynth;
    if (!m) return null;
    return {
      niveau: 1 + Math.log10(m.engine.levelGlide.target) / 0.6,
      helderheid: 0.5 + Math.log2(m.engine.brightnessGlide.target) / 1.4,
      dichtheid: 1 - m.weather.thinGlide.target / 0.45,
    };
  },
  'varve-dj': () => {
    // @ts-ignore
    const midi = window.midi;
    if (!midi?.read) return null;
    /** @type {Record<string, number>} */
    const w = {};
    for (const [id, actie] of [['master', 'mixer.master'], ['xfader', 'mixer.xfader'], ['beeld', 'video.master'], ['puls', 'video.pulse'], ['__zwart', 'video.black.hold']]) {
      const v = midi.read(actie);
      if (typeof v === 'number') w[id] = v;
    }
    return w;
  },
};

/** Logboek van één app: ontvangen/verzonden berichten en fouten, ook over herstarts heen. */
class Logboek {
  constructor() {
    /** @type {{ t: number, b: any }[]} */ this.in = [];
    /** @type {{ t: number, b: any }[]} */ this.uit = [];
    /** @type {{ t: number, tekst: string }[]} */ this.fouten = [];
    /** @type {number|undefined} */ this.pid = undefined;
  }
  /** @param {{ r: string, t: number, d?: string, tekst?: string, pid?: number }} x */
  neem(x) {
    if (x.r === 'fout') { this.fouten.push({ t: x.t, tekst: String(x.tekst) }); return; }
    if (x.r === 'pid') { this.pid = x.pid; return; }
    let b;
    try { b = JSON.parse(String(x.d)); } catch { return; }
    (x.r === 'in' ? this.in : this.uit).push({ t: x.t, b });
  }
  manifest() { return this.uit.filter((x) => x.b.t === 'manifest').at(-1)?.b.manifest; }
}

/**
 * Wat er tot nu toe gespeeld is: genoeg voor een gedeeltelijk rapport als de repetitie halverwege stopt
 * (Ctrl-C, --max-duur, een onverwachte fout).
 * @type {{ naam: string|null, datum: string, omgeving: Record<string, unknown>, stappen: import('./repetitie-avond.mjs').Stap[], klaar: boolean }}
 */
const lopend = { naam: null, datum: '', omgeving: {}, stappen: [], klaar: false };

/** Schrijf een gedeeltelijk rapport (alleen als er al iets gespeeld is en het volledige rapport er nog niet is). @param {string} reden */
function schrijfDeelrapport(reden) {
  if (!lopend.naam || lopend.klaar || !lopend.stappen.length) return;
  const omgeving = { ...lopend.omgeving, afgebroken: reden };
  const uitslag = deelUitslag(lopend.stappen);
  writeFileSync(`${lopend.naam}.json`, JSON.stringify({ omgeving, ...uitslag }, null, 2));
  writeFileSync(`${lopend.naam}.md`, rapportMd({ datum: lopend.datum, omgeving, uitslag }));
  console.error(`gedeeltelijk rapport (${lopend.stappen.length} stappen): ${lopend.naam}.md`);
}

/**
 * Controleer vooraf of een Vite-app zijn afhankelijkheden heeft (anders wacht je 30 s op niets).
 * @param {string} app @param {string} map @param {string[]} [extra]
 */
function moetNodeModules(app, map, extra = []) {
  const mist = ['vite', ...extra].filter((m) => !existsSync(join(map, 'node_modules', m)));
  if (mist.length) throw new Error(`${app}: eerst \`npm install\` in ${map} (node_modules mist ${mist.join(', ')})`);
}

async function main() {
  const config = laadConfig();
  const paden = leesPaden(config, { bestand: optie('--paden') });
  const zonder = new Set(appLijst(optie('--zonder'), '--zonder'));
  const herstarten = appLijst(optie('--herstart') ?? 'formula-lab,varve-dj,flux', '--herstart');
  const deze = APPS.filter((a) => !zonder.has(a));
  const hubPoort = Number(optie('--hub-poort') ?? config.poorten.http);
  const uitMap = resolve(optie('--uit') ?? join(HUB_MAP, 'tools/uitvoer'));
  const datum = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const tmp = mkdtempSync(join(tmpdir(), 'repetitie-'));
  opruimer.voeg('tijdelijke map', () => rmSync(tmp, { recursive: true, force: true }));

  // ── de hub ──────────────────────────────────────────────────────────────────────────────────────
  if (await poortBezet(hubPoort)) throw new Error(`poort ${hubPoort} is bezet: draait er al een hub (of nog een vorige repetitie)? Stop hem (lsof -i :${hubPoort}) of gebruik --hub-poort.`);
  const systeem = new NepSysteem();
  const apc = systeem.voegToe('APC40 mkII');
  const lpd8 = systeem.voegToe('LPD8 mk2');
  lpd8.antwoord = (b) => { if (b[1] === 0x7e) setTimeout(() => lpd8.injecteer([0xf0, 0x7e, 0, 6, 2, 0x47, 0x4c, 0, 0xf7]), 1); };
  const hub = await startHub({ config: { ...config, hotplug_ms: 100 }, systeem, klok: echteKlok, poort: hubPoort, host: '127.0.0.1', drivers: false });
  opruimer.voeg('hub', () => hub.stop());
  // De echte poort (met --hub-poort 0 kiest het systeem er een).
  const hubUrl = `ws://localhost:${new URL(hub.adres).port}/app`;
  log(`hub op ${hub.adres} (nep-APC40 + nep-LPD8)`);
  await totUiterlijk(() => hub.apparaten.apc.verbonden && hub.apparaten.lpd8.model === 'mk2', 10000,
    `de nep-controllers melden zich niet binnen 10 s (APC40 verbonden: ${hub.apparaten.apc.verbonden}, LPD8-model: ${hub.apparaten.lpd8.model})`);

  // ── servers van de apps ─────────────────────────────────────────────────────────────────────────
  /** @type {Record<string, string>} */
  const omgevingApps = {};
  const poortVan = (/** @type {string} */ app) => Number(config.apps[app]?.poort);
  /** @type {Record<string, string>} */
  const adres = {};
  /** @param {string} app */
  const moetBestaan = (app, map = paden[app]) => { if (!map || !existsSync(map)) throw new Error(`${app}: map ${map} bestaat niet (zie --paden, docs/REPETITIE.md)`); return map; };

  for (const app of deze) {
    if (app === 'flux') continue;
    const p = poortVan(app);
    if (await poortBezet(p)) throw new Error(poortBezetMelding(app, p));
  }
  /** @type {Record<string, import('./repetitie-proces.mjs').Proces>} */
  const servers = {};
  if (deze.includes('formula-lab')) {
    const map = moetBestaan('formula-lab');
    moetNodeModules('formula-lab', map, ['lz-string']);
    const lz = createRequire(join(map, 'package.json'))('lz-string');
    const hash = `#f=${lz.compressToEncodedURIComponent(JSON.stringify({ v: 1, source: FORMULE }))}`;
    servers['formula-lab'] = start(process.execPath, [join(map, 'node_modules/vite/bin/vite.js'), '--port', String(poortVan('formula-lab')), '--strictPort', '--host', 'localhost'], { cwd: map }, 'formula-lab');
    adres['formula-lab'] = `http://localhost:${poortVan('formula-lab')}/?hub=${encodeURIComponent(hubUrl)}${hash}`;
    omgevingApps['formula-lab'] = `${map} · ${gitStand(map)}`;
  }
  if (deze.includes('medisynth')) {
    const map = moetBestaan('medisynth');
    moetNodeModules('medisynth', map);
    servers.medisynth = start(process.execPath, [join(map, 'node_modules/vite/bin/vite.js'), '--port', String(poortVan('medisynth')), '--strictPort', '--host', 'localhost'], { cwd: map }, 'medisynth');
    adres.medisynth = `http://localhost:${poortVan('medisynth')}/?debug&hub=${encodeURIComponent(hubUrl)}`;
    omgevingApps.medisynth = `${map} · ${gitStand(map)}`;
  }
  if (deze.includes('waterschaal')) {
    const map = moetBestaan('waterschaal');
    servers.waterschaal = start('python3', ['-m', 'http.server', String(poortVan('waterschaal')), '--bind', '127.0.0.1'], { cwd: map }, 'waterschaal');
    adres.waterschaal = `http://localhost:${poortVan('waterschaal')}/td/waterschaal-lokaal.html?hub=${encodeURIComponent(hubUrl)}`;
    omgevingApps.waterschaal = `${map} · ${gitStand(map)}`;
  }
  if (deze.includes('varve-dj')) {
    let map = paden['varve-dj'];
    if (!map || !existsSync(join(map, 'src/control/hub.js'))) {
      const repo = moetBestaan('youtube-mixer', paden['youtube-mixer']);
      const w = varveDjWerkboom(repo);
      map = w.map;
      omgevingApps['varve-dj'] = `${repo} · origin/main @ ${w.basis} + ${w.patches.join(', ')} (tijdelijke worktree)`;
    } else omgevingApps['varve-dj'] = `${map} · ${gitStand(map)}`;
    servers['varve-dj'] = start(process.execPath, [join(map, 'server/index.js')], {
      cwd: map,
      env: { ...process.env, PORT: String(poortVan('varve-dj')), VARVE_DB: join(tmp, 'varve.db'), VARVE_MEDIA: join(tmp, 'media'), VARVE_OPNAMES: join(tmp, 'opnames'), VARVE_HERANALYSE: 'uit' },
    }, 'varve-dj');
    adres['varve-dj'] = `http://localhost:${poortVan('varve-dj')}/?hub=${encodeURIComponent(hubUrl)}`;
  }
  for (const app of Object.keys(adres)) await wachtOpUrl(adres[app].replace(/\?.*$/, ''), { proces: servers[app] });

  // ── Chromium ────────────────────────────────────────────────────────────────────────────────────
  const { chromium } = await import('playwright-core');
  /** @type {import('playwright-core').Browser} */
  let browser;
  try {
    browser = await chromium.launch({
      executablePath: CHROMIUM, headless: !vlag('--zichtbaar'),
      // Signalen handelt de repetitie zelf af (opruimen); anders sluit Playwright alleen Chromium en stopt node.
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
  } catch (e) {
    throw new Error(`Chromium start niet${CHROMIUM ? ` (${CHROMIUM})` : ''}. Installeer hem eenmalig met \`npx playwright-core install chromium\`, `
      + `of wijs een eigen Chrome aan: CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node tools/repetitie.mjs\n  ${String(/** @type {any} */ (e)?.message ?? e).split('\n')[0]}`);
  }
  // Ná de servers toegevoegd, dus vóór de servers opgeruimd: de pagina's verbinden niet opnieuw met wat al weg is.
  opruimer.voeg('Chromium', () => browser.close());

  /** @type {Map<string, import('./repetitie-avond.mjs').Deelnemer>} */
  const deelnemers = new Map();
  /** @type {Map<string, Logboek>} */
  const logboeken = new Map();

  /** Een app in een eigen browsercontext. @param {string} app */
  async function pagina(app) {
    const boek = new Logboek();
    logboeken.set(app, boek);
    const context = await browser.newContext();
    await context.exposeBinding('__repetitieMeld', (_bron, x) => boek.neem(x));
    await context.addInitScript(SPION, Number(new URL(hub.adres).port));
    const page = await context.newPage();
    page.on('console', (m) => { if (m.type() === 'error') boek.fouten.push({ t: wandklok(), tekst: metPlek(m) }); });
    page.on('pageerror', (e) => boek.fouten.push({ t: wandklok(), tekst: e.message }));
    /** Wachten tot de app klaar is na het laden (zonder zelf te navigeren). */
    const klaar = async () => {
      if (app === 'varve-dj') await page.waitForFunction(() => /** @type {any} */ (window).midi && /** @type {any} */ (window).feedback, null, { timeout: 20000 });
      if (app === 'formula-lab') await page.waitForFunction(() => /param\(s\)/.test(document.getElementById('status')?.textContent ?? ''), null, { timeout: 20000 });
      if (app === 'medisynth') {
        // Eén klik start de klank (en met ?debug: window.medisynth om terug te lezen).
        await page.waitForTimeout(500);
        const { width, height } = page.viewportSize() ?? { width: 800, height: 600 };
        await page.mouse.click(width / 2, height / 2);
        await page.waitForFunction(() => /** @type {any} */ (window).medisynth, null, { timeout: 10000 }).catch(() => {});
      }
    };
    await page.goto(adres[app]);
    await klaar();
    const lezer = /** @type {any} */ (LEZERS)[app];
    deelnemers.set(app, {
      id: app, soort: 'browser',
      lees: async () => {
        if (!lezer) return null;
        const w = await leesPagina(page, lezer);
        if (w === TE_LAAT) { boek.fouten.push({ t: wandklok(), tekst: `[repetitie] teruglezen duurde langer dan ${LEES_MS} ms (hangt de pagina?)` }); return null; }
        return w;
      },
      ontvangen: async () => boek.in,
      fouten: async () => boek.fouten,
      // Eén keer herladen (reload, niet goto: bij formula-lab verschilt de URL alleen in het #fragment, en dan
      // navigeert goto niet opnieuw), dus één nieuwe verbinding en één nieuwe inst; daarna alleen wachten.
      herstart: async () => {
        try { await page.reload(); await klaar(); } catch (e) { log(`   ${app}: herladen gaf een fout: ${String(/** @type {any} */ (e)?.message ?? e).split('\n')[0]}`); }
      },
      .../** @type {any} */ (PANIEK)[app] ? { paniek: /** @type {any} */ (PANIEK)[app] } : {},
    });
  }

  /** flux in een pseudo-terminal, met de meetlat van tools/repetitie-flux.py. */
  async function fluxStart() {
    const map = moetBestaan('flux');
    const bestand = join(map, 'flux-screensaver');
    const boek = new Logboek();
    logboeken.set('flux', boek);
    omgevingApps.flux = `${map} · ${gitStand(map)} (pty, python3)`;
    const logPad = join(tmp, 'flux.jsonl');
    writeFileSync(logPad, '');
    let gelezen = 0;
    const lees = () => {
      const tekst = readFileSync(logPad, 'utf8');
      const nieuw = tekst.slice(gelezen);
      const eind = nieuw.lastIndexOf('\n');
      if (eind < 0) return;
      gelezen += eind + 1;
      for (const regel of nieuw.slice(0, eind).split('\n')) {
        let x;
        try { x = JSON.parse(regel); } catch { continue; }
        if (x.r === 'staat') boek.staat = { ...boek.staat, ...x.w };
        else boek.neem(x);
      }
    };
    const leeg = mkdtempSync(join(tmp, 'flux-xdg-'));
    let proces = null;
    const draai = () => {
      proces = start('python3', ['-c', 'import pty, sys; pty.spawn(sys.argv[1:])',
        'python3', join(HUB_MAP, 'tools/repetitie-flux.py'), bestand, logPad,
        '--hub', hubUrl, '--opening', 'nee', '--uitvloeien', '0.3', '--invloeien', '0.5'],
      { env: { ...process.env, XDG_CONFIG_HOME: leeg, XDG_RUNTIME_DIR: leeg, VARVE_HUB: '', COLUMNS: '120', LINES: '40', TERM: 'xterm-256color' } }, 'flux');
    };
    /** @type {any} */ (boek).staat = {};
    draai();
    deelnemers.set('flux', {
      id: 'flux', soort: 'pty',
      lees: async () => {
        lees();
        const begin = boek.uit.find((x) => x.b.t === 'staat')?.b.waarden ?? {};
        return { ...begin, .../** @type {any} */ (boek).staat };
      },
      ontvangen: async () => { lees(); return boek.in; },
      fouten: async () => { lees(); return boek.fouten; },
      herstart: async () => {
        // Zoals een screensaverbeurt eindigt: SIGTERM naar flux zelf (hij vloeit uit en meldt zich af),
        // daarna sluit de pseudo-terminal vanzelf. Pas als dat niet lukt: de hele procesgroep.
        lees();
        /** @type {any} */ (proces)?.verwachtStop();
        const p = /** @type {any} */ (proces)?.p;
        const weg = p ? new Promise((r) => (p.exitCode !== null ? r(undefined) : p.once('exit', r))) : Promise.resolve();
        if (boek.pid) { try { process.kill(boek.pid, 'SIGTERM'); } catch { /* al weg */ } }
        if (!(await Promise.race([weg.then(() => true), wacht(5000).then(() => false)])) && p) await stopProces(p);
        boek.pid = undefined;
        /** @type {any} */ (boek).staat = {};
        draai();
      },
    });
  }

  for (const app of deze) {
    if (app === 'flux') await fluxStart();
    else await pagina(app);
    log(`${app} gestart`);
  }

  /** De cockpit in Chromium. */
  async function cockpit() {
    const context = await browser.newContext();
    const page = await context.newPage();
    /** @type {{ t: number, tekst: string }[]} */
    const fouten = [];
    page.on('console', (m) => { if (m.type() === 'error') fouten.push({ t: wandklok(), tekst: metPlek(m) }); });
    page.on('pageerror', (e) => fouten.push({ t: wandklok(), tekst: e.message }));
    await page.goto(hub.adres + '/');
    await page.waitForFunction((n) => document.querySelectorAll('#apps .naam').length >= n, deze.length, { timeout: 10000 }).catch(() => {});
    await page.waitForFunction(() => document.getElementById('verbinding')?.dataset.status === 'verbonden', null, { timeout: 5000 }).catch(() => {});
    const namen = await metTijd(page.$$eval('#apps .naam', (l) => l.map((x) => x.textContent ?? '')), LEES_MS, /** @type {string[]} */ ([]));
    const status = await metTijd(page.$eval('#verbinding', (x) => /** @type {HTMLElement} */ (x).dataset.status ?? ''), LEES_MS, 'geen antwoord');
    await page.screenshot({ path: join(uitMap, `repetitie-${datum}-cockpit.png`) }).catch(() => {});
    return {
      namen, status,
      fouten: async () => fouten,
      focus: async (/** @type {string} */ app) => {
        const naam = hub.kern.beeld().apps.find((/** @type {any} */ a) => a.app === app)?.naam;
        await page.locator('#apps li button', { has: page.locator('.naam', { hasText: naam }) }).first().click();
      },
      sluit: async () => { await context.close(); },
    };
  }

  mkdirSync(uitMap, { recursive: true });
  const begin = Date.now();
  const naam = join(uitMap, `repetitie-${datum}`);
  Object.assign(lopend, {
    naam, datum,
    omgeving: { datum: new Date().toISOString(), node: process.version, chromium: browser.version(), hub: `${HUB_MAP} · ${gitStand(HUB_MAP)}`, controllers: 'NepSysteem: APC40 mkII + LPD8 mk2 (fabrieksprofiel)', ...omgevingApps },
  });
  const uitslag = await speelAvond({
    kern: hub.kern, apc, lpd8, nu: wandklok, wacht, deelnemers, cockpit, log, stappen: lopend.stappen,
    herstarten, opkomstMs: 30000, schuifPauzeMs: 4,
  });

  const omgeving = {
    datum: new Date().toISOString(), duur: `${Math.round((Date.now() - begin) / 1000)} s`,
    node: process.version, chromium: browser.version(), hub: `${HUB_MAP} · ${gitStand(HUB_MAP)}`,
    controllers: 'NepSysteem: APC40 mkII + LPD8 mk2 (fabrieksprofiel)', ...omgevingApps,
  };
  lopend.klaar = true;
  writeFileSync(`${naam}.json`, JSON.stringify({ omgeving, ...uitslag, manifesten: Object.fromEntries([...logboeken].map(([a, b]) => [a, b.manifest() ?? null])) }, null, 2));
  writeFileSync(`${naam}.md`, rapportMd({ datum, omgeving, uitslag }));
  log(`\nrapport: ${naam}.md`);

  if (vlag('--fixtures')) {
    const fx = join(HUB_MAP, 'test/fixtures/manifesten');
    mkdirSync(fx, { recursive: true });
    for (const [app, boek] of logboeken) {
      // De EERSTE manifest die de app stuurde: dat is de stand bij het opstarten (formula-lab stuurt een nieuw bij elke formule).
      const m = boek.uit.find((x) => x.b.t === 'manifest')?.b.manifest;
      const staat = boek.uit.find((x) => x.b.t === 'staat')?.b.waarden;
      // Zonder lokale mappen in de bron: alleen repo-naam, tak en commit.
      const bron = String(omgevingApps[app]).replace(/(^|\s)\/\S*\/([^/\s]+)(?= · )/g, '$1$2');
      if (m) writeFileSync(join(fx, `${app}.json`), `${JSON.stringify({ _bron: `${bron} — vastgelegd door tools/repetitie.mjs op ${omgeving.datum}`, manifest: m, staat: staat ?? {} }, null, 2)}\n`);
    }
    log(`manifesten → ${fx}`);
  }
  return uitslag.totaal.ok;
}

if (isHoofdmodule(import.meta.url)) {
  const maxDuur = Number(optie('--max-duur') ?? MAX_DUUR_S);
  if (!(maxDuur > 0)) { console.error(`--max-duur moet een aantal seconden zijn (kreeg ${optie('--max-duur')})`); process.exit(2); }
  opruimer.vangAf({ voorAf: schrijfDeelrapport });
  const uitWaakhond = opruimer.waakhond(maxDuur * 1000);
  let ok = false;
  try { ok = await main(); } catch (e) { console.error(`\nde repetitie stopt: ${/** @type {any} */ (e)?.message ?? e}`); if (process.env.DEBUG) console.error(e); schrijfDeelrapport(`fout: ${/** @type {any} */ (e)?.message ?? e}`); }
  uitWaakhond();
  await opruimer.draai();
  process.exit(ok ? 0 : 1);
}
