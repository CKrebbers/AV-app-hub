// @ts-check
// De starter: zet een hele set klaar (docs/SETS.md).
//
//   1. Per app: draait hij al (al verbonden met de hub, of zijn poort is bezet)? Dan niet opnieuw starten
//      — alleen verbinden (en bij een bezette poort zonder verbinding de URL openen).
//      Anders: het startcommando in de map van de repo (sets/paden.json), in een eigen procesgroep.
//   2. De URL (met ?hub=) gaat open in Chrome zodra de poort van de app open is. Draaide de app al zonder
//      verbinding, dan eerst HERVERBIND_MS wachten: na een hub-herstart komt een bestaande tab vanzelf terug.
//   3. Wachten tot elke app zich bij de kern meldt (kern.beeld: status "actief"), met een time-out en een
//      melding per app die zegt wáár het hangt.
//   4. Daarna de beginsnapshot (via de cockpit-ingang van de kern) en de beginfocus.
//   5. stop(): alleen wat de starter zelf startte gaat dicht (SIGTERM, na STOP_MS SIGKILL); wat al draaide blijft.
//      Ctrl-C midden in het opstarten: na stop() start er niets meer. stopNu() is de synchrone noodrem (exit).
//
// Tijd komt van de geïnjecteerde Klok; processen, Chrome en poortcontrole zijn geïnjecteerd (tests: nep).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PADEN_PAD, STANDAARD_TIME_OUT_S, thuisPad, toonPad, vulIn } from './set.js';

/** Hoe vaak de starter kijkt (poorten, beeld, processen). */
export const TIK_MS = 250;
/** Na de laatste aanmelding nog even wachten, zodat de `staat` van de apps binnen is vóór de beginsnapshot. */
export const RUST_MS = 500;
/** Hoe lang een eigen proces na SIGTERM krijgt voor SIGKILL. */
export const STOP_MS = 3000;
/**
 * Een app die al draait maar (nog) niet verbonden is: zo lang wachten voor de starter een tab opent. Na een
 * hub-herstart herverbindt een bestaande tab met een backoff tot 5 s (MediSynth: 500/1000/2000/5000 ms); een
 * tweede tab zou de eerste verdringen (PROTOCOL §11), maar de oude blijft dan wél klank maken.
 */
export const HERVERBIND_MS = 6000;
/** Zoveel regels uitvoer per proces bewaren (voor de melding als het misgaat). */
const STAART = 12;

/**
 * @typedef {import('./set.js').SetDef} SetDef
 * @typedef {import('./set.js').SetApp} SetApp
 * @typedef {import('./toegang.js').KernToegang} KernToegang
 * @typedef {import('./systeem.js').Proces} Proces
 * @typedef {import('./systeem.js').StartProces} StartProces
 * @typedef {'al verbonden'|'draaide al'|'gestart'|'handmatig'|'niet gestart'} Hoe
 * @typedef {{ app: string, hoe: Hoe, klaar: boolean, melding: string }} Uitslag
 */

/**
 * @typedef {{
 *   id: string, naam: string, spec: SetApp, poort: number|undefined, wacht: 'kern'|'poort'|'geen',
 *   timeOutMs: number, url: string|null, hoe: Hoe|null, klaar: boolean, mis: string|null,
 *   proces: Proces|null, staart: string[], einde: { code: number|null, sein?: string, fout?: string }|null,
 *   poortIsOpen: boolean, urlOpen: boolean, urlNa: number,
 * }} AppGang
 */

/**
 * @param {{
 *   set: SetDef, config: any, paden?: Record<string, string>, hub: KernToegang, hubPoort: number,
 *   klok: import('../core/klok.js').Klok, startProces: StartProces, openUrl: ((url: string) => Promise<void>|void)|null,
 *   poortOpen: (poort: number) => Promise<boolean>, bestaat?: (pad: string) => boolean,
 *   log?: (regel: string) => void, toonUitvoer?: boolean, tikMs?: number, rustMs?: number, stopMs?: number,
 *   herverbindMs?: number, padenPad?: string,
 * }} o
 */
