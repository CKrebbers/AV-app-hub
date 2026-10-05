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
import { HINT } from './ports/hid.js';

/** Zo lang mag het afsluiten van een lopende opname hub.stop() ophouden (schijf weg of traag). */
export const OPNAME_SLUIT_MS = 2000;

/**
 * Is een melding van de Opnemer een fout (rood in de cockpit)? Fouten dragen de oorzaak mee (e), of beginnen
 * met "opname: " (geen avondmap, niets bewaard, achterstand); "opname: schrijven lukt weer" is goed nieuws.
 * "opname gestart …", "opname loopt: …" en "opname klaar: …" zijn gewone meldingen.
 * @param {string} tekst @param {unknown} [e]
 */
export function isOpnameFout(tekst, e) {
  if (e !== undefined && e !== null) return true;
  return /^opname: /.test(String(tekst)) && !/lukt weer/.test(String(tekst));
}

/**
 * Opnemer-meldingen → beeld.opnameInfo (melding + fout) voor de cockpit. Het beeld wordt gedrosseld, dus alleen
 * de laatste melding komt aan; daarom verdwijnt een fout van deze avond niet stilletjes achter 'opname klaar':
 * die wordt dan samengevoegd ('opname klaar: … — maar: samenvatting niet geschreven …') en blijft rood. Ook een
 * avond met verloren regels eindigt rood. Pas een nieuwe avond ('opname gestart') begint weer zonder fout.
 * Let op: hangt af van de tekst van de meldingen in src/opname/opnemer.js en schrijver.js (zie isOpnameFout).
 * @param {(info: { melding?: string, fout: boolean }) => void} zet
 */
export function opnameMeldingen(zet) {
  /** @type {string|null} de laatste fout van deze avond (null = geen, of 'schrijven lukt weer') */
  let fout = null;
  return {
    /** @param {string} t @param {unknown} [e] */
    melding(t, e) {
      const tekst = String(t);
      if (/^opname gestart/.test(tekst)) fout = null;
      if (/^opname klaar/.test(tekst)) {
        if (fout) zet({ melding: `${tekst} — maar: ${fout.replace(/^opname: /, '')}`, fout: true });
        else zet({ melding: tekst, fout: false });
        fout = null;
        return;
      }
      const isFout = isOpnameFout(tekst, e);
      if (isFout) fout = tekst;
      else if (/^opname: schrijven lukt weer/.test(tekst)) fout = null;   // verloren regels komen bij 'klaar'
      zet({ melding: tekst, fout: isFout });
    },
    /** De avond is afgesloten (Opnemer 'klaar', direct na 'opname klaar'): regels verloren = rood. @param {{ verloren?: number }} [r] */
    klaar(r) { if ((r?.verloren ?? 0) > 0) zet({ fout: true }); },
  };
}

/**
 * Wat de cockpit bij de Maschine zegt (beeld.apparaten["maschine-mk2"].hint): wat te doen bij deze status.
 * @param {string} status @param {string|null} [reden]
 */
export function maschineHint(status, reden = null) {
  if (status === 'bezet') return HINT.bezet;
  if (status === 'geen-invoer') return HINT.invoer;
  // Alleen als node-hid echt ontbreekt helpt npm install (niet bij --zonder-midi of een vid/pid die niet klopt).
  if (status === 'geen-hid') return /^node-hid niet geïnstalleerd/.test(reden ?? '') ? `${reden} — npm install haalt node-hid binnen` : (reden ?? 'geen HID');
  return null;
}

/**
 * @param {{
 *   config: any, systeem: import('./ports/poort.js').Systeem, klok?: import('./core/klok.js').Klok,
 *   hid?: import('./ports/hid.js').HidSysteem|null, hidReden?: string|null, xboardProfiel?: any,
 *   poort?: number, host?: string, lpd8Profiel?: any, drivers?: boolean, fetch?: typeof fetch,
 *   logboek?: import('./core/logboek.js').Logboek|null, log?: (...a: unknown[]) => void, token?: string|null,
 *   geheugen?: string|null,
 *   opname?: false | { thuis?: string, bestanden?: import('./opname/schrijver.js').Bestanden, datum?: () => Date, git?: string|null|(() => Promise<string|null>), spoelMs?: number, sluitMs?: number },
 * }} o  opname: avondmap (LPD8-pad 4, zie docs/OPNAME.md); false = niet opnemen
 *       geheugen: pad van het geheugenbestand (snapshots, truth:"hub"-waarden; zie src/opslag.js), null = niet bewaren.
 *       `varve-hub start` geeft `geheugenPad(config)` mee; tests geven een eigen pad of niets.
 *       token: vereist van elke verbinding van buiten de eigen machine (--lan, docs/NETWERK.md)
 *       hid: HID voor de Maschine MK2 (src/ports/hid.js; null = zonder, `hidReden` zegt waarom)
 */
