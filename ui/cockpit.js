// @ts-check
// Cockpit: de pagina die de hub toont en zonder hardware bedient (PROTOCOL.md §8).
//   binnen: beeld (volledig), leds ({dev, staat}), invoer ({g})
//   uit:    virtueel ({dev, bytes}), focus ({app}), zet ({app, id, v}), snapshot ({nr, actie})

import { ROLLEN } from '../src/protocol/manifest.js';
import { klem01 } from '../src/protocol/berichten.js';
import { maakApc } from './apc.js';
import { maakLpd8, KNOP_NAMEN } from './lpd8.js';
import { Verbinding, cockpitUrl } from './verbinding.js';
import { toonWaarde, invoerTekst, focusVan, isVerbonden, ademPeriode, ademSchaal, appKleur, paramSleutel } from './opmaak.js';

const LOG_MAX = 50;
const LANG_DRUKKEN_MS = 700;

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

/** @type {any} */
let beeld = null;
let bpm = 120;

const verbinding = new Verbinding({
  url: cockpitUrl(location),
  bijBericht: ontvang,
  bijStatus: toonStatus,
});

const apc = maakApc($('apc'), { stuur: (bytes) => virtueel('apc40', bytes), bpm: () => bpm });
const lpd = maakLpd8($('lpd8'), { stuur: (bytes) => virtueel('lpd8', bytes) });

/** @param {'apc40'|'lpd8'} dev @param {number[]} bytes */
function virtueel(dev, bytes) {
  if (!verbinding.stuur({ t: 'virtueel', dev, bytes })) knipperStatus();
}

/** @param {any} b */
function ontvang(b) {
  switch (b.t) {
    case 'beeld': beeld = b; tekenBeeld(); break;
    case 'leds': if ((b.dev ?? 'apc40') === 'apc40' && b.staat && typeof b.staat === 'object') apc.zetLeds(b.staat); break;
    case 'invoer': if (b.g) { apc.invoer(b.g); lpd.invoer(b.g); logInvoer(b.g); } break;
    default: break; // onbekend: negeren (PROTOCOL.md §1.5)
  }
}

// ── verbinding ──────────────────────────────────────────────────────────────

/** @param {import('./verbinding.js').StatusInfo} s */
function toonStatus(s) {
  const el = $('verbinding');
  el.dataset.status = s.status;
  document.body.classList.toggle('los', s.status !== 'verbonden');
  const tekst = /** @type {HTMLElement} */ (el.querySelector('span'));
  tekst.textContent = s.status === 'verbonden' ? 'verbonden'
    : s.status === 'verbinden' ? (s.poging ? `verbinden… (poging ${s.poging + 1})` : 'verbinden…')
    : `geen hub — opnieuw over ${((s.opnieuwOver ?? 0) / 1000).toLocaleString('nl-NL')} s`;
}
function knipperStatus() {
  const el = $('verbinding');
  el.classList.remove('tik'); void el.offsetWidth; el.classList.add('tik');
}

// ── beeld ───────────────────────────────────────────────────────────────────

function tekenBeeld() {
  const app = focusVan(beeld);
  tekenApparaten(beeld.apparaten ?? {});
  tekenApps(Array.isArray(beeld.apps) ? beeld.apps : [], app);
  tekenParams((beeld.apps ?? []).find((/** @type {any} */ a) => a && a.app === app) ?? null);
  tekenGlobaal(beeld.globaal ?? {});
}

/** @param {Record<string, unknown>} apparaten */
function tekenApparaten(apparaten) {
  for (const dev of ['apc40', 'lpd8']) {
    const el = $(`dev-${dev}`);
    const aan = isVerbonden(apparaten[dev]);
    el.classList.toggle('aan', aan);
    el.title = `${dev === 'apc40' ? 'APC40 mkII' : 'LPD8'}: ${aan ? 'aangesloten' : 'niet aangesloten'}`;
  }
}

/** @type {Map<string, HTMLLIElement>} */
const appRijen = new Map();