export function startSet({
  set, config, paden = {}, hub, hubPoort, klok, startProces, openUrl, poortOpen, bestaat = existsSync,
  log = () => {}, toonUitvoer = false, tikMs = TIK_MS, rustMs = RUST_MS, stopMs = STOP_MS,
  herverbindMs = HERVERBIND_MS, padenPad = PADEN_PAD,
}) {
  const padenNaam = toonPad(padenPad);
  const hubUrl = `ws://localhost:${hubPoort}/app`;
  /** @type {AppGang[]} */
  const gangen = Object.entries(set.apps).map(([id, spec]) => {
    const cfg = config?.apps?.[id] ?? {};
    const poort = spec.poort ?? cfg.poort;
    const vars = { poort, hub: hubUrl, hub_poort: hubPoort };
    return {
      id, naam: cfg.naam ?? id, spec, poort,
      wacht: spec.wacht ?? 'kern',
      timeOutMs: (spec.time_out_s ?? set.time_out_s ?? STANDAARD_TIME_OUT_S) * 1000,
      url: spec.url ? vulIn(spec.url, vars) : null,
      hoe: null, klaar: false, mis: null, proces: null, staart: [], einde: null, poortIsOpen: false, urlOpen: false, urlNa: 0,
    };
  });
  let gestopt = false;
  /** Lopende wachttijden: klok-handle → verder. stop() wist ze en laat de lus meteen verder (en eindigen). */
  /** @type {Map<any, () => void>} */
  const timers = new Map();
  /** @param {number} ms */
  const slaap = (ms) => new Promise((goed) => {
    const h = klok.zet(() => { timers.delete(h); goed(undefined); }, ms);
    timers.set(h, () => goed(undefined));
  });

  /** Een app lukt niet: meteen melden (de andere apps kunnen nog even bezig zijn). @param {AppGang} g @param {string} tekst */
  const faal = (g, tekst) => { g.mis = tekst; log(`  ${g.id}: MIS — ${tekst}`); };

  /** @param {string} id */
  const inBeeld = (id) => hub.beeld().apps.find((a) => a.app === id);

  /**
   * De URL openen (één keer). Er wordt niet op gewacht: `xdg-open` kan blijven hangen tot de browser sluit,
   * en dan mogen de time-outs, snapshot en focus van de rest niet stilvallen.
   * @param {AppGang} g
   */
  const openOnce = (g) => {
    if (!g.url || g.urlOpen || gestopt) return;
    g.urlOpen = true;
    const url = g.url;
    if (!openUrl) { log(`  ${g.id}: open zelf in Chrome → ${url}`); return; }
    log(`  ${g.id}: Chrome → ${url}`);
    void Promise.resolve().then(() => openUrl(url))
      .catch((e) => log(`  ${g.id}: kon de URL niet openen (${/** @type {Error} */ (e)?.message ?? e}) — open hem zelf: ${url}`));
  };

  /** @param {AppGang} g */
  async function begin(g) {
    g.poortIsOpen = g.poort !== undefined ? await poortOpen(g.poort) : false;
    if (gestopt) return; // Ctrl-C tijdens het kijken: niets meer starten (stop() heeft zijn lijst al gemaakt)
    const b = inBeeld(g.id);
    // Een driver (uurwerk via HTTP) meldt zich ook als de app er niet is; daarom telt "verbonden" alleen
    // samen met een open poort als de app er een heeft.
    if (b?.status === 'actief' && (g.poort === undefined || g.poortIsOpen)) {
      g.hoe = 'al verbonden';
      g.urlOpen = true; // de tab is er al: geen tweede (die zou de eerste verdringen, PROTOCOL §11)
      log(`  ${g.id}: draait al en is verbonden — niet opnieuw gestart`);
      return;
    }
    if (g.poortIsOpen) {
      g.hoe = 'draaide al';
      log(`  ${g.id}: poort ${g.poort} is al bezet — draait al, niet opnieuw gestart`);
      if (g.url && g.wacht === 'kern') {
        // Misschien is er al een tab die na een hub-herstart nog aan het herverbinden is: eerst even afwachten.
        g.urlNa = klok.nu() + herverbindMs;
        log(`  ${g.id}: nog niet verbonden — ${Math.round(herverbindMs / 1000)} s kijken of een open tab vanzelf terugkomt, anders gaat de URL open`);
      }
      return;
    }
    const start = g.spec.start;
    if (!start) {
      g.hoe = 'handmatig';
      const repo = config?.apps?.[g.id]?.repo;
      const map = repo && paden[repo] ? thuisPad(paden[repo]) : `<map van ${repo ?? g.id}>`;
      const hoe = vulIn(g.spec.handmatig ?? 'start hem zelf', { poort: g.poort, hub: hubUrl, hub_poort: hubPoort, repo: map });
      log(`  ${g.id}: start niet vanzelf — ${hoe}`);
      if (g.poort === undefined) openOnce(g);
      return;
    }
    const repo = config?.apps?.[g.id]?.repo;
    const basis = repo ? paden[repo] : undefined;
    if (!basis) {
      g.hoe = 'niet gestart';
      faal(g, `geen map voor repo "${repo}" in ${padenNaam} (voorbeeld: sets/paden.voorbeeld.json)`);
      return;
    }
    const cwd = join(thuisPad(basis), start.map ?? '.');
    if (!bestaat(cwd)) {
      g.hoe = 'niet gestart';
      faal(g, `map ${cwd} bestaat niet (${padenNaam} → "${repo}")`);
      return;
    }
    const vars = { poort: g.poort, hub: hubUrl, hub_poort: hubPoort, repo: thuisPad(basis) };
    // In het commando (via de shell) gequote: een map met een spatie, $ of ; blijft één woord.
    const commando = vulIn(start.commando, Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v === undefined ? v : shellQuote(String(v))])));
    const omgeving = Object.fromEntries(Object.entries(start.omgeving ?? {}).map(([k, v]) => [k, vulIn(v, vars)]));
    log(`  ${g.id}: start "${commando}" in ${cwd}`);
    if (gestopt) return;
    try {
      g.proces = startProces({ commando, cwd, omgeving });
    } catch (e) {
      g.hoe = 'niet gestart';
      faal(g, `starten lukt niet: ${/** @type {Error} */ (e).message}`);
      return;
    }
    g.hoe = 'gestart';
    g.proces.bij('uitvoer', (/** @type {string} */ t) => {
      for (const r of t.split(/\r?\n/)) {
        if (!r.trim()) continue;
        g.staart.push(r);
        if (g.staart.length > STAART) g.staart.shift();
        if (toonUitvoer) log(`  [${g.id}] ${r}`);
      }
    });
    g.proces.bij('einde', (/** @type {any} */ e) => { g.einde = e; });
    if (g.poort === undefined) openOnce(g);
  }

  /** Waarom een app (nog) niet klaar is, in Clay's woorden. @param {AppGang} g */
  function waarom(g) {
    const b = inBeeld(g.id);
    if (g.poort !== undefined && !g.poortIsOpen && g.wacht !== 'geen') {
      return g.hoe === 'handmatig' ? `poort ${g.poort} gaat niet open — is hij gestart?` : `poort ${g.poort} gaat niet open`;
    }
    if (g.wacht === 'kern') {
      const cfg = config?.apps?.[g.id];
      if (!b && cfg?.koppeling === 'midi') {
        return `de hub heeft geen virtuele MIDI-poort "${cfg.midipoort ?? '?'}" voor ${g.naam} — draait de hub met echte MIDI (zonder --zonder-midi, en zonder --geen-drivers)?`;
      }
      if (!b) return g.url
        ? `meldt zich niet bij de hub — is de tab open met ${g.url.includes('?hub=') || g.url.includes('&hub=') ? 'die URL' : `?hub=${hubUrl}`}, en heeft deze versie van de app de hub-koppeling?`
        : 'meldt zich niet bij de hub';
      if (b.status === 'nieuw') return 'zei hallo, maar stuurde geen geldig manifest';
      if (b.status !== 'actief') return `meldde zich, maar is nu "${b.status}"`;
    }
    return 'onbekend';
  }

  /** Eén ronde kijken. @param {AppGang} g @param {number} begon */
  async function kijk(g, begon) {
    if (g.klaar || g.mis) return;
    if (g.poort !== undefined && !g.poortIsOpen) g.poortIsOpen = await poortOpen(g.poort);
    if (gestopt) return;
    // Kwam een open tab vanzelf terug (na een hub-herstart)? Dan geen tweede tab.
    if (g.hoe === 'draaide al' && inBeeld(g.id)?.status === 'actief') g.urlOpen = true;
    if (g.poortIsOpen && klok.nu() >= g.urlNa) openOnce(g);
    // Een proces dat stopt met een fout vóór het klaar is: meteen melden, niet wachten op de time-out.
    // (Code 0 is normaal voor een startscript dat zijn servers op de achtergrond zet, zoals uurwerk/start.sh.)
    if (g.einde && g.einde.code !== 0 && !g.klaar) {
      const hoe = g.einde.fout ?? (g.einde.sein ? `gestopt door ${g.einde.sein}` : `stopte met code ${g.einde.code}`);
      faal(g, `het startcommando ${hoe}${g.staart.length ? `; laatste uitvoer:\n      ${g.staart.join('\n      ')}` : ''}`);
      return;
    }
    const poortGoed = g.poort === undefined || g.poortIsOpen;
    if (g.wacht === 'geen') g.klaar = true;
    else if (g.wacht === 'poort') g.klaar = g.poortIsOpen;
    else g.klaar = poortGoed && inBeeld(g.id)?.status === 'actief';
    if (g.klaar) { log(`  ${g.id}: klaar${g.wacht === 'kern' ? ' (verbonden met de hub)' : g.wacht === 'poort' ? ` (poort ${g.poort} open)` : ''}`); return; }
    if (klok.nu() - begon >= g.timeOutMs) {
      const staart = g.staart.length && g.hoe === 'gestart' ? `; laatste uitvoer:\n      ${g.staart.join('\n      ')}` : '';
      faal(g, `niet klaar binnen ${Math.round(g.timeOutMs / 1000)} s — ${waarom(g)}${staart}`);
    }
  }

  /** Beginsnapshot: alleen voor apps die klaar zijn en die de hub kent. */
  function zetSnapshot() {
    for (const [id, waarden] of Object.entries(set.snapshot ?? {})) {
      const g = gangen.find((x) => x.id === id);
      if (!g?.klaar) { log(`  snapshot ${id}: overgeslagen (app niet klaar)`); continue; }
      const b = inBeeld(id);
      if (!b || b.status !== 'actief') { log(`  snapshot ${id}: overgeslagen (de hub kent ${id} niet${g.spec.opmerking ? ` — ${g.spec.opmerking}` : ''})`); continue; }
      const params = new Map((b.params ?? []).map((p) => [p.id, p]));
      /** @type {string[]} */
      const gezet = [];
      for (const [p, v] of Object.entries(waarden)) {
        const def = params.get(p);
        if (!def) { log(`  snapshot ${id}.${p}: geen parameter met die id in het manifest (wel: ${[...params.keys()].join(', ') || 'geen'})`); continue; }
        if (def.soort === 'trigger') { log(`  snapshot ${id}.${p}: is een trigger — overgeslagen`); continue; }
        hub.zet(id, p, v);
        gezet.push(`${p}=${v}`);
      }
      if (gezet.length) log(`  snapshot ${id}: ${gezet.join(', ')}`);
    }
  }

  function zetFocus() {
    if (!set.focus) return;
    const g = gangen.find((x) => x.id === set.focus);
    const b = inBeeld(set.focus);
    if (!g?.klaar || b?.status !== 'actief') { log(`  focus: ${set.focus} is niet klaar — focus blijft ${hub.beeld().focus ?? 'leeg'}`); return; }
    hub.focus(set.focus);
    log(`  focus: ${set.focus}`);
  }

  /** @returns {Uitslag[]} */
  const uitslag = () => gangen.map((g) => ({
    app: g.id, hoe: g.hoe ?? 'niet gestart', klaar: g.klaar,
    melding: g.klaar ? 'klaar' : (g.mis ?? (gestopt ? 'gestopt' : 'bezig')),
  }));

  async function loop() {
    log(`Set "${set.naam}": ${gangen.length} app${gangen.length === 1 ? '' : 's'}`);
    for (const g of gangen) {
      if (gestopt) break;
      if (g.spec.opmerking) log(`  ${g.id}: ${vulIn(g.spec.opmerking, { poort: g.poort, hub: hubUrl, hub_poort: hubPoort })}`);
      await begin(g);
    }
    const begon = klok.nu();
    while (!gestopt && gangen.some((g) => !g.klaar && !g.mis)) {
      for (const g of gangen) { if (gestopt) break; await kijk(g, begon); }
      if (gestopt || !gangen.some((g) => !g.klaar && !g.mis)) break;
      await slaap(tikMs);
    }
    if (gestopt) return uitslag();
    if (gangen.some((g) => g.klaar) && (set.snapshot || set.focus)) {
      await slaap(rustMs);
      if (gestopt) return uitslag();
      zetSnapshot();
      zetFocus();
    }
    const n = gangen.filter((g) => g.klaar).length;
    log(`Set "${set.naam}": ${n}/${gangen.length} klaar${n < gangen.length ? ` — niet klaar: ${gangen.filter((g) => !g.klaar).map((g) => g.id).join(', ')}` : ''}`);
    return uitslag();
  }

  const klaar = loop();

  return {
    klaar,
    /** Wat de starter zelf startte (voor tests en de melding bij stoppen). */
    eigen: () => gangen.filter((g) => g.proces).map((g) => g.id),
    uitslag,
    /**
     * Noodrem, synchroon (mag in process.on('exit')): SIGTERM naar elk eigen proces dat nog leeft, en daarna
     * niets meer starten. Voor als het proces wegvalt zonder dat stop() kon lopen.
     */
    stopNu() {
      gestopt = true;
      for (const g of gangen) if (g.proces?.leeft()) g.proces.stop('SIGTERM');
    },
    /** Ruim op wat de starter zelf startte. Wat al draaide, blijft draaien. */
    async stop() {
      if (gestopt) return;
      gestopt = true;
      for (const [h, verder] of timers) { klok.wis(h); verder(); }
      timers.clear();
      const eigen = gangen.filter((g) => g.proces);
      for (const g of eigen) /** @type {Proces} */ (g.proces).stop('SIGTERM');
      const eind = klok.nu() + stopMs;
      while (eigen.some((g) => g.proces?.leeft()) && klok.nu() < eind) {
        await new Promise((goed) => { klok.zet(() => goed(undefined), Math.min(100, stopMs)); });
      }
      for (const g of eigen) {
        if (!g.proces?.leeft()) continue;
        log(`  ${g.id}: stopt niet na ${stopMs / 1000} s — SIGKILL`);
        g.proces.stop('SIGKILL');
      }
      if (eigen.length) log(`Gestopt: ${eigen.map((g) => g.id).join(', ')}`);
    },
  };
}

/** Eén shell-woord: 'tekst' met enkele quotes (een ' erin wordt '\''). @param {string} x */
export const shellQuote = (x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`);