export async function startHub({ config, systeem, hid = null, hidReden = null, klok = echteKlok, poort, host, lpd8Profiel = null, xboardProfiel = null, drivers = true, fetch: f = globalThis.fetch, logboek = null, log = () => {}, opname = {}, geheugen = null, token = null }) {
  const sluitMs = (opname ? opname.sluitMs : undefined) ?? OPNAME_SLUIT_MS;
  const cfg = { ...config, kaarten: { ...laadKaarten(), ...(config.kaarten ?? {}) } };
  const apparaten = maakApparaten({ systeem, hid, hidReden, klok, config: cfg, logboek, lpd8Profiel, xboardProfiel });
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
  // De Maschine is het speeloppervlak van de lease-app die erop speelt (§17); ook hier eerst de poortwachter.
  const maschine = apparaten.maschine;
  const speelOppervlakken = maschine ? {
    'maschine-mk2': {
      /** @param {number[]} m */ led(m) { if (!stoppend) maschine.led(m); },
      /** @param {0|1} nr @param {Uint8Array} d */ scherm(nr, d) { if (!stoppend) maschine.scherm(nr, d); },
      leeg() { if (!stoppend) maschine.leeg(); },
    },
  } : {};
  const kern = new Kern({ klok, config: cfg, oppervlak, speelOppervlakken });
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
  // Cockpit: sinds wanneer er opgenomen wordt — ná opnemer.koppel, zodat de Opnemer al geprobeerd heeft te
  // beginnen: zonder avondmap loopt er niets (opnemer.actief false), dan ook geen sinds en geen looptijd.
  if (opnemer) kern.bij('opname', (/** @type {boolean} */ aan) => kern.zetOpnameInfo({ sinds: aan && opnemer.actief ? klok.nu() : null }));
  await opnemer?.gitKlaar;   // kort (git rev-parse): dan staat de commit ook in de kop van een avond die meteen begint
  if (opnemer) {
    const meldingen = opnameMeldingen((info) => kern.zetOpnameInfo({ map: opnemer.huidig?.map ?? null, ...info }));
    opnemer.bij('melding', (/** @type {string} */ t, /** @type {unknown} */ e) => { log(t); meldingen.melding(t, e); });
    opnemer.bij('klaar', (/** @type {{ verloren?: number }} */ r) => meldingen.klaar(r));
  }
  apparaten.lpd8.bij('profiel', () => opnemer?.profielGewijzigd());

  // Echte controllers → kern; hun stand → cockpit.
  apparaten.apc.bij('gebeurtenis', (/** @type {any} */ g, /** @type {number[]} */ b) => { opnemer?.invoer('apc40', b); kern.invoer(g, b); });
  apparaten.lpd8.bij('gebeurtenis', (/** @type {any} */ g, /** @type {number[]} */ b) => { opnemer?.invoer('lpd8', b); kern.invoer(g, b); });
  const meldApc = () => kern.zetApparaat('apc40', { verbonden: apparaten.apc.verbonden, naam: apparaten.apc.poort?.naam ?? null });
  const meldLpd8 = () => kern.zetApparaat('lpd8', { verbonden: apparaten.lpd8.verbonden, naam: apparaten.lpd8.poort?.naam ?? null, model: apparaten.lpd8.model });
  for (const e of ['verbonden', 'weg']) { apparaten.apc.bij(e, meldApc); apparaten.lpd8.bij(e, meldLpd8); }
  apparaten.lpd8.bij('model', meldLpd8);
  apparaten.lpd8.bij('weg', () => kern.apparaatWeg('lpd8'));
  // Speelapparaten (§17): Xboard49 (ruwe MIDI) en Maschine MK2 (virtuele MIDI, al uitgedund) → kern en opname.
  const xboard = apparaten.xboard;
  for (const [sessie, dev] of /** @type {const} */ ([[xboard, 'xboard49'], [maschine, 'maschine-mk2']])) {
    if (!sessie) continue;
    sessie.bij('gebeurtenis', (/** @type {any} */ g, /** @type {number[]} */ b) => { opnemer?.invoer(dev, b); kern.invoer(g, b); });
    sessie.bij('weg', () => kern.apparaatWeg(dev));
  }
  const meldXboard = () => { if (xboard) kern.zetApparaat('xboard49', { verbonden: xboard.verbonden, naam: xboard.poort?.naam ?? null }); };
  const meldMaschine = () => {
    if (maschine) kern.zetApparaat('maschine-mk2', { verbonden: maschine.verbonden, naam: maschine.naam, status: maschine.status, hint: maschineHint(maschine.status, maschine.statusReden) });
  };
  for (const e of ['verbonden', 'weg']) { xboard?.bij(e, meldXboard); maschine?.bij(e, meldMaschine); }
  maschine?.bij('status', meldMaschine);
  meldXboard();
  meldMaschine();
  // Mislukt sturen of openen: één regel per storing (de sessie meldt niet per bericht of per poging); het opnieuw
  // openen en initialiseren doet de aansluiting zelf (src/core/aansluiting.js, PROTOCOL §16).
  for (const [sessie, label] of /** @type {const} */ ([[apparaten.apc, 'APC'], [apparaten.lpd8, 'LPD8'], [xboard, 'Xboard49']])) {
    sessie?.bij('fout', (/** @type {Error} */ e, /** @type {string} */ soort) => {
      log(soort === 'sturen' ? `${label}: sturen mislukt — kabel los? de hub probeert opnieuw`
        : `${label}: openen mislukt (${e?.message ?? e}) — de hub probeert opnieuw`);
    });
  }
  // De Maschine: bezet (een NI-programma heeft hem) of geen invoer (macOS-Invoermonitoring): zeggen wat te doen.
  maschine?.bij('fout', (/** @type {Error} */ e, /** @type {string} */ soort) => {
    log(soort === 'sturen' ? 'Maschine: sturen mislukt — kabel los? de hub probeert opnieuw'
      : soort === 'invoer' ? `Maschine: open, maar er komt niets binnen — ${HINT.invoer}`
        : `Maschine: bezet (${e?.message ?? e}) — ${HINT.bezet}`);
  });

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
    poort: poort ?? cfg.poorten.http, host: host ?? cfg.server?.host ?? '127.0.0.1', origins: cfg.server?.origins ?? [], token,
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
