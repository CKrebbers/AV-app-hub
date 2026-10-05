// @ts-check
// Speelapparaten (PROTOCOL §17): de E-MU Xboard49 en de Maschine MK2 spelen voor één lease-app tegelijk, los van de
// APC-lagen. Puur: geen I/O en geen klok. De kern geeft door wat binnenkomt (ruwe MIDI van de Xboard, virtuele MIDI
// van de Maschine) en wat apps terugsturen (LED's, schermen); dit bepaalt wie het krijgt.
//
// Wie speelt (per apparaat): de app met APC-focus als die het apparaat in `speelt` heeft; anders de laatst
// gefocuste app die het heeft; anders de eerste in slotvolgorde die het heeft. Alleen verbonden lease-apps tellen.
// De hubtoets (Bank) doet hier niets: het keyboard blijft spelen terwijl je focus wisselt.
//
// Niets blijft hangen (zoals §11 voor de APC): een loslaten (noot uit, pedaal op) gaat altijd naar de app die het
// indrukken kreeg, ook na een focuswissel; een loslaten van iets dat niemand vasthield, gaat nergens heen. Valt het
// apparaat weg, dan krijgt elke app zijn loslaten van wat hij nog vasthield. Polyfone aftertouch volgt de noot.
// Paniek van de Xboard (CC 120/123) gaat naar wie nu speelt én naar elke app die op dat kanaal nog iets vasthoudt.
//
// Terug: LED's (`{t:'led', dev, bytes}`) en schermen (`{t:'scherm', dev, nr, data}`) worden per app bewaard en
// gaan naar het apparaat zolang die app speelt. Wisselt wie speelt, dan eerst alles uit en daarna wat de nieuwe app
// het laatst stuurde (volledige repaint, zoals de lease-LED's van de APC).

import { SPEELAPPARATEN } from '../protocol/manifest.js';

export { SPEELAPPARATEN };

/**
 * @typedef {{ app: string, speelt: readonly string[], verbonden: boolean }} SpelerApp
 * @typedef {{ led: (m: number[]) => void, scherm: (nr: 0|1, data: Uint8Array) => void, leeg: () => void }} SpeelOppervlak
 * @typedef {{
 *   apps: () => Iterable<SpelerApp>, focus: () => string|null, slots: () => readonly (string|null)[],
 *   naar: (app: string, b: { t: 'midi', dev: string, bytes: number[] }) => void,
 *   oppervlakken?: Record<string, SpeelOppervlak|undefined>,
 * }} Opties
 */

/** Indrukken, loslaten of iets dat een ingedrukte toets volgt. @param {number[]} b */
function soortVan(b) {
  const st = b[0] & 0xf0, ch = b[0] & 0x0f;
  if (st === 0x90 && b[2] > 0) return { soort: /** @type {const} */ ('druk'), sleutel: `n:${ch}:${b[1]}` };
  if (st === 0x80 || st === 0x90) return { soort: /** @type {const} */ ('los'), sleutel: `n:${ch}:${b[1]}` };
  if (st === 0xa0) return { soort: /** @type {const} */ ('volg'), sleutel: `n:${ch}:${b[1]}` };
  if (st === 0xb0 && b[1] === 64) return { soort: b[2] >= 64 ? /** @type {const} */ ('druk') : /** @type {const} */ ('los'), sleutel: `cc:${ch}:64` };
  if (st === 0xb0 && (b[1] === 120 || b[1] === 123)) return { soort: /** @type {const} */ ('paniek'), sleutel: '', ch };
  return { soort: /** @type {const} */ ('anders'), sleutel: '' };
}
/** Het loslaten bij een sleutel (als de hub het zelf moet maken). @param {string} sleutel */
function losVan(sleutel) {
  const [t, ch, n] = sleutel.split(':');
  return t === 'cc' ? [0xb0 | Number(ch), Number(n), 0] : [0x80 | Number(ch), Number(n), 0];
}
/** LED-adres in de kaart van een app: kanaal + noot (of CC). @param {number[]} m */
const ledSleutel = (m) => `${(m[0] & 0xf0) === 0xb0 ? 'cc' : 'n'}:${m[0] & 0x0f}:${m[1]}`;

export class Spelers {
  /** @param {Opties} o */
  constructor(o) {
    this.o = o;
    /** Wie nu speelt, per apparaat. @type {Record<string, string|null>} */
    this.doel = Object.fromEntries(SPEELAPPARATEN.map((d) => [d, null]));
    /** Apps in de volgorde waarin ze focus kregen (laatste = meest recent). @type {string[]} */
    this.focusVolgorde = [];
    /** Per apparaat: wat er ingedrukt is en naar welke app dat ging. @type {Map<string, Map<string, string>>} */
    this.vast = new Map(SPEELAPPARATEN.map((d) => [d, new Map()]));
    /** Per app, per apparaat: de laatste LED-berichten (per adres). @type {Map<string, Map<string, Map<string, number[]>>>} */
    this.kaarten = new Map();
    /** Per app, per apparaat: de schermen (null = nooit gestuurd). @type {Map<string, Map<string, (Uint8Array|null)[]>>} */
    this.schermen = new Map();
  }

  /** Wie speelt nu op `dev` (of null). @param {string} dev */
  doelVan(dev) { return this.doel[dev] ?? null; }
  /** Voor de cockpit: per apparaat de app die nu speelt. */
  doelen() { return { ...this.doel }; }

