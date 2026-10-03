// @ts-check
// De hub als geheel: apparaten (APC40, LPD8), kern, server (cockpit + apps) en drivers aan elkaar.
// Geen eigen logica — alleen bedrading. Alles is injecteerbaar, zodat dezelfde hub draait met echte
// MIDI (Mac), met NepSysteem (tests, cloud) of helemaal zonder controllers (alleen de cockpit).
import { join } from 'node:path';
import { Kern } from './core/kern.js';
import { echteKlok } from './core/klok.js';
import { maakApparaten } from './apparaten.js';
import { startServer } from './transports/server.js';
import { startDrivers } from './drivers/index.js';
import { koppelGeheugen, schrijfMsUit } from './opslag.js';
import { HUB_MAP, laadKaarten } from './config.js';
import * as APC from './devices/apc40mk2.js';
import * as LPD8 from './devices/lpd8.js';
import { Opnemer, avondmapPad } from './opname/opnemer.js';

/** Zo lang mag het afsluiten van een lopende opname hub.stop() ophouden (schijf weg of traag). */
export const OPNAME_SLUIT_MS = 2000;

/**
 * @param {{
 *   config: any, systeem: import('./ports/poort.js').Systeem, klok?: import('./core/klok.js').Klok,
 *   poort?: number, host?: string, lpd8Profiel?: any, drivers?: boolean, fetch?: typeof fetch,
 *   logboek?: import('./core/logboek.js').Logboek|null, log?: (...a: unknown[]) => void,
 *   geheugen?: string|null,
 *   opname?: false | { thuis?: string, bestanden?: import('./opname/schrijver.js').Bestanden, datum?: () => Date, git?: string|null|(() => Promise<string|null>), spoelMs?: number, sluitMs?: number },
 * }} o  opname: avondmap (LPD8-pad 4, zie docs/OPNAME.md); false = niet opnemen
 *       geheugen: pad van het geheugenbestand (snapshots, truth:"hub"-waarden; zie src/opslag.js), null = niet bewaren.
 *       `varve-hub start` geeft `geheugenPad(config)` mee; tests geven een eigen pad of niets.
 */
