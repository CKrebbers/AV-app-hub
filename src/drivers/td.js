// @ts-check
// TD-driver (driver.soort "td"): bespeelt een COMP in TouchDesigner over de exec-bridge van td-lab
// (`/td_bridge`, een Web Server DAT die Python uitvoert in TD's hoofddraad; td-lab/bridge/td_bridge.py).
// Geen regel code in td-lab: de hub spreekt de taal van de bridge (docs/VOLGENDE-KOPPELINGEN.md §6.3).
//
// Wat er over de draad gaat (het echte formaat van de bridge):
//   POST <url>/exec, body = Python-tekst (text/plain), antwoord ALTIJD HTTP 200 met JSON
//   {ok, stdout, result, error}. Een Python-fout is `ok:false` met de traceback in `error`; een
//   enkele expressie wordt ge-eval'd en komt terug in `result`. De bridge herlaadt td_bridge.py bij
//   elk verzoek; een tikfout daarin geeft geen JSON (of niets): dat telt als "niet gezond".
//
// - Per tik één batch: alle gewijzigde parameters in één `/exec`, hooguit max_hz per seconde en nooit
//   twee batches tegelijk onderweg (TD's hoofddraad mag niet vollopen). Laatste waarde wint.
// - Elke toewijzing staat in een eigen try: één hernoemde parameter houdt de rest niet tegen. Wat niet
//   lukte, meldt de batch terug (`varve-hub: niet gezet: …`); dat logt de driver één keer per parameter.
// - Gezondheid: elke gezond_s een expressie die de id van de COMP teruggeeft (alleen een geheel getal telt).
//   Gelukt → hartslag naar de kern. Geen COMP, geen JSON of geen antwoord → geen hartslag (de kern maakt de
//   app 'stil' en daarna 'weg').
// - Opnieuw aanmelden (de kern speelt alles opnieuw af, truth:"hub") na elke storing (een mislukte check of
//   een verloren batch), ook als de id gelijk bleef: TD kan intussen herstart zijn met dezelfde op-id.
//   De driver houdt zijn eigen `inst`: na een storing dezelfde (voor de kern een netwerkhapering: de waarden
//   gaan gewoon opnieuw, zonder slew vanaf de standaard), een nieuwe alleen bij een andere COMP-id
//   (`./td run scripts/genesis.py` herbouwde hem: TD staat echt op zijn standaard) en bij opnieuw().
// - Draait TD niet: opnieuw proberen met backoff (gezond_s, ×2, tot TD_BACKOFF_MAX_MS) en elke
//   verandering van toestand één keer in het log, niet bij elke poging.
// - Paniek: de waarden uit driver.paniek in één batch, meteen (ook als de laatste check misging), en als
//   `zet` aan de kern gemeld.
// - Een ongeldig COMP-pad of een ongeldige parameternaam gooit bij het maken (maakDriver); daarna gooit
//   de driver nooit meer: een TD die er niet is, mag de hub niet hinderen.
//
// driver = { soort:"td", comp:"/genesis", gezond_s?:2, max_hz?:10,
//            pars: { paramId: { par:"Speed", bereik?:[min,max] } | { puls:"Reseed" } },
//            paniek?: { paramId: 0..1 } }
// De poort staat alleen in config.json (huisregel 6): apps.<app>.poort, anders bekende_apps.<app>.tcp.
// Geen (geldige) poort → de driver start niet en zegt waarom.
import { DriverBasis, scheidStatisch, bewaarBegrensd } from './basis.js';
import { klem01, nieuweInst } from '../protocol/berichten.js';

/** @typedef {import('../protocol/types.js').NaarApp} NaarApp @typedef {import('../core/klok.js').Klok} Klok */
/** @typedef {{ par?: string, puls?: string, bereik?: [number, number] }} ParSpec */
/** @typedef {(url: string, init?: any) => Promise<any>} Fetch */
/** @typedef {{ ok: true, result: unknown } | { ok: false, fout: string, transport: boolean }} ExecUitslag */

