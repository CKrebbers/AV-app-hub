// @ts-check
// Cockpit: de pagina die de hub toont en zonder hardware bedient (PROTOCOL.md §8).
//   binnen: beeld (volledig), leds ({dev, staat}), invoer ({g})
//   uit:    virtueel ({dev, bytes}), focus ({app}), zet ({app, id, v}), snapshot ({nr, actie})

import { ROLLEN } from '../src/protocol/manifest.js';
import { klem01 } from '../src/protocol/berichten.js';
import { maakApc } from './apc.js';
import { maakLpd8, KNOP_NAMEN } from './lpd8.js';
import { Verbinding, cockpitUrl } from './verbinding.js';
import { toonWaarde, invoerTekst, focusVan, isVerbonden, ademPeriode, ademSchaal, appKleur, paramSleutel, opnameVan, looptijdTekst, slewsVan, sectieVan } from './opmaak.js';

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

/**
 * Loslaatberichten die niet weg konden (geen verbinding). Die sturen we na het herverbinden alsnog:
 * anders blijft een toets in de hub ingedrukt (bv. Bank → alle APC-invoer in de hublaag, PROTOCOL.md §7).
 * Een overbodige note-off is onschuldig; een gemiste niet. @type {Map<string, { dev: 'apc40'|'lpd8', bytes: number[] }>}
 */
const gemist = new Map();

/** Is dit het loslaten van een toets (note-off, of de footswitch naar 0)? @param {number[]} b */
const isLoslaten = (b) => (b[0] & 0xf0) === 0x80 || ((b[0] & 0xf0) === 0x90 && b[2] === 0) || (b[0] === 0xb0 && b[1] === 64 && b[2] === 0);

/** @param {'apc40'|'lpd8'} dev @param {number[]} bytes */
function virtueel(dev, bytes) {
  if (verbinding.stuur({ t: 'virtueel', dev, bytes })) return;
  knipperStatus();
  if (isLoslaten(bytes)) gemist.set(`${dev}:${bytes[0]}:${bytes[1]}`, { dev, bytes });
}

/** Alles wat in de hub ingedrukt staat loslaten: APC-knoppen, LPD8-pads en triggers. */
function losAlles() {
  apc.losAlles();
  lpd.losAlles();
  for (const los of loslaters) los();
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
  if (s.status === 'weg') losAlles(); // de note-offs belanden in `gemist`
  if (s.status === 'verbonden') {
    // De hub stuurt bij verbinden zijn beeld; wat de LEDs nu tonen weten we niet meer.
    apc.wisLeds();
    for (const [k, m] of [...gemist]) if (verbinding.stuur({ t: 'virtueel', ...m })) gemist.delete(k);
  }
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
  const apps = Array.isArray(beeld.apps) ? beeld.apps : [];
  const obj = (/** @type {unknown} */ x) => (x && typeof x === 'object' && !Array.isArray(x) ? /** @type {any} */ (x) : {});
  tekenApparaten(obj(beeld.apparaten));
  tekenOpname(opnameVan(beeld));
  tekenApps(apps, app);
  tekenParams(apps.find((/** @type {any} */ a) => a && a.app === app) ?? null, slewsVan(beeld, app));
  tekenGlobaal(obj(beeld.globaal));
  tekenSectie(sectieVan(beeld));
}

// ── opname (LPD8-pad 4) ─────────────────────────────────────────────────────

/** Looptijd op het moment van het laatste beeld (ms) en wanneer dat binnenkwam: de cockpit telt zelf door. */
const opnameKlok = { aan: false, looptijdMs: /** @type {number|null} */ (null), t: 0 };

