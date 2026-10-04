// @ts-check
// Proef-runner: voert een begeleid hardwareprotocol uit en legt alles vast in het logboek.
// Een protocol is een lijst stappen; elke stap krijgt `h` (hulpjes) en doet zijn ding.
// Alles wat de gebruiker moet doen wordt ook als 'verwacht' gemeld, zodat een
// gesimuleerde gebruiker (tests) dezelfde proef automatisch kan doorlopen.
import { bronUitBericht } from '../devices/lpd8.js';
import { Zender } from '../core/zender.js';
import { laadConfig } from '../config.js';

/**
 * @typedef {{ toon: (t: string) => void, regel: () => { p: Promise<string>, annuleer: () => void } }} IO
 * @typedef {{ id: string, titel: string, vereist?: ('apc40'|'lpd8')[], doe: (h: Hulp) => Promise<void> }} Stap
 * @typedef {{ naam: string, titel: string, stappen: Stap[] }} Protocol
 * @typedef {ReturnType<typeof maakHulp>} Hulp
 */

/**
 * @param {Protocol} protocol
 * @param {{ apparaten: ReturnType<typeof import('../apparaten.js').maakApparaten>, io: IO, klok: import('../core/klok.js').Klok,
 *           logboek: import('../core/logboek.js').Logboek, schaal?: number, gebruiker?: Zender, bewaarProfiel?: (p: any) => void,
 *           config?: Record<string, any> }} ctx  config: standaard config.json (voor bv. de hubtoets)
 */
export async function voerUit(protocol, ctx) {
  const h = maakHulp(ctx);
  ctx.logboek.regel('proef', { naam: protocol.naam, titel: protocol.titel });
  h.toon(`\n━━ ${protocol.titel} ━━  (typ "o" + Enter om een stap over te slaan)\n`);
  if (h.configFout) {
    ctx.logboek.regel('waarschuwing', { config: h.configFout });
    h.toon(`  ⚠ config.json kon niet gelezen worden (${h.configFout}); de proef gebruikt de standaardwaarden. Herstel config.json (of haal hem weg) en draai de proef opnieuw.`);
  }
  for (const [i, stap] of protocol.stappen.entries()) {
    const ontbreekt = (stap.vereist ?? []).filter((d) => !(d === 'apc40' ? ctx.apparaten.apc : ctx.apparaten.lpd8).verbonden);
    if (ontbreekt.length) {
      ctx.logboek.regel('stap', { id: stap.id, status: 'overgeslagen', reden: `geen ${ontbreekt.join(', ')}` });
      h.toon(`\n[${i + 1}/${protocol.stappen.length}] ${stap.titel} — overgeslagen (geen ${ontbreekt.join(', ')})`);
      continue;
    }
    ctx.logboek.regel('stap', { id: stap.id, status: 'begin' });
    h.toon(`\n[${i + 1}/${protocol.stappen.length}] ${stap.titel}`);
    h.stapId = stap.id;
    try {
      await stap.doe(h);
      ctx.logboek.regel('stap', { id: stap.id, status: 'klaar' });
    } catch (e) {
      const fout = /** @type {Error} */ (e);
      ctx.logboek.regel('stap', { id: stap.id, status: 'fout', fout: fout.message, stack: fout.stack });
      h.toon(`  ✗ fout in deze stap: ${fout.message} (staat in het logboek, we gaan door)`);
    }
  }
  ctx.logboek.regel('samenvatting', { bevindingen: h.bevindingen });
  return h.bevindingen;
}