/** Naam van een custom parameter in TD: hoofdletter, dan letters en cijfers. Alleen zulke namen komen in de Python. */
export const TD_PAR = /^[A-Z][A-Za-z0-9]*$/;
/** Pad van een COMP: `/naam` of `/a/b`, alleen letters, cijfers en _. */
export const TD_COMP = /^\/[A-Za-z_][A-Za-z0-9_]*(?:\/[A-Za-z_][A-Za-z0-9_]*)*$/;
/** Hoe lang een gezondheidscheck mag duren. gezond_s + time-out moet onder stil blijven (3 s × hb_s; valideerStatisch). */
export const TD_CHECK_TIMEOUT_MS = 1000;
/** Hoe lang een batch mag duren voor hij als mislukt telt (TD kan een frame of wat haperen). */
export const TD_EXEC_TIMEOUT_MS = 2000;
/** Langste wachttijd tussen twee pogingen als TD (of de COMP) er niet is. */
export const TD_BACKOFF_MAX_MS = 10000;
/** Zo herkent de driver in de traceback welke parameters niet gezet konden worden. */
const NIET_GEZET = /varve-hub: niet gezet: ([A-Za-z0-9,]+)/;

/** Getal als Python-literal: 6 decimalen, geen -0. @param {number} x */
export function pyGetal(x) {
  const r = Math.round(x * 1e6) / 1e6;
  return Object.is(r, -0) ? '0' : String(r);
}

/**
 * De Python-waarde voor één parameter, of null (niets te zetten). Puur, voor driver en tests.
 * - waarde: bereik[0] + v·(bereik[1]-bereik[0]) (standaard 0..1)
 * - schakelaar: True/False (v ≥ 0.5)
 * - keuze: menuIndex = round(v·(n-1))
 * @param {ParSpec} spec @param {{ soort: string, keuzes?: string[] }} param @param {number} v
 * @returns {{ par: string, attr: 'val'|'menuIndex', py: string } | null}
 */
export function tdToewijzing(spec, param, v) {
  if (!spec?.par || !TD_PAR.test(spec.par) || !Number.isFinite(v)) return null;
  const x = klem01(v);
  if (param.soort === 'schakelaar') return { par: spec.par, attr: 'val', py: x >= 0.5 ? 'True' : 'False' };
  if (param.soort === 'keuze') {
    const n = Array.isArray(param.keuzes) ? param.keuzes.length : 2;
    return { par: spec.par, attr: 'menuIndex', py: String(Math.round(x * (n - 1))) };
  }
  if (param.soort !== 'waarde') return null;
  const [lo, hi] = Array.isArray(spec.bereik) ? spec.bereik : [0, 1];
  return { par: spec.par, attr: 'val', py: pyGetal(lo + x * (hi - lo)) };
}

/**
 * De Python van één batch. Begint met de COMP (geen COMP = fout, niets half toegepast), elke toewijzing
 * in een eigen try, en eindigt met een fout als er iets niet lukte (zo telt de batch als mislukt).
 * Namen die niet door TD_PAR komen, worden overgeslagen (er komt nooit tekst van buiten in de Python).
 * @param {string} comp @param {{ par: string, attr: 'val'|'menuIndex', py: string }[]} zetten @param {string[]} pulsen
 */
export function tdBatch(comp, zetten, pulsen) {
  if (!TD_COMP.test(comp)) throw new Error(`ongeldig COMP-pad: ${comp}`);
  const r = [
    `_hub_c = op('${comp}')`,
    `if _hub_c is None: raise RuntimeError('varve-hub: geen COMP ${comp}')`,
    '_hub_fout = []',
    'def _hub_par(n):',
    '    p = getattr(_hub_c.par, n, None)',
    '    if p is None: raise AttributeError(n)',
    '    return p',
  ];
  for (const z of zetten) {
    if (!TD_PAR.test(z.par) || (z.attr !== 'val' && z.attr !== 'menuIndex') || !/^(True|False|-?[0-9.e+-]+)$/.test(z.py)) continue;
    r.push(`try: _hub_par('${z.par}').${z.attr} = ${z.py}`, `except Exception: _hub_fout.append('${z.par}')`);
  }
  for (const p of pulsen) {
    if (!TD_PAR.test(p)) continue;
    r.push(`try: _hub_par('${p}').pulse()`, `except Exception: _hub_fout.append('${p}')`);
  }
  r.push("if _hub_fout: raise RuntimeError('varve-hub: niet gezet: ' + ','.join(_hub_fout))");
  return r.join('\n');
}