/** @param {ReturnType<typeof opnameVan>} o */
function tekenOpname(o) {
  const rec = $('rec');
  rec.hidden = !o.aan;
  // Pad 4 staat aan, maar er komt niets op schijf (fout en geen map): geen rode REC met looptijd die doortelt.
  rec.classList.toggle('niets', o.niets);
  /** @type {HTMLElement} */ (rec.querySelector('.rec-map')).textContent = o.niets ? '— niets bewaard' : o.map;
  rec.title = !o.aan ? '' : o.niets ? 'LPD8-pad 4 staat aan, maar er wordt niets bewaard — zie de melding'
    : `de avond wordt opgenomen${o.map ? ` in ${o.map}` : ''} (LPD8-pad 4)`;
  Object.assign(opnameKlok, { aan: o.aan, looptijdMs: o.looptijdMs, t: performance.now() });
  tekenLooptijd();
  // De laatste melding blijft staan tot er een andere komt (ook na het stoppen: 'opname klaar: …').
  const m = $('opname-melding');
  if (m.textContent !== o.melding) m.textContent = o.melding;
  m.title = o.melding;
  m.hidden = !o.melding;
  m.classList.toggle('fout', o.fout);
  lpd.zetOpname(o.aan, o.niets);
}

function tekenLooptijd() {
  const t = /** @type {HTMLElement} */ ($('rec').querySelector('.rec-tijd'));
  const k = opnameKlok;
  const tekst = k.aan && k.looptijdMs !== null ? looptijdTekst(k.looptijdMs + performance.now() - k.t) : '';
  if (t.textContent !== tekst) t.textContent = tekst;
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
  let plek = 0;
  apps.forEach((a, i) => {
    if (!a || typeof a.app !== 'string' || gezien.has(a.app)) return;
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
    // Volgorde van het beeld aanhouden, maar een rij alleen verplaatsen als hij verkeerd staat:
    // verplaatsen haalt de knop even uit het document, en dan valt een lopende klik (en de
    // toetsenbordfocus en de CSS-animaties) weg — bij 10 beelden per seconde bijna altijd.
    const daar = lijst.children[plek] ?? null;
    if (daar !== li) lijst.insertBefore(li, daar);
    plek++;
  });
  for (const [app, li] of appRijen) if (!gezien.has(app)) { li.remove(); appRijen.delete(app); }
  $('apps-leeg').hidden = gezien.size > 0;
}

// ── parameters van de focus-app ─────────────────────────────────────────────

let huidigeParams = '';
/**
 * zet: de bediening op v zetten. glij: een lopende slew tonen (tussen = waar de app nu is, doel = waar de hub
 * hem heen laat glijden; tussen null = hij glijdt niet). bedient: jij hebt hem vast (of liet hem net los):
 * het getal blijft dan jouw waarde, niet de tussenwaarde.
 * @type {Map<string, { zet: (v: number) => void, glij: (tussen: number|null, doel: number|null, restMs?: number|null, bedient?: boolean) => void, rustTot: number }>}
 */
const paramRijen = new Map();
/** Parameters die je nu bedient: binnenkomende waarden even negeren. @type {Set<string>} */
const paramBezig = new Set();
/** Zo lang na een eigen wijziging negeren we binnenkomende waarden (de hub/app moet nog bevestigen). */
const PARAM_RUST_MS = 400;
/** Loslaten van ingedrukte triggers (bij een nieuwe parameterlijst, of als de pagina weggaat). @type {Set<() => void>} */
const loslaters = new Set();