/** @param {any[]} apps @param {string|null} focus */
function tekenApps(apps, focus) {
  const lijst = $('apps');
  const gezien = new Set();
  apps.forEach((a, i) => {
    if (!a || typeof a.app !== 'string') return;
    gezien.add(a.app);
    let li = appRijen.get(a.app);
    if (!li) {
      li = document.createElement('li');
      li.className = 'app';
      li.dataset.app = a.app;
      li.innerHTML = '<button type="button"><span class="slot"></span><span class="kleur"></span><span class="naam"></span><span class="lease">lease</span><span class="status"></span></button>';
      const app = a.app;
      /** @type {HTMLElement} */ (li.querySelector('button')).addEventListener('click', () => {
        if (!verbinding.stuur({ t: 'focus', app })) knipperStatus();
      });
      appRijen.set(a.app, li);
    }
    const q = (/** @type {string} */ s) => /** @type {HTMLElement} */ (/** @type {HTMLElement} */ (li).querySelector(s));
    q('.slot').textContent = String(Number.isInteger(a.slot) ? a.slot : i + 1);
    q('.kleur').style.background = appKleur(a);
    q('.naam').textContent = a.naam || a.app;
    const status = typeof a.status === 'string' ? a.status : 'actief';
    q('.status').textContent = status;
    li.dataset.status = status;
    li.style.setProperty('--app', appKleur(a));
    li.classList.toggle('focus', a.app === focus);
    li.classList.toggle('met-lease', a.lease === true);
    /** @type {HTMLElement} */ (li.querySelector('button')).setAttribute('aria-pressed', String(a.app === focus));
    lijst.appendChild(li); // volgorde van het beeld aanhouden
  });
  for (const [app, li] of appRijen) if (!gezien.has(app)) { li.remove(); appRijen.delete(app); }
  $('apps-leeg').hidden = gezien.size > 0;
}

// ── parameters van de focus-app ─────────────────────────────────────────────

let huidigeParams = '';
/** @type {Map<string, { zet: (v: number) => void }>} */
const paramRijen = new Map();
/** Parameters die je nu bedient: binnenkomende waarden even negeren. @type {Set<string>} */
const paramBezig = new Set();

/** @param {any|null} app */
function tekenParams(app) {
  const doos = $('params');
  $('focus-titel').textContent = app ? `Focus · ${app.naam || app.app}` : 'Focus';
  doos.style.setProperty('--app', app ? appKleur(app) : 'var(--accent)');
  const sleutel = paramSleutel(app?.app ?? null, app?.params);
  if (sleutel !== huidigeParams) {
    huidigeParams = sleutel;
    paramRijen.clear(); paramBezig.clear();
    doos.replaceChildren();
    if (!app) { doos.append(leeg('Geen app met focus. Klik op een app.')); }
    else if (!Array.isArray(app.params) || !app.params.length) { doos.append(leeg(app.lease ? 'Lease-app: hij krijgt de APC rechtstreeks.' : 'Geen parameters.')); }
    else {
      let groep = '';
      for (const p of app.params) {
        if (!p || typeof p.id !== 'string') continue;
        if (p.groep && p.groep !== groep) {
          groep = p.groep;
          const h = document.createElement('h3'); h.className = 'groep'; h.textContent = groep; doos.append(h);
        }
        doos.append(paramRij(app.app, p));
      }
    }
  }
  const waarden = app?.waarden ?? {};
  for (const [id, r] of paramRijen) if (!paramBezig.has(id) && typeof waarden[id] === 'number') r.zet(waarden[id]);
}

/** @param {string} tekst */
function leeg(tekst) { const p = document.createElement('p'); p.className = 'leeg'; p.textContent = tekst; return p; }

/**
 * Eén regel: naam, bediening, waarde. `zet` stuurt naar de hub; de rij toont meteen de nieuwe waarde.
 * @param {string} app @param {any} p
 */
