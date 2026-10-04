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

/** Wat er in een vak staat. @param {Vak} v */
function vakTekst(v) {
  if (v.rol === 'keuze') return `${esc(v.naam)}: <b>${esc(v.optie)}</b>`;
  if (v.rol === 'stap') return `${esc(v.naam)} <i>→ volgende (${v.stap})</i>`;
  if (v.rol === 'schakelaar') return `${esc(v.naam)} <i>aan/uit</i>`;
  if (v.rol === 'trigger') return `${esc(v.naam)}`;
  return esc(v.naam);
}
/** @param {Vak|null} v @param {string} ctrl @param {string} [klas] */
const td = (v, ctrl, klas = '') => (v
  ? `<td class="vol ${klas} rol-${esc(v.rol)}" data-ctrl="${esc(ctrl)}" data-param="${esc(v.id)}"${v.optie !== undefined ? ` data-optie="${esc(v.optie)}"` : ''}>${vakTekst(v)}</td>`
  : `<td class="leeg ${klas}" data-ctrl="${esc(ctrl)}"></td>`);

/** Een rij van 8 (faders, track- of device-knoppen). @param {string} label @param {(Vak|null)[]} vakken @param {string} pre */
const rij = (label, vakken, pre) => `<tr><th scope="row">${label}</th>${vakken.map((v, i) => td(v, `${pre}${i + 1}`)).join('')}<td class="rand"></td></tr>`;

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
  return `<table class="sb-apc sb-pads" data-kolommen="${kolommen.length}">
<thead><tr><th scope="col">pads</th>${kolommen.map((k) => `<th scope="col">${k + 1}</th>`).join('')}${scenes ? '<th scope="col" class="scene">scene</th>' : ''}</tr></thead>
<tbody>${lijf}</tbody></table>`;
}

/**
 * Track-knoppen, faders (met Stop All ernaast) en device-knoppen per pagina: altijd 8 breed, zoals de APC.
 * @param {AppBlad} a
 */
function strookTabel(a) {
  const rijen = [];
  if (a.tk.some(Boolean)) rijen.push(rij('track', a.tk, 'tk'));
  if (a.faders.some(Boolean) || a.stopAll) {
    rijen.push(`<tr><th scope="row">fader</th>${a.faders.map((v, i) => td(v, `fader${i + 1}`)).join('')}`
      + `${a.stopAll ? `<td class="vol stopall" data-ctrl="stopall" data-param="${esc(a.stopAll.id)}">${esc(a.stopAll.naam)}</td>` : '<td class="rand"></td>'}</tr>`);
  }
  a.paginas.forEach((p, i) => {
    const label = a.paginas.length > 1 ? `device <small>${i === 0 ? 'begin' : `◄/► ${i + 1}`}${p.naam ? ` ${esc(p.naam)}` : ''}</small>` : 'device';
    rijen.push(rij(label, p.dk, 'dk').replace('<tr>', `<tr data-pagina="${i}">`));
  });
  if (!rijen.length) return '';
  return `<table class="sb-apc sb-strook">
<thead><tr><th></th>${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<th scope="col">${n}</th>`).join('')}<th class="rand">${a.stopAll ? 'stop all' : ''}</th></tr></thead>
<tbody>${rijen.join('\n')}</tbody></table>`;
}

/** @param {AppBlad} a @param {Spiekbrief} sb */
function focusRegel(a, sb) {
  const toets = esc(sb.hub.toetsNaam);
  if (a.slot !== null) return `<span class="sb-focus">${toets} + Track Select <b>${a.slot}</b></span>`;
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
    lijf = `<p class="sb-volgt"><b>Indeling volgt als de app zich meldt.</b>${a.fout ? ` (${esc(a.fout)})` : ''}${lease}</p>`
      + (a.opmerking ? `<p class="sb-opm">${esc(a.opmerking)}</p>` : '');
  } else if (a.soort === 'lease') {
    lijf = `<p class="sb-volgt"><b>Met focus is de hele APC van ${esc(a.naam)}</b> (lease): faders, knoppen, pads en Stop All doen wat ${esc(a.naam)} zelf zegt.
