// @ts-check
// Herstel na een harde stop (kill -9, stroom weg, de hub crashte): een avond die niet netjes werd afgesloten,
// heeft een gebaren.jsonl zonder eindregel en geen samenvatting.md. Bij de volgende start van de hub:
//   - gebaren.jsonl wordt ingekort tot de laatste volledige regel (een halve laatste regel, als het schrijven
//     precies toen werd afgebroken, gaat weg); alles daarvóór blijft precies zoals het was;
//   - er komt een samenvatting.md die zegt dat de avond is afgebroken, hoe lang hij liep en hoeveel regels er zijn.
// Zo blijft elke afgebroken avond leesbaar en af te spelen (`npm run herhaal`), en ziet `check` geen halve avond.
// De laatste ±seconde vóór de stop kan ontbreken: de opname schrijft per seconde weg (schrijver.js, SPOEL_MS).
// Wat er tijdens de herstart gebeurt, staat in een nieuwe avond (zie cli.js start: de opname loopt door).
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { GEBAREN, SAMENVATTING, duurTekst } from './opnemer.js';

/**
 * @typedef {{
 *   readdir: (pad: string) => Promise<string[]>, readFile: (pad: string) => Promise<string>,
 *   truncate: (pad: string, lengte: number) => Promise<void>, writeFile: (pad: string, tekst: string) => Promise<void>,
 *   bestaat: (pad: string) => Promise<boolean>,
 * }} HerstelBestanden
 */

/** @type {HerstelBestanden} */
export const echteHerstelBestanden = {
  readdir: (pad) => fsp.readdir(pad),
  readFile: (pad) => fsp.readFile(pad, 'utf8'),
  truncate: (pad, lengte) => fsp.truncate(pad, lengte),
  writeFile: (pad, tekst) => fsp.writeFile(pad, tekst, 'utf8'),
  bestaat: (pad) => fsp.access(pad).then(() => true, () => false),
};

/**
 * Een opname terug tot de laatste volledige regel: wat er na de laatste '\n' staat, telt niet (halve regel).
 * Puur. `lengte` in bytes (voor truncate), `regels` = volledige regels, `ms` = de laatste tijd die erin staat.
 * @param {string} tekst
 * @returns {{ lengte: number, weg: number, regels: number, ms: number, eind: boolean, kop: any }}
 */
export function laatsteVolledige(tekst) {
  const i = tekst.lastIndexOf('\n');
  const heel = i < 0 ? '' : tekst.slice(0, i + 1);
  let ms = 0, regels = 0, eind = false;
  /** @type {any} */ let kop = null;
  for (const r of heel.split('\n')) {
    if (!r.trim()) continue;
    regels++;
    let x;
    try { x = JSON.parse(r); } catch { continue; }
    if (regels === 1) kop = x;
    const t = Array.isArray(x) ? Number(x[0]) : Number(x?.ms);
    if (Number.isFinite(t)) ms = Math.max(ms, t);
    if (x && !Array.isArray(x) && x.e === 'eind') eind = true;
  }
  return { lengte: Buffer.byteLength(heel, 'utf8'), weg: Buffer.byteLength(tekst, 'utf8') - Buffer.byteLength(heel, 'utf8'), regels, ms, eind, kop };
}

/**
 * Zoek in de avondmap naar avonden zonder samenvatting.md (niet afgesloten) en herstel ze. Gooit nooit:
 * wat niet lukt, komt als melding terug. Geeft per herstelde avond de map en wat er gedaan is.
 * `voor`: alleen avonden die vóór dit moment begonnen (kop.begon) — nooit een avond die deze hub zelf al opneemt.
 * `na`: alleen avonden die op of na dit moment begonnen — de start van de omgevallen hub (uit zijn loopbestand), zodat
 * alleen zíjn avond hersteld wordt en nooit een die een andere hub (andere poort, zelfde avondmap) nu nog opneemt.
 * `varve-hub start` roept dit alleen aan als het loopbestand zegt dat de vorige hub omviel.
 * @param {{ map: string|null, voor: Date, na?: Date|null, fs?: HerstelBestanden, log?: (tekst: string) => void }} o
 * @returns {Promise<{ map: string, regels: number, weg: number, duur_ms: number }[]>}
 */
export async function herstelAvonden({ map, voor, na = null, fs = echteHerstelBestanden, log = () => {} }) {
  if (!map) return [];
  let namen;
  try { namen = (await fs.readdir(map)).sort(); } catch { return []; }   // nog geen avondmap: niets te doen
  /** @type {{ map: string, regels: number, weg: number, duur_ms: number }[]} */
  const hersteld = [];
  for (const naam of namen) {
    const avond = join(map, naam);
    const gebaren = join(avond, GEBAREN);
    try {
      if (await fs.bestaat(join(avond, SAMENVATTING))) continue;
      if (!(await fs.bestaat(gebaren))) continue;
      const r = laatsteVolledige(await fs.readFile(gebaren));
      if (r.kop?.soort !== 'avond') continue;                            // geen avond van de hub: niet aankomen
      const begon = Date.parse(r.kop?.begon);
      if (!(begon < voor.getTime())) continue;                           // van nu (of onbekend): niet aankomen
      if (na && !(begon >= na.getTime())) continue;                      // van vóór de omgevallen hub: niet van hem
      if (r.weg > 0) await fs.truncate(gebaren, r.lengte);
      await fs.writeFile(join(avond, SAMENVATTING), samenvattingAfgebroken(naam, avond, r));
      hersteld.push({ map: avond, regels: r.regels, weg: r.weg, duur_ms: r.ms });
      log(`opname: de avond ${avond} was niet afgesloten (de hub viel om) — hersteld: ${r.regels} regels, ${duurTekst(r.ms)}`
        + `${r.weg ? `, een halve laatste regel (${r.weg} bytes) weggehaald` : ''}; samenvatting.md geschreven`);
    } catch (e) {
      log(`opname: kon de afgebroken avond ${avond} niet herstellen — ${/** @type {any} */ (e)?.message ?? e}`);
    }
  }
  return hersteld;
}

/** @param {string} naam @param {string} map @param {ReturnType<typeof laatsteVolledige>} r */
function samenvattingAfgebroken(naam, map, r) {
  return [
    `# Avond ${naam} — afgebroken`,
    '',
    'De hub stopte zonder deze avond af te sluiten (hij viel om, werd hard gestopt, of de stroom ging weg).',
    'Bij de volgende start heeft de hub hem hersteld: alles tot de laatste volledige regel staat erin;',
    'de laatste seconde vóór de stop kan ontbreken, en er is geen eindstand (`eind`), dus `herhaal` kan niet',
    'controleren of de apps op dezelfde stand eindigen.',
    '',
    `- Begon: ${r.kop?.begon ?? '?'}`,
    `- Duur tot de laatste regel: ${duurTekst(r.ms)}`,
    `- Hub: ${r.kop?.['hub-git'] ? `git ${r.kop['hub-git']}` : 'git onbekend'}`,
    `- Bestand: ${GEBAREN} (${r.regels} regels${r.weg ? `; een halve laatste regel van ${r.weg} bytes weggehaald` : ''})`,
    '',
    `Opnieuw afspelen tegen een draaiende hub (in de AV-app-hub-map): \`npm run herhaal -- "${map}"\` (zie docs/OPNAME.md).`,
    '',
  ].join('\n');
}
