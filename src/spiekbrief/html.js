// @ts-check
// De spiekbrief als HTML-pagina (docs/SPIEKBRIEF.md): op het scherm in de stijl van de cockpit (ui/stijl.css),
// op papier één A4 liggend per set, zwart op wit met de appkleur als randje (ui/spiekbrief.css, @media print).
// Puur: model in, tekst uit. Geen script op de pagina. Alles wat van een app komt (namen uit manifesten) wordt
// ge-escaped; een kleur komt er alleen in als #rrggbb.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HUB_MAP } from '../config.js';

/** @typedef {import('./model.js').Spiekbrief} Spiekbrief @typedef {import('./model.js').AppBlad} AppBlad
 *  @typedef {import('./model.js').Vak} Vak */

/** De stylesheets van de pagina, in volgorde: tokens en basis van de cockpit, dan de spiekbrief zelf. */
export const STIJLEN = Object.freeze(['stijl.css', 'spiekbrief.css']);

/** @param {unknown} x */
export const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
/** Alleen een echte hexkleur komt in een style-attribuut. @param {string} k */
const kleur = (k) => (/^#[0-9a-fA-F]{6}$/.test(k) ? k.toLowerCase() : '#888888');

const MAANDEN = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];
/** @param {Date} d */
const datumTekst = (d) => `${d.getDate()} ${MAANDEN[d.getMonth()]} ${d.getFullYear()}`;

/**
 * De <link>s naar /ui/ (de hub serveert ze), of de stijlen zelf in de pagina (een los bestand van de CLI).
 * @param {'link'|'inline'} css @param {string} uiMap
 */
function stijlen(css, uiMap) {
  if (css === 'link') return STIJLEN.map((s) => `<link rel="stylesheet" href="/ui/${s}">`).join('\n');
  return `<style>\n${STIJLEN.map((s) => readFileSync(join(uiMap, s), 'utf8')).join('\n')}\n</style>`;
}