export async function startHub({ config, systeem, klok = echteKlok, poort, host, lpd8Profiel = null, drivers = true, fetch: f = globalThis.fetch, logboek = null, log = () => {}, opname = {}, geheugen = null }) {
  const sluitMs = (opname ? opname.sluitMs : undefined) ?? OPNAME_SLUIT_MS;
  const cfg = { ...config, kaarten: { ...laadKaarten(), ...(config.kaarten ?? {}) } };
  const apparaten = maakApparaten({ systeem, klok, config: cfg, logboek, lpd8Profiel });
  // De kern tekent via een poortwachter: zodra stop() begint, komt er van de kern niets meer op de APC.
  // Anders kan een app die tijdens het afsluiten nog `zet` stuurt LEDs aanzetten ná het zwart.
  let stoppend = false;
  const apc = apparaten.apc;
  const oppervlak = {
    /** @param {string} id @param {any} s */ zet(id, s) { if (!stoppend) apc.zet(id, s); },
    teken() { return stoppend ? 0 : apc.teken(); },
    /** @param {number[]} b */ stuur(b) { if (!stoppend) apc.stuur(b); },
    vergeet() { if (!stoppend) apc.vergeet(); },
    /** @param {string} naam @param {Function} fn */ bij(naam, fn) { return apc.bij(naam, /** @type {any} */ (fn)); },
  };
  const kern = new Kern({ klok, config: cfg, oppervlak });
  // Vóór de drivers en de server: wie zich aanmeldt, vindt zijn bewaarde waarden al klaar.
  const opslag = geheugen ? koppelGeheugen({ kern, pad: geheugen, klok, log, schrijfMs: schrijfMsUit(cfg) }) : null;

  // Avondmap: LPD8-pad 4 neemt de avond op (ruwe invoer + wat naar de apps gaat). De ruwe bytes worden hier
  // vastgelegd, vlak vóór kern.invoer, want het kern-event 'invoer' draagt alleen de gebeurtenis.
  const opnemer = opname === false ? null : new Opnemer({
    kern, klok, map: avondmapPad(cfg, opname.thuis), bestanden: opname.bestanden, datum: opname.datum,
    ...(opname.git !== undefined ? { git: opname.git } : {}), spoelMs: opname.spoelMs,
    lpd8Profiel: () => apparaten.lpd8.profiel,
  });
  opnemer?.koppel();
  await opnemer?.gitKlaar;   // kort (git rev-parse): dan staat de commit ook in de kop van een avond die meteen begint
  opnemer?.bij('melding', (/** @type {string} */ t) => log(t));
  apparaten.lpd8.bij('profiel', () => opnemer?.profielGewijzigd());

  // Echte controllers → kern; hun stand → cockpit.
  apparaten.apc.bij('gebeurtenis', (/** @type {any} */ g, /** @type {number[]} */ b) => { opnemer?.invoer('apc40', b); kern.invoer(g, b); });
  apparaten.lpd8.bij('gebeurtenis', (/** @type {any} */ g, /** @type {number[]} */ b) => { opnemer?.invoer('lpd8', b); kern.invoer(g, b); });
  const meldApc = () => kern.zetApparaat('apc40', { verbonden: apparaten.apc.verbonden, naam: apparaten.apc.poort?.naam ?? null });
  const meldLpd8 = () => kern.zetApparaat('lpd8', { verbonden: apparaten.lpd8.verbonden, naam: apparaten.lpd8.poort?.naam ?? null, model: apparaten.lpd8.model });
  for (const e of ['verbonden', 'weg']) { apparaten.apc.bij(e, meldApc); apparaten.lpd8.bij(e, meldLpd8); }
  apparaten.lpd8.bij('model', meldLpd8);
  apparaten.lpd8.bij('weg', () => kern.apparaatWeg('lpd8'));

  // Virtuele controllers uit de cockpit: precies alsof de bytes van USB kwamen.
  // De virtuele LPD8 stuurt altijd de mk2-fabrieksstand, los van het profiel van de echte LPD8.
  const virtueleLpd8 = LPD8.maakOntleder(LPD8.standaardProfiel('mk2'));
  /** @param {'apc40'|'lpd8'} dev @param {number[]} bytes */
  const opVirtueel = (dev, bytes) => {
    const g = dev === 'apc40' ? APC.ontleed(bytes) : virtueleLpd8(bytes);
    logboek?.midi('in', `${dev}-virtueel`, bytes);
    opnemer?.invoer(`${dev}-virtueel`, bytes);
    kern.invoer(g, bytes);
  };

  const server = await startServer({
    poort: poort ?? cfg.poorten.http, host: host ?? cfg.server?.host ?? '127.0.0.1', origins: cfg.server?.origins ?? [],
    kern, uiMap: join(HUB_MAP, 'ui'), srcMap: join(HUB_MAP, 'src'), opVirtueel,
  });
  const actieveDrivers = drivers ? startDrivers({ kern, klok, systeem, fetch: f, config: cfg, log }) : null;
  apparaten.start();

  return {
    kern, apparaten, server, opVirtueel, opnemer, opslag,
    adres: server.adres,
    async stop() {
      if (stoppend) return;
      stoppend = true;
      actieveDrivers?.stop();
      await server.stop();               // geen app- of cockpitberichten meer
      // Een lopende avond netjes afsluiten (eindstaat, samenvatting) — maar begrensd: hangt de schijf (extern
      // volume weg, netwerkschijf), dan moeten de LEDs toch uit en de poorten dicht.
      if (opnemer) {
        /** @type {any} */ let t;
        const opTijd = await Promise.race([
          opnemer.sluit().then(() => true, () => true),
          new Promise((r) => { t = setTimeout(() => r(false), sluitMs); }),
        ]);
        clearTimeout(t);
        if (!opTijd) log(`opname niet volledig weggeschreven — de schijf reageerde niet binnen ${sluitMs / 1000} s (${opnemer.map}); de hub stopt toch`);
      }
      opslag?.stop();                    // wat nog wacht meteen naar schijf (vóór kern.stop: van een lopende slew het doel)
      kern.stop();
      await apparaten.stop();            // LEDs uit, poorten dicht
    },
  };
}
