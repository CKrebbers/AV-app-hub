// @ts-check
// Oefenruimte: lessen om de basis van de hub onder de knie te krijgen, met twee oefen-apps (Zon, Zee).
// De pagina is twee dingen tegelijk:
//   - een cockpit (/cockpit): ziet het beeld, de LEDs en alle invoer, en heeft virtuele controllers;
//   - twee apps (/app): Zon en Zee, die zich gedragen als elke andere app.
// De Leraar (oefen/lessen.js) kijkt na elke gebeurtenis of de opdracht gelukt is.

import { maakApc } from './apc.js';
import { maakLpd8 } from './lpd8.js';
import { Verbinding, cockpitUrl } from './verbinding.js';
import { isVerbonden, toonWaarde } from './opmaak.js';
import { OefenApp, MANIFESTEN, ZON, ZEE } from './oefen/apps.js';
import { Leraar, LESSEN, SPIEKBRIEF, kortWaar } from './oefen/lessen.js';
import { startTafereel } from './oefen/tekening.js';

const HINT_NA_MS = 20000;
const STROOM_MAX = 7;
const OPSLAG = 'varve-hub-oefenen';

/** @param {string} id */
const $ = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

// ── voortgang bewaren (alleen gemak; werkt ook zonder) ───────────────────────
/** @returns {{ les?: number, gehaald?: string[] }} */
function leesVoortgang() { try { return JSON.parse(localStorage.getItem(OPSLAG) ?? '{}') ?? {}; } catch { return {}; } }
/** @param {{ les: number, gehaald: string[] }} v */
function bewaarVoortgang(v) { try { localStorage.setItem(OPSLAG, JSON.stringify(v)); } catch { /* privévenster */ } }

