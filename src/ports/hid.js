// @ts-check
// Echte HID via node-hid, voor de Maschine MK2 (src/devices/maschine-mk2.js). Net als rtmidi.js pas geladen als het
// nodig is: zonder de module (een optionalDependency) of zonder HID (de cloud) start de hub gewoon, zonder Maschine.
//
// Wat we van node-hid 3.4 gebruiken (README): `HID.devices(vid, pid)` (een USB-opsomming; niet te vaak, daarom
// kijkt de hub alleen in de gewone hotplug-ronde), `new HID.HID(pad, { nonExclusive })`, het 'data'-event (een
// Buffer per invoerrapport, eerste byte = rapport-id), 'error' (het toestel is weg of kapot: daarna leest hij niets
// meer), `write(bytes)` (synchroon; eerste byte = rapport-id) en `close()`.
// Op macOS opent hidapi standaard exclusief: heeft een ander programma (Maschine 2, Controller Editor,
// NIHardwareAgent, NIHostIntegrationAgent) hem al, dan gooit `new HID.HID` → de sessie meldt "bezet" en probeert het
// in elke hotplug-ronde opnieuw. Of macOS 'Invoermonitoring' vraagt om invoer te lezen, meet de proef.
import { execFileSync } from 'node:child_process';

/**
 * @typedef {{ naam: string, pad: string, vid: number, pid: number, product: string|null }} HidApparaat
 * @typedef {{
 *   naam: string, product?: string|null,
 *   stuur: (bytes: number[]) => void,
 *   bijBericht: (fn: (b: Uint8Array) => void) => () => void,
 *   sluit: () => void,
 *   levend?: () => boolean,
 * }} HidPoort
 * @typedef {{
 *   soort: string,
 *   apparaten: () => HidApparaat[],
 *   zoek: (vid: number, pid: number) => string|null,
 *   open: (naam: string, o?: { nietExclusief?: boolean }) => HidPoort,
 * }} HidSysteem
 */

/**
 * @param {() => Promise<any>} [importeer] (tests geven een nep-module of een die faalt)
 * @returns {Promise<{ systeem: HidSysteem|null, reden?: string }>}
 */
export async function laadHid(importeer = () => import('node-hid')) {
  let HID;
  try {
    const m = await importeer();
    HID = m?.default ?? m;
  } catch (e) {
    return { systeem: null, reden: `node-hid niet geïnstalleerd (${/** @type {Error} */ (e).message.split('\n')[0]})` };
  }
  try {
    HID.devices(); // werkt de opsomming? (geen HID-systeem: dan gooit dit)
  } catch (e) {
    return { systeem: null, reden: `HID niet beschikbaar (${/** @type {Error} */ (e).message})` };
  }
  return { systeem: hidSysteemVan(HID) };
}

/**
 * Een HidSysteem bovenop een node-hid-module (of iets met dezelfde vorm). De naam van een toestel is zijn pad:
 * na opnieuw insteken krijgt het een nieuw pad, en dan ziet de aansluiting een ander toestel (sluiten, opnieuw openen).
 * @param {any} HID
 * @returns {HidSysteem}
 */
export function hidSysteemVan(HID) {
  /** @param {any} d @returns {HidApparaat} */
  const apparaat = (d) => ({ naam: String(d.path), pad: String(d.path), vid: d.vendorId, pid: d.productId, product: d.product ?? null });
  return {
    soort: 'hid',
    apparaten: () => HID.devices().filter((/** @type {any} */ d) => d.path).map(apparaat),
    zoek(vid, pid) {
      const d = HID.devices(vid, pid).find((/** @type {any} */ x) => x.path && x.vendorId === vid && x.productId === pid);
      return d ? String(d.path) : null;
    },
    open(naam, { nietExclusief = false } = {}) {
      const product = HID.devices().find((/** @type {any} */ d) => String(d.path) === naam)?.product ?? null;
      const d = new HID.HID(naam, { nonExclusive: nietExclusief });
      /** @type {Set<(b: Uint8Array) => void>} */
      const luisteraars = new Set();
      let levend = true;
      d.on('data', (/** @type {Uint8Array} */ b) => { for (const fn of luisteraars) fn(b); });
      // Uittrekken: node-hid meldt een leesfout en leest daarna niets meer. De aansluiting ziet `levend()` false en
      // opent het toestel opnieuw zodra het er weer is.
      d.on('error', () => { levend = false; });
      return {
        naam, product,
        stuur(b) {
          if (!levend) throw new Error(`${product ?? naam}: toestel weg`);
          d.write(b);
        },
        bijBericht: (fn) => { luisteraars.add(fn); return () => luisteraars.delete(fn); },
        sluit() { levend = false; luisteraars.clear(); try { d.removeAllListeners('data'); d.close(); } catch { /* al dicht */ } },
        levend: () => levend,
      };
    },
  };
}

/** NI-programma's die de Maschine (exclusief) kunnen vasthouden; de hub stopt ze nooit zelf. */
export const NI_PROGRAMMAS = Object.freeze(['NIHardwareAgent', 'NIHostIntegrationAgent', 'Maschine 2', 'Controller Editor']);

/**
 * Welke van die programma's draaien er nu? Leest de proceslijst (`ps`); lukt dat niet, dan een lege lijst.
 * @param {() => string} [ps] tests geven een eigen lijst
 * @returns {string[]}
 */
export function draaiendeNi(ps = () => execFileSync('ps', ['-axo', 'comm'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) {
  let tekst = '';
  try { tekst = ps(); } catch { return []; }
  const regels = tekst.split('\n').map((r) => r.trim().split('/').pop() ?? '');
  return NI_PROGRAMMAS.filter((p) => regels.some((r) => r === p || r.startsWith(`${p} `) || r === `${p}.app`));
}

/** Wat Clay doet als de Maschine bezet is of niets stuurt (hub-log, doctor, proef, cockpit). */
export const HINT = Object.freeze({
  bezet: 'sluit Maschine 2 en Controller Editor; NIHardwareAgent en NIHostIntegrationAgent kunnen hem ook vasthouden (Activiteitenweergave). De hub probeert het elke ronde opnieuw',
  invoer: 'macOS laat de invoer niet door: Systeeminstellingen → Privacy en beveiliging → Invoermonitoring → zet Terminal (of iTerm/Node) aan, en start de hub opnieuw',
});
