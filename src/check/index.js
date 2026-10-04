// @ts-check
// `varve-hub check [set] [--json] [--lan]`: vlak vóór een optreden alles nalopen. Per punt ✓ (goed), ! (let op,
// speelbaar) of ✗ (eerst oplossen), met één regel uitleg en wat te doen. Exitcode 0 = geen ✗, 1 = minstens één ✗.
// Zie docs/CHECK.md.
//
// Niets hier verandert iets: geen MIDI-poort openen (alleen de lijst, zoals doctor), geen geheugen hernoemen
// (leesGeheugen doet dat wel, dus hier een eigen lezing), geen token maken. Alles wat de buitenwereld raakt
// (bestanden, fetch, kindprocessen, platform, thuismap, PATH, tijd) is injecteerbaar; tests raken niets echts.
import * as nodeFs from 'node:fs';
import { spawn as echteSpawn } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { HUB_MAP } from '../config.js';
import { echteKlok } from '../core/klok.js';
import { zoekNaam } from '../ports/poort.js';
import { geheugenPad } from '../opslag.js';
import { avondmapPad } from '../opname/opnemer.js';
import { tokenPad, isLoopbackHost, GELDIG } from '../lan.js';
import { laadSet as echteLaadSet, laadPaden as echteLaadPaden, poortOpen as echtePoortOpen, PADEN_PAD, toonPad } from '../sets/index.js';
import { controleerSet, isDriver } from './set.js';
import { haal } from './systeem.js';

/** @typedef {'ok'|'let'|'fout'} Status */
/** @typedef {{ groep: string, naam: string, status: Status, uitleg: string, doen?: string }} Punt */
/** @typedef {import('../core/klok.js').Klok} Klok */
/**
 * @typedef {Pick<typeof nodeFs, 'existsSync'|'readFileSync'|'readdirSync'|'statSync'|'accessSync'|'statfsSync'|'realpathSync'>} Bestanden
 */

export const TEKEN = Object.freeze({ ok: '✓', let: '!', fout: '✗' });
// De avondmap zelf is klein (gebaren.jsonl en samenvatting.md, meestal een paar MB). De grenzen zijn ruime marge:
// een volle schijf breekt ook het geheugen, de logboeken en de dev-servers van de apps.
/** Minder vrije ruimte dan dit op de schijf van de avondmap: let op. */
export const RUIMTE_LET = 2 * 1024 ** 3;
/** Minder dan dit: fout (de schijf loopt in de loop van de avond vol). */
export const RUIMTE_FOUT = 500 * 1024 ** 2;
/** Mappen waaronder externe schijven hangen. */
const SCHIJVEN = /^\/(Volumes|media|mnt|run\/media)\//;
/** Wat er van zo'n pad overblijft als de schijf niet is aangesloten. */
const SCHIJF_WORTEL = /^\/(Volumes|mnt)$|^\/(run\/)?media(\/[^/]+)?$/;
/** Programma's die als Chrome tellen buiten macOS. */
export const CHROME_LINUX = Object.freeze(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);

/**
 * @typedef {{
 *   config: any,
 *   laadMidi: () => Promise<{ systeem: import('../ports/poort.js').Systeem|null, reden?: string }>,
 *   set?: string|null, lan?: boolean, poort?: number,
 *   hubMap?: string, thuis?: string, env?: Record<string, string|undefined>, platform?: string,
 *   fs?: Bestanden, fetch?: typeof fetch, spawn?: typeof echteSpawn, klok?: Klok,
 *   poortOpen?: (poort: number) => Promise<boolean>,
 *   laadSet?: typeof echteLaadSet, laadPaden?: typeof echteLaadPaden, padenPad?: string, setsMap?: string,
 * }} CheckOpties
 */

/**
 * Loop alles na.
 * @param {CheckOpties} o
 * @returns {Promise<{ punten: Punt[], code: 0|1, set: string|null, hub: boolean }>}
 */