function paramRij(app, p) {
  const rij = document.createElement('div');
  rij.className = `param ${p.soort}`;
  rij.dataset.id = p.id;
  const naam = document.createElement('label');
  naam.textContent = p.naam || p.id;
  naam.title = `${p.id}${p.rol ? ` · ${p.rol}` : ''}${p.hint ? ` · ${p.hint}` : ''}`;
  const waarde = document.createElement('output');
  rij.append(naam);
  let huidige = typeof p.standaard === 'number' ? p.standaard : 0;
  /** @type {number|null} */ let gepland = null;
  /** @param {number} v */
  const stuur = (v) => {
    huidige = klem01(v);
    waarde.textContent = toonWaarde(p, huidige);
    if (gepland === null) gepland = requestAnimationFrame(() => {
      gepland = null;
      if (!verbinding.stuur({ t: 'zet', app, id: p.id, v: huidige })) knipperStatus();
    });
  };
  /** @type {(v: number) => void} */
  let toon;

  if (p.soort === 'keuze' && Array.isArray(p.keuzes)) {
    const groep = document.createElement('div');
    groep.className = 'keuzes';
    const n = p.keuzes.length;
    const knoppen = p.keuzes.map((/** @type {string} */ k, /** @type {number} */ i) => {
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = k;
      b.addEventListener('click', () => { stuur(n <= 1 ? 0 : i / (n - 1)); toon(huidige); });
      groep.append(b);
      return b;
    });
    rij.append(groep);
    toon = (v) => { const i = Math.round(v * (n - 1)); knoppen.forEach((b, j) => b.classList.toggle('aan', i === j)); };
  } else if (p.soort === 'schakelaar') {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'schakel';
    b.addEventListener('click', () => { stuur(huidige >= 0.5 ? 0 : 1); toon(huidige); });
    rij.append(b);
    toon = (v) => { b.classList.toggle('aan', v >= 0.5); b.textContent = v >= 0.5 ? 'aan' : 'uit'; };
  } else if (p.soort === 'trigger') {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'trigger'; b.textContent = 'druk';
    const los = () => { if (!b.classList.contains('aan')) return; b.classList.remove('aan'); paramBezig.delete(p.id); stuur(0); };
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); paramBezig.add(p.id); b.classList.add('aan'); stuur(1); });
    b.addEventListener('pointerup', los); b.addEventListener('pointerleave', los); b.addEventListener('pointercancel', los);
    rij.append(b);
    toon = () => {};
  } else {
    const s = document.createElement('input');
    s.type = 'range'; s.min = '0'; s.max = '1'; s.step = '0.001';
    s.setAttribute('aria-label', p.naam || p.id);
    s.addEventListener('pointerdown', () => paramBezig.add(p.id));
    const klaar = () => paramBezig.delete(p.id);
    s.addEventListener('pointerup', klaar); s.addEventListener('pointercancel', klaar); s.addEventListener('change', klaar);
    s.addEventListener('input', () => stuur(Number(s.value)));
    rij.append(s);
    toon = (v) => { s.value = String(v); };
  }
  rij.append(waarde);
  const zet = (/** @type {number} */ v) => { huidige = klem01(v); toon(huidige); waarde.textContent = toonWaarde(p, huidige); };
  zet(huidige);
  paramRijen.set(p.id, { zet });
  return rij;
}

// ── snapshots ───────────────────────────────────────────────────────────────

function maakSnapshots() {
  const doos = $('snapshots');
  for (let nr = 1; nr <= 4; nr++) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'snapshot'; b.textContent = String(nr); b.dataset.nr = String(nr);
    b.title = `snapshot ${nr}: klik = laden, shift-klik of lang drukken = bewaren`;
    /** @type {any} */ let timer = null;
    let lang = false;
    /** @param {'laad'|'bewaar'} actie */
    const doe = (actie) => {
      if (!verbinding.stuur({ t: 'snapshot', nr, actie })) { knipperStatus(); return; }
      b.dataset.actie = actie;
      b.classList.remove('gedaan'); void b.offsetWidth; b.classList.add('gedaan');
      $('snapshot-melding').textContent = actie === 'bewaar' ? `snapshot ${nr} bewaard` : `snapshot ${nr} geladen`;
    };
    b.addEventListener('pointerdown', () => { lang = false; clearTimeout(timer); timer = setTimeout(() => { lang = true; doe('bewaar'); }, LANG_DRUKKEN_MS); });
    const stop = () => clearTimeout(timer);
    b.addEventListener('pointerup', stop); b.addEventListener('pointerleave', stop); b.addEventListener('pointercancel', stop);
    b.addEventListener('click', (e) => { if (lang) { lang = false; return; } doe(e.shiftKey ? 'bewaar' : 'laad'); });
    doos.append(b);
  }
}