/** De gezondheidscheck: één expressie (de bridge eval't hem), id van de COMP of None. @param {string} comp */
export function tdCheck(comp) {
  if (!TD_COMP.test(comp)) throw new Error(`ongeldig COMP-pad: ${comp}`);
  return `(lambda c: c.id if c is not None else None)(op('${comp}'))`;
}

const isPoort = (/** @type {unknown} */ p) => Number.isInteger(p) && /** @type {number} */ (p) > 0 && /** @type {number} */ (p) < 65536;

/**
 * Waar de bridge luistert. Alleen config.json (huisregel 6): apps.<app>.poort, anders bekende_apps.<app>.tcp.
 * Geen geldige poort → url null en een melding (de driver start dan niet; geen stille terugval).
 * @param {string} app @param {any} config
 * @returns {{ url: string, melding?: undefined } | { url: null, melding: string }}
 */
export function tdUrl(app, config) {
  const eigen = config?.apps?.[app]?.poort;
  if (isPoort(eigen)) return { url: `http://127.0.0.1:${eigen}` };
  if (eigen !== undefined) return { url: null, melding: `config.json → apps.${app}.poort (${JSON.stringify(eigen)}) is geen poort (een getal 1..65535): driver start niet` };
  const bekend = config?.bekende_apps?.[app]?.tcp;
  if (isPoort(bekend)) return { url: `http://127.0.0.1:${bekend}` };
  return { url: null, melding: `geen poort in config.json (bekende_apps.${app}.tcp of apps.${app}.poort): driver start niet` };
}

