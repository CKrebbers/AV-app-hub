// @ts-check
// Apparaatsessies: de hub-kant van één aangesloten controller.
// ApcSessie zet de modus, tekent LEDs via de wachtrij en meldt gebeurtenissen.
// Lpd8Sessie herkent het model, leest programma's en meldt gebeurtenissen volgens het profiel.
// XboardSessie (alleen invoer) en MaschineSessie (USB-HID) zijn de speelapparaten (PROTOCOL §17).
import * as APC from './devices/apc40mk2.js';
import * as LPD8 from './devices/lpd8.js';
import * as XB from './devices/xboard49.js';
import * as MS from './devices/maschine-mk2.js';
import { zoekIngang } from './ports/poort.js';
import { Aansluiting } from './core/aansluiting.js';
import { LedBeeld } from './core/leds.js';
import { Wachtrij } from './core/wachtrij.js';
import { Zender } from './core/zender.js';

/** @typedef {import('./ports/poort.js').Systeem} Systeem @typedef {import('./ports/poort.js').Poort} Poort
 *  @typedef {import('./ports/hid.js').HidSysteem} HidSysteem
 *  @typedef {import('./core/klok.js').Klok} Klok @typedef {import('./core/logboek.js').Logboek} Logboek */

class Sessie extends Zender {
  /**
   * @param {{ dev: string, patroon?: RegExp|null, systeem?: Systeem|null, klok: Klok, intervalMs?: number, lijstMs?: number,
   *   zoek?: () => string|null, open?: (naam: string) => Poort,
   *   logboek?: Logboek|null, led?: { per_burst: number, burst_ms: number } }} o
   *   zoek/open: een ander soort apparaat dan een gewone MIDI-poort (zie Aansluiting)
   */
  constructor(o) {
    super();
    this.dev = o.dev;
    this.klok = o.klok;
    this.logboek = o.logboek ?? null;
    /** @type {Poort|null} */
    this.poort = null;
    /** Welke storingen al gemeld zijn (één melding per storing, niet per bericht of per poging). 'sturen' is voorbij
     *  zodra er weer iets verstuurd is, 'openen' zodra de poort weer open is: los van elkaar, zodat de ene de
     *  melding van de andere niet onderdrukt. */
    this.gemeld = { sturen: false, openen: false, invoer: false };
    this.rij = new Wachtrij({
      klok: o.klok, perBurst: o.led?.per_burst ?? 16, burstMs: o.led?.burst_ms ?? 4,
      stuur: (b) => {
        const p = this.poort;
        if (!p) return;
        this.logUit(b);
        // Het apparaat is (even) losgetrokken of de poort is stuk: de poort gooit. Dat mag de hub niet laten vallen
        // (dit draait in een timer: een uitzondering hier stopte het hele proces). De poort meteen opnieuw openen en
        // het apparaat opnieuw initialiseren (golf 8): ook als de kabel al terug is vóór de hotplug-ronde het zag.
        try { p.stuur(b); } catch (e) {
          this.aansluiting.herstel(p);
          this.storing(/** @type {Error} */ (e), 'sturen');
          return;
        }
        this.gemeld.sturen = false;
        this.aansluiting.gelukt();
      },
    });
    this.aansluiting = new Aansluiting({
      systeem: o.systeem, patroon: o.patroon, klok: o.klok, intervalMs: o.intervalMs, lijstMs: o.lijstMs, zoek: o.zoek, open: o.open,
      bijVerbonden: (p) => this.#verbonden(p),
      bijWeg: (naam) => { this.poort = null; this.rij.wis(); this.logboek?.regel('melding', { dev: this.dev, wat: 'weg', naam }); this.meld('weg', naam); },
      bijFout: (e) => this.storing(e, 'openen'),
      // Sturen bleef mislukken na een keer opnieuw openen: de poort blijft open (de ingang werkt misschien nog), het
      // apparaat wordt alleen opnieuw geïnitialiseerd.
      bijOpnieuw: (p) => { if (this.poort === p) this.bijAansluiten(); },
    });
  }
  /** Meldt 'fout' (e, soort: 'sturen' | 'openen' | 'invoer'), één keer per storing. @param {Error} e @param {'sturen'|'openen'|'invoer'} soort */
  storing(e, soort) {
    if (this.gemeld[soort]) return;
    this.gemeld[soort] = true;
    this.logboek?.regel('melding', { dev: this.dev, wat: 'fout', soort, fout: e.message });
    this.meld('fout', e, soort);
  }
  get verbonden() { return this.poort !== null; }
  start() { this.aansluiting.start(); }
  /** Poort dicht; wat nog in de wachtrij stond kan nergens meer heen (en geen timer blijft op de klok staan). */
  stop() { this.aansluiting.stop(); this.poort = null; this.rij.wis(); }
  /** @param {number[]} b */
  stuur(b) { this.rij.zet(b); }
  /** @param {Poort} p */
  #verbonden(p) {
    this.poort = p;
    this.gemeld.openen = false;
    this.logboek?.regel('melding', { dev: this.dev, wat: 'verbonden', naam: p.naam });
    p.bijBericht((b) => this.bijBinnen(/** @type {any} */ (b)));
    this.bijAansluiten();
    this.meld('verbonden', p.naam);
  }
  /** Eén bericht van het apparaat: loggen, ontleden, melden. @param {number[]} b */
  bijBinnen(b) {
    this.logboek?.midi('in', this.dev, b);
    const g = this.ontleed(b);
    this.logboek?.regel('gebeurtenis', g);
    this.meld('gebeurtenis', g, b);
  }
  /** Wat naar het apparaat ging, in het logboek. @param {number[]} b */
  logUit(b) { this.logboek?.midi('uit', this.dev, b); }
  /** @param {number[]} b @returns {any} */
  ontleed(b) { return { dev: this.dev, el: null, kind: 'onbekend', bytes: b }; }
  bijAansluiten() {}
}