  /** @param {string} dev @returns {string|null} */
  #kies(dev) {
    /** @type {Map<string, SpelerApp>} */
    const kan = new Map();
    for (const a of this.o.apps()) if (a.verbonden && a.speelt.includes(dev)) kan.set(a.app, a);
    if (!kan.size) return null;
    const f = this.o.focus();
    if (f && kan.has(f)) return f;
    for (let i = this.focusVolgorde.length - 1; i >= 0; i--) if (kan.has(this.focusVolgorde[i])) return this.focusVolgorde[i];
    for (const s of this.o.slots()) if (s && kan.has(s)) return s;
    return /** @type {string} */ (kan.keys().next().value);
  }

  /** De APC-focus ging naar `app` (of naar niemand). @param {string|null} app */
  focusGewijzigd(app) {
    if (app) {
      this.focusVolgorde = this.focusVolgorde.filter((x) => x !== app);
      this.focusVolgorde.push(app);
    }
    return this.bijwerken();
  }

  /** Opnieuw kiezen wie speelt (na focus, manifest, verbinden of wegvallen); tekent het apparaat als dat wisselt. */
  bijwerken() {
    let veranderd = false;
    for (const dev of SPEELAPPARATEN) {
      const nieuw = this.#kies(dev);
      if (nieuw === this.doel[dev]) continue;
      this.doel[dev] = nieuw;
      veranderd = true;
      this.#teken(dev);
    }
    return veranderd;
  }

  /** Volledige repaint van een apparaat met de kaart van wie nu speelt (of alles uit). @param {string} dev */
  #teken(dev) {
    const opp = this.o.oppervlakken?.[dev];
    if (!opp) return;
    opp.leeg();
    const app = this.doel[dev];
    if (!app) return;
    for (const m of this.kaarten.get(app)?.get(dev)?.values() ?? []) opp.led(m);
    (this.schermen.get(app)?.get(dev) ?? []).forEach((d, nr) => { if (d) opp.scherm(/** @type {0|1} */ (nr), d); });
  }

  /**
   * Invoer van een speelapparaat (ruwe of virtuele MIDI) → naar wie het hoort.
   * @param {string} dev @param {number[]} bytes
   */
  invoer(dev, bytes) {
    const vast = this.vast.get(dev);
    if (!vast || !bytes.length) return;
    const x = soortVan(bytes);
    const stuur = (/** @type {string} */ app, /** @type {number[]} */ b) => this.o.naar(app, { t: 'midi', dev, bytes: [...b] });
    if (x.soort === 'los') {
      const app = vast.get(x.sleutel);
      vast.delete(x.sleutel);
      if (app) stuur(app, bytes);
      return;
    }
    if (x.soort === 'volg') {
      const app = vast.get(x.sleutel);
      if (app) stuur(app, bytes);
      return;
    }
    const doel = this.doel[dev];
    if (x.soort === 'paniek') {
      const apps = new Set(doel ? [doel] : []);
      for (const [k, app] of vast) {
        if (Number(k.split(':')[1]) !== x.ch) continue;
        apps.add(app);
        // De noten zijn hiermee los; het pedaal niet (CC123 laat sustain staan): dat loslaten blijft bij wie het indrukte.
        if (k.startsWith('n:')) vast.delete(k);
      }
      for (const app of apps) stuur(app, bytes);
      return;
    }
    if (!doel) return;
    if (x.soort === 'druk') {
      const was = vast.get(x.sleutel);
      // Al ingedrukt bij een andere app (de focus wisselde, of er kwam nooit een loslaten): die eerst los.
      if (was && was !== doel) stuur(was, losVan(x.sleutel));
      vast.set(x.sleutel, doel);
    }
    stuur(doel, bytes);
  }

  /** Het apparaat viel weg: elke app krijgt het loslaten van wat hij nog vasthield. @param {string} dev */
  apparaatWeg(dev) {
    const vast = this.vast.get(dev);
    if (!vast) return;
    for (const [k, app] of [...vast]) this.o.naar(app, { t: 'midi', dev, bytes: losVan(k) });
    vast.clear();
  }

  /**
   * LED-berichten van een app voor een speelapparaat: bewaren, en doorsturen als die app nu speelt.
   * @param {string} app @param {string} dev @param {number[][]} lijst (al gecontroleerd: 3 bytes, noot of CC)
   */
  led(app, dev, lijst) {
    if (!this.#speelt(app, dev)) return;
    let perDev = this.kaarten.get(app);
    if (!perDev) this.kaarten.set(app, (perDev = new Map()));
    let kaart = perDev.get(dev);
    if (!kaart) perDev.set(dev, (kaart = new Map()));
    const opp = this.doel[dev] === app ? this.o.oppervlakken?.[dev] : undefined;
    for (const m of lijst) {
      const k = ledSleutel(m);
      kaart.delete(k);   // achteraan: bij een repaint de nieuwste volgorde
      kaart.set(k, [...m]);
      opp?.led([...m]);
    }
  }

  /** Een scherm van een app (2048 bytes). @param {string} app @param {string} dev @param {0|1} nr @param {Uint8Array} data */
  scherm(app, dev, nr, data) {
    if (!this.#speelt(app, dev)) return;
    let perDev = this.schermen.get(app);
    if (!perDev) this.schermen.set(app, (perDev = new Map()));
    const s = perDev.get(dev) ?? [null, null];
    s[nr] = Uint8Array.from(data);
    perDev.set(dev, s);
    if (this.doel[dev] === app) this.o.oppervlakken?.[dev]?.scherm(nr, /** @type {Uint8Array} */ (s[nr]));
  }

  /** Een app die de hub helemaal vergeet (nooit een manifest): zijn kaarten en plek in de focusvolgorde weg. @param {string} app */
  vergeetApp(app) {
    this.kaarten.delete(app);
    this.schermen.delete(app);
    this.focusVolgorde = this.focusVolgorde.filter((x) => x !== app);
  }

  /** @param {string} app @param {string} dev */
  #speelt(app, dev) {
    for (const a of this.o.apps()) if (a.app === app) return a.speelt.includes(dev);
    return false;
  }
}
