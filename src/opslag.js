// @ts-check
// Geheugen op schijf: de snapshots en de waarden van apps met truth:"hub" over een herstart van de hub heen.
// De kern geeft en neemt de inhoud (`exporteer`/`importeer`, puur) en meldt 'geheugen' bij elke wijziging;
// hier wordt dat gelezen bij de start en gedebounced (hooguit één keer per `schrijf_ms`) atomisch weggeschreven:
// eerst een tijdelijk bestand, dat met fsync echt op schijf staat, dan rename. Zo staat er na een crash of
// stroomstoring het oude of het nieuwe bestand, nooit een half of leeg (gaat de rename zelf bij stroomverlies
// verloren, dan staat er de vorige versie).
// Pad uit config.json (`geheugen.pad`, `~` = thuismap); $VARVE_HUB_STAAT gaat voor (zoals $VARVE_HUB_CONFIG).
import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
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
  // 'geheugen': snapshots en truth:"hub"-waarden. 'beeld' (hooguit 10×/s): ook slots en focus horen erbij (die
  // melden geen 'geheugen'); schrijf() vergelijkt eerst, dus zonder echte wijziging gaat er niets naar schijf.
  const afmelden = [kern.bij('geheugen', plan), kern.bij('beeld', plan)];

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
// (kill -9, crash, stroom weg) — midden in een set. Erin: welke set, de processen die de set-starter startte
// (zodat een herstart ze niet dubbel start en ze bij Ctrl-C toch stopt) en of de opname liep.

/**
 * @typedef {{ v: 1, pid: number, begon: string, set: string|null, apps: Record<string, number>, opname: boolean }} Loop
 */

/** Pad van het loopbestand bij een geheugenpad. @param {string} geheugen */
export const loopPad = (geheugen) => `${geheugen}.loopt`;

/** Leeft proces `pid` nog? (signaal 0 stuurt niets.) @param {number} pid */
export function procesLeeft(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return /** @type {any} */ (e)?.code === 'EPERM'; }
}

/**
 * Lees het vorige loopbestand en schrijf het eigen. `vorige` = wat de omgevallen hub achterliet (of null: de vorige
 * stopte netjes, of er draait nog een hub met dit geheugen — dan `ander` = zijn pid).
 * @param {{ pad: string, set?: string|null, pid?: number, datum?: () => Date, leeft?: (pid: number) => boolean, fs?: Bestanden }} o
 */
export function openLoopbestand({ pad, set = null, pid = process.pid, datum = () => new Date(), leeft = procesLeeft, fs = nodeFs }) {
  ruimTmpOp(pad, fs);
  /** @type {Partial<Loop>|null} */
  let vorige = null;
  /** @type {number|null} */
  let ander = null;
  try {
    const d = JSON.parse(fs.readFileSync(pad, 'utf8'));
    vorige = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch (e) {
    // Weg = de vorige stopte netjes. Er wel maar kapot (half geschreven bij stroomverlies): toch omgevallen.
    if (/** @type {any} */ (e)?.code !== 'ENOENT') vorige = {};
  }
  if (vorige && typeof vorige.pid === 'number' && vorige.pid !== pid && leeft(vorige.pid)) { ander = vorige.pid; vorige = null; }
  if (vorige) {
    const apps = /** @type {Record<string, number>} */ ({});
    for (const [id, p] of Object.entries(isObject(vorige.apps) ? /** @type {object} */ (vorige.apps) : {})) if (Number.isInteger(p) && p > 1) apps[id] = p;
    vorige = { ...vorige, apps, opname: vorige.opname === true, set: typeof vorige.set === 'string' ? vorige.set : null };
  }
  /** @type {Loop} */
  const nu = { v: 1, pid, begon: datum().toISOString(), set, apps: {}, opname: false };
  let weg = false;
  /** @type {string|null} */
  let fout = null;
  const schrijf = () => {
    if (weg) return;
    try { schrijfGeheugen(pad, nu, fs); fout = null; } catch (e) { fout = /** @type {Error} */ (e).message; }
  };
  schrijf();
  return {
    pad,
    /** @type {Partial<Loop>|null} */ vorige,
    ander,
    /** Waarom het loopbestand niet geschreven kon worden (of null). */
    fout: () => fout,
    /** De set-starter startte (of nam over) proces `pid` voor app `id`. @param {string} id @param {number} p */
    app(id, p) { if (nu.apps[id] === p) return; nu.apps[id] = p; schrijf(); },
    /** De opname ging aan of uit. @param {boolean} aan */
    opname(aan) { if (nu.opname === aan) return; nu.opname = aan; schrijf(); },
    /** Netjes gestopt: het loopbestand weg. */
    wis() { weg = true; try { fs.rmSync(pad, { force: true }); } catch { /* dan denkt de volgende start dat we omvielen: onschuldig */ } },
  };
}

/** @param {unknown} x */
const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