/** @param {Parameters<typeof voerUit>[1]} ctx */
function maakHulp(ctx) {
  const { apparaten, io, klok, logboek } = ctx;
  const schaal = ctx.schaal ?? 1;
  const gebruiker = ctx.gebruiker ?? new Zender();
  const { config, configFout } = ctx.config ? { config: ctx.config, configFout: null } : leesConfig();
  /** @type {Record<string, unknown>} */
  const bevindingen = {};

  /** Belooft alleen als de gebruiker "o" typt; andere regels (een losse Enter) worden genegeerd. */
  const overslaan = () => {
    let actief = true;
    /** @type {() => void} */
    let annuleerHuidige = () => {};
    const p = new Promise((klaar) => {
      const volgende = () => {
        if (!actief) return;
        const r = io.regel();
        annuleerHuidige = r.annuleer;
        r.p.then((regel) => { if (!actief) return; if (regel.trim().toLowerCase().startsWith('o')) klaar(regel); else volgende(); });
      };
      volgende();
    });
    return { p, annuleer: () => { actief = false; annuleerHuidige(); } };
  };

  const h = {
    apc: apparaten.apc,
    lpd8: apparaten.lpd8,
    klok,
    /** Tijdschaal (1 = echt; tests versnellen). Gemeten tijden vergelijk je met `drempel * h.schaal`. */
    schaal,
    /** config.json (of wat de aanroeper meegaf): de proef leest bv. de hubtoets, net als de kern. */
    config,
    /** Foutmelding als config.json niet te lezen was (dan gelden de standaarden). @type {string|null} */
    configFout,
    stapId: '',
    /** Eindigde de laatste `eerste()` doordat de gebruiker "o" typte (en niet door een time-out)? */
    laatsteOvergeslagen: false,
    bevindingen,
    /** @param {string} t */
    toon: (t) => io.toon(t),
    /** Pauze in echte tijd (geschaald in tests). @param {number} ms */
    pauze: (ms) => new Promise((r) => klok.zet(() => r(undefined), ms * schaal)),
    /** Meld wat de gebruiker nu moet doen (voor de gesimuleerde gebruiker). @param {Record<string, unknown>} wat */
    verwacht: (wat) => gebruiker.meld('verwacht', { stap: h.stapId, ...wat }),
    /** @param {string} id @param {unknown} data */
    bevinding(id, data) { bevindingen[id] = data; logboek.regel('bevinding', { id, data }); },

    /** Open vraag. @param {string} tekst */
    async vraag(tekst) {
      io.toon(`  ? ${tekst}`);
      h.verwacht({ soort: 'vraag', tekst });
      const antwoord = (await io.regel().p).trim();
      logboek.regel('antwoord', { stap: h.stapId, vraag: tekst, antwoord });
      return antwoord;
    },
    /** Ja/nee + optionele notitie ("n pad 3 bleef uit"). Lege regel = ja. @param {string} tekst */
    async jn(tekst) {
      const a = await h.vraag(`${tekst} [j/n/o + notitie]`);
      const [w, ...rest] = a.split(/\s+/);
      const eerste = (w || 'j').toLowerCase();
      return { ok: eerste.startsWith('j') ? true : eerste.startsWith('n') ? false : null, notitie: rest.join(' ') };
    },
    /** Enter om door te gaan. @param {string} tekst */
    async enter(tekst) { await h.vraag(`${tekst} (Enter)`); },

    /**
     * Wacht tot alle ids "klaar" zijn. Standaard: één druk/beweging per id.
     * @param {{ dev: 'apc40'|'lpd8', ids: string[], tekst: string, klaar?: (g: any, mem: any) => boolean, bijElk?: (g: any) => void }} o
     */
    async wachtOp({ dev, ids, tekst, klaar = (g) => g.kind !== 'los', bijElk }) {
      const sessie = dev === 'apc40' ? apparaten.apc : apparaten.lpd8;
      const open = new Set(ids), gezien = [], vreemd = new Set();
      /** @type {Map<string, any>} */
      const mem = new Map();
      io.toon(`  → ${tekst}  (${ids.length} te gaan)`);
      h.verwacht({ soort: 'controls', dev, ids, tekst });
      const regel = overslaan();
      /** @type {() => void} */
      let stopLuister = () => {};
      const allemaal = new Promise((klaarAlles) => {
        if (!open.size) return klaarAlles(undefined);
        stopLuister = sessie.bij('gebeurtenis', (/** @type {any} */ g) => {
          if (!g.el) return;
          if (!ids.includes(g.el)) { if (g.kind !== 'los' && !vreemd.has(g.el)) { vreemd.add(g.el); io.toon(`    · ${g.el} hoort niet bij deze stap`); } return; }
          if (!open.has(g.el)) return;
          if (!mem.has(g.el)) mem.set(g.el, {});
          if (!klaar(g, mem.get(g.el))) return;
          open.delete(g.el);
          gezien.push(g.el);
          bijElk?.(g);
          const rest = [...open];
          io.toon(`    ✓ ${g.el} (${gezien.length}/${ids.length})${rest.length && rest.length <= 8 ? ` — nog: ${rest.join(', ')}` : ''}`);
          if (!open.size) klaarAlles(undefined);
        });
      });
      const overgeslagen = await Promise.race([allemaal.then(() => false), regel.p.then(() => true)]);
      regel.annuleer();
      stopLuister();
      const uitslag = { gezien, ontbrekend: [...open], overgeslagen, vreemd: [...vreemd] };
      logboek.regel('wacht', { stap: h.stapId, dev, ...uitslag });
      if (overgeslagen && open.size) io.toon(`    overgeslagen; ontbrekend: ${[...open].join(', ')}`);
      return uitslag;
    },

    /**
     * Eerstvolgende gebeurtenis die aan het filter voldoet (of null bij overslaan/time-out).
     * @param {{ dev: 'apc40'|'lpd8', filter?: (g: any, bytes: number[]) => boolean, timeoutMs?: number, verwacht?: Record<string, unknown> }} o
     * @returns {Promise<{ g: any, bytes: number[] } | null>}
     */
    async eerste({ dev, filter = (g) => g.kind !== 'los', timeoutMs = 0, verwacht = {} }) {
      const sessie = dev === 'apc40' ? apparaten.apc : apparaten.lpd8;
      h.verwacht({ soort: 'eerste', dev, ...verwacht });
      const regel = overslaan();
      /** @type {() => void} */
      let stop = () => {};
      let timer = null;
      const treffer = new Promise((r) => {
        stop = sessie.bij('gebeurtenis', (/** @type {any} */ g, /** @type {number[]} */ b) => { if (filter(g, b)) r({ g, bytes: b }); });
        if (timeoutMs) timer = klok.zet(() => r(null), timeoutMs * schaal);
      });
      let overgeslagen = false;
      const uit = await Promise.race([treffer, regel.p.then(() => { overgeslagen = true; return null; })]);
      regel.annuleer();
      stop();
      if (timer !== null) klok.wis(timer);
      h.laatsteOvergeslagen = overgeslagen;
      return /** @type {any} */ (uit);
    },

    /** Wacht tot een apparaat 'weg' of 'verbonden' meldt. @param {'apc40'|'lpd8'} dev @param {'weg'|'verbonden'} wat @param {number} timeoutMs */
    async wachtMelding(dev, wat, timeoutMs) {
      const sessie = dev === 'apc40' ? apparaten.apc : apparaten.lpd8;
      h.verwacht({ soort: 'melding', dev, wat });
      const regel = overslaan();
      /** @type {() => void} */
      let stop = () => {};
      let timer = null;
      const t0 = klok.nu();
      const gebeurd = new Promise((r) => {
        stop = sessie.bij(wat, () => r(true));
        timer = klok.zet(() => r(false), timeoutMs * schaal);
      });
      const ok = await Promise.race([gebeurd, regel.p.then(() => false)]);
      regel.annuleer();
      stop();
      klok.wis(timer);
      return { ok, ms: Math.round(klok.nu() - t0) };
    },

    /** Leer een LPD8-pad of -knop: eerste bruikbare bericht. @param {'pad'|'knop'} soort @param {number} nr */
    async leer(soort, nr) {
      const r = await h.eerste({
        dev: 'lpd8', verwacht: { wat: soort, nr },
        filter: (_g, b) => { const bron = bronUitBericht(b); return !!bron && (soort === 'knop' ? bron.t === 'cc' : true); },
      });
      return r ? bronUitBericht(r.bytes) : null;
    },
  };
  return h;
}

/**
 * config.json lezen als de aanroeper hem niet meegaf. Kapot: leeg (dan gelden de standaarden, zoals in de kern),
 * maar met de foutmelding erbij, zodat de proef het zegt in plaats van stil verder te gaan.
 * @returns {{ config: Record<string, any>, configFout: string|null }}
 */
function leesConfig() {
  try { return { config: laadConfig(), configFout: null }; } catch (e) { return { config: {}, configFout: /** @type {Error} */ (e).message }; }
}

/** Terminal-IO met readline: één regel tegelijk, annuleerbaar. @param {import('node:readline').Interface} rl @returns {IO} */
export function terminalIO(rl) {
  /** @type {((r: string) => void)[]} */
  const wachters = [];
  rl.on('line', (r) => { const w = wachters.shift(); w?.(r); });
  return {
    toon: (t) => console.log(t),
    regel() {
      /** @type {(r: string) => void} */
      let los = () => {};
      const p = new Promise((r) => { los = r; wachters.push(r); });
      return { p, annuleer: () => { const i = wachters.indexOf(los); if (i >= 0) wachters.splice(i, 1); } };
    },
  };
}