/** @param {any|null} app @param {Map<string, { doel: number, restMs: number|null }>} [slews] lopende slews van die app (beeld.slews) */
function tekenParams(app, slews = new Map()) {
  const doos = $('params');
  $('focus-titel').textContent = app ? `Focus · ${app.naam || app.app}` : 'Focus';
  doos.style.setProperty('--app', app ? appKleur(app) : 'var(--accent)');
  const sleutel = paramSleutel(app?.app ?? null, app?.params);
  if (sleutel !== huidigeParams) {
    huidigeParams = sleutel;
    for (const los of loslaters) los(); // een ingedrukte trigger niet laten hangen
    loslaters.clear(); paramRijen.clear(); paramBezig.clear();
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
  const nu = performance.now();
  for (const [id, r] of paramRijen) {
    const v = waarden && typeof waarden === 'object' && typeof waarden[id] === 'number' ? waarden[id] : null;
    const slew = slews.get(id) ?? null;
    if (paramBezig.has(id) || nu < r.rustTot) {
      // Je bedient hem (of liet hem net los): de schuif blijft van jou. Glijdt de app nog achter je aan,
      // dan toont de balk waar hij nu is en "→" het doel van de hub (dat kan ook een snapshot of macro zijn).
      if (slew && v !== null) r.glij(v, slew.doel, slew.restMs, true);
      else r.glij(null, null);
      continue;
    }
    // Glijdt hij (slew_s, PROTOCOL.md §12), dan staat de schuif op het doel en is de tussenwaarde een aparte
    // balk: zo springt een schuif die je net losliet niet terug naar de tussenwaarde.
    if (slew) { r.zet(slew.doel); r.glij(v, slew.doel, slew.restMs); }
    else { if (v !== null) r.zet(v); r.glij(null, null); }
  }
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
  const rijStaat = {
    zet: (/** @type {number} */ _v) => {},
    glij: (/** @type {number|null} */ _t, /** @type {number|null} */ _d, /** @type {number|null|undefined} */ _r) => {},
    rustTot: 0,
  };
  /** @type {number|null} */ let gepland = null;
  /** @param {number} v */
  const neem = (v) => {
    huidige = klem01(v);
    waarde.textContent = toonWaarde(p, huidige);
    rijStaat.rustTot = performance.now() + PARAM_RUST_MS;
  };
  const verstuur = () => { if (!verbinding.stuur({ t: 'zet', app, id: p.id, v: huidige })) knipperStatus(); };
  /** Direct, als eigen bericht: triggers, schakelaars, keuzes. Een trigger mag nooit samenvallen. @param {number} v */
  const stuur = (v) => { neem(v); verstuur(); };
  /** Gebundeld per frame: alleen voor een schuifje dat je sleept. @param {number} v */
  const stuurGebundeld = (v) => {
    neem(v);
    if (gepland === null) gepland = requestAnimationFrame(() => { gepland = null; verstuur(); });
  };
  const spoel = () => { if (gepland !== null) { cancelAnimationFrame(gepland); gepland = null; verstuur(); } };
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
    const druk = () => { if (b.classList.contains('aan')) return; paramBezig.add(p.id); b.classList.add('aan'); stuur(1); };
    const los = () => { if (!b.classList.contains('aan')) return; b.classList.remove('aan'); paramBezig.delete(p.id); stuur(0); };
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); druk(); });
    b.addEventListener('pointerup', los); b.addEventListener('pointerleave', los); b.addEventListener('pointercancel', los);
    const isDruktoets = (/** @type {KeyboardEvent} */ e) => e.key === 'Enter' || e.key === ' ';
    b.addEventListener('keydown', (e) => { if (!isDruktoets(e)) return; e.preventDefault(); if (!e.repeat) druk(); });
    b.addEventListener('keyup', (e) => { if (!isDruktoets(e)) return; e.preventDefault(); los(); });
    b.addEventListener('blur', los);
    loslaters.add(los);
    rij.append(b);
    toon = () => {};
  } else {
    const schuif = document.createElement('div');
    schuif.className = 'schuif';
    const s = document.createElement('input');
    s.type = 'range'; s.min = '0'; s.max = '1'; s.step = '0.001';
    s.setAttribute('aria-label', p.naam || p.id);
    s.addEventListener('pointerdown', () => paramBezig.add(p.id));
    const klaar = () => { spoel(); paramBezig.delete(p.id); };
    s.addEventListener('pointerup', klaar); s.addEventListener('pointercancel', klaar); s.addEventListener('change', klaar);
    s.addEventListener('input', () => stuurGebundeld(Number(s.value)));
    // Slew: balk = tussenwaarde (wat de app nu heeft), streep + "→ 80%" = het doel.
    rij.classList.add('met-schuif');
    const tussen = document.createElement('i'); tussen.className = 'tussen';
    const doel = document.createElement('i'); doel.className = 'doel';
    const naar = document.createElement('span'); naar.className = 'naar';
    schuif.append(tussen, s, doel, naar);
    rij.append(schuif);
    toon = (v) => { s.value = String(v); };
    rijStaat.glij = (t, d, restMs, bedient = false) => {
      const glijdt = t !== null && Number.isFinite(t);
      rij.classList.toggle('glijdt', glijdt);
      if (!glijdt) { delete rij.dataset.tussen; delete rij.dataset.doel; waarde.textContent = toonWaarde(p, huidige); return; }
      const naarV = d ?? huidige;
      rij.style.setProperty('--tussen', String(klem01(t)));
      rij.style.setProperty('--doel', String(klem01(naarV)));
      rij.dataset.tussen = String(t); rij.dataset.doel = String(naarV);
      naar.textContent = `→ ${toonWaarde(p, naarV)}`;
      naar.title = typeof restMs === 'number' ? `glijdt nog ${(restMs / 1000).toLocaleString('nl-NL', { maximumFractionDigits: 1 })} s` : 'glijdt (slew)';
      tussen.title = `nu ${toonWaarde(p, t)}`;
      // Je liet hem los: de schuif staat op het doel, het getal is waar de app nu is. Bedien je hem, dan blijft het jouw getal.
      waarde.textContent = toonWaarde(p, bedient ? huidige : t);
    };
  }
  rij.append(waarde);
  rijStaat.zet = (/** @type {number} */ v) => { huidige = klem01(v); toon(huidige); waarde.textContent = toonWaarde(p, huidige); };
  rijStaat.zet(huidige);
  paramRijen.set(p.id, rijStaat);
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
  const fase = typeof g.adem === 'number' ? g.adem : null;
  adem.bekend = fase !== null;
  if (fase !== null) { adem.fase = fase; adem.t = performance.now(); }
  const nieuweBpm = typeof g.bpm === 'number' && g.bpm > 0 ? g.bpm : 120;
  $('bpm').textContent = typeof g.bpm === 'number' ? g.bpm.toFixed(g.bpm % 1 ? 1 : 0) : '—';
  $('grondtoon').textContent = typeof g.grondtoon === 'string' ? g.grondtoon : '—';
  $('adem-tekst').textContent = `${adem.periode.toFixed(1)} s · ${(60 / adem.periode).toFixed(1)}/min`;
  document.body.classList.toggle('paniek', !!g.paniek);
  if (nieuweBpm !== bpm) { bpm = nieuweBpm; apc.herteken(); }
}