export async function check(o) {
  const {
    config, laadMidi, set = null, lan = false,
    hubMap = HUB_MAP, thuis = homedir(), env = process.env, platform = process.platform,
    fs = nodeFs, fetch = globalThis.fetch, spawn = echteSpawn, klok = echteKlok,
    poortOpen = echtePoortOpen, laadSet = echteLaadSet, laadPaden = echteLaadPaden,
  } = o;
  const poort = o.poort ?? config.poorten.http;
  const padenPad = o.padenPad ?? (hubMap === HUB_MAP ? PADEN_PAD : join(hubMap, 'sets', 'paden.json'));
  const setsMap = o.setsMap ?? join(hubMap, 'sets');
  /** @type {Punt[]} */
  const punten = [];
  /** @param {string} groep */
  const in_ = (groep) => (/** @type {Status} */ status, /** @type {string} */ naam, /** @type {string} */ uitleg, /** @type {string} */ doen = '') => {
    punten.push({ groep, naam, status, uitleg, ...(doen ? { doen } : {}) });
  };
  /** Een pad zoals Clay het leest: in de hub-map relatief, in de thuismap met ~. @param {string} p */
  const toon = (p) => (p.startsWith(hubMap + sep) ? relative(hubMap, p) : p === thuis ? '~' : p.startsWith(thuis + sep) ? `~/${relative(thuis, p)}` : p);

  // De set eerst laden (de punten komen onderaan): de startregel van de hub noemt hem alleen als hij bestaat.
  /** @type {import('../sets/set.js').SetDef|null} */
  let def = null;
  /** @type {Error|null} */
  let setFout = null;
  if (set) { try { def = laadSet(set, { config, map: setsMap }); } catch (e) { setFout = /** @type {Error} */ (e); } }

  // ── De hub en de controllers ───────────────────────────────────────────────────────────────────
  const hub = in_('hub');
  const lsof = `lsof -nP -iTCP:${poort} -sTCP:LISTEN`;
  const { host, metToken } = hubAdres(config, () => leesToken(fs, tokenPad(thuis)));
  const r = await haal({ fetch, klok }, `http://${host.includes(':') ? `[${host}]` : host}:${poort}/api/beeld${metToken}`);
  /** @type {any} */
  let beeld = null;
  if (r.soort === 'antwoord') {
    try { beeld = r.status === 200 ? JSON.parse(r.tekst) : null; } catch { beeld = null; }
    if (beeld && typeof beeld === 'object' && beeld.apparaten) {
      // Een driver-app (MIDI, OSC, HTTP) staat 'actief' zodra de hub zijn driver draait, ook als de app dicht is.
      const actief = (beeld.apps ?? []).filter((/** @type {any} */ a) => a.status === 'actief');
      const drivers = actief.filter((/** @type {any} */ a) => isDriver(config, a.app)).length;
      hub('ok', 'hub', `de hub draait op poort ${poort} (${actief.length - drivers} app(s) verbonden${drivers ? `, ${drivers} driver(s)` : ''})`);
    } else {
      beeld = null;
      hub('fout', 'hub', `op poort ${poort} antwoordt iets anders dan de hub (HTTP ${r.status})`,
        `zoek wat daar draait (${lsof}) en stop het, of zet een andere poort in config.json → poorten.http`);
    }
  } else if (r.soort === 'dicht') {
    const startArgs = [def ? set : null, lan ? '--lan' : null].filter(Boolean).join(' ');
    hub('let', 'hub', `de hub draait nog niet (poort ${poort})`, `start hem straks met npm start${startArgs ? ` -- ${startArgs}` : ''}`);
  } else if (r.soort === 'stil') {
    hub('fout', 'hub', `op poort ${poort} luistert iets dat niet antwoordt (een vastgelopen hub?)`,
      `stop dat proces (${lsof} toont het) en start de hub opnieuw`);
  } else {
    hub('fout', 'hub', `op poort ${poort} luistert iets dat geen HTTP spreekt (${r.reden})`,
      `zoek wat daar draait (${lsof}) en stop het, of zet een andere poort in config.json → poorten.http`);
  }

  const apparaten = in_('apparaten');
  const namen = /** @type {const} */ ([['apc40', 'APC40'], ['lpd8', 'LPD8']]);
  if (beeld) {
    for (const [dev, label] of namen) {
      const a = beeld.apparaten?.[dev];
      if (a?.verbonden) apparaten('ok', dev, `${label} verbonden met de hub${a.naam ? ` (${a.naam})` : ''}`);
      else apparaten('fout', dev, `de hub ziet de ${label} niet`, `steek de ${label} in (USB; de hub vindt hem vanzelf binnen ${Math.round((config.hotplug_ms ?? 2000) / 1000)} s)`);
    }
  } else {
    // Zoals doctor: alleen de lijst met poorten, niets openen.
    let m;
    try { m = await laadMidi(); } catch (e) { m = { systeem: null, reden: /** @type {Error} */ (e).message }; }
    if (!m.systeem) {
      const module = /niet geïnstalleerd/.test(m.reden ?? '');
      apparaten('fout', 'midi', `geen MIDI: ${m.reden ?? 'onbekend'}`, module
        ? 'doe npm install in de hub-map (dan komt @julusian/midi mee)'
        : 'het MIDI-systeem van de computer antwoordt niet: trek de controllers los en weer in, of herstart de computer');
    } else {
      let lijst;
      try { lijst = m.systeem.lijst(); } catch (e) { lijst = null; apparaten('fout', 'midi', `MIDI-poorten niet te lezen: ${/** @type {Error} */ (e).message}`, 'herstart de computer of het MIDI-systeem'); }
      if (lijst) {
        for (const [dev, label] of namen) {
          const naam = zoekNaam(lijst, new RegExp(config.apparaten[dev].naam, 'i'));
          if (naam) apparaten('ok', dev, `${label} zichtbaar als MIDI-poort (${naam})`);
          else apparaten('fout', dev, `${label} niet gevonden tussen de MIDI-poorten`, `steek de ${label} in (USB, en aan) en draai check opnieuw; npm run doctor toont alle poorten`);
        }
      }
    }
  }

  // ── Bestanden van de hub ───────────────────────────────────────────────────────────────────────
  const best = in_('bestanden');
  const profiel = join(hubMap, 'lpd8-profiel.json');
  if (!fs.existsSync(profiel)) {
    best('let', 'lpd8-profiel', 'het LPD8-profiel is nog niet geleerd (lpd8-profiel.json): de hub gebruikt de standaardnoten', 'draai de proef (npm run proef) met de LPD8 aangesloten');
  } else {
    const opzij = 'zet het opzij (mv lpd8-profiel.json lpd8-profiel.json.oud; de hub gebruikt dan de standaardnoten) of draai de proef opnieuw (npm run proef)';
    /** @type {any} */
    let p;
    try { p = JSON.parse(String(fs.readFileSync(profiel, 'utf8'))); } catch (e) {
      p = undefined;
      best('fout', 'lpd8-profiel', `lpd8-profiel.json is kapot (${/** @type {Error} */ (e).message}): de hub start dan niet`, opzij);
    }
    if (p === null) best('let', 'lpd8-profiel', 'lpd8-profiel.json is leeg (null): de hub gebruikt de standaardnoten', 'draai de proef (npm run proef) met de LPD8 aangesloten');
    else if (p !== undefined && (typeof p !== 'object' || !Array.isArray(p.pads) || !Array.isArray(p.knoppen))) {
      // De ontleder zoekt in pads en knoppen (src/devices/lpd8.js): zonder die lijsten struikelt hij over de eerste noot.
      best('fout', 'lpd8-profiel', 'lpd8-profiel.json heeft niet de vorm van een profiel (pads en knoppen ontbreken): de LPD8 werkt dan niet', opzij);
    } else if (p !== undefined) {
      let datum = '';
      try { datum = lokaal(fs.statSync(profiel).mtime).slice(0, 10); } catch { datum = ''; }
      const over = [p.model, datum].filter(Boolean).join(', ');
      best('ok', 'lpd8-profiel', `LPD8-profiel geleerd${over ? ` (${over})` : ''}`);
    }
  }

  const proefMap = join(hubMap, config.proefmap ?? 'proef');
  const f0 = f0Proeven(fs, proefMap);
  const klaar = f0.filter((x) => x.af);
  if (klaar.length) best('ok', 'proef', `de F0-proef is gedaan (${klaar.length}×, laatst ${klaar.at(-1)?.wanneer})`);
  else if (f0.length) best('let', 'proef', `de F0-proef is begonnen maar niet afgemaakt (${f0.at(-1)?.wanneer}; geen samenvatting in het logboek)`, 'doe de proef helemaal (npm run proef, ±30-40 min; met o sla je een stap over) en push het bestand');
  else best('let', 'proef', `de F0-proef is nog nooit gedaan (geen ${toon(proefMap)}/*-f0-hardware.jsonl): wat de hub over je hardware weet, is niet nagemeten`, 'doe de proef (npm run proef, ±30-40 min) en push het bestand');

  const gPad = geheugenPad(config, { env, thuis });
  if (!gPad) best('let', 'geheugen', 'geheugen staat uit (config.json → geheugen.pad): snapshots gaan bij stoppen verloren', 'zet geheugen.pad in config.json als je ze wilt bewaren');
  else {
    let tekst = null, fout = null;
    try { tekst = String(fs.readFileSync(gPad, 'utf8')); } catch (e) { fout = /** @type {any} */ (e); }
    if (fout?.code === 'ENOENT') best('ok', 'geheugen', `nog geen geheugen (${toon(gPad)}): de hub begint leeg`);
    else if (fout?.code === 'EISDIR') best('fout', 'geheugen', `geheugen.pad wijst naar een map (${toon(gPad)}): de hub onthoudt deze avond niets`, 'zet in config.json → geheugen.pad een bestand, bv. ~/.varve-hub/staat.json');
    else if (fout) best('fout', 'geheugen', `geheugen ${toon(gPad)} is niet te lezen (${fout.code ?? fout.message}): de hub begint leeg en zet het opzij als .kapot (lukt dat niet, dan onthoudt hij deze avond niets)`, `kijk naar de rechten (ls -l ${toon(gPad)}) of zet het bestand opzij`);
    else {
      try {
        const d = JSON.parse(tekst ?? '');
        // Zoals kern.importeer: alleen een object met v 1; anders begint de hub leeg (PROTOCOL §12).
        if (d && typeof d === 'object' && !Array.isArray(d) && d.v === 1) best('ok', 'geheugen', `geheugen leesbaar (${toon(gPad)})`);
        else best('fout', 'geheugen', `geheugen ${toon(gPad)} heeft een onbekende versie (${JSON.stringify(d?.v ?? null)}): de hub begint leeg en zet het opzij als .kapot`, `zet het zelf opzij (mv ${toon(gPad)} ${toon(gPad)}.oud) of start de hub-versie die het schreef`);
      } catch (e) {
        best('fout', 'geheugen', `geheugen ${toon(gPad)} is kapot (${/** @type {Error} */ (e).message}): de hub begint leeg en je snapshots zijn weg`, `zet het opzij (mv ${toon(gPad)} ${toon(gPad)}.kapot) of haal een kopie terug`);
      }
    }
    if (fs.existsSync(`${gPad}.kapot`)) best('let', 'geheugen-kapot', `er staat een eerder kapot geheugen: ${toon(gPad)}.kapot`, 'kijk erin of er iets te redden valt, en haal het daarna weg');
  }

  const avond = avondmapPad(config, thuis, hubMap);
  if (!avond) best('let', 'avondmap', 'geen avondmap in config.json: de avond wordt niet opgenomen', 'zet "avondmap" in config.json (bv. ~/Movies/varve-avonden)');
  else best(...avondmapPunt(fs, avond, toon));

  // ── Chrome ─────────────────────────────────────────────────────────────────────────────────────
  const prog = in_('programma');
  if (platform === 'darwin') {
    const waar = ['/Applications/Google Chrome.app', join(thuis, 'Applications', 'Google Chrome.app')].find((p) => fs.existsSync(p));
    if (waar) prog('ok', 'chrome', `Chrome aanwezig (${toon(waar)})`);
    else prog('fout', 'chrome', 'Google Chrome niet gevonden in /Applications: de set kan de apps niet openen', 'installeer Chrome (de apps zijn er op getest; Web MIDI)');
  } else {
    const gevonden = CHROME_LINUX.find((n) => inPad(fs, n, env.PATH ?? ''));
    if (gevonden) prog('ok', 'chrome', `Chrome aanwezig (${gevonden})`);
    else prog('let', 'chrome', `geen Chrome of Chromium in PATH (${CHROME_LINUX.join(', ')}): xdg-open opent dan je standaardbrowser`, 'installeer Chrome of Chromium; de apps zijn in Chrome getest');
  }

  // ── Netwerk (--lan) ────────────────────────────────────────────────────────────────────────────
  if (lan) {
    const net = in_('netwerk');
    const tPad = tokenPad(thuis);
    /** @type {nodeFs.Stats|null} */
    let st = null;
    try { st = fs.statSync(tPad); } catch { st = null; }
    if (!st) net('fout', 'token', `nog geen token (${toon(tPad)}): een tablet kan de cockpit niet openen`, 'maak het nu met node src/cli.js token en open het adres dat het toont op de tablet');
    else {
      const goed = leesToken(fs, tPad) !== null;
      if (!goed) net('fout', 'token', `${toon(tPad)} bevat geen geldig token`, 'haal het weg en maak een nieuw met node src/cli.js token --nieuw');
      else if ((st.mode & 0o077) !== 0) net('let', 'token', `${toon(tPad)} is leesbaar voor anderen (${(st.mode & 0o777).toString(8)}, moet 600 zijn)`, `chmod 600 ${toon(tPad)} en maak voor de zekerheid een nieuw token (node src/cli.js token --nieuw)`);
      else net('ok', 'token', `token aanwezig (${toon(tPad)}, 600)`);
      const tMap = dirname(tPad);
      let mapModus = 0;
      try { mapModus = fs.statSync(tMap).mode; } catch { mapModus = 0; }
      if (mapModus & 0o077) net('let', 'token-map', `${toon(tMap)} is open voor anderen (${(mapModus & 0o777).toString(8)}, liefst 700)`, `chmod 700 ${toon(tMap)}`);
    }
  }

  // ── De set ─────────────────────────────────────────────────────────────────────────────────────
  if (set) {
    const s = in_(`set`);
    if (setFout) s('fout', 'set', setFout.message, /onbekende set/.test(setFout.message) ? 'kijk de naam na: de sets die er zijn staan hierboven' : 'los de fouten in het setbestand op (docs/SETS.md)');
    if (def) {
      /** @type {Record<string, string>|null} */
      let paden = null;
      if (!fs.existsSync(padenPad)) {
        s('fout', 'paden', `${toonPad(padenPad)} ontbreekt: de set weet niet waar je repo's staan`, 'doe eenmalig: cp sets/paden.voorbeeld.json sets/paden.json en zet je mappen erin (docs/SETS.md)');
      } else {
        try { paden = laadPaden(padenPad); s('ok', 'paden', `${toonPad(padenPad)} aanwezig`); } catch (e) { s('fout', 'paden', /** @type {Error} */ (e).message, `los de fout in ${toonPad(padenPad)} op`); }
      }
      for (const p of await controleerSet({ set: def, config, paden: paden ?? {}, padenBekend: paden !== null, padenNaam: toonPad(padenPad), beeld, thuis, fs, poortOpen, spawn, klok, toon, platform })) punten.push(p);
    }
  }

  return { punten, code: punten.some((p) => p.status === 'fout') ? 1 : 0, set, hub: !!beeld };
}