export class ApcSessie extends Sessie {
  /** @param {ConstructorParameters<typeof Sessie>[0] & { modus?: number }} o */
  constructor(o) {
    super(o);
    this.modus = o.modus ?? APC.MODUS.alternatief;
    this.leds = new LedBeeld({ controls: APC.CONTROLS, berichten: APC.ledBerichten });
    this.leds.zwart();
  }
  /** @param {number[]} b */
  ontleed(b) { return APC.ontleed(b); }
  /** Bij (her)aansluiten: modus, ringtypes en alles opnieuw tekenen. Het apparaat valt na replug terug op modus 0. */
  bijAansluiten() { this.init(); }
  init() {
    this.rij.wis();
    this.stuur(APC.intro(this.modus));
    for (const b of APC.ringTypeBerichten(APC.RING.single)) this.stuur(b);
    this.leds.vergeet();
    this.teken();
  }
  /** @param {string} id @param {import('./devices/apc40mk2.js').LedStaat} s */
  zet(id, s) { this.leds.zet(id, s); }
  /** Stuur alle LED-wijzigingen. Geeft het aantal berichten terug. */
  teken() { const w = this.leds.wijzigingen(); this.rij.zetAlle(w); return w.length; }
  /** De volgende `teken()` stuurt alles opnieuw (bv. nadat een lease-app buiten het LED-model om tekende). */
  vergeet() { this.leds.vergeet(); }
  zwart() { this.leds.zwart(); return this.teken(); }
  /** Bij afsluiten: alles uit via de wachtrij (niet overspoelen), en wachten tot het verstuurd is. */
  async zwartEnWacht(maxMs = 500) {
    this.zwart();
    /** @type {any} */ let h;
    await Promise.race([this.rij.leeg(), new Promise((r) => { h = this.klok.zet(() => r(undefined), maxMs); })]);
    this.klok.wis(h);   // leeg op tijd: de wachttimer niet laten staan (hield de hub na stop() nog 0,5 s in leven)
  }
}