/** De laatst geziene teller van sectie.nieuw (§18); de eerste is alleen het vertrekpunt. @type {number|null} */
let sectieTeller = null;

/** De sectie: label · energie, de bron in de tooltip, en een flits als er een nieuwe begint. @param {ReturnType<typeof sectieVan>} s */
function tekenSectie(s) {
  const el = $('sectie');
  if (el.textContent !== s.tekst) el.textContent = s.tekst;
  el.title = s.bron ? `sectie van ${s.bron}` : s.tekst === '—' ? 'geen app levert de sectie' : 'geen bron meer: de laatste sectie staat bevroren';
  if (s.teller === null) return;
  if (sectieTeller !== null && s.teller !== sectieTeller) {
    el.dataset.klappen = String(Number(el.dataset.klappen ?? 0) + 1);
    el.classList.remove('klap'); void el.offsetWidth; el.classList.add('klap');
  }
  sectieTeller = s.teller;
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
setInterval(tekenLooptijd, 250); // REC-looptijd telt door tussen de beelden
// Pagina weg, tabblad verborgen of venster uit beeld: niets ingedrukt laten staan in de hub.
addEventListener('pagehide', losAlles);
addEventListener('blur', losAlles);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') losAlles(); });
verbinding.start();

// Voor tests en debuggen in de console.
Object.assign(window, { cockpit: { apc, lpd, verbinding, get beeld() { return beeld; } } });
