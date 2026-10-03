// @ts-check
// Geheugen op schijf: de snapshots en de waarden van apps met truth:"hub" over een herstart van de hub heen.
// De kern geeft en neemt de inhoud (`exporteer`/`importeer`, puur) en meldt 'geheugen' bij elke wijziging;
// hier wordt dat gelezen bij de start en gedebounced (hooguit één keer per `schrijf_ms`) atomisch weggeschreven
// (eerst een tijdelijk bestand, dan rename: een stroomstoring laat nooit een half bestand achter).
// Pad uit config.json (`geheugen.pad`, `~` = thuismap); $VARVE_HUB_STAAT gaat voor (zoals $VARVE_HUB_CONFIG).
import * as nodeFs from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export const SCHRIJF_MS = 1000;

/** @typedef {Pick<typeof nodeFs, 'readFileSync' | 'writeFileSync' | 'renameSync' | 'mkdirSync' | 'rmSync'>} Bestanden */

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
 * Lees het geheugen. Ontbreekt het, of is het kapot, dan `data: null` en een melding; een kapot bestand
 * wordt bewaard als `<pad>.kapot` (zodat de eerstvolgende keer schrijven het niet stilletjes wegveegt).
 * @param {string} pad @param {Bestanden} [fs]
 * @returns {{ data: unknown, melding: string|null }}
 */
export function leesGeheugen(pad, fs = nodeFs) {
  let tekst;
  try { tekst = fs.readFileSync(pad, 'utf8'); } catch (e) {
    const fout = /** @type {{ code?: string, message: string }} */ (e);
    if (fout.code === 'ENOENT') return { data: null, melding: `nog geen geheugen (${pad}): de hub begint leeg` };
    return { data: null, melding: `geheugen ${pad} niet te lezen (${fout.message}): de hub begint leeg` };
  }
  try { return { data: JSON.parse(tekst), melding: null }; } catch (e) {
    return { data: null, melding: `geheugen ${pad} is kapot (${/** @type {Error} */ (e).message}): de hub begint leeg${bewaarKapot(pad, fs)}` };
  }
}

/** @param {string} pad @param {Bestanden} fs */
function bewaarKapot(pad, fs) {
  try { fs.renameSync(pad, `${pad}.kapot`); return `; het oude bestand staat in ${pad}.kapot`; } catch { return ''; }
}

/**
 * Schrijf atomisch: tijdelijk bestand naast het echte, dan rename.
 * @param {string} pad @param {unknown} data @param {Bestanden} [fs]
 */
export function schrijfGeheugen(pad, data, fs = nodeFs) {
  fs.mkdirSync(dirname(pad), { recursive: true });
  const tmp = `${pad}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1) + '\n');
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
  const { data, melding } = leesGeheugen(pad, fs);
  if (melding) log('geheugen', melding);
  else {
    const r = kern.importeer(data);
    if (!r.ok) log('geheugen', `geheugen ${pad} onbruikbaar (${r.reden}): de hub begint leeg${bewaarKapot(pad, fs)}`);
    else log('geheugen', `geladen uit ${pad}${r.overgeslagen ? ` (${r.overgeslagen} ongeldige onderdelen overgeslagen)` : ''}`);
  }
  let laatst = JSON.stringify(kern.exporteer());
  /** @type {any} */ let timer = null;
  let gestopt = false;
  /** @type {Error|null} */ let fout = null;

  const schrijf = () => {
    timer = null;
    const nu = kern.exporteer();
    const tekst = JSON.stringify(nu);
    if (tekst === laatst) return;
    try {
      schrijfGeheugen(pad, nu, fs);
      laatst = tekst;
      if (fout) { fout = null; log('geheugen', `${pad} weer bijgewerkt`); }
    } catch (e) {
      // Niet bij elke poging opnieuw melden; de volgende wijziging probeert het weer.
      if (!fout) log('geheugen', `kan ${pad} niet schrijven: ${/** @type {Error} */ (e).message}`);
      fout = /** @type {Error} */ (e);
    }
  };
  const plan = () => { if (!gestopt && timer === null) timer = klok.zet(schrijf, schrijfMs); };
  const afmelden = kern.bij('geheugen', plan);

  return {
    pad,
    /** Schrijf nu (als er iets veranderde), los van de debounce. */
    schrijfNu() { if (timer !== null) { klok.wis(timer); timer = null; } schrijf(); },
    /** Niet meer luisteren; wat nog wacht gaat meteen naar schijf. */
    stop() {
      if (gestopt) return;
      gestopt = true;
      afmelden();
      if (timer !== null) { klok.wis(timer); timer = null; }
      schrijf();
    },
  };
}