export class Lpd8Sessie extends Sessie {
  /** @param {ConstructorParameters<typeof Sessie>[0] & { profiel?: import('./devices/lpd8.js').Profiel|null }} o */
  constructor(o) {
    super(o);
    /** @type {import('./devices/lpd8.js').Model|null} */
    this.model = null;
    /** @type {Map<number, any>} */
    this.programmas = new Map();
    this.vastProfiel = o.profiel ?? null;
    this.profiel = o.profiel ?? LPD8.standaardProfiel(null);
    this.ontleder = LPD8.maakOntleder(this.profiel);
  }
  /** @param {import('./devices/lpd8.js').Profiel} p */
  zetProfiel(p) { this.profiel = p; this.ontleder = LPD8.maakOntleder(p); this.meld('profiel', p); }
  /** @param {number[]} b */
  ontleed(b) {
    if (b[0] === 0xf0) {
      const m = LPD8.modelUit(b);
      if (m && !this.model) { this.model = m; if (!this.vastProfiel) this.zetProfiel(LPD8.standaardProfiel(m)); this.meld('model', m); }
      const p = LPD8.ontleedProgramma(b);
      if (p) { this.programmas.set('prog' in p ? p.prog : -1, p); this.meld('programma', p); }
      return { dev: 'lpd8', el: null, kind: 'onbekend', sysex: true, model: m, programma: p ?? undefined };
    }
    return this.ontleder(b);
  }
  bijAansluiten() { this.stuur([...LPD8.IDENTITEIT_VRAAG]); }
  /** Vraag programma's op (na het model). @param {number[]} nummers */
  vraagProgrammas(nummers) { if (this.model) for (const n of nummers) this.stuur(LPD8.vraagProgramma(this.model, n)); }
}

/**
 * E-MU Xboard49: alleen invoer (het keyboard ontvangt niets). De hub opent alleen de ingang; hotplug zoals de LPD8.
 * De 16 knoppen krijgen een naam via het profiel (geleerd in de proef, anders de gok uit src/devices/xboard49.js).
 */
export class XboardSessie extends Sessie {
  /** @param {Omit<ConstructorParameters<typeof Sessie>[0], 'dev'> & { systeem: Systeem, patroon: RegExp, profiel?: XB.Profiel|null }} o */
  constructor(o) {
    const { systeem, patroon } = o;
    super({ ...o, dev: 'xboard49', zoek: () => zoekIngang(systeem.lijst(), patroon), open: (naam) => systeem.open(naam, { alleenIngang: true }) });
    this.vastProfiel = o.profiel ?? null;
    this.profiel = o.profiel ?? XB.standaardProfiel();
    this.ontleder = XB.maakOntleder(this.profiel);
  }
  /** @param {XB.Profiel} p */
  zetProfiel(p) { this.profiel = p; this.ontleder = XB.maakOntleder(p); this.meld('profiel', p); }
  /** @param {number[]} b */
  ontleed(b) { return this.ontleder(b); }
}

/**
 * Native Instruments Maschine MK2 over USB-HID (src/ports/hid.js). Maakt van de rapporten virtuele MIDI
 * (docs/MASCHINE.md) en meldt die als gebeurtenis (g, bytes), één per bericht, zoals de andere sessies. De pads
 * sturen ±750 rapporten per seconde, ook in rust: alleen wat ertoe doet komt in het logboek (elk knoppenrapport; een
 * padrapport alleen als het MIDI opleverde, of tijdens `neemRuwOp`), en de virtuele MIDI is al uitgedund (aftertouch
 * hooguit `aftertouch_hz` per pad). Lampjes en schermen: `led`, `scherm`, `leeg` (het speeloppervlak van de kern),
 * samengevoegd per klok-tik; alleen wat veranderde gaat de draad op.
 *
 * Status (`status`, event 'status'): 'geen-hid' (node-hid ontbreekt), 'zoekt' (niet aangesloten), 'bezet' (openen
 * mislukt: een NI-programma heeft hem), 'verbonden', 'geen-invoer' (open, maar binnen `stil_ms` geen enkel rapport:
 * macOS-Invoermonitoring). 'bezet' en 'geen-invoer' komen ook als 'fout' (e, 'openen' | 'invoer'), één keer per storing.
 */
