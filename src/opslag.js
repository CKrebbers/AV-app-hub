// @ts-check
// Geheugen op schijf: de snapshots en de waarden van apps met truth:"hub" over een herstart van de hub heen.
// De kern geeft en neemt de inhoud (`exporteer`/`importeer`, puur) en meldt 'geheugen' bij elke wijziging;
// hier wordt dat gelezen bij de start en gedebounced (hooguit één keer per `schrijf_ms`) atomisch weggeschreven:
// eerst een tijdelijk bestand, dat met fsync echt op schijf staat, dan rename. Zo staat er na een crash of
// stroomstoring het oude of het nieuwe bestand, nooit een half of leeg (gaat de rename zelf bij stroomverlies
// verloren, dan staat er de vorige versie).
// Pad uit config.json (`geheugen.pad`, `~` = thuismap); $VARVE_HUB_STAAT gaat voor (zoals $VARVE_HUB_CONFIG).
import * as nodeFs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir, uptime } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

export const SCHRIJF_MS = 1000;

/**
 * @typedef {Pick<typeof nodeFs, 'readFileSync' | 'writeFileSync' | 'renameSync' | 'mkdirSync' | 'rmSync'
 *   | 'openSync' | 'fsyncSync' | 'closeSync' | 'copyFileSync' | 'readdirSync'>} Bestanden
 */

/**
 * Waar het geheugen staat, of null (uit).
 * @param {any} config @param {{ env?: Record<string, string|undefined>, thuis?: string }} [o]
 * @returns {string|null}
 */
export function geheugenPad(config, { env = process.env, thuis = homedir() } = {}) {
  const p = env.VARVE_HUB_STAAT || config?.geheugen?.pad;
  if (typeof p !== 'string' || !p) return null;
  if (p === '~') return thuis;
  return p.startsWith('~/') ? join(thuis, p.slice(2)) : resolve(p);
}

/**
 * Hoe vaak er hooguit geschreven wordt: `geheugen.schrijf_ms` uit config, maar nooit vaker dan eens per seconde.
 * Geen eindig getal (bv. "1s") → de standaard.
 * @param {any} config @returns {number}
 */
export function schrijfMsUit(config) {
  const ms = config?.geheugen?.schrijf_ms;
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.max(SCHRIJF_MS, ms) : SCHRIJF_MS;
}

/**
 * Lees het geheugen. Ontbreekt het, of is het kapot, dan `data: null` en een melding; een kapot bestand
 * wordt bewaard als `<pad>.kapot` (zodat de eerstvolgende keer schrijven het niet stilletjes wegveegt).
 * Is het er wel maar niet te lezen (geen rechten, een map, I/O-fout), dan net zo; lukt ook dat veiligstellen
 * niet, dan `schrijven: false`: liever deze sessie niets onthouden dan het oude geheugen overschrijven.
 * @param {string} pad @param {Bestanden} [fs]
 * @returns {{ data: unknown, melding: string|null, schrijven: boolean }}
 */
export function leesGeheugen(pad, fs = nodeFs) {
  let tekst;
  try { tekst = fs.readFileSync(pad, 'utf8'); } catch (e) {
    const fout = /** @type {{ code?: string, message: string }} */ (e);
    if (fout.code === 'ENOENT') return { data: null, melding: `nog geen geheugen (${pad}): de hub begint leeg`, schrijven: true };
    const bewaard = bewaarKapot(pad, fs);
    return {
      data: null, schrijven: bewaard !== '',
      melding: `geheugen ${pad} niet te lezen (${fout.message}): de hub begint leeg${bewaard
        || ' en schrijft deze sessie niets weg (anders gaat het oude geheugen verloren); kijk naar de rechten van dat bestand'}`,
    };
  }
  try { return { data: JSON.parse(tekst), melding: null, schrijven: true }; } catch (e) {
    return { data: null, melding: `geheugen ${pad} is kapot (${/** @type {Error} */ (e).message}): de hub begint leeg${bewaarKapot(pad, fs)}`, schrijven: true };
  }
}

/** @param {string} pad @param {Bestanden} fs */
function bewaarKapot(pad, fs) {
  try { fs.renameSync(pad, `${pad}.kapot`); return `; het oude bestand staat in ${pad}.kapot`; } catch { return ''; }
}

/** Een kopie als `.kapot` (het origineel blijft staan). @param {string} pad @param {Bestanden} fs */
function kopieKapot(pad, fs) {
  try { fs.copyFileSync(pad, `${pad}.kapot`); return `; het origineel staat in ${pad}.kapot`; } catch { return ''; }
}

