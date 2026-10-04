// @ts-check
// `varve-hub start --blijf`: een bewaker die de hub in een kindproces draait en hem na een crash opnieuw start.
// Begrensd: valt hij vaker dan BLIJF_MAX keer om binnen BLIJF_VENSTER_MS, dan stopt de bewaker (een crash-lus
// moet je zien, niet eindeloos laten doorgaan). Een vaste fout (poort bezet = 3, geen token = 4, verkeerd
// gebruik = 2) start niet opnieuw: dat lost opnieuw proberen niet op. Netjes stoppen (Ctrl-C, SIGTERM, venster
// dicht) gaat één keer door naar de hub, die dan opruimt zoals altijd; een tweede Ctrl-C stopt hem meteen.
// Het kind draait in een eigen procesgroep: zo krijgt hij Ctrl-C van de terminal alleen via de bewaker (anders
// kwam het twee keer aan en sloeg de hub het opruimen over).
// Na een herstart weet de hub zelf dat de vorige omviel (loopbestand, src/opslag.js): slots, focus, opname en
// de apps van de set gaan verder waar ze waren.
import { spawn } from 'node:child_process';
import { echteKlok } from './core/klok.js';

/** Hooguit zoveel herstarts binnen het venster. */
export const BLIJF_MAX = 5;
export const BLIJF_VENSTER_MS = 60_000;
/** Even wachten voor een herstart (de poort komt vrij, een crash-lus loopt niet heet). */
export const BLIJF_WACHT_MS = 1000;
/**
 * Een tweede sein binnen zoveel ms is hetzelfde Ctrl-C: `npm start` stuurt het nog eens door naar de bewaker
 * (de terminal stuurt het al naar de hele procesgroep). Zou de bewaker dat ook doorsturen, dan zag de hub twee
 * keer Ctrl-C en sloeg hij het opruimen over.
 */
export const DUBBEL_MS = 500;
/** Exitcodes van `start` die opnieuw starten niet oplost. */
export const VASTE_FOUTEN = Object.freeze([2, 3, 4]);

/**
 * @typedef {{ pid?: number, kill: (sein: NodeJS.Signals) => unknown, on: (e: 'exit', fn: (code: number|null, sein: NodeJS.Signals|null) => void) => unknown }} Kind
 * @typedef {(node: string, args: string[]) => Kind} StartKind
 */

/** @type {StartKind} */
const startEcht = (node, args) => spawn(node, args, { stdio: ['ignore', 'inherit', 'inherit'], detached: true });

/**
 * Draai de hub tot hij netjes stopt, een vaste fout geeft, of te vaak omvalt. Geeft de exitcode voor de bewaker.
 * @param {{
 *   node: string, cli: string, args: string[], log?: (t: string) => void, klok?: import('./core/klok.js').Klok,
 *   start?: StartKind, signalen?: { on: (s: NodeJS.Signals, fn: () => void) => unknown, off: (s: NodeJS.Signals, fn: () => void) => unknown },
 *   max?: number, vensterMs?: number, wachtMs?: number,
 * }} o
 * @returns {Promise<{ code: number, herstarts: number }>}
 */
export function bewaker({
  node, cli, args, log = () => {}, klok = echteKlok, start = startEcht, signalen = process,
  max = BLIJF_MAX, vensterMs = BLIJF_VENSTER_MS, wachtMs = BLIJF_WACHT_MS,
}) {
  return new Promise((klaar) => {
    /** @type {number[]} momenten van omvallen (kern-klok) */
    const crashes = [];
    let herstarts = 0;
    let stoppen = false;
    /** @type {Kind|null} */
    let kind = null;
    /** @type {any} */
    let timer = null;
    let laatsteSein = -Infinity;
    /** @type {[NodeJS.Signals, () => void][]} */
    const handlers = /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM', 'SIGHUP']).map((s) => [s, () => {
      const nu = klok.nu();
      if (nu - laatsteSein < DUBBEL_MS) return;
      laatsteSein = nu;
      stoppen = true;
      if (timer !== null) { klok.wis(timer); timer = null; einde(0); return; }   // tussen twee starts: niets te stoppen
      try { kind?.kill(s); } catch { /* al weg */ }
    }]);
    for (const [s, fn] of handlers) signalen.on(s, fn);
    /** @param {number} code */
    const einde = (code) => { for (const [s, fn] of handlers) signalen.off(s, fn); klaar({ code, herstarts }); };

    const draai = () => {
      timer = null;
      const k = start(node, [cli, ...args]);
      kind = k;
      log(`bewaker: hub gestart (proces ${k.pid ?? '?'})${herstarts ? ` — herstart ${herstarts}` : ''}`);
      k.on('exit', (code, sein) => {
        kind = null;
        if (stoppen) return einde(code ?? 0);
        if (code === 0) return einde(0);                                   // de hub stopte zelf netjes
        if (code !== null && VASTE_FOUTEN.includes(code)) {
          log(`bewaker: de hub stopte met een vaste fout (code ${code}) — niet opnieuw gestart; los de melding hierboven op`);
          return einde(code);
        }
        const nu = klok.nu();
        crashes.push(nu);
        while (crashes.length && nu - crashes[0] > vensterMs) crashes.shift();
        const hoe = sein ? `door ${sein}` : `met code ${code}`;
        if (crashes.length > max) {
          log(`bewaker: de hub viel ${crashes.length} keer om binnen ${Math.round(vensterMs / 1000)} s (laatst ${hoe}) — gestopt. `
            + 'Kijk naar de fout hierboven, en start hem met de hand opnieuw.');
          return einde(1);
        }
        herstarts++;
        log(`bewaker: de hub viel om (${hoe}) — over ${wachtMs / 1000} s opnieuw (${crashes.length}/${max} binnen ${Math.round(vensterMs / 1000)} s)`);
        timer = klok.zet(draai, wachtMs);
      });
    };
    draai();
  });
}