/** Datum en tijd in lokale tijd, 'JJJJ-MM-DD UU:MM'. @param {Date} d */
export const lokaal = (d) => {
  const t = (/** @type {number} */ n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${t(d.getMonth() + 1)}-${t(d.getDate())} ${t(d.getHours())}:${t(d.getMinutes())}`;
};

/**
 * De F0-proeven in de proefmap: alleen `<stempel>-f0-hardware.jsonl` (opnames staan in dezelfde map en worden niet
 * gelezen), nooit een synthetische. Per proef wanneer hij begon (lokale tijd; de stempel in de naam is UTC) en of
 * hij af is: de runner schrijft pas aan het eind een regel `samenvatting` (src/proef/runner.js). Oud → nieuw.
 * @param {Bestanden} fs @param {string} map @returns {{ wanneer: string, af: boolean }[]}
 */
export function f0Proeven(fs, map) {
  let lijst;
  try { lijst = /** @type {string[]} */ (fs.readdirSync(map)).filter((f) => f.endsWith('-f0-hardware.jsonl')).sort(); } catch { return []; }
  /** @type {{ wanneer: string, af: boolean }[]} */
  const uit = [];
  for (const f of lijst) {
    let tekst = '';
    try { tekst = String(fs.readFileSync(join(map, f), 'utf8')); } catch { continue; }
    /** @type {any} */
    let kop = null;
    try { kop = JSON.parse(tekst.slice(0, tekst.indexOf('\n') >>> 0)); } catch { kop = null; }
    if (kop?.synthetisch) continue;
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})/.exec(f);
    const begon = typeof kop?.begon === 'string' ? new Date(kop.begon)
      : m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5])) : null;
    const wanneer = begon && !Number.isNaN(begon.getTime()) ? lokaal(begon) : f;
    uit.push({ wanneer, af: /"e":"samenvatting"/.test(tekst) });
  }
  return uit;
}

/**
 * Is de avondmap (of de dichtstbijzijnde map erboven die al bestaat) schrijfbaar, en is er genoeg ruimte?
 * @param {Bestanden} fs @param {string} avond @param {(p: string) => string} toon
 * @returns {[Status, string, string, string?]}
 */
export function avondmapPunt(fs, avond, toon) {
  let bestaand = avond;
  while (!fs.existsSync(bestaand) && dirname(bestaand) !== bestaand) bestaand = dirname(bestaand);
  let isMap = true;
  try { isMap = fs.statSync(bestaand).isDirectory(); } catch { isMap = true; }
  if (!isMap) {
    return ['fout', 'avondmap', `avondmap ${toon(avond)}: ${toon(bestaand)} is een bestand, geen map: de avond wordt niet opgenomen`, `zet het bestand opzij of kies een andere avondmap in config.json`];
  }
  // Een externe schijf die niet is aangesloten (/Volumes/Extern/avonden → alleen /Volumes bestaat nog): dan meten
  // schrijfrechten en statfs de verkeerde schijf.
  if (bestaand !== avond && SCHIJVEN.test(avond) && SCHIJF_WORTEL.test(bestaand)) {
    return ['let', 'avondmap', `avondmap ${toon(avond)} bestaat niet: de schijf lijkt niet aangesloten (alleen ${toon(bestaand)} bestaat)`,
      'sluit de schijf aan, of kies een andere avondmap in config.json'];
  }
  try { fs.accessSync(bestaand, nodeFs.constants.W_OK); } catch {
    return ['fout', 'avondmap', `avondmap ${toon(avond)} is niet schrijfbaar (${toon(bestaand)}): de avond wordt niet opgenomen`, `kijk naar de rechten (ls -ld ${toon(bestaand)}) of zet een andere avondmap in config.json`];
  }
  // Ontbreekt er meer dan de map zelf: misschien een tikfout in het pad (de opname maakt de mappen wel aan).
  if (bestaand !== avond && bestaand !== dirname(avond)) {
    return ['let', 'avondmap', `avondmap ${toon(avond)} bestaat niet, en ${toon(dirname(avond))} ook niet (wel ${toon(bestaand)})`,
      'kijk het pad na in config.json → avondmap (klopt het, dan maakt de opname de mappen zelf aan)'];
  }
  let vrij;
  try { const st = fs.statfsSync(bestaand); vrij = Number(st.bavail) * Number(st.bsize); } catch (e) {
    return ['let', 'avondmap', `avondmap ${toon(avond)} schrijfbaar, maar de vrije ruimte is niet na te gaan (${/** @type {Error} */ (e).message})`, 'kijk zelf of er een paar GB vrij is'];
  }
  const gb = (/** @type {number} */ b) => `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  const waar = `avondmap ${toon(avond)}${bestaand === avond ? '' : ` (wordt aangemaakt in ${toon(bestaand)})`}`;
  if (vrij < RUIMTE_FOUT) return ['fout', 'avondmap', `${waar}: nog maar ${gb(vrij)} vrij`, 'maak ruimte vrij (oude avonden of opnames naar een externe schijf): een volle schijf breekt ook het geheugen, de logboeken en de apps'];
  if (vrij < RUIMTE_LET) return ['let', 'avondmap', `${waar}: ${gb(vrij)} vrij (krap)`, 'maak liefst een paar GB vrij: ruim marge voor geheugen, logboeken en de dev-servers van de apps'];
  return ['ok', 'avondmap', `${waar} schrijfbaar, ${gb(vrij)} vrij`];
}

/**
 * Een geldig token uit het bestand, of null (ontbreekt, onleesbaar of ongeldig). Dezelfde regel als src/lan.js (GELDIG).
 * @param {Bestanden} fs @param {string} pad @returns {string|null}
 */
export function leesToken(fs, pad) {
  try {
    const t = String(fs.readFileSync(pad, 'utf8')).trim();
    return GELDIG.test(t) ? t : null;
  } catch { return null; }
}

/**
 * Waar check de hub vraagt: 127.0.0.1, tenzij config.json → server.host een eigen (LAN-)adres is; dan dat adres,
 * en omdat de hub daar een token vraagt, het token erbij.
 * @param {any} config @param {() => string|null} token @returns {{ host: string, metToken: string }}
 */
export function hubAdres(config, token) {
  const h = config.server?.host;
  if (isLoopbackHost(h) || h === '0.0.0.0' || h === '::') return { host: '127.0.0.1', metToken: '' };
  const t = token();
  return { host: h, metToken: t ? `?token=${encodeURIComponent(t)}` : '' };
}

/** Uitvoerbaar programma in PATH, via de geïnjecteerde fs. @param {Bestanden} fs @param {string} naam @param {string} pad */
function inPad(fs, naam, pad) {
  for (const map of pad.split(delimiter)) {
    if (!map) continue;
    try { fs.accessSync(join(map, naam), nodeFs.constants.X_OK); return true; } catch { /* volgende */ }
  }
  return false;
}

const GROEPEN = /** @type {Record<string, string>} */ ({ hub: 'Hub', apparaten: 'Controllers', bestanden: 'Bestanden', programma: 'Programma\'s', netwerk: 'Netwerk (--lan)', set: 'Set' });

/**
 * Leesbare tekst: per groep een kop, per punt ✓/!/✗ met uitleg en (bij ! en ✗) wat te doen.
 * @param {{ punten: Punt[], code: number, set: string|null }} r @returns {string}
 */
export function tekstVan(r) {
  const regels = [`varve-hub check${r.set ? ` — set ${r.set}` : ''}`];
  let groep = '';
  for (const p of r.punten) {
    if (p.groep !== groep) { groep = p.groep; regels.push('', GROEPEN[groep] ?? groep); }
    regels.push(`  ${TEKEN[p.status]} ${p.uitleg}`);
    if (p.doen && p.status !== 'ok') regels.push(`      → ${p.doen}`);
  }
  const fout = r.punten.filter((p) => p.status === 'fout').length;
  const let_ = r.punten.filter((p) => p.status === 'let').length;
  regels.push('', fout ? `${fout} × ✗${let_ ? `, ${let_} × !` : ''} — los eerst de ✗ op en draai check opnieuw.`
    : let_ ? `Speelbaar: geen ✗, ${let_} × ! (kijk ernaar als er tijd is).` : 'Alles in orde. Goede avond!');
  return regels.join('\n');
}

/** Voor --json: de punten met hun teken, plus ok en code. @param {{ punten: Punt[], code: number, set: string|null, hub: boolean }} r */
export const jsonVan = (r) => ({
  ok: r.code === 0, code: r.code, set: r.set, hub: r.hub,
  punten: r.punten.map((p) => ({ ...p, teken: TEKEN[p.status] })),
});
