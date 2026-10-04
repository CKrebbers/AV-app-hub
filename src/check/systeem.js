// @ts-check
// Kleine hulpjes voor `varve-hub check` die de buitenwereld raken: een commando draaien (lsof), een
// HTTP-verzoek met time-out, en wie er op een poort luistert. Alles krijgt zijn spawn/fetch/klok geïnjecteerd.

/** @typedef {import('../core/klok.js').Klok} Klok */

/**
 * Draai een commando en geef zijn stdout, of null (bestaat niet, faalt, of duurt langer dan `ms`).
 * @param {{ spawn: typeof import('node:child_process').spawn, klok: Klok }} o
 * @param {string} cmd @param {string[]} args @param {number} [ms]
 * @returns {Promise<string|null>}
 */
export function draai({ spawn, klok }, cmd, args, ms = 2000) {
  return new Promise((goed) => {
    let klaar = false;
    const eind = (/** @type {string|null} */ x) => { if (klaar) return; klaar = true; klok.wis(t); goed(x); };
    let p;
    const t = klok.zet(() => { try { p?.kill('SIGKILL'); } catch { /* al weg */ } eind(null); }, ms);
    try { p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { eind(null); return; }
    let uit = '';
    p.stdout?.on('data', (/** @type {Buffer|string} */ d) => { uit += String(d); });
    p.on('error', () => eind(null));
    // lsof geeft code 1 als er niets gevonden is: dan is de uitvoer leeg, niet "kapot".
    p.on('close', (/** @type {number|null} */ code) => eind(code === 0 || (code === 1 && !uit) ? uit : null));
  });
}

/**
 * Wie luistert er op deze TCP-poort? Via lsof (macOS en Linux). null = niet na te gaan (geen lsof),
 * `{}` zonder pid = niemand gevonden.
 * @param {{ spawn: typeof import('node:child_process').spawn, klok: Klok }} o @param {number} poort
 * @returns {Promise<{ pid?: number, commando?: string, map?: string } | null>}
 */
export async function wieLuistert(o, poort) {
  const uit = await draai(o, 'lsof', ['-nP', `-iTCP:${poort}`, '-sTCP:LISTEN', '-Fpc']);
  if (uit === null) return null;
  const pid = Number(/^p(\d+)$/m.exec(uit)?.[1]);
  if (!pid) return {};
  const commando = /^c(.+)$/m.exec(uit)?.[1];
  const cwd = await draai(o, 'lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
  const map = cwd ? /^n(.+)$/m.exec(cwd)?.[1] : undefined;
  return { pid, ...(commando ? { commando } : {}), ...(map ? { map } : {}) };
}

/**
 * GET met een time-out op de geïnjecteerde klok.
 * @param {{ fetch: typeof fetch, klok: Klok }} o @param {string} url @param {number} [ms]
 * @returns {Promise<{ soort: 'antwoord', status: number, tekst: string } | { soort: 'dicht' } | { soort: 'stil' } | { soort: 'fout', reden: string }>}
 *   dicht = niemand luistert; stil = geen antwoord binnen ms; fout = iets anders
 */
export async function haal({ fetch, klok }, url, ms = 1500) {
  const ac = new AbortController();
  let verlopen = false;
  /** @type {any} */
  let t;
  const tijd = new Promise((goed) => { t = klok.zet(() => { verlopen = true; ac.abort(); goed({ soort: 'stil' }); }, ms); });
  const verzoek = (async () => {
    try {
      const r = await fetch(url, { signal: ac.signal });
      return { soort: 'antwoord', status: r.status, tekst: await r.text() };
    } catch (e) {
      if (verlopen) return { soort: 'stil' };
      const x = /** @type {any} */ (e);
      const code = x?.cause?.code ?? x?.code;
      if (code === 'ECONNREFUSED' || code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND') return { soort: 'dicht' };
      return { soort: 'fout', reden: String(x?.cause?.message ?? x?.message ?? x) };
    }
  })();
  try { return /** @type {any} */ (await Promise.race([verzoek, tijd])); } finally { klok.wis(t); }
}