// ── apps ─────────────────────────────────────────────────────────────────────
const appUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/app`;
/** @type {Record<string, OefenApp>} */
const apps = {};
for (const id of [ZON, ZEE]) apps[id] = new OefenApp({ manifest: MANIFESTEN[id], url: appUrl });

const opgeslagen = leesVoortgang();
const leraar = new Leraar({
  acties: { zelfZetten: (app, id, v) => apps[app]?.zelfZetten(id, v) },
  nu: () => performance.now(),
  klaar: Array.isArray(opgeslagen.gehaald) ? opgeslagen.gehaald : [],
});

// ── cockpit-verbinding en virtuele controllers ───────────────────────────────
/** @type {any} */
let beeld = null;
let bpm = 120;
const verbinding = new Verbinding({ url: cockpitUrl(location), bijBericht: ontvang, bijStatus: toonStatus });
const apc = maakApc($('apc'), { stuur: (bytes) => verbinding.stuur({ t: 'virtueel', dev: 'apc40', bytes }), bpm: () => bpm });
const lpd = maakLpd8($('lpd8'), { stuur: (bytes) => verbinding.stuur({ t: 'virtueel', dev: 'lpd8', bytes }) });
let virtueelGekozen = false;
$('virtueel').addEventListener('toggle', () => { virtueelGekozen = true; });

/** @param {any} b */
function ontvang(b) {
  switch (b.t) {
    case 'beeld':
      beeld = b;
      if (typeof b.globaal?.bpm === 'number' && b.globaal.bpm !== bpm) { bpm = b.globaal.bpm; apc.herteken(); }
      lpd.zetGlobaal(b.globaal ?? {});
      tekenApparaten();
      tekenApps();
      leraar.verwerk({ soort: 'beeld', beeld: b });
      break;
    case 'leds': if ((b.dev ?? 'apc40') === 'apc40' && b.staat && typeof b.staat === 'object') apc.zetLeds(b.staat); break;
    case 'invoer': if (b.g) { apc.invoer(b.g); lpd.invoer(b.g); leraar.verwerk({ soort: 'invoer', g: b.g }); } break;
    default: break;
  }
}

/** @param {import('./verbinding.js').StatusInfo} s */
function toonStatus(s) {
  if (s.status === 'weg') { apc.losAlles(); lpd.losAlles(); }
  if (s.status === 'verbonden') apc.wisLeds();
  const el = $('verbinding');
  el.dataset.status = s.status;
  document.body.classList.toggle('los', s.status !== 'verbonden');
  /** @type {HTMLElement} */ (el.querySelector('span')).textContent = s.status === 'verbonden' ? 'verbonden met de hub'
    : s.status === 'verbinden' ? 'verbinden…' : 'geen hub — start hem met npm start';
}

function tekenApparaten() {
  const ap = beeld?.apparaten ?? {};
  let iets = false;
  for (const dev of ['apc40', 'lpd8']) {
    const aan = isVerbonden(ap[dev]);
    iets ||= aan;
    $(`dev-${dev}`).classList.toggle('aan', aan);
  }
  // Geen echte controllers: klap de virtuele open (tenzij je hem zelf al open/dicht deed).
  const beide = isVerbonden(ap.apc40) && isVerbonden(ap.lpd8);
  if (!virtueelGekozen) /** @type {HTMLDetailsElement} */ ($('virtueel')).open = !beide;
  $('virtueel-uitleg').textContent = beide ? '(je APC40 en LPD8 zijn aangesloten; deze werken ook)' : iets
    ? '(een van je controllers is niet aangesloten: gebruik hier de virtuele)' : '(je APC40 en LPD8 zijn niet aangesloten: gebruik deze)';
}

// ── Zon en Zee: waarden, pickup en wat er binnenkomt ─────────────────────────
/** @type {{ app: string, tekst: string, bron: string }[]} */
const stroom = [];

for (const a of Object.values(apps)) {
  a.bij((b) => {
    if (b.t === '_status') { tekenApps(); return; }
    if (b.t === '_zelf') voegStroom(a.app, `${b.id} → ${toonPct(b.v)} (in de app zelf)`, 'zelf');
    else {
      if (b.t === 'zet') { voegStroom(a.app, `${b.id} → ${toonPct(b.v)}`, b.bron ?? 'hub'); knipper(a.app, b.id); }
      if (b.t === 'trig') voegStroom(a.app, `${b.id} ${b.aan ? 'aan' : 'uit'}`, 'trig');
      if (b.t === 'focus') voegStroom(a.app, b.aan ? 'krijgt focus' : 'verliest focus', 'focus');
      leraar.verwerk({ soort: 'app', app: a.app, b });
    }
    tekenApps();
  });
}

const toonPct = (/** @type {number} */ v) => `${Math.round(v * 100)}%`;

/** @param {string} app @param {string} tekst @param {string} bron */
function voegStroom(app, tekst, bron) {
  // Een fader stuurt veel zets achter elkaar: één regel per app+parameter+bron, bijgewerkt.
  const sleutel = tekst.split(' ')[0];
  const vorige = stroom[0];
  if (vorige && vorige.app === app && vorige.bron === bron && vorige.tekst.split(' ')[0] === sleutel) vorige.tekst = tekst;
  else stroom.unshift({ app, tekst, bron });
  stroom.length = Math.min(stroom.length, STROOM_MAX);
  const ol = $('stroom');
  ol.replaceChildren(...stroom.map((s) => {
    const li = document.createElement('li');
    const bronEl = document.createElement('span');
    bronEl.className = `bron ${s.bron}`;
    bronEl.textContent = s.bron;
    const naam = document.createElement('b');
    naam.textContent = MANIFESTEN[s.app]?.naam ?? s.app;
    li.append(bronEl, naam, ` ${s.tekst}`);
    return li;
  }));
}

/** @type {Map<string, any>} */
const knipperTimers = new Map();
/** @param {string} app @param {string} id */
function knipper(app, id) {
  const k = `${app}:${id}`;
  clearTimeout(knipperTimers.get(k));
  document.querySelector(`#app-${app} [data-p="${id}"]`)?.classList.add('knipper');
  knipperTimers.set(k, setTimeout(() => document.querySelector(`#app-${app} [data-p="${id}"]`)?.classList.remove('knipper'), 400));
}