// ── globaal ─────────────────────────────────────────────────────────────────

/** @type {Map<string, HTMLElement>} */
const macroRijen = new Map();
const adem = { fase: 0, t: 0, periode: 10, bekend: false };

function maakMacros() {
  const dl = $('macros');
  ROLLEN.forEach((rol, i) => {
    const rij = document.createElement('div');
    rij.className = 'macro'; rij.dataset.rol = rol;
    rij.innerHTML = `<dt>K${i + 1} ${KNOP_NAMEN[i]}</dt><dd><i></i><span>—</span></dd>`;
    rij.title = rol;
    dl.append(rij);
    macroRijen.set(rol, rij);
  });
}

/** @param {Record<string, any>} g */
function tekenGlobaal(g) {
  for (const [rol, rij] of macroRijen) {
    const v = g[rol];
    const ok = typeof v === 'number';
    rij.style.setProperty('--v', String(ok ? klem01(v) : 0));
    /** @type {HTMLElement} */ (rij.querySelector('span')).textContent = !ok ? '—'
      : rol === 'klok.adem_periode' ? `${ademPeriode(v).toFixed(1)} s` : `${Math.round(v * 100)}%`;
  }
  lpd.zetGlobaal(g);
  adem.periode = ademPeriode(g['klok.adem_periode']);
  const fase = typeof g.adem === 'number' ? g.adem : typeof g.adem_fase === 'number' ? g.adem_fase : null;
  adem.bekend = fase !== null;
  if (fase !== null) { adem.fase = fase; adem.t = performance.now(); }
  const nieuweBpm = typeof g.bpm === 'number' && g.bpm > 0 ? g.bpm : 120;
  $('bpm').textContent = typeof g.bpm === 'number' ? g.bpm.toFixed(g.bpm % 1 ? 1 : 0) : '—';
  $('grondtoon').textContent = typeof g.grondtoon === 'string' ? g.grondtoon : '—';
  $('adem-tekst').textContent = `${adem.periode.toFixed(1)} s · ${(60 / adem.periode).toFixed(1)}/min`;
  document.body.classList.toggle('paniek', !!g.paniek);
  if (nieuweBpm !== bpm) { bpm = nieuweBpm; apc.herteken(); }
}

function ademLus() {
  const cirkel = $('adem');
  const stap = () => {
    if (adem.bekend) {
      const fase = (adem.fase + (performance.now() - adem.t) / 1000 / adem.periode) % 1;
      cirkel.style.setProperty('--s', ademSchaal(fase).toFixed(3));
      cirkel.classList.add('loopt');
    } else cirkel.classList.remove('loopt');
    requestAnimationFrame(stap);
  };
  requestAnimationFrame(stap);
}

// ── invoerlog ───────────────────────────────────────────────────────────────

/** @param {any} g */
function logInvoer(g) {
  const lijst = $('log');
  const li = document.createElement('li');
  const nu = new Date();
  const tijd = `${nu.toLocaleTimeString('nl-NL', { hour12: false })}.${String(nu.getMilliseconds()).padStart(3, '0')}`;
  li.innerHTML = '<time></time><span></span>';
  /** @type {HTMLElement} */ (li.firstChild).textContent = tijd;
  /** @type {HTMLElement} */ (li.lastChild).textContent = invoerTekst(g);
  li.dataset.dev = String(g.dev ?? '');
  lijst.prepend(li);
  while (lijst.children.length > LOG_MAX) /** @type {Element} */ (lijst.lastElementChild).remove();
}

// ── start ───────────────────────────────────────────────────────────────────

maakSnapshots();
maakMacros();
ademLus();
verbinding.start();

// Voor tests en debuggen in de console.
Object.assign(window, { cockpit: { apc, lpd, verbinding, get beeld() { return beeld; } } });