/** Stuurtekens (ook ANSI-escapes) eruit: tekst van de andere kant komt zo in het log. @param {unknown} e */
const schoon = (e) => String(e ?? '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
/** De laatste regel van een traceback (of de tekst zelf), kort en zonder stuurtekens. @param {unknown} e */
export const kort = (e) => schoon(e).trim().split('\n').map((r) => r.replace(/\t/g, ' ').trim()).filter(Boolean).pop()?.slice(0, 200) ?? '';

export class TdDriver extends DriverBasis {
  /**
   * @param {Record<string, any>} statisch
   * @param {{ klok: Klok, fetch?: Fetch, config?: any, log?: (...a: unknown[]) => void }} o
   */
  constructor(statisch, { klok, fetch = globalThis.fetch, config, log }) {
    const { manifest, driver } = scheidStatisch(statisch);
    super({ manifest, klok, log });
    this.driver = driver;
    this.fetch = fetch;
    // Wat in de Python komt, eerst gecontroleerd (ook buiten valideerStatisch om): hier gooien, niet later in een timer.
    if (typeof driver.comp !== 'string' || !TD_COMP.test(driver.comp)) throw new Error(`${manifest.app}: ongeldig COMP-pad: ${String(driver.comp)}`);
    /** @type {Set<string>} alle TD-namen uit driver.pars (alleen die mogen terugkomen in 'niet gezet') */
    this.tdNamen = new Set();
    for (const [id, spec] of Object.entries(driver.pars ?? {})) {
      const naam = /** @type {any} */ (spec)?.par ?? /** @type {any} */ (spec)?.puls;
      if (typeof naam !== 'string' || !TD_PAR.test(naam)) throw new Error(`${manifest.app}: driver.pars.${id}: ongeldige TD-parameter`);
      this.tdNamen.add(naam);
    }
    const { url, melding } = tdUrl(manifest.app, config);
    /** @type {string|null} null = geen poort in config.json: start() doet niets */
    this.url = url;
    this.poortMelding = melding ?? null;
    if (melding) this.log('driver', manifest.app, melding);
    this.comp = driver.comp;
    /** @type {string|null} de inst waarmee de driver zich aanmeldt (null = nog nooit aangemeld) */
    this.inst = null;
    this.gezondMs = (driver.gezond_s ?? 2) * 1000;
    this.minAfstandMs = 1000 / (driver.max_hz ?? 10);
    /** @type {Map<string, any>} */
    this.params = new Map((manifest.params ?? []).map((/** @type {any} */ p) => [p.id, p]));
    /** @type {Map<string, { par: string, attr: 'val'|'menuIndex', py: string }>} wat de volgende batch zet, per TD-parameter */
    this.wachtend = new Map();
    /** @type {Set<string>} pulsen voor de volgende batch */
    this.pulsen = new Set();
    this.laatstOp = -Infinity;
    /** @type {any} */
    this.flushTimer = null;
    /** batches die nu onderweg zijn (een paniek mag naast een gewone batch) */
    this.inVlucht = 0;
    /** null = nog onbekend; true = bridge én COMP gezond; false = niet (geen bridge, geen COMP of kapot) */
    this.bereikbaar = /** @type {boolean|null} */ (null);
    /** id van de COMP bij de laatste gezonde check (een andere id = herbouwd) */
    this.compId = /** @type {unknown} */ (null);
    /** een batch ging verloren sinds de laatste gezonde check → bij herstel opnieuw aanmelden (replay) */
    this.gemist = false;
    /** aantal mislukte checks op rij (backoff) */
    this.missers = 0;
    /** @type {'gezond'|'geen-comp'|'weg'|null} laatst gemelde toestand (alleen een verandering komt in het log) */
    this.toestand = null;
    /** @type {Set<string>} TD-parameters die niet gezet konden worden (één keer gemeld) */
    this.kapot = new Set();
    this.batchFouten = 0;
    /** @type {any} */
    this.checkTimer = null;
    this.checkBezig = false;
    /** @type {Map<any, { ac: AbortController|null, einde: (u: ExecUitslag) => void }>} lopende verzoeken, per time-out-handle */
    this.lopend = new Map();
    /** @type {any[]} */
    this.meldTimers = [];
    /** verhoogd bij elke start en stop: een antwoord uit een vorige ronde telt niet meer */
    this.ronde = 0;
    this.gestopt = true;
    /** @type {string[]} alle verstuurde batches (diagnose/tests; begrensd) */
    this.verstuurd = [];
  }

  /** Wachttijd tot de volgende check: gezond_s, en bij missers ×2 tot TD_BACKOFF_MAX_MS. */
  get wachtMs() {
    if (this.missers <= 1) return this.gezondMs;
    return Math.min(TD_BACKOFF_MAX_MS, this.gezondMs * 2 ** (this.missers - 1));
  }

  /**
   * Eén POST /exec. Lost altijd op (nooit een fout): `ok:true` alleen bij geldige JSON met ok:true.
   * `transport: true` = geen (bruikbaar) antwoord van de bridge; false = de bridge antwoordde met ok:false.
   * @param {string} code @param {number} timeoutMs @returns {Promise<ExecUitslag>}
   */
  #exec(code, timeoutMs) {
    return new Promise((resolve) => {
      let klaar = false;
      const ac = typeof AbortController === 'function' ? new AbortController() : null;
      /** @param {ExecUitslag} u */
      const einde = (u) => {
        if (klaar) return;
        klaar = true;
        if (this.lopend.delete(timer)) this.klok.wis(timer);
        resolve(u);
      };
      const timer = this.klok.zet(() => {
        this.lopend.delete(timer);
        ac?.abort();
        einde({ ok: false, fout: `geen antwoord binnen ${timeoutMs} ms`, transport: true });
      }, timeoutMs);
      this.lopend.set(timer, { ac, einde });
      let p;
      try {
        p = this.fetch(`${this.url}/exec`, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: code, ...(ac ? { signal: ac.signal } : {}) });
      } catch (e) { einde({ ok: false, fout: foutTekst(e), transport: true }); return; }
      Promise.resolve(p).then(async (r) => {
        if (!r || r.ok === false) return einde({ ok: false, fout: `HTTP ${r?.status ?? '?'}`, transport: true });
        let tekst = '';
        try { tekst = typeof r.text === 'function' ? await r.text() : ''; } catch { return einde({ ok: false, fout: 'antwoord onleesbaar', transport: true }); }
        /** @type {any} */
        let j;
        try { j = JSON.parse(tekst); } catch { return einde({ ok: false, fout: tekst ? 'geen JSON van de bridge' : 'leeg antwoord van de bridge', transport: true }); }
        if (!j || typeof j !== 'object') return einde({ ok: false, fout: 'geen JSON-object van de bridge', transport: true });
        if (j.ok !== true) return einde({ ok: false, fout: kort(j.error) || 'ok:false', transport: false });
        einde({ ok: true, result: j.result });
      }, (e) => einde({ ok: false, fout: foutTekst(e), transport: true }));
    });
  }

  // ── waarden naar TD ──────────────────────────────────────────────────────

  /** Plan de volgende batch: hooguit max_hz per seconde, en niet zolang er een onderweg is. */
  #plan() {
    if (this.gestopt || this.flushTimer !== null || this.inVlucht > 0) return;
    if (!this.wachtend.size && !this.pulsen.size) return;
    // altijd via de klok (ook bij 0 ms): alles wat de kern in één keer stuurt (replay, snapshot) wordt één batch
    this.flushTimer = this.klok.zet(() => { this.flushTimer = null; this.#flush(); }, Math.max(0, this.laatstOp + this.minAfstandMs - this.klok.nu()));
  }

  /** @param {boolean} [altijd] ook sturen als de laatste check misging (paniek: liever één verzoek te veel dan geen zwart) */
  #flush(altijd = false) {
    if (this.gestopt || (!this.wachtend.size && !this.pulsen.size)) return;
    const zetten = [...this.wachtend.values()], pulsen = [...this.pulsen];
    this.wachtend.clear();
    this.pulsen.clear();
    // TD of de COMP is er niet: niet sturen (geen stapel verzoeken); bij herstel speelt de kern alles opnieuw af.
    if (this.bereikbaar === false && !altijd) { this.gemist = true; return; }
    this.laatstOp = this.klok.nu();
    this.#stuurBatch(tdBatch(this.comp, zetten, pulsen), zetten.map((z) => z.par).concat(pulsen));
  }

  /** @param {string} code @param {string[]} namen */
  async #stuurBatch(code, namen) {
    const ronde = this.ronde;
    this.inVlucht++;
    bewaarBegrensd(this.verstuurd, code);
    const u = await this.#exec(code, TD_EXEC_TIMEOUT_MS);
    if (ronde !== this.ronde) return; // intussen gestopt
    this.inVlucht--;
    if (u.ok) {
      for (const n of namen) this.kapot.delete(n);
      if (this.batchFouten > 1) this.log('driver', this.manifest.app, `weer verbonden; ${this.batchFouten} batches gingen verloren (de kern speelt alles opnieuw af)`);
      this.batchFouten = 0;
    } else {
      const deels = u.transport ? null : NIET_GEZET.exec(u.fout);
      if (deels) {
        // De rest van de batch is gezet; opnieuw afspelen helpt niet voor een parameter die niet bestaat.
        // alleen namen die de driver zelf stuurt (TD_PAR en driver.pars): `kapot` blijft begrensd, het log schoon
        const nieuw = deels[1].split(',').filter((n) => TD_PAR.test(n) && this.tdNamen.has(n) && !this.kapot.has(n));
        for (const n of nieuw) this.kapot.add(n);
        if (nieuw.length) this.log('driver', this.manifest.app, `${this.comp}: parameter ${nieuw.join(', ')} niet te zetten (hernoemd of weg? kijk apps/${this.manifest.app}.json → driver.pars na)`);
      } else {
        this.gemist = true;
        if (u.transport) this.bereikbaar = false; // pas weer sturen na een gezonde check
        if (++this.batchFouten === 1) this.log('driver', this.manifest.app, `batch mislukt: ${u.fout}`);
      }
    }
    this.#plan();
  }

  /** @param {string} id @param {number} v */
  #zet(id, v) {
    const spec = this.driver.pars?.[id];
    const p = this.params.get(id);
    if (!spec || !p || !Number.isFinite(v)) return;
    if (p.soort === 'trigger') { this.#trig(id, v >= 0.5); return; }
    const z = tdToewijzing(spec, p, v);
    if (!z) return;
    this.wachtend.set(z.par, z);
    this.#plan();
  }

  /** @param {string} id @param {boolean} aan */
  #trig(id, aan) {
    if (!aan || !this.params.has(id)) return; // pulsen zijn momenten: alleen bij indrukken
    if (id === 'paniek') { this.#paniek(); return; }
    const puls = this.driver.pars?.[id]?.puls;
    if (typeof puls !== 'string' || !TD_PAR.test(puls)) return;
    this.pulsen.add(puls);
    this.#plan();
  }

  /** Paniek: de waarden uit driver.paniek meteen (niet wachten op max_hz), en als `zet` aan de kern melden. */
  #paniek() {
    /** @type {[string, number][]} */
    const gemeld = [];
    for (const [id, v] of Object.entries(this.driver.paniek ?? {})) {
      const p = this.params.get(id);
      const z = p && p.soort !== 'trigger' ? tdToewijzing(this.driver.pars?.[id], p, Number(v)) : null;
      if (!z) continue;
      this.wachtend.set(z.par, z);
      gemeld.push([id, klem01(Number(v))]);
    }
    const puls = this.driver.pars?.paniek?.puls;
    if (typeof puls === 'string' && TD_PAR.test(puls)) this.pulsen.add(puls);
    if (this.flushTimer !== null) { this.klok.wis(this.flushTimer); this.flushTimer = null; }
    this.#flush(true);
    if (!gemeld.length) return;
    // De app veranderde "zelf": zo volgen waarden, ringen en pickup. Uitgesteld: we zitten midden in een bericht van de kern.
    const h = this.klok.zet(() => {
      this.meldTimers = this.meldTimers.filter((x) => x !== h);
      if (!this.kern) return;
      for (const [id, v] of gemeld) this.kern.ontvang(this.verbinding, { t: 'zet', id, v });
    }, 0);
    this.meldTimers.push(h);
  }

  /** @param {NaarApp} b */
  vertaal(b) {
    if (b.t === 'zet') this.#zet(b.id, b.v);
    else if (b.t === 'trig') this.#trig(b.id, b.aan === true);
    // welkom, scene, focus, globaal, midi, fout: niets voor TD
  }

  // ── gezondheid ───────────────────────────────────────────────────────────

  /** @param {'gezond'|'geen-comp'|'weg'} t @param {string} [waarom] */
  #meld(t, waarom = '') {
    if (t === this.toestand) return;
    this.toestand = t;
    const app = this.manifest.app;
    if (t === 'weg') this.log('driver', app, `bridge niet bereikbaar op ${this.url}${metReden(waarom)} — opnieuw met backoff (tot ${TD_BACKOFF_MAX_MS / 1000} s). Draait TouchDesigner met /td_bridge? (docs/TDLAB.md)`);
    else if (t === 'geen-comp') this.log('driver', app, `bridge draait, maar ${this.comp} bestaat niet (nog niet gebouwd? ./td run scripts/genesis.py)`);
    else this.log('driver', app, `verbonden met ${this.comp} via ${this.url}`);
  }

  /** Eén gezondheidscheck. Geeft een belofte die nooit faalt (voor tests). */
  async controleer() {
    if (this.checkBezig || this.gestopt) return;
    const ronde = this.ronde;
    this.checkBezig = true;
    const u = await this.#exec(tdCheck(this.comp), TD_CHECK_TIMEOUT_MS);
    if (ronde !== this.ronde) return; // intussen gestopt (en misschien opnieuw gestart): deze uitslag telt niet
    this.checkBezig = false;
    const id = u.ok ? u.result : null;
    // Alleen een geheel getal is een COMP-id; iets anders (een object, tekst) komt niet van deze check.
    if (!u.ok || !Number.isInteger(id)) {
      this.missers++;
      this.bereikbaar = false;
      if (!u.ok) this.#meld('weg', u.fout);
      else if (id === null || id === undefined) this.#meld('geen-comp');
      else this.#meld('weg', 'antwoord is geen COMP-id; draait er iets anders op deze poort?');
      return;
    }
    this.missers = 0;
    const vorig = this.compId, was = this.bereikbaar;
    this.bereikbaar = true;
    this.compId = id;
    this.#meld('gezond');
    const herbouwd = vorig !== null && id !== vorig;
    if (herbouwd) this.log('driver', this.manifest.app, `${this.comp} is herbouwd: de hub speelt alles opnieuw af`);
    if (herbouwd || was === false || this.gemist) {
      // Terug na een storing of een rebuild: opnieuw aanmelden, zodat de kern (truth:"hub") alles opnieuw afspeelt.
      // Ook bij dezelfde id na een storing: TD kan intussen herstart zijn (de .toe opnieuw geopend). Een nieuwe inst
      // alleen na een rebuild; anders ziet de kern een hapering en stuurt hij de waarden zonder slew vanaf de standaard.
      this.gemist = false;
      this.aanmelden(herbouwd);
    }
    this.hartslag();
    this.#plan(); // wat tijdens de storing wachtte (een paniek, een zet) gaat nu
  }

  /**
   * Meld de app aan bij de kern (hallo + manifest). De driver houdt zijn eigen inst: dezelfde = voor de kern een
   * netwerkhapering (waarden opnieuw, zonder slew); een nieuwe = TD staat weer op zijn standaard (PROTOCOL §10).
   * @param {boolean} [nieuw] een nieuwe inst (na een rebuild of een herstart van TD)
   */
  aanmelden(nieuw = false) {
    if (!this.kern) return;
    if (nieuw || this.inst === null) this.inst = nieuweInst();
    this.kern.ontvang(this.verbinding, { t: 'hallo', app: this.manifest.app, inst: this.inst, v: 1 });
    this.kern.ontvang(this.verbinding, { t: 'manifest', manifest: this.manifest });
  }

  /** Laat de kern alles opnieuw afspelen, vanaf de standaard (bijv. na een herstart van TD). */
  opnieuw() { if (this.kern) this.aanmelden(true); }

  /** Check, en daarna de volgende inplannen (met backoff als het misging). */
  #rondeCheck() {
    const ronde = this.ronde;
    const verder = () => {
      if (ronde !== this.ronde || this.gestopt) return;
      this.checkTimer = this.klok.zet(() => { this.checkTimer = null; this.#rondeCheck(); }, this.wachtMs);
    };
    this.controleer().then(verder, (e) => {
      // hoort niet te gebeuren (controleer faalt nooit), maar een unhandled rejection zou de hub stoppen
      if (ronde === this.ronde) this.checkBezig = false;
      this.log('driver', this.manifest.app, `check mislukt: ${kort(e?.message ?? e)}`);
      verder();
    });
  }

  /** @param {import('./basis.js').KernVoorDriver} kern */
  start(kern) {
    if (!this.gestopt) return; // loopt al: geen tweede timerketen
    if (this.url === null) { this.log('driver', this.manifest.app, `niet gestart: ${this.poortMelding} (docs/TDLAB.md)`); return; }
    this.gestopt = false;
    this.ronde++;
    this.missers = 0;
    this.koppel(kern);
    this.#rondeCheck();
  }

  stop() {
    this.gestopt = true;
    this.ronde++;
    if (this.checkTimer !== null) this.klok.wis(this.checkTimer);
    this.checkTimer = null;
    if (this.flushTimer !== null) this.klok.wis(this.flushTimer);
    this.flushTimer = null;
    for (const h of this.meldTimers) this.klok.wis(h);
    this.meldTimers = [];
    for (const [h, l] of [...this.lopend]) { this.klok.wis(h); l.ac?.abort(); l.einde({ ok: false, fout: 'gestopt', transport: true }); }
    this.lopend.clear();
    this.checkBezig = false;
    this.inVlucht = 0;
    this.wachtend.clear();
    this.pulsen.clear();
    this.ontkoppel();
  }
}

/** Kort en bruikbaar: fetch van Node zegt alleen "fetch failed"; de echte reden (ECONNREFUSED) zit in cause. @param {any} e */
function foutTekst(e) { return kort(e?.cause?.code ?? e?.code ?? e?.message ?? e); }

/** ` (reden)` of niets. @param {string} w */
function metReden(w) { return w ? ` (${w})` : ''; }