function tekenApps() {
  for (const a of Object.values(apps)) {
    const m = MANIFESTEN[a.app];
    const info = beeld?.apps?.find((/** @type {any} */ x) => x.app === a.app);
    const doos = $(`app-${a.app}`);
    doos.style.setProperty('--app', m.kleur ?? '#888');
    doos.classList.toggle('focus', beeld?.focus === a.app);
    if (!doos.dataset.klaar) {
      doos.dataset.klaar = '1';
      const titel = document.createElement('div');
      titel.className = 'titel';
      titel.innerHTML = '<i></i><span class="naam"></span><span class="focus-label">focus</span><small class="slot"></small>';
      /** @type {HTMLElement} */ (titel.querySelector('.naam')).textContent = m.naam;
      doos.append(titel);
      for (const p of m.params) {
        if (p.soort === 'trigger') continue;
        const rij = document.createElement('div');
        rij.className = 'p'; rij.dataset.p = p.id;
        rij.innerHTML = '<span><span class="label"></span><span class="waar"></span></span><span class="balk"><b></b><i class="fysiek" hidden></i></span><span class="w"></span>';
        /** @type {HTMLElement} */ (rij.querySelector('.label')).textContent = p.naam;
        /** @type {HTMLElement} */ (rij.querySelector('.waar')).textContent = kortWaar(a.app, p.id);
        doos.append(rij);
      }
      const pick = document.createElement('div');
      pick.className = 'pickup';
      doos.append(pick);
    }
    /** @type {HTMLElement} */ (doos.querySelector('.slot')).textContent = !a.verbonden ? 'niet verbonden'
      : info?.slot ? `slot ${info.slot}` : 'verbinden…';
    // Pickup: waar staat de fysieke control, en heeft hij de app al "gevangen"?
    /** @type {string[]} */
    const wachtend = [];
    for (const p of m.params) {
      if (p.soort === 'trigger') continue;
      const rij = /** @type {HTMLElement} */ (doos.querySelector(`[data-p="${p.id}"]`));
      const v = a.waarden[p.id] ?? 0;
      /** @type {HTMLElement} */ (rij.querySelector('.balk b')).style.width = `${v * 100}%`;
      /** @type {HTMLElement} */ (rij.querySelector('.w')).textContent = p.soort === 'keuze' || p.soort === 'schakelaar' ? toonWaarde(p, v) : toonPct(v);
      const fys = /** @type {HTMLElement} */ (rij.querySelector('.fysiek'));
      const pk = beeld?.focus === a.app ? Object.entries(beeld?.pickup ?? {}).find(([, x]) => /** @type {any} */ (x).id === p.id) : null;
      const x = /** @type {any} */ (pk?.[1]);
      if (x && typeof x.fysiek === 'number' && !x.gevangen) {
        fys.hidden = false; fys.style.left = `calc(${x.fysiek * 100}% - 1px)`;
        const doel = typeof x.doel === 'number' ? x.doel : v;
        wachtend.push(`${kortWaar(a.app, p.id)} staat op ${toonPct(x.fysiek)}, ${p.naam} op ${toonPct(doel)}: beweeg hem erlangs om op te pakken`);
      } else fys.hidden = true;
    }
    /** @type {HTMLElement} */ (doos.querySelector('.pickup')).textContent = wachtend[0] ?? '';
  }
}

// ── de les ───────────────────────────────────────────────────────────────────
let hintTimer = /** @type {any} */ (null);
let laatsteStap = '';
/** @type {HTMLElement[]} */
let gewezen = [];