export class MaschineSessie extends Sessie {
  /**
   * @param {{ hid: HidSysteem|null, reden?: string|null, instellingen: any, klok: Klok, intervalMs?: number,
   *   logboek?: Logboek|null, led?: { per_burst: number, burst_ms: number } }} o
   *   instellingen: config.json → apparaten.maschine-mk2 (vid, pid, niet_exclusief, stil_ms, pads, encoder_drempel, led_max, per_burst)
   */
  constructor(o) {
    const cfg = o.instellingen ?? {};
    const vid = parseInt(String(cfg.vid ?? ''), 16), pid = parseInt(String(cfg.pid ?? ''), 16);
    const geldig = Number.isFinite(vid) && Number.isFinite(pid);
    const hid = geldig ? o.hid : null;
    super({
      dev: 'maschine-mk2', klok: o.klok, logboek: o.logboek, intervalMs: o.intervalMs,
      // HID-schrijven is synchroon (een schermstuk is 265 bytes): minder rapporten per burst dan de MIDI-controllers.
      led: { per_burst: typeof cfg.per_burst === 'number' && cfg.per_burst >= 1 ? cfg.per_burst : 4, burst_ms: o.led?.burst_ms ?? 4 },
      // Een HID-opsomming is een USB-ronde: alleen in de gewone hotplug-ronde, niet elke 250 ms. Uittrekken ziet de
      // poort zelf (een leesfout: levend() false).
      lijstMs: o.intervalMs ?? 2000,
      zoek: () => {
        const naam = hid ? hid.zoek(vid, pid) : null;
        // Was hij bezet en is hij nu weg (uitgetrokken): weer 'zoekt', en een volgende 'bezet' krijgt weer een regel.
        if (!naam && this.status === 'bezet') { this.gemeld.openen = false; this.#zetStatus('zoekt', null); }
        return naam;
      },
      open: (naam) => /** @type {any} */ (/** @type {HidSysteem} */ (hid).open(naam, { nietExclusief: cfg.niet_exclusief === true })),
    });
    this.hid = hid;
    /** VID/PID uit config.json (null als die ontbreken of geen hex zijn). */
    this.vid = geldig ? vid : null;
    this.pid = geldig ? pid : null;
    this.vidPid = geldig ? `${cfg.vid}:${cfg.pid}`.toLowerCase() : null;
    this.geenHid = hid ? null : (geldig ? (o.reden ?? 'geen HID') : 'geen vid/pid in config.json (apparaten.maschine-mk2)');
    this.inst = {
      pads: { ...MS.STANDAARD.pads, ...(cfg.pads ?? {}) },
      encoder_drempel: typeof cfg.encoder_drempel === 'number' ? cfg.encoder_drempel : MS.STANDAARD.encoder_drempel,
      stilMs: typeof cfg.stil_ms === 'number' ? cfg.stil_ms : 2000,
    };
    this.leds = new MS.MaschineLeds({ led_max: typeof cfg.led_max === 'number' ? cfg.led_max : MS.STANDAARD.led_max });
    /** @type {Uint8Array[]} */
    this.schermen = [MS.leegScherm(), MS.leegScherm()];
    /** Per scherm, per stuk: wat er al op de draad ging. @type {(string|null)[][]} */
    this.schermVerstuurd = [Array(8).fill(null), Array(8).fill(null)];
    this.knopStaat = MS.nieuweKnopStaat();
    this.padStaten = MS.nieuwePadStaten();
    /** Rapporten sinds het laatste (her)aansluiten; padrapporten die nog onverkort het logboek in moeten. */
    this.frames = 0;
    this.ruw = 0;
    this.onbekend = 0;
    /** @type {'geen-hid'|'zoekt'|'bezet'|'verbonden'|'geen-invoer'} */
    this.status = hid ? 'zoekt' : 'geen-hid';
    /** @type {string|null} */
    this.statusReden = this.geenHid;
    /** @type {any} */ this.planTimer = null;
    /** @type {any} */ this.waakTimer = null;
    this.bij('fout', (/** @type {Error} */ e, /** @type {string} */ soort) => { if (soort === 'openen') this.#zetStatus('bezet', e?.message ?? String(e)); });
    this.bij('weg', () => { this.#wisWaak(); this.#zetStatus('zoekt', null); });
  }
  /** Naam voor mensen: het product (node-hid), anders het pad. */
  get naam() { return /** @type {any} */ (this.poort)?.product ?? this.poort?.naam ?? null; }
  start() { if (this.hid) super.start(); }
  stop() {
    super.stop();
    this.#wisWaak();
    if (this.planTimer !== null) this.klok.wis(this.planTimer);
    this.planTimer = null;
  }
  /** @param {'geen-hid'|'zoekt'|'bezet'|'verbonden'|'geen-invoer'} s @param {string|null} [reden] */
  #zetStatus(s, reden = null) {
    if (this.status === s && this.statusReden === reden) return;
    this.status = s;
    this.statusReden = reden;
    this.logboek?.regel('melding', { dev: this.dev, wat: 'status', status: s, ...(reden ? { reden } : {}) });
    this.meld('status', s, reden);
  }
  #wisWaak() { if (this.waakTimer !== null) this.klok.wis(this.waakTimer); this.waakTimer = null; }

  /** (Her)aangesloten: tellers en staat van voren af aan, alles opnieuw tekenen, en kijken of er invoer komt. */
  bijAansluiten() {
    const p = this.poort;
    this.knopStaat = MS.nieuweKnopStaat();
    this.padStaten = MS.nieuwePadStaten();
    this.frames = 0;
    this.gemeld.invoer = false;
    this.#zetStatus('verbonden', null);
    this.leds.vergeet();
    this.schermVerstuurd = [Array(8).fill(null), Array(8).fill(null)];
    this.#spoel();
    this.#wisWaak();
    this.waakTimer = this.klok.zet(() => {
      this.waakTimer = null;
      if (this.poort !== p || this.frames > 0) return;
      this.#zetStatus('geen-invoer', null);
      this.storing(new Error('open, maar er komt geen enkel rapport binnen'), 'invoer');
    }, this.inst.stilMs);
  }

  /** Eén HID-rapport. @param {Uint8Array|number[]} f */
  bijBinnen(f) {
    this.frames++;
    if (this.status === 'geen-invoer') { this.gemeld.invoer = false; this.#zetStatus('verbonden', null); }
    this.meld('rapport', f);
    /** @type {number[][]} */
    let midi = [];
    if (f[0] === MS.RAPPORT.knoppen) {
      const r = MS.knoppenStap(this.knopStaat, f, this.inst);
      this.knopStaat = r.staat;
      midi = r.midi;
      this.#logRuw(f);
    } else if (f[0] === MS.RAPPORT.pads) {
      const r = MS.padsStap(this.padStaten, f, this.klok.nu(), this.inst.pads);
      this.padStaten = r.staten;
      midi = r.midi;
      if (this.ruw > 0) { this.ruw--; this.#logRuw(f); }
      else if (midi.length) this.#logRuw(f);
    } else if (++this.onbekend <= 20) this.#logRuw(f);   // onbekende rapporten: de eerste paar, voor de proef
    for (const m of midi) {
      const g = MS.ontleedMidi(m);
      this.logboek?.midi('in', 'maschine-mk2-midi', m);
      this.logboek?.regel('gebeurtenis', g);
      this.meld('gebeurtenis', g, m);
    }
  }
  /** @param {Uint8Array|number[]} f */
  #logRuw(f) {
    if (!this.logboek) return;
    const b = Array.from(f);
    this.logboek.midi('in', this.dev, b);
    this.logboek.regel('gebeurtenis', MS.ontleedRapport(b));
  }
  /** De volgende n padrapporten onverkort in het logboek (de rustopname van de proef). @param {number} n */
  neemRuwOp(n) { this.ruw = Math.max(0, Math.floor(n)); }
  /** Schermen niet byte voor byte in het logboek: welk scherm en welk stuk is genoeg. @param {number[]} b */
  logUit(b) {
    if ((b[0] & 0xfe) === MS.RAPPORT.scherm) this.logboek?.regel('uit', { dev: this.dev, scherm: b[0] & 1, stuk: b[3] / 8 });
    else super.logUit(b);
  }

  // ── het speeloppervlak (de kern, §17) ──────────────────────────────────────

  /** Eén virtueel MIDI-bericht van de app die speelt (noot aan/uit = lampje). @param {number[]} m */
  led(m) { if (this.leds.midi(m)) this.#plan(); }
  /** @param {0|1} nr @param {ArrayLike<number>} data 2048 bytes */
  scherm(nr, data) {
    if (nr !== 0 && nr !== 1) return;
    this.schermen[nr] = Uint8Array.from({ length: MS.SCHERM.bytes }, (_, i) => data[i] ?? 0);
    this.#plan();
  }
  /** Alle lampjes uit en beide schermen leeg. */
  leeg() { this.leds.uit(); this.schermen = [MS.leegScherm(), MS.leegScherm()]; this.#plan(); }
  /** Toon wat er in `leds` (MaschineLeds) gezet is: voor de proef, die lampjes ook rechtstreeks zet. */
  toon() { this.#plan(); }
  /** Nu versturen wat er klaarstaat; belooft als alles over de draad is (de proef meet zo hoe lang schrijven duurt). */
  spoelNu() {
    if (this.planTimer !== null) { this.klok.wis(this.planTimer); this.planTimer = null; }
    this.#spoel();
    return this.rij.leeg();
  }
  #plan() {
    if (this.planTimer !== null) return;
    this.planTimer = this.klok.zet(() => { this.planTimer = null; this.#spoel(); }, 0);
  }
  #spoel() {
    if (!this.poort) return;   // niet aangesloten: het model wacht tot bijAansluiten (dan gaat alles)
    for (const r of this.leds.rapporten()) this.stuur(r);
    for (const nr of /** @type {const} */ ([0, 1])) {
      MS.schermRapporten(nr, this.schermen[nr]).forEach((stuk, i) => {
        const k = stuk.join(',');
        if (this.schermVerstuurd[nr][i] === k) return;
        this.schermVerstuurd[nr][i] = k;
        this.stuur(stuk);
      });
    }
  }
  /** Bij afsluiten: lampjes uit en schermen leeg (de panelen houden hun beeld vast), wachten tot het verstuurd is. */
  async uitEnWacht(maxMs = 500) {
    this.leeg();
    if (this.planTimer !== null) { this.klok.wis(this.planTimer); this.planTimer = null; }
    this.#spoel();
    /** @type {any} */ let h;
    await Promise.race([this.rij.leeg(), new Promise((r) => { h = this.klok.zet(() => r(undefined), maxMs); })]);
    this.klok.wis(h);
  }
}

/**
 * De controllers, met hotplug. APC40 en LPD8 altijd; de Xboard49 en de Maschine MK2 alleen als config.json ze noemt
 * (`apparaten.xboard49`, `apparaten.maschine-mk2`). De Maschine heeft een HID-systeem nodig (src/ports/hid.js);
 * zonder (`hid` null, `hidReden` waarom) bestaat de sessie wel, met status 'geen-hid'.
 * @param {{ systeem: Systeem, hid?: HidSysteem|null, hidReden?: string|null, klok: Klok, config: any, logboek?: Logboek|null,
 *   lpd8Profiel?: any, xboardProfiel?: any }} o
 */
export function maakApparaten({ systeem, hid = null, hidReden = null, klok, config, logboek = null, lpd8Profiel = null, xboardProfiel = null }) {
  const gemeen = { systeem, klok, logboek, intervalMs: config.hotplug_ms, led: config.led };
  const apc = new ApcSessie({ ...gemeen, dev: 'apc40', patroon: new RegExp(config.apparaten.apc40.naam, 'i'), modus: config.apparaten.apc40.modus });
  const lpd8 = new Lpd8Sessie({ ...gemeen, dev: 'lpd8', patroon: new RegExp(config.apparaten.lpd8.naam, 'i'), profiel: lpd8Profiel });
  const xbPatroon = XB.patroon(config);
  const xboard = xbPatroon ? new XboardSessie({ ...gemeen, patroon: xbPatroon, profiel: xboardProfiel }) : null;
  const mcfg = config.apparaten?.['maschine-mk2'];
  const maschine = mcfg ? new MaschineSessie({ hid, reden: hidReden, instellingen: mcfg, klok, logboek, intervalMs: config.hotplug_ms, led: config.led }) : null;
  /** @type {Record<string, Sessie|null>} */
  const perDev = { apc40: apc, lpd8, xboard49: xboard, 'maschine-mk2': maschine };
  return {
    apc, lpd8, xboard, maschine, systeem, hid,
    /** De sessie van een apparaat ('apc40', 'lpd8', 'xboard49', 'maschine-mk2'), of null. @param {string} dev */
    sessie: (dev) => perDev[dev] ?? null,
    start() { apc.start(); lpd8.start(); xboard?.start(); maschine?.start(); },
    /** LEDs uit (en de schermen van de Maschine leeg), poorten dicht. */
    async stop() {
      await Promise.all([apc.verbonden ? apc.zwartEnWacht() : null, maschine?.verbonden ? maschine.uitEnWacht() : null]);
      apc.stop(); lpd8.stop(); xboard?.stop(); maschine?.stop();
    },
  };
}