Alleen <b>${esc(sb.hub.toetsNaam)}</b> blijft van de hub: ${esc(sb.hub.toetsNaam)} + Track Select = andere app.</p>`
      + (a.paniek ? `<p class="sb-opm">LPD8 P1 (paniek) werkt ook hier.</p>` : '');
  } else {
    lijf = padsTabel(a) + strookTabel(a);
    const extra = [];
    if (a.overig.length) extra.push(`ook: ${a.overig.map((v) => `<span data-ctrl="${esc(v.ctrl)}" data-param="${esc(v.id)}">${esc(v.ctrl)} = ${vakTekst(v)}</span>`).join(' · ')}`);
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

/**
 * Hoeveel regels een app-kaart ongeveer hoog is (kop, rijen van de tabel, opmerkingen). Alleen om de dichtheid
 * van het blad te kiezen: zo past ook een set met veel apps op één A4.
 * @param {AppBlad} a
 */
export function gewicht(a) {
  if (a.soort !== 'indeling') return 4 + (a.opmerking ? 2 : 0);
  let pads = 0;
  a.grid.forEach((r, i) => { if (r.some(Boolean) || a.scenes[i]) pads = i + 2; });
  // Een rij van 8 smalle vakken loopt vaak over twee regels: telt anderhalf.
  return 3 + pads + 1.5 * ((a.tk.some(Boolean) ? 1 : 0) + (a.faders.some(Boolean) || a.stopAll ? 1 : 0) + a.paginas.length)
    + (a.overig.length || a.niet.length ? 1 : 0);
}

/**
 * Kolommen en dichtheid van het blad: 2 kolommen, bij meer dan 4 apps of ±40 regels 3; daarboven gaat op papier
 * alles kleiner (ui/spiekbrief.css, data-dicht), zodat elke set op één A4 past.
 * @param {AppBlad[]} apps
 */
export function dichtheid(apps) {
  const totaal = apps.reduce((s, a) => s + gewicht(a), 0);
  return { totaal, kolommen: totaal > 40 || apps.length > 4 ? 3 : 2, dicht: totaal > 66 ? 2 : totaal > 48 ? 1 : 0 };
}

/**
 * Verdeel de kaarten over de kolommen: in setvolgorde, elke kaart in de kolom die op dat moment het kortst is.
 * (CSS-kolommen breken op papier slecht af; zo staat elke kaart heel en is het blad gelijk gevuld.)
 * @param {AppBlad[]} apps @param {number} n
 */
export function verdeel(apps, n) {
  /** @type {AppBlad[][]} */
  const kolommen = Array.from({ length: n }, () => []);
  const hoogte = new Array(n).fill(0);
  for (const a of apps) {
    const i = hoogte.indexOf(Math.min(...hoogte));
    kolommen[i].push(a);
    hoogte[i] += gewicht(a);
  }
  return kolommen.filter((k) => k.length);
}

/** @param {Spiekbrief} sb @param {{ gemaakt?: Date|null }} o */
function blad(sb, { gemaakt = null }) {
  const n = sb.apps.length;
  const d = dichtheid(sb.apps);
  const meta = [
    sb.set.focusNaam ? `begint met focus op <b>${esc(sb.set.focusNaam)}</b>` : null,
    sb.live ? `zoals de hub nu draait (${sb.apps.filter((a) => a.slot !== null).length} van de ${n} apps bij de hub)` : 'gemaakt zonder draaiende hub: Track Select-nummers volgen de volgorde waarin de apps zich melden',
    gemaakt ? `gemaakt ${datumTekst(gemaakt)}` : null,
  ].filter(Boolean).join(' · ');
  return `<main class="sb-blad" data-set="${esc(sb.set.id)}" data-apps="${n}" data-kolommen="${d.kolommen}" data-dicht="${d.dicht}">
<header class="sb-kop">
<h1><span class="sb-klein">Spiekbrief</span> ${esc(sb.set.naam)}</h1>
${sb.set.beschrijving ? `<p class="sb-beschrijving">${esc(sb.set.beschrijving)}</p>` : ''}
<p class="sb-meta">${meta}</p>
</header>
<div class="sb-lijf">
${altijd(sb)}
<div class="sb-apps">
${verdeel(sb.apps, d.kolommen).map((kol) => `<div class="sb-kolom">\n${kol.map((a) => appKaart(a, sb)).join('\n')}\n</div>`).join('\n')}
</div>
</div>
<footer class="sb-legenda">
<b>Fader</b> pakt pas op als hij langs de stand van de app komt (tot dan knippert clip-stop van die strip) ·
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