/** @param {string} titel @param {string} lijf @param {{ css?: 'link'|'inline', uiMap?: string }} o */
function pagina(titel, lijf, { css = 'link', uiMap = join(HUB_MAP, 'ui') }) {
  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${esc(titel)}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect x='3' y='2' width='10' height='12' rx='1' fill='%232E5BFF'/%3E%3C/svg%3E">
${stijlen(css, uiMap)}
</head>
<body class="sb">
${lijf}
</body>
</html>
`;
}

/** @param {string} wat @param {boolean} [opHub] */
const kop = (wat, opHub = true) => `<header class="kop sb-scherm">
<div class="merk"><span class="stip" aria-hidden="true"></span>varve-hub <small>${esc(wat)}</small></div>
${opHub ? '<a class="naar-oefen" href="/">cockpit</a><a class="naar-oefen" href="/spiekbrief">alle sets</a>' : ''}
<span class="sb-print-hint">afdrukken: ⌘P / Ctrl-P · A4 liggend</span>
</header>`;

// ── één vak (een control) ─────────────────────────────────────────────────────

/**
 * Een fader die niet oppakt (PROTOCOL §4 takeover, of een kaart) krijgt dat erbij; een ring alleen als de hub
 * de ringen niet de stand van de app laat overnemen (config `ringen_nemen_waarde_over: false`, kern.js), want anders telt takeover daar niet.
 * @typedef {{ ring?: boolean }} VakOpties  ring: ook ringen markeren
 * @param {Vak} v @param {VakOpties} [o]
 */
const overnameTekst = (v, o = {}) => ((v.rol === 'fader' || (v.rol === 'ring' && o.ring)) && v.takeover && v.takeover !== 'pickup'
  ? ` <i class="sb-overname">${esc(v.takeover)}</i>` : '');

/** Een naam in een smal vak: na ↔ en / mag de regel breken (Blender↔cam), dan hoeft het niet midden in een woord. @param {unknown} x */
const naam = (x) => esc(x).replace(/([↔/])(?=\S)/g, '$1<wbr>');

/** Wat er in een vak staat. @param {Vak} v @param {VakOpties} [o] */
function vakTekst(v, o = {}) {
  if (v.rol === 'fader' || v.rol === 'ring') return `${naam(v.naam)}${overnameTekst(v, o)}`;
  if (v.rol === 'keuze') return `${naam(v.naam)}: <b>${naam(v.optie)}</b>`;
  if (v.rol === 'stap') return `${naam(v.naam)} <i>→ volgende (${v.stap})</i>`;
  if (v.rol === 'schakelaar') return `${naam(v.naam)} <i>aan/uit</i>`;
  return naam(v.naam);
}
/** @param {Vak|null} v @param {string} ctrl @param {string} [klas] @param {VakOpties} [o] */
const td = (v, ctrl, klas = '', o = {}) => (v
  ? `<td class="vol ${klas} rol-${esc(v.rol)}" data-ctrl="${esc(ctrl)}" data-param="${esc(v.id)}"${v.optie !== undefined ? ` data-optie="${esc(v.optie)}"` : ''}>${vakTekst(v, o)}</td>`
  : `<td class="leeg ${klas}" data-ctrl="${esc(ctrl)}"></td>`);

/** Een rij van 8 (faders, track- of device-knoppen). @param {string} label @param {(Vak|null)[]} vakken @param {string} pre @param {VakOpties} o */
const rij = (label, vakken, pre, o) => `<tr><th scope="row">${label}</th>${vakken.map((v, i) => td(v, `${pre}${i + 1}`, '', o)).join('')}<td class="rand"></td></tr>`;

// ── een app ───────────────────────────────────────────────────────────────────

/**
 * Het padgrid, alleen de kolommen die iets doen (met hun nummer erboven) en de rijen van boven tot de laagste
 * die iets doet; scene 1 staat naast de bovenste rij, zoals op de APC. Leeg als de app geen pads of scènes heeft.
 * @param {AppBlad} a
 */
function padsTabel(a) {
  const kolommen = [0, 1, 2, 3, 4, 5, 6, 7].filter((k) => a.grid.some((r) => r[k]));
  const scenes = a.scenes.some(Boolean);
  let rijen = 0;
  a.grid.forEach((r, i) => { if (r.some(Boolean) || a.scenes[i]) rijen = i + 1; });
  if (!rijen) return '';
  const lijf = a.grid.slice(0, rijen).map((r, i) => {
    const nr = 5 - i;
    const scene = a.scenes[i];
    const sc = !scenes ? '' : scene
      ? `<td class="vol scene" data-ctrl="${esc(scene.ctrl)}">▶ ${esc(scene.naam)}</td>`
      : `<td class="leeg scene" data-ctrl="scene${i + 1}"></td>`;
    return `<tr class="pads"><th scope="row">rij ${nr}</th>${kolommen.map((k) => td(r[k], `pad${nr}-${k + 1}`, 'pad')).join('')}${sc}</tr>`;
  }).join('\n');
  return `<table class="sb-apc sb-pads" data-kolommen="${kolommen.length}" style="--n:${kolommen.length}">
<thead><tr><th scope="col">pads</th>${kolommen.map((k) => `<th scope="col">${k + 1}</th>`).join('')}${scenes ? '<th scope="col" class="scene">scene</th>' : ''}</tr></thead>
<tbody>${lijf}</tbody></table>`;
}

/**
 * Track-knoppen, faders (met Stop All ernaast) en device-knoppen per pagina: altijd 8 breed, zoals de APC.
 * @param {AppBlad} a @param {VakOpties} o
 */
function strookTabel(a, o) {
  const rijen = [];
  if (a.tk.some(Boolean)) rijen.push(rij('track', a.tk, 'tk', o));
  if (a.faders.some(Boolean) || a.stopAll) {
    rijen.push(`<tr><th scope="row">fader</th>${a.faders.map((v, i) => td(v, `fader${i + 1}`, '', o)).join('')}`
      + `${a.stopAll ? `<td class="vol stopall" data-ctrl="stopall" data-param="${esc(a.stopAll.id)}">${esc(a.stopAll.naam)}</td>` : '<td class="rand"></td>'}</tr>`);
  }
  a.paginas.forEach((p, i) => {
    const label = a.paginas.length > 1 ? `device <small>${i === 0 ? 'begin' : `◄/► ${i + 1}`}${p.naam ? ` ${esc(p.naam)}` : ''}</small>` : 'device';
    rijen.push(rij(label, p.dk, 'dk', o).replace('<tr>', `<tr data-pagina="${i}">`));
  });
  if (!rijen.length) return '';
  return `<table class="sb-apc sb-strook">
<thead><tr><th></th>${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<th scope="col">${n}</th>`).join('')}<th class="rand">${a.stopAll ? 'stop all' : ''}</th></tr></thead>
<tbody>${rijen.join('\n')}</tbody></table>`;
}

/** @param {AppBlad} a @param {Spiekbrief} sb */
function focusRegel(a, sb) {
  const toets = esc(sb.hub.toetsNaam);
  if (a.slot !== null) return `<span class="sb-focus">${toets} + Track Select <b>${a.slot}</b>${a.status === 'weg' ? ' (niet verbonden)' : ''}</span>`;
  return `<span class="sb-focus">${toets} + Track Select onder zijn kleur</span>`;
}

/** @param {AppBlad} a @param {Spiekbrief} sb */
function appKaart(a, sb) {
  const kop = `<header>
<h3>${esc(a.naam)}${a.beginFocus ? ' <span class="sb-label">begint met focus</span>' : ''}</h3>
${focusRegel(a, sb)}
</header>`;
  const bron = a.bronUitleg ? `<p class="sb-bron">indeling: ${esc(a.bronUitleg)}</p>` : '';
  let lijf = '';
  if (a.soort === 'volgt' || a.soort === 'fout') {
    const lease = a.koppeling === 'lease' ? ` Het is een lease-app: met focus is de hele APC van ${esc(a.naam)}, alleen ${esc(sb.hub.toetsNaam)} blijft van de hub.` : '';
    const wat = a.soort === 'fout'
      ? `<b>Indeling niet te bepalen</b> (${esc(a.fout)}); ze volgt als de app zich meldt.`
      : '<b>Indeling volgt als de app zich meldt.</b>';
    lijf = `<p class="sb-volgt">${wat}${lease}</p>`
      + (a.opmerking ? `<p class="sb-opm">${esc(a.opmerking)}</p>` : '');
  } else if (a.soort === 'lease') {
    lijf = `<p class="sb-volgt"><b>Met focus is de hele APC van ${esc(a.naam)}</b> (lease): faders, knoppen, pads en Stop All doen wat ${esc(a.naam)} zelf zegt.
Alleen <b>${esc(sb.hub.toetsNaam)}</b> blijft van de hub: ${esc(sb.hub.toetsNaam)} + Track Select = andere app.</p>`
      + (a.paniek ? `<p class="sb-opm">LPD8 P1 (paniek) werkt ook hier.</p>` : '');
  } else {
    const o = { ring: !sb.hub.overname };
    lijf = padsTabel(a) + strookTabel(a, o);
    const extra = [];
    if (a.overig.length) extra.push(`ook: ${a.overig.map((v) => `<span data-ctrl="${esc(v.ctrl)}" data-param="${esc(v.id)}">${esc(v.ctrl)} = ${vakTekst(v, o)}</span>`).join(' · ')}`);
    if (a.niet.length) extra.push(`niet op de APC (cockpit): ${a.niet.map(esc).join(', ')}`);
    if (extra.length) lijf += `<p class="sb-opm">${extra.join('<br>')}</p>`;
  }
  return `<section class="sb-app sb-${a.soort}" data-app="${esc(a.app)}" style="--app:${kleur(a.kleur)}">
${kop}
${lijf}
${bron}
</section>`;
}

// ── altijd: LPD8 en de hublaag ────────────────────────────────────────────────

/** @param {Spiekbrief} sb */
function altijd(sb) {
  const t = esc(sb.hub.toetsNaam);
  const knoppen = sb.lpd8.knoppen.map((k) => `<tr data-ctrl="${esc(k.ctrl)}" data-rol="${esc(k.rol)}"><th scope="row">${k.knop}</th><td><b>${esc(k.naam)}</b>${k.apps.length
    ? ` <span class="sb-wie">${k.apps.map((x) => `<span data-app="${esc(x.app)}">${esc(x.naam)}: ${esc(x.param)}</span>`).join(' · ')}</span>`
    : ' <span class="sb-niemand">— (alleen globaal)</span>'}</td></tr>`).join('\n');
  // Pads met dezelfde uitleg na elkaar (P5–P8: snapshot 1–4) op één regel.
  /** @type {import('./model.js').LpdPad[][]} */
  const groepen = [];
  for (const p of sb.lpd8.pads) {
    const g = groepen.at(-1);
    if (g && g[0].uitleg === p.uitleg && /^snapshot /.test(p.kort)) g.push(p); else groepen.push([p]);
  }
  const pads = groepen.map((g) => {
    const p = g[0], q = /** @type {import('./model.js').LpdPad} */ (g.at(-1));
    const pad = g.length > 1 ? `${p.pad}–${q.pad}` : p.pad;
    const kort = g.length > 1 ? `${p.kort}–${q.kort.replace(/^snapshot /, '')}` : p.kort;
    return `<tr data-ctrl="${g.map((x) => esc(x.ctrl)).join(' ')}"><th scope="row">${pad}</th><td><b>${esc(kort)}</b> <span class="sb-wie">${esc(p.uitleg)}</span></td></tr>`;
  }).join('\n');
  const ook = sb.ookVerbonden.length
    ? `<p class="sb-opm">Ook bij de hub: ${sb.ookVerbonden.map((a) => `<span class="sb-stip" style="--app:${kleur(a.kleur)}"></span>${esc(a.naam)}${a.slot !== null ? ` (Track Select ${a.slot})` : ''}`).join(' · ')}</p>`
    : '';
  return `<aside class="sb-altijd">
<section class="sb-lpd8">
<h2>LPD8 · altijd, voor alle apps</h2>
<table class="sb-lijst">${knoppen}</table>
<table class="sb-lijst">${pads}</table>
</section>
<section class="sb-hub">
<h2>APC · ${t} vasthouden</h2>
<ul>
<li><b>Track Select</b> = focus naar die app; de bovenste padrij toont de apps in hun kleur (pulseert = focus)</li>
<li><b>Scene 1–5</b> = hub-snapshot laden · <b>+ Shift</b> = bewaren (1–4 = LPD8 P5–P8)</li>
</ul>
${ook}
</section>
</aside>`;
}

// ── hoe vol is het blad (alleen om op papier één A4 te halen) ────────────────
// Een schatting in px op papier (A4 liggend, 7 mm marge: 1070 × 741 px bij 96 dpi), mét de lengte van de namen:
// een naam van 30 tekens in een vak van 8 loopt over vier regels. De maten volgen ui/spiekbrief.css (@media print).
// test/spiekbrief-pagina.test.js print de echte sets, een set met acht apps en een set met lange namen.

const BLAD = { breed: 1070, hoog: 741, kop: 50, legenda: 36 };
/** De schatting zit er tot ±10% naast (gemeten in Chromium): liever een stap dichter dan een tweede blad. */
const MARGE = 1.1;

/** Aantal regels van een tekst bij `per` tekens per regel (woorden heel; een te lang woord breekt). @param {string} tekst @param {number} per */
export function regels(tekst, per) {
  const p = Math.max(1, Math.floor(per));
  let n = 1, rij = 0;
  for (const w of String(tekst).split(/\s+/).filter(Boolean)) {
    const l = w.length;
    if (rij && rij + 1 + l <= p) { rij += 1 + l; continue; }
    if (rij) n++;
    n += Math.ceil(l / p) - 1;
    rij = l % p || p;
  }
  return n;
}

/** De tekst in een vak zonder opmaak (zie vakTekst). @param {Vak} v */
const vakPlat = (v) => (v.rol === 'keuze' ? `${v.naam}: ${v.optie}` : v.rol === 'stap' ? `${v.naam} → volgende (${v.stap})`
  : v.rol === 'schakelaar' ? `${v.naam} aan/uit` : v.rol === 'fader' || v.rol === 'ring' ? `${v.naam}${v.takeover !== 'pickup' ? ` ${v.takeover}` : ''}` : v.naam);
/** Hoogte van een tabelrij: minstens 5,2 mm, anders de langste tekst. @param {string[]} teksten @param {number} per */
const rijHoogte = (teksten, per) => Math.max(19.6, 3 + 10.4 * Math.max(1, ...teksten.map((t) => regels(t, per)))) + 2;

/**
 * Hoe hoog een app-kaart ongeveer is (px op papier, zonder zoom) bij een kaartbreedte `breed`. Alleen om de
 * dichtheid van het blad te kiezen: zo past ook een set met veel apps of lange namen op één A4.
 * @param {AppBlad} a @param {number} [breed] px; standaard een kaart in twee kolommen over de hele breedte
 */
export function gewicht(a, breed = (BLAD.breed - 10) / 2) {
  const tekst = (/** @type {string} */ t, /** @type {number} */ pt = 7) => regels(t, (breed - 24) / (pt * 0.75)) * pt * 1.6;
  let h = 50;                                                              // rand, kop, regel "indeling: …"
  if (a.soort !== 'indeling') {
    h += tekst('Met focus is de hele APC van de app zelf (lease): faders, knoppen, pads en Stop All doen wat de app zelf zegt. Alleen bank blijft van de hub.', 8);
    if (a.opmerking) h += tekst(a.opmerking) + 4;
    return h + 12;
  }
  // pads: alleen de kolommen die iets doen, met scene ernaast
  const kolommen = [0, 1, 2, 3, 4, 5, 6, 7].filter((k) => a.grid.some((r) => r[k]));
  const scenes = a.scenes.some(Boolean);
  let rijen = 0;
  a.grid.forEach((r, i) => { if (r.some(Boolean) || a.scenes[i]) rijen = i + 1; });
  if (rijen) {
    const vrij = breed - 24 - 38 - (scenes ? 64 : 0);
    const kol = Math.min(74, vrij / Math.max(1, kolommen.length));
    h += 12;
    for (let i = 0; i < rijen; i++) {
      const sc = a.scenes[i];
      h += Math.max(rijHoogte(kolommen.map((k) => { const v = a.grid[i][k]; return v ? vakPlat(v) : ''; }), (kol - 6) / 6.4),
        sc ? rijHoogte([`▶ ${sc.naam}`], 58 / 5.8) : 0);
    }
  }
  // de rijen van 8: track, fader (met Stop All), device per pagina
  const strook = [a.tk.some(Boolean) ? a.tk : null, a.faders.some(Boolean) || a.stopAll ? a.faders : null, ...a.paginas.map((p) => p.dk)]
    .filter((x) => x !== null);
  if (strook.length) {
    const cel = (breed - 24 - 32 - 40 - 14) / 8;
    h += 12 + strook.reduce((s, r) => s + rijHoogte(/** @type {(Vak|null)[]} */ (r).map((v) => (v ? vakPlat(v) : '')), (cel - 5) / 5.9), 0);
  }
  if (a.overig.length || a.niet.length) h += tekst(`${a.overig.map((v) => `${v.ctrl} = ${vakPlat(v)}`).join(' · ')} niet op de APC (cockpit): ${a.niet.join(', ')}`) + 4;
  return h;
}

/** Hoe hoog het LPD8- en hubblok is bij breedte `breed` (als strook onder de kaarten: twee lijsten naast elkaar). @param {Spiekbrief|null} sb @param {number} breed @param {boolean} strook */
function altijdHoogte(sb, breed, strook) {
  if (!sb) return strook ? 150 : 420;
  const k = sb.lpd8.knoppen.map((x) => `${x.knop} ${x.naam} ${x.apps.map((y) => `${y.naam}: ${y.param}`).join(' · ') || '— (alleen globaal)'}`);
  const p = sb.lpd8.pads.slice(0, 5).map((x) => `${x.pad} ${x.kort} ${x.uitleg}`);
  const lijst = (/** @type {string[]} */ l, /** @type {number} */ b) => l.reduce((s, t) => s + regels(t, (b - 50) / 5.6) * 12.5 + 1, 0);
  if (strook) return 34 + Math.max(lijst(k, breed * 0.72 * 0.58), lijst(p, breed * 0.72 * 0.42), 80);
  return 34 + lijst(k, breed) + lijst(p, breed) + 120;
}

/** De opmaak van het blad, van ruim naar dicht: kolommen, zoom en of de LPD8 als strook onder de kaarten staat. */
const OPMAAK = Object.freeze([
  { dicht: 0, kolommen: 2, zoom: 1, strook: true },
  { dicht: 1, kolommen: 2, zoom: 0.86, strook: false },
  { dicht: 1, kolommen: 3, zoom: 0.86, strook: false },
  { dicht: 2, kolommen: 2, zoom: 0.72, strook: false },
  { dicht: 2, kolommen: 3, zoom: 0.72, strook: false },
  { dicht: 3, kolommen: 2, zoom: 0.6, strook: false },
  { dicht: 3, kolommen: 3, zoom: 0.6, strook: false },
]);

/**
 * Kolommen en dichtheid van het blad: de ruimste opmaak (OPMAAK) waarin de hoogste kolom kaarten, met het
 * LPD8-blok, op één A4 past (met MARGE). Meer dan 4 apps: nooit de brede opmaak. Past niets, dan de dichtste. Op papier gaat alles dan kleiner
 * (ui/spiekbrief.css, data-dicht en data-kolommen).
 * @param {AppBlad[]} apps @param {Spiekbrief|null} [sb] voor de lengte van het LPD8-blok
 */
export function dichtheid(apps, sb = null) {
  /** @type {{ kolommen: number, dicht: number, breed: number, hoogte: number, ruimte: number }|null} */
  let laatste = null;
  for (const o of OPMAAK) {
    if ((o.strook && apps.length > 4) || (o.kolommen > 2 && apps.length <= 2)) continue;
    const gebied = (o.strook ? BLAD.breed : BLAD.breed * (o.kolommen === 3 ? 0.78 : 0.73)) / o.zoom;
    const breed = (gebied - 10 * (o.kolommen - 1)) / o.kolommen;
    const links = o.strook ? 0 : altijdHoogte(sb, BLAD.breed * (o.kolommen === 3 ? 0.22 : 0.27) / o.zoom, false);
    const ruimte = BLAD.hoog / o.zoom - BLAD.kop - BLAD.legenda - (o.strook ? altijdHoogte(sb, BLAD.breed, true) + 12 : 0);
    const hoogte = Math.max(links, ...verdeel(apps, o.kolommen, breed).map((k) => k.reduce((s, a) => s + gewicht(a, breed) + 10, 0)));
    laatste = { kolommen: o.kolommen, dicht: o.dicht, breed, hoogte: Math.round(hoogte), ruimte: Math.round(ruimte) };
    if (hoogte * MARGE <= ruimte) break;
  }
  return /** @type {NonNullable<typeof laatste>} */ (laatste);
}

/**
 * Verdeel de kaarten over de kolommen: in setvolgorde, elke kaart in de kolom die op dat moment het kortst is.
 * (CSS-kolommen breken op papier slecht af; zo staat elke kaart heel en is het blad gelijk gevuld.)
 * @param {AppBlad[]} apps @param {number} n @param {number} [breed] kaartbreedte (zie gewicht)
 */
export function verdeel(apps, n, breed) {
  /** @type {AppBlad[][]} */
  const kolommen = Array.from({ length: n }, () => []);
  const hoogte = new Array(n).fill(0);
  for (const a of apps) {
    const i = hoogte.indexOf(Math.min(...hoogte));
    kolommen[i].push(a);
    hoogte[i] += gewicht(a, breed);
  }
  return kolommen.filter((k) => k.length);
}

/** @param {Spiekbrief} sb @param {{ gemaakt?: Date|null }} o */
function blad(sb, { gemaakt = null }) {
  const n = sb.apps.length;
  const d = dichtheid(sb.apps, sb);
  const overname = sb.apps.some((a) => [...a.faders, ...a.tk, ...a.paginas.flatMap((p) => p.dk), ...a.overig]
    .some((v) => v && overnameTekst(v, { ring: !sb.hub.overname })));
  const meta = [
    sb.set.focusNaam ? `begint met focus op <b>${esc(sb.set.focusNaam)}</b>` : null,
    sb.live ? `zoals de hub nu draait (${sb.apps.filter((a) => a.slot !== null && a.status !== 'weg').length} van de ${n} apps bij de hub)` : 'gemaakt zonder draaiende hub: Track Select-nummers volgen de volgorde waarin de apps zich melden',
    gemaakt ? `gemaakt ${datumTekst(gemaakt)}` : null,
  ].filter(Boolean).join(' · ');
  return `<main class="sb-blad" data-set="${esc(sb.set.id)}" data-apps="${n}" data-kolommen="${d.kolommen}" data-dicht="${d.dicht}">
<header class="sb-kop">
<h1><span class="sb-klein">Spiekbrief</span> ${esc(sb.set.naam)}</h1>
${sb.set.beschrijving ? `<p class="sb-beschrijving">${esc(sb.set.beschrijving)}</p>` : ''}
<p class="sb-meta">${meta}</p>
${sb.fouten.length ? `<p class="sb-opm sb-fouten">Niet te lezen (die apps staan er zonder indeling): ${sb.fouten.map(esc).join(' · ')}</p>` : ''}
</header>
<div class="sb-lijf">
${altijd(sb)}
<div class="sb-apps">
${verdeel(sb.apps, d.kolommen, d.breed).map((kol) => `<div class="sb-kolom">\n${kol.map((a) => appKaart(a, sb)).join('\n')}\n</div>`).join('\n')}
</div>
</div>
<footer class="sb-legenda">
<b>Fader</b> pakt pas op als hij langs de stand van de app komt (tot dan knippert clip-stop van die strip) ·
${overname ? '<span class="sb-overname-uitleg"><i>direct</i> bij een fader of knop = springt meteen mee, <i>schaal</i> = loopt geleidelijk mee tot ze gelijk staan</span> ·\n' : ''}
<b>draaiknop</b> ${sb.hub.overname ? 'neemt de stand van de app over bij een appwissel' : 'pakt op zoals een fader'} ·
<b>pad</b>: tik = actie, <i>aan/uit</i> = schakelaar, kolom met opties = keuze (bovenaan de eerste) ·
<b>stop all</b> = paniek van de app met focus (vasthouden) ·
<b>scene</b> ▶ = scène van de app met focus
</footer>
</main>`;
}

/**
 * Eén of meer sets als pagina: elke set op een eigen A4 (liggend).
 * @param {Spiekbrief[]} brieven
 * @param {{ css?: 'link'|'inline', uiMap?: string, gemaakt?: Date|null, opHub?: boolean }} [o]
 *   css: 'link' voor de hub (/ui/…), 'inline' voor een los bestand. gemaakt: de datum onderaan (geïnjecteerd).
 */
export function spiekbriefHtml(brieven, { css = 'link', uiMap, gemaakt = null, opHub = css === 'link' } = {}) {
  const titel = brieven.length === 1 ? `Spiekbrief ${brieven[0].set.naam}` : 'Spiekbrieven';
  return pagina(`varve-hub · ${titel}`, `${kop('spiekbrief', opHub)}\n${brieven.map((sb) => blad(sb, { gemaakt })).join('\n')}`, { css, uiMap });
}

/**
 * De lijst van sets (GET /spiekbrief).
 * @param {{ id: string, naam: string, beschrijving: string }[]} sets
 * @param {{ css?: 'link'|'inline', uiMap?: string, fouten?: string[] }} [o]
 */
export function lijstHtml(sets, { css = 'link', uiMap, fouten = [] } = {}) {
  const items = sets.map((s) => `<li><a href="/spiekbrief?set=${encodeURIComponent(s.id)}"><b>${esc(s.naam)}</b></a> <code>${esc(s.id)}</code>${s.beschrijving ? `<br><span>${esc(s.beschrijving)}</span>` : ''}</li>`).join('\n');
  const mis = fouten.length ? `<p class="sb-opm">Niet te lezen: ${fouten.map(esc).join(' · ')}</p>` : '';
  return pagina('varve-hub · spiekbrief', `${kop('spiekbrief')}
<main class="sb-index">
<h1>Spiekbrief: wat doet welke knop</h1>
<p>Kies een set. Je krijgt één A4 (liggend) met wat elke knop van de APC40 en de LPD8 doet, zoals de hub het nu ziet. Afdrukken met ⌘P / Ctrl-P.</p>
${sets.length ? `<ul class="sb-sets">${items}</ul>` : '<p class="leeg">Er staan geen sets in sets/.</p>'}
${sets.length > 1 ? '<p><a href="/spiekbrief?set=alle">Alle sets onder elkaar</a> (één pagina per set)</p>' : ''}
${mis}
<p class="hint">Zonder draaiende hub: <code>npm run spiekbrief -- &lt;set&gt;</code> (docs/SPIEKBRIEF.md).</p>
</main>`, { css, uiMap });
}