function tekenLes() {
  const t = leraar.toestand();
  bewaarVoortgang({ les: t.lesIndex, gehaald: t.gehaald });
  const ol = $('voortgang');
  if (!ol.childElementCount) {
    LESSEN.forEach((les, i) => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = String(i + 1); b.title = les.titel;
      b.addEventListener('click', () => leraar.gaNaar(i));
      li.append(b); ol.append(li);
    });
  }
  [...ol.querySelectorAll('button')].forEach((b, i) => {
    b.classList.toggle('nu', i === t.lesIndex);
    b.classList.toggle('gehaald', t.gehaald.includes(LESSEN[i].id));
    b.setAttribute('aria-current', i === t.lesIndex ? 'step' : 'false');
  });
  $('les-nr').textContent = `Les ${t.lesIndex + 1} van ${t.aantal}`;
  $('les-titel').textContent = t.les.titel;
  $('les-intro').innerHTML = t.les.intro;          // eigen tekst uit lessen.js
  const opdracht = $('opdracht');
  if (t.opdracht) {
    const stappen = t.les.stappen.length > 1
      ? `<div class="stappen" aria-hidden="true">${t.les.stappen.map((_, i) => `<i class="${i < t.stapIndex ? 'klaar' : i === t.stapIndex ? 'nu' : ''}"></i>`).join('')}</div>` : '';
    opdracht.innerHTML = stappen + t.opdracht;
    opdracht.classList.remove('gelukt');
  } else {
    opdracht.textContent = '';
  }
  // Dezelfde opdracht onderaan in beeld, voor als je naar de virtuele controllers scrolt.
  const balk = $('opdracht-balk');
  balk.innerHTML = t.opdracht ?? (t.lesKlaar ? '✓ Les gehaald — scroll omhoog voor de volgende les.' : '');
  const geleerd = $('geleerd');
  geleerd.hidden = !t.lesKlaar;
  if (t.lesKlaar) { geleerd.innerHTML = t.allesKlaar ? `${t.les.geleerd}<br><br><b>Alle lessen gehaald!</b> De spiekbrief hieronder heeft alles nog eens op een rij.` : t.les.geleerd; }
  $('knop-volgende').hidden = !t.lesKlaar || t.allesKlaar;
  $('knop-begrepen').hidden = !t.knop;
  if (t.lesKlaar && !t.allesKlaar) $('knop-volgende').focus({ preventScroll: true });

  // Hint pas na een tijdje op dezelfde stap.
  const stapSleutel = `${t.lesIndex}:${t.stapIndex}:${t.lesKlaar}`;
  if (stapSleutel !== laatsteStap) {
    laatsteStap = stapSleutel;
    $('les-hint').hidden = true;
    clearTimeout(hintTimer);
    if (t.hint) hintTimer = setTimeout(() => { $('les-hint').textContent = `Tip: ${t.hint}`; $('les-hint').hidden = false; }, HINT_NA_MS);
  }

  // Wijs de controls aan op de virtuele APC en LPD8.
  for (const el of gewezen) el.classList.remove('wijs');
  gewezen = [];
  for (const w of t.wijs ?? []) {
    const [dev, id] = w.split(':');
    const el = (dev === 'apc' ? apc.el : lpd.el).get(id);
    if (el) { el.classList.add('wijs'); gewezen.push(el); }
  }

  // Andere apps verbonden? De LPD8 en snapshots raken die ook.
  const anderen = (beeld?.apps ?? []).filter((/** @type {any} */ a) => a.status === 'actief' && a.app !== ZON && a.app !== ZEE);
  $('let-op').hidden = !anderen.length;
  $('let-op').textContent = anderen.length
    ? `Let op: ook ${anderen.map((/** @type {any} */ a) => a.naam).join(', ')} is verbonden. De LPD8, snapshots en paniek werken daar ook op — oefen liefst zonder andere apps.` : '';
}

let vorigeKlaar = false;
leraar.bij(() => {
  const t = leraar.toestand();
  tekenLes();
  if (t.lesKlaar && !vorigeKlaar) $('geleerd').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  vorigeKlaar = t.lesKlaar;
});
$('knop-volgende').addEventListener('click', () => leraar.volgende());
$('knop-opnieuw').addEventListener('click', () => leraar.gaNaar(leraar.lesIndex));
$('knop-begrepen').addEventListener('click', () => leraar.verwerk({ soort: 'knop' }));

// Spiekbrief
$('spiekbrief').replaceChildren(...SPIEKBRIEF.flatMap(([wat, doet]) => {
  const dt = document.createElement('dt'); dt.textContent = wat;
  const dd = document.createElement('dd'); dd.textContent = doet;
  return [dt, dd];
}));

// De opdrachtbalk onderaan alleen tonen als de opdracht zelf uit beeld is.
new IntersectionObserver(([e]) => { document.body.classList.toggle('opdracht-weg', !e.isIntersecting); })
  .observe($('opdracht-anker'));

// ── tafereel ─────────────────────────────────────────────────────────────────
const stand = (/** @type {OefenApp} */ a) => ({ waarden: a.waarden, triggers: a.triggers, focus: a.focus, verbonden: a.verbonden });
startTafereel(/** @type {HTMLCanvasElement} */ ($('tafereel')), () => ({
  zon: stand(apps[ZON]), zee: stand(apps[ZEE]),
  adem: Number(apps[ZON].globaal.adem ?? beeld?.globaal?.adem ?? 0),
  paniek: Number(beeld?.globaal?.paniek ?? 0) > 0,
}));

// ── start ────────────────────────────────────────────────────────────────────
verbinding.start();
// Zon eerst, dan Zee: zo krijgen ze (op een lege hub) slot 1 en 2.
apps[ZON].start();
setTimeout(() => apps[ZEE].start(), 300);
addEventListener('pagehide', () => { for (const a of Object.values(apps)) a.stop(); verbinding.stop(); });
const begin = Number.isInteger(opgeslagen.les) ? /** @type {number} */ (opgeslagen.les) : 0;
leraar.gaNaar(begin);
tekenLes();
tekenApps();