/** Ruim tijdelijke bestanden van een eerder (gecrasht) proces op: `<naam>.<pid>.tmp` naast het pad. @param {string} pad @param {Bestanden} fs */
function ruimTmpOp(pad, fs) {
  const naam = basename(pad);
  let lijst;
  try { lijst = fs.readdirSync(dirname(pad)); } catch { return; }
  for (const f of lijst) {
    if (!f.startsWith(`${naam}.`) || !/^\d+\.tmp$/.test(f.slice(naam.length + 1))) continue;
    try { fs.rmSync(join(dirname(pad), f), { force: true }); } catch { /* laat staan */ }
  }
}

/**
 * Schrijf atomisch: tijdelijk bestand naast het echte, fsync, dan rename.
 * @param {string} pad @param {unknown} data @param {Bestanden} [fs]
 */
export function schrijfGeheugen(pad, data, fs = nodeFs) {
  fs.mkdirSync(dirname(pad), { recursive: true, mode: 0o700 });
  const tmp = `${pad}.${process.pid}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'w', 0o600);   // snapshots en waarden: alleen voor jou
    try {
      fs.writeFileSync(fd, JSON.stringify(data, null, 1) + '\n');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, pad);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* niets meer aan te doen */ }
    throw e;
  }
}

/**
 * Koppel een kern aan een geheugenbestand: nu lezen en importeren, daarna bij elke 'geheugen'-melding
 * hooguit eens per `schrijfMs` wegschrijven (alleen als er echt iets veranderde). `stop()` schrijft wat
 * nog wacht meteen weg.
 * @param {{
 *   kern: { exporteer: () => unknown, importeer: (d: unknown) => { ok: boolean, reden?: string, overgeslagen: number }, bij: (naam: string, fn: Function) => () => void },
 *   pad: string, klok: import('./core/klok.js').Klok, log?: (...a: unknown[]) => void, schrijfMs?: number, fs?: Bestanden,
 * }} o
 */
export function koppelGeheugen({ kern, pad, klok, log = () => {}, schrijfMs = SCHRIJF_MS, fs = nodeFs }) {
  ruimTmpOp(pad, fs);
  const { data, melding, schrijven } = leesGeheugen(pad, fs);
  if (melding) log('geheugen', melding);
  else {
    const r = kern.importeer(data);
    if (!r.ok) log('geheugen', `geheugen ${pad} onbruikbaar (${r.reden}): de hub begint leeg${bewaarKapot(pad, fs)}`);
    // Wat overgeslagen werd, valt bij de volgende keer schrijven weg: eerst een kopie van het origineel.
    else log('geheugen', `geladen uit ${pad}${r.overgeslagen ? ` (${r.overgeslagen} ongeldige onderdelen overgeslagen${kopieKapot(pad, fs)})` : ''}`);
  }
  let laatst = JSON.stringify(kern.exporteer());
  /** @type {any} */ let timer = null;
  let gestopt = false;
  /** @type {Error|null} */ let fout = null;

  const schrijf = () => {
    timer = null;
    if (!schrijven) return;
    const nu = kern.exporteer();
    const tekst = JSON.stringify(nu);
    if (tekst === laatst) return;
    try {
      schrijfGeheugen(pad, nu, fs);
      laatst = tekst;
      if (fout) { fout = null; log('geheugen', `${pad} weer bijgewerkt`); }
    } catch (e) {
      // Niet bij elke poging opnieuw melden; de volgende wijziging probeert het weer.
      if (!fout) {
        log('geheugen', `kan ${pad} niet schrijven (${/** @type {Error} */ (e).message}) — controleer of ${dirname(pad)} schrijfbaar is, `
          + 'of zet een ander pad in config.json → geheugen.pad (of $VARVE_HUB_STAAT). De hub werkt door, maar onthoudt niets.');
      }
      fout = /** @type {Error} */ (e);
    }
  };
  const plan = () => { if (!gestopt && schrijven && timer === null) timer = klok.zet(schrijf, schrijfMs); };
  const afmelden = [kern.bij('geheugen', plan)];

  return {
    pad,
    /** Schrijf nu (als er iets veranderde), los van de debounce. */
    schrijfNu() { if (timer !== null) { klok.wis(timer); timer = null; } schrijf(); },
    /** Niet meer luisteren; wat nog wacht gaat meteen naar schijf. */
    stop() {
      if (gestopt) return;
      gestopt = true;
      for (const f of afmelden) f();
      if (timer !== null) { klok.wis(timer); timer = null; }
      schrijf();
    },
  };
}

// ── Loopbestand: viel de vorige hub om? ─────────────────────────────────────────
// Naast het geheugen staat `<pad>.loopt` zolang de hub draait; bij netjes stoppen (Ctrl-C, SIGTERM, venster
// dicht) gaat het weg. Staat het er bij de start nog, en leeft dat proces niet meer, dan viel de vorige hub om
// (kill -9, een fout in de hub, stroom weg) — midden in een set. Erin: welke set, de processen die de set-starter
// startte en sinds wanneer (zodat een herstart ze niet dubbel start en ze bij Ctrl-C toch stopt), of de opname liep,
// en de slots en focus (kern.slotsEnFocus: alleen een herstart krijgt die terug, een gewone start begint leeg).
// Een loopbestand van vóór de laatste opstart van de computer (stroomstoring, geforceerde herstart, dagen later) is
// verlopen: de processen van toen bestaan niet meer, hun nummers zijn hergebruikt. Dan wordt alleen de afgebroken
// avond nog hersteld; de rest is een gewone start. Binnen dezelfde opstart wordt elk procesnummer nagekeken: begon dat
// proces niet rond het moment dat de vorige hub het startte, dan is het een ander proces en blijft het ongemoeid.
// Draait er nog een hub met hetzelfde geheugen (`ander`), dan raakt deze het loopbestand niet aan: het is van die hub.

/**
 * @typedef {{ v: 1, pid: number, begon: string, set: string|null, apps: Record<string, number>,
 *   sinds: Record<string, string>, opname: boolean, slots?: (string|null)[], focus?: string|null }} Loop
 */

/** Hoeveel het begin van een proces mag afwijken van wat het loopbestand zegt (ps rekent in hele seconden). */
export const SPELING_MS = 5000;

/** Pad van het loopbestand bij een geheugenpad. @param {string} geheugen */
export const loopPad = (geheugen) => `${geheugen}.loopt`;

/** Leeft proces `pid` nog? (signaal 0 stuurt niets.) @param {number} pid */
export function procesLeeft(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e)?.code === 'EPERM'; }
}

/** Wanneer de computer opstartte (ms sinds 1970), uit de uptime. */
export const opstartMoment = () => Date.now() - uptime() * 1000;

/**
 * Wanneer proces `pid` begon (ms sinds 1970, op ±1 s), of null als het niet bestaat of `ps` het niet zegt.
 * `ps -o etime=` werkt op macOS en Linux en hangt niet van de taal van het systeem af.
 * @param {number} pid
 */
export function procesSinds(pid) {
  try {
    const t = execFileSync('ps', ['-o', 'etime=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 2000 });
    const ms = etimeMs(t);
    return ms === null ? null : Date.now() - ms;
  } catch { return null; }
}

/** `[[dd-]hh:]mm:ss` (ps etime) → ms, of null. @param {string} tekst */
export function etimeMs(tekst) {
  const m = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)\s*$/.exec(tekst);
  if (!m) return null;
  const [d, h, min, sec] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0));
  return (((d * 24 + h) * 60 + min) * 60 + sec) * 1000;
}

/**
 * Lees het vorige loopbestand en schrijf het eigen.
 *   vorige: wat de omgevallen hub achterliet, voor een herstart (null: de vorige stopte netjes, er draait nog een hub
 *     met dit geheugen, of het loopbestand is van vóór de laatste opstart van de computer).
 *   omgevallen: { begon } als de vorige hub omviel (ook als het loopbestand verlopen is) — voor het herstel van
 *     zijn afgebroken avond; null als niet.
 *   verlopen: het loopbestand is van vóór de laatste opstart. ander: pid van een hub die nog draait met dit geheugen.
 *   vreemd: apps waarvan het procesnummer nu van een ander proces is (niet overnemen).
 * @param {{ pad: string, set?: string|null, pid?: number, datum?: () => Date, leeft?: (pid: number) => boolean,
 *   sindsVan?: (pid: number) => number|null, opstart?: () => number, fs?: Bestanden }} o
 */
export function openLoopbestand({
  pad, set = null, pid = process.pid, datum = () => new Date(), leeft = procesLeeft, sindsVan = procesSinds,
  opstart = opstartMoment, fs = nodeFs,
}) {
  ruimTmpOp(pad, fs);
  /** @type {any} */
  let ruw = null;
  try {
    const d = JSON.parse(fs.readFileSync(pad, 'utf8'));
    ruw = isObject(d) ? d : {};
  } catch (e) {
    // Weg = de vorige stopte netjes. Er wel maar kapot (half geschreven bij stroomverlies): toch omgevallen.
    if (/** @type {any} */ (e)?.code !== 'ENOENT') ruw = {};
  }
  /** @type {Partial<Loop> & { vreemd: Record<string, number> }|null} */
  let vorige = null;
  /** @type {number|null} */
  let ander = null;
  let verlopen = false;
  if (ruw) {
    const begon = typeof ruw.begon === 'string' ? Date.parse(ruw.begon) : NaN;
    if (Number.isFinite(begon) && begon < opstart()) verlopen = true;
    else if (typeof ruw.pid === 'number' && ruw.pid !== pid && leeft(ruw.pid)) {
      // Is dat proces de hub van toen? Een hergebruikt nummer begon pas na het omvallen, dus ná `begon`.
      const s = sindsVan(ruw.pid);
      if (s === null || !Number.isFinite(begon) || s <= begon + SPELING_MS) ander = ruw.pid;
    }
  }
  const omgevallen = ruw && ander === null ? { begon: typeof ruw.begon === 'string' ? ruw.begon : null } : null;
  if (ruw && ander === null && !verlopen) {
    const begon = Date.parse(ruw.begon);
    /** @type {Record<string, string>} */
    const sindsen = isObject(ruw.sinds) ? ruw.sinds : {};
    /** @type {Record<string, number>} */
    const apps = {};
    /** @type {Record<string, number>} */
    const vreemd = {};
    for (const [id, p] of Object.entries(isObject(ruw.apps) ? ruw.apps : {})) {
      if (!Number.isInteger(p) || p <= 1) continue;
      // Het proces dat de groep leidt (de shell van het startcommando): begon het toen de vorige hub het startte?
      // Bestaat het niet meer, dan kan het nummer van de groep niet hergebruikt zijn zolang de groep bestaat.
      const s = sindsVan(p);
      const toen = Date.parse(sindsen[id]);
      const goed = s === null
        || (Number.isFinite(toen) ? Math.abs(s - toen) <= SPELING_MS : !Number.isFinite(begon) || s >= begon - SPELING_MS);
      if (goed) apps[id] = p; else vreemd[id] = p;
    }
    vorige = {
      ...ruw, apps, vreemd, sinds: Object.fromEntries(Object.entries(sindsen).filter(([id, t]) => id in apps && typeof t === 'string')),
      opname: ruw.opname === true, set: typeof ruw.set === 'string' ? ruw.set : null,
    };
  }
  /** @type {Loop} */
  const nu = { v: 1, pid, begon: datum().toISOString(), set, apps: {}, sinds: {}, opname: false };
  // Van een andere hub: niet overschrijven en niet wissen (anders weet de volgende start niet dat díé omviel).
  let weg = ander !== null;
  /** @type {string|null} */
  let fout = null;
  const schrijf = () => {
    if (weg) return;
    try { schrijfGeheugen(pad, nu, fs); fout = null; } catch (e) { fout = /** @type {Error} */ (e).message; }
  };
  schrijf();
  return {
    pad,
    vorige,
    omgevallen,
    verlopen,
    ander,
    /** Waarom het loopbestand niet geschreven kon worden (of null). */
    fout: () => fout,
    /**
     * De set-starter startte (of nam over) proces `p` voor app `id`. Een overgenomen proces houdt zijn begintijd.
     * @param {string} id @param {number} p
     */
    app(id, p) {
      if (nu.apps[id] === p) return;
      nu.apps[id] = p;
      const toen = vorige?.apps?.[id] === p ? vorige.sinds?.[id] : undefined;
      nu.sinds[id] = typeof toen === 'string' ? toen : datum().toISOString();
      schrijf();
    },
    /** De opname ging aan of uit. @param {boolean} aan */
    opname(aan) { if (nu.opname === aan) return; nu.opname = aan; schrijf(); },
    /** Slots en focus van de kern (kern.slotsEnFocus()); alleen bij een echte wijziging naar schijf. @param {{ slots: (string|null)[], focus: string|null }} d */
    slotsEnFocus(d) {
      if (JSON.stringify(d.slots) === JSON.stringify(nu.slots ?? []) && (d.focus ?? null) === (nu.focus ?? null)) return;
      nu.slots = [...d.slots];
      nu.focus = d.focus ?? null;
      schrijf();
    },
    /** Netjes gestopt: het loopbestand weg. */
    wis() { if (weg) return; weg = true; try { fs.rmSync(pad, { force: true }); } catch { /* dan denkt de volgende start dat we omvielen: onschuldig */ } },
  };
}

/** @param {unknown} x @returns {x is Record<string, any>} */
const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
