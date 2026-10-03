// @ts-check
// De netwerkkant van de hub (PROTOCOL.md §2, §3, §8): één HTTP-server met twee WebSocket-paden.
//   GET /                 → ui/index.html (cockpit)
//   GET /ui/<pad>         → statische bestanden uit uiMap
//   GET /src/devices/*.js, /src/protocol/*.js → gedeelde code voor de cockpit (alleen die twee mappen)
//   GET /api/beeld        → kern.beeld() als JSON
//   WS  /app              → één Verbinding per socket naar de kern
//   WS  /cockpit          → beeld/leds/invoer naar de cockpit, virtueel/focus/zet/snapshot terug
// Beveiliging: alleen WebSockets zonder Origin (Node-clients), van localhost/127.0.0.1, van `origins`, of
// same-origin met de hub zelf op een IP-adres (cockpit op een tablet bij host 0.0.0.0). HTTP weigert een
// Host-header die geen localhost/IP/geconfigureerde host is (DNS-rebinding).
// Token (`--lan`, docs/NETWERK.md): met `token` moet elke verbinding van buiten de eigen machine (niet 127.0.0.1/::1)
// het token tonen: HTTP via ?token= of het cookie dat de hub dan zet, /cockpit via ?token= of dat cookie, /app via
// ?token= in de URL of `token` in hallo. Verkeerd of geen token: HTTP 401, of fout + close-code 4003 op /app.
// Robuust: kapotte JSON, te grote berichten, wegvallende sockets en trage cockpits laten de hub nooit vallen.
import http from 'node:http';
import { stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { leesVanApp, klem01 } from '../protocol/berichten.js';
import { vindCC } from '../devices/apc40mk2.js';

/** @typedef {import('../protocol/types.js').Verbinding} Verbinding */

/**
 * Wat de server van de kern gebruikt (src/core/kern.js volgt dit contract).
 * @typedef {{
 *   verbind: (v: Verbinding) => void,
 *   ontvang: (v: Verbinding, b: import('../protocol/types.js').VanApp) => void,
 *   verbreek: (v: Verbinding) => void,
 *   cockpit: (b: CockpitOpdracht) => void,
 *   beeld: () => Record<string, unknown>,
 *   bij: (naam: string, fn: Function) => (() => void) | unknown,
 * }} KernVoorServer
 * @typedef {{ t: 'focus', app: string|null } | { t: 'zet', app: string, id: string, v: number } | { t: 'snapshot', nr: number, actie: 'laad'|'bewaar' }} CockpitOpdracht
 */

export const MAX_BERICHT = 256 * 1024;
export const MAX_ACHTERSTAND = 1024 * 1024;

const MIME = /** @type {Record<string, string>} */ ({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
});

/** @param {string} bestand */
export const mimeVan = (bestand) => MIME[path.extname(bestand).toLowerCase()] ?? 'application/octet-stream';

// ── Origin ───────────────────────────────────────────────────────────────────

/** Hostnaam zonder IPv6-haken. @param {string} h */
const kaal = (h) => h.replace(/^\[(.*)\]$/, '$1');
/** localhost of een IP-adres: namen die een vreemde site niet via DNS-rebinding naar de hub kan laten wijzen. @param {string} h */
const lokaleNaam = (h) => h === 'localhost' || isIP(kaal(h)) !== 0;

/**
 * Mag een WebSocket met deze Origin-header verbinden? Geen Origin = Node-client = ja.
 * Toegestaan: http(s)://localhost[:poort], http(s)://127.0.0.1[:poort], exact wat in `origins` staat, en
 * same-origin: de Origin wijst naar dezelfde host:poort als de Host-header én die host is localhost of een
 * IP-adres (zo werkt de cockpit die de hub zelf serveert ook via http://192.168.x.x:7700, maar niet via een
 * domeinnaam die een aanvaller naar 127.0.0.1 laat wijzen).
 * @param {string|undefined} origin @param {string[]} [origins] @param {string} [hostKop] Host-header van het verzoek
 */
export function originToegestaan(origin, origins = [], hostKop) {
  if (origin === undefined) return true;
  if (origins.includes(origin)) return true;
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password || (u.pathname !== '/' && u.pathname !== '')) return false;
  if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
  return typeof hostKop === 'string' && u.host === hostKop.toLowerCase() && lokaleNaam(u.hostname);
}

/**
 * Mag een HTTP-verzoek met deze Host-header bediend worden? Tegen DNS-rebinding: alleen localhost,
 * IP-adressen, de geconfigureerde host en de hosts uit `origins`. Geen Host-header (oude/Node-clients) = ja.
 * @param {string|undefined} hostKop @param {{ host?: string, origins?: string[] }} [o]
 */
export function hostToegestaan(hostKop, { host, origins = [] } = {}) {
  if (hostKop === undefined) return true;
  let naam;
  try { naam = new URL(`http://${hostKop}`).hostname; } catch { return false; }
  if (lokaleNaam(naam)) return true;
  if (host && naam === host.toLowerCase()) return true;
  return origins.some((o) => { try { return new URL(o).hostname === naam; } catch { return false; } });
}

// ── Token ────────────────────────────────────────────────────────────────────

/** Naam van het cookie waarmee een browser (cockpit op een tablet) het token onthoudt. */
export const TOKEN_COOKIE = 'varve_hub_token';
/** Close-code voor een /app-verbinding zonder geldig token. */
export const CLOSE_TOKEN = 4003;

/** Komt de verbinding van de eigen machine (loopback)? @param {string|undefined} adres */
export const isLokaalAdres = (adres) => typeof adres === 'string' && (/^(::ffff:)?127\./.test(adres) || adres === '::1');

/** Vergelijken in vaste tijd (geen lengte- of timinglek). @param {unknown} gegeven @param {string} token */
export function tokenKlopt(gegeven, token) {
  if (typeof gegeven !== 'string' || !gegeven || !token) return false;
  const h = (/** @type {string} */ x) => createHash('sha256').update(x).digest();
  return timingSafeEqual(h(gegeven), h(token));
}

/** Het token uit ?token= of uit het cookie van een verzoek (of null). @param {import('node:http').IncomingMessage} req */
export function tokenVanVerzoek(req) {
  let uitUrl = null;
  try { uitUrl = new URL(req.url ?? '/', 'http://hub').searchParams.get('token'); } catch { /* ongeldig pad */ }
  const koekjes = typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
  let uitKoekje = null;
  for (const deel of koekjes.split(';')) {
    const i = deel.indexOf('=');
    if (i > 0 && deel.slice(0, i).trim() === TOKEN_COOKIE) { try { uitKoekje = decodeURIComponent(deel.slice(i + 1).trim()); } catch { /* kapot */ } }
  }
  return { uitUrl, uitKoekje };
}

// ── Statische bestanden ──────────────────────────────────────────────────────

/**
 * Een (al gedecodeerd) relatief pad veilig binnen `basis` oplossen; null bij traversal.
 * @param {string} basis @param {string} rel
 */
export function veiligPad(basis, rel) {
  if (rel.includes('\0')) return null;
  const wortel = path.resolve(basis);
  const doel = path.resolve(wortel, '.' + path.sep + rel);
  if (doel !== wortel && !doel.startsWith(wortel + path.sep)) return null;
  return doel;
}

/** @param {import('node:http').ServerResponse} res @param {number} code @param {string} tekst */
function eindig(res, code, tekst) {
  res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
  res.end(tekst);
}

/** @param {import('node:http').ServerResponse} res @param {string|null} bestand @param {boolean} hoofd */
async function stuurBestand(res, bestand, hoofd) {
  if (!bestand) return eindig(res, 404, 'niet gevonden');
  try {
    let pad = bestand;
    let s = await stat(pad);
    if (s.isDirectory()) { pad = path.join(pad, 'index.html'); s = await stat(pad); }
    if (!s.isFile()) return eindig(res, 404, 'niet gevonden');
    const inhoud = hoofd ? null : await readFile(pad);
    res.writeHead(200, {
      'content-type': mimeVan(pad), 'content-length': s.size,
      'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
    });
    res.end(inhoud);
  } catch {
    if (!res.headersSent) eindig(res, 404, 'niet gevonden');
    else res.destroy();
  }
}

// ── Cockpit-uitzender ────────────────────────────────────────────────────────

/**
 * Verdeelt kern-events over cockpit-sockets. Een trage cockpit (bufferedAmount > maxAchterstand)
 * slaat beeld en leds over; zodra hij bij is krijgt hij het laatste beeld en alle gemiste LED-standen
 * samengevoegd. Invoer is live-weergave en vervalt bij achterstand.
 * Houdt per dev de samengevoegde LED-stand bij (kern.beeld() bevat die niet): een nieuwe cockpit krijgt
 * direct na het beeld de volledige stand, zodat een herladen pagina niet donker blijft.
 * Los van ws te testen: een socket is alles met `readyState`, `bufferedAmount` en `send(tekst)`.
 */
export class CockpitUitzender {
  /**
   * @param {{ beeld: () => Record<string, unknown>, maxAchterstand?: number, inhaalMs?: number,
   *   zet?: (fn: () => void, ms: number) => any, wis?: (h: any) => void }} o
   */
  constructor({ beeld, maxAchterstand = MAX_ACHTERSTAND, inhaalMs = 50, zet = setTimeout, wis = clearTimeout }) {
    this.beeldVan = beeld;
    this.max = maxAchterstand;
    this.inhaalMs = inhaalMs;
    this.zet = zet;
    this.wis = wis;
    /** @type {Map<{ readyState: number, bufferedAmount: number, send: (s: string) => void }, { beeld: boolean, leds: Map<string, Record<string, unknown>>, timer: any }>} */
    this.sockets = new Map();
    /** Alles wat de kern ooit op een apparaat zette, per dev samengevoegd. @type {Map<string, Record<string, unknown>>} */
    this.ledStaat = new Map();
  }
  get aantal() { return this.sockets.size; }
  /** @param {{ readyState: number, bufferedAmount: number, send: (s: string) => void }} ws */
  voegToe(ws) {
    this.sockets.set(ws, { beeld: false, leds: new Map(), timer: null });
    this.#stuur(ws, this.#beeldTekst());
    for (const [dev, staat] of this.ledStaat) this.#stuur(ws, veiligJson({ t: 'leds', dev, staat }));
  }
  /** @param {any} ws */
  verwijder(ws) {
    const s = this.sockets.get(ws);
    if (s?.timer) this.wis(s.timer);
    this.sockets.delete(ws);
  }
  sluit() { for (const ws of [...this.sockets.keys()]) this.verwijder(ws); }

  beeld() {
    if (!this.sockets.size) return;
    const tekst = this.#beeldTekst();
    if (tekst === null) return;
    for (const [ws, s] of this.sockets) {
      if (this.#bij(ws)) this.#stuur(ws, tekst);
      else { s.beeld = true; this.#inhalen(ws); }
    }
  }
  /** @param {{ dev?: string, staat?: Record<string, unknown> }} x */
  leds(x) {
    if (!x || typeof x !== 'object') return;
    const dev = typeof x.dev === 'string' ? x.dev : 'apc40';
    if (x.staat && typeof x.staat === 'object') this.ledStaat.set(dev, { ...(this.ledStaat.get(dev) ?? {}), ...x.staat });
    if (!this.sockets.size) return;
    const tekst = veiligJson({ ...x, t: 'leds', dev });
    if (tekst === null) return;
    for (const [ws, s] of this.sockets) {
      if (this.#bij(ws) && !s.leds.size) this.#stuur(ws, tekst);
      else {
        const oud = s.leds.get(dev) ?? {};
        s.leds.set(dev, { ...oud, ...(x.staat ?? {}) });
        this.#inhalen(ws);
      }
    }
  }
  /** @param {unknown} g */
  invoer(g) {
    if (!this.sockets.size) return;
    const tekst = veiligJson({ t: 'invoer', g });
    if (tekst === null) return;
    for (const ws of this.sockets.keys()) if (this.#bij(ws)) this.#stuur(ws, tekst);
  }

  /** @param {any} ws */
  #bij(ws) { return ws.readyState === WebSocket.OPEN && ws.bufferedAmount <= this.max; }
  /** @param {any} ws @param {string|null} tekst */
  #stuur(ws, tekst) {
    if (tekst === null || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(tekst); } catch { /* socket viel net weg; close-handler ruimt op */ }
  }
  #beeldTekst() {
    try { return veiligJson({ ...this.beeldVan(), t: 'beeld' }); } catch (e) { console.error('[server] kern.beeld() faalde:', e); return null; }
  }
  /** Wacht tot de socket bij is en stuur dan het gemiste. @param {any} ws */
  #inhalen(ws) {
    const s = this.sockets.get(ws);
    if (!s || s.timer) return;
    s.timer = this.zet(() => {
      s.timer = null;
      if (!this.sockets.has(ws) || ws.readyState !== WebSocket.OPEN) return;
      if (!this.#bij(ws)) return this.#inhalen(ws);
      if (s.beeld) { s.beeld = false; this.#stuur(ws, this.#beeldTekst()); }
      for (const [dev, staat] of s.leds) this.#stuur(ws, veiligJson({ t: 'leds', dev, staat }));
      s.leds.clear();
    }, this.inhaalMs);
  }
}

/** @param {unknown} x */
function veiligJson(x) { try { return JSON.stringify(x); } catch (e) { console.error('[server] niet te serialiseren:', e); return null; } }

// ── Cockpit-berichten ────────────────────────────────────────────────────────

/**
 * Een bericht van de cockpit controleren (PROTOCOL.md §8). Onbekend → negeren.
 * @param {unknown} ruw
 * @returns {{ ok: true, virtueel: { dev: 'apc40'|'lpd8', bytes: number[] } } | { ok: true, kern: CockpitOpdracht } | { ok: true, onbekend: true } | { ok: false, fout: string }}
 */
export function leesVanCockpit(ruw) {
  let x = ruw;
  if (typeof ruw === 'string') { try { x = JSON.parse(ruw); } catch { return { ok: false, fout: 'geen geldige JSON' }; } }
  if (!x || typeof x !== 'object' || Array.isArray(x)) return { ok: false, fout: 'bericht is geen object' };
  const b = /** @type {Record<string, any>} */ (x);
  switch (b.t) {
    case 'virtueel': {
      if (b.dev !== 'apc40' && b.dev !== 'lpd8') return { ok: false, fout: 'virtueel: dev moet apc40 of lpd8 zijn' };
      const ok = Array.isArray(b.bytes) && b.bytes.length > 0 && b.bytes.length <= 512
        && b.bytes.every((/** @type {unknown} */ n) => Number.isInteger(n) && /** @type {number} */ (n) >= 0 && /** @type {number} */ (n) <= 255);
      if (!ok) return { ok: false, fout: 'virtueel: bytes moet een lijst getallen 0..255 zijn' };
      return { ok: true, virtueel: { dev: b.dev, bytes: [...b.bytes] } };
    }
    case 'focus':
      if (b.app !== null && (typeof b.app !== 'string' || !b.app)) return { ok: false, fout: 'focus: app (id of null) nodig' };
      return { ok: true, kern: { t: 'focus', app: b.app } };
    case 'zet':
      if (typeof b.app !== 'string' || typeof b.id !== 'string' || typeof b.v !== 'number') return { ok: false, fout: 'zet: app, id en v nodig' };
      return { ok: true, kern: { t: 'zet', app: b.app, id: b.id, v: klem01(b.v) } };
    case 'snapshot':
      if (!Number.isInteger(b.nr) || b.nr < 1) return { ok: false, fout: 'snapshot: nr (1..) nodig' };
      if (b.actie !== 'laad' && b.actie !== 'bewaar') return { ok: false, fout: 'snapshot: actie laad of bewaar' };
      return { ok: true, kern: { t: 'snapshot', nr: b.nr, actie: b.actie } };
    default:
      return { ok: true, onbekend: true };
  }
}

// ── Server ───────────────────────────────────────────────────────────────────

/**
 * @param {{
 *   poort: number, host?: string, kern: KernVoorServer, uiMap: string, srcMap: string,
 *   opVirtueel?: (dev: 'apc40'|'lpd8', bytes: number[]) => void, origins?: string[],
 *   maxAchterstand?: number, pingMs?: number, token?: string|null,
 * }} o `token`: vereist voor elke verbinding van buiten de eigen machine (zie boven); null = geen controle.
 * @returns {Promise<{ adres: string, poort: number, tokenVereist: boolean, stop: () => Promise<void> }>}
 */
export async function startServer({ poort, host = '127.0.0.1', kern, uiMap, srcMap, opVirtueel, origins = [], maxAchterstand = MAX_ACHTERSTAND, pingMs = 15000, token = null }) {
  if (token !== null && (typeof token !== 'string' || token.length < 16)) throw new Error('token moet een tekst van minstens 16 tekens zijn');
  /** Heeft dit verzoek (HTTP of upgrade) geen token nodig, of toont het het goede? Dan ook: kwam het uit de URL?
   *  @param {import('node:http').IncomingMessage} req */
  const toegang = (req) => {
    if (!token || isLokaalAdres(req.socket.remoteAddress)) return { ok: true, uitUrl: false };
    const { uitUrl, uitKoekje } = tokenVanVerzoek(req);
    if (tokenKlopt(uitUrl, token)) return { ok: true, uitUrl: true };
    return { ok: tokenKlopt(uitKoekje, token), uitUrl: false };
  };
  const veilig = (/** @type {string} */ wat, /** @type {() => void} */ fn) => {
    try { fn(); } catch (e) { console.error(`[server] fout in ${wat}:`, e); }
  };

  const server = http.createServer((req, res) => {
    veiligeRoute(req, res).catch(() => { if (!res.headersSent) eindig(res, 500, 'interne fout'); else res.destroy(); });
  });
  server.on('clientError', (_e, sock) => { try { sock.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch { /* al weg */ } });

  /** @param {import('node:http').IncomingMessage} req @param {import('node:http').ServerResponse} res */
  async function veiligeRoute(req, res) {
    if (!hostToegestaan(req.headers.host, { host, origins })) return eindig(res, 403, 'host niet toegestaan');
    const t = toegang(req);
    if (!t.ok) return eindig(res, 401, 'token nodig: open de cockpit met ?token=… (node src/cli.js token op de hub toont het adres)');
    // Een browser die het token in de URL meegaf onthoudt het, zodat de cockpit-WebSocket en de
    // scripts van de pagina het ook hebben (die kennen de ?token= van de pagina niet).
    if (t.uitUrl && token) res.setHeader('set-cookie', `${TOKEN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    if (req.method !== 'GET' && req.method !== 'HEAD') return eindig(res, 404, 'niet gevonden');
    const hoofd = req.method === 'HEAD';
    let pad;
    try { pad = decodeURIComponent(new URL(req.url ?? '/', 'http://hub').pathname); } catch { return eindig(res, 400, 'ongeldig pad'); }
    if (pad === '/' || pad === '/index.html') return stuurBestand(res, veiligPad(uiMap, 'index.html'), hoofd);
    if (pad.startsWith('/ui/')) return stuurBestand(res, veiligPad(uiMap, pad.slice(4)), hoofd);
    const src = /^\/src\/(devices|protocol)\/([A-Za-z0-9_-]+\.js)$/.exec(pad);
    if (src) return stuurBestand(res, veiligPad(path.join(srcMap, src[1]), src[2]), hoofd);
    if (pad === '/api/beeld') {
      let tekst;
      try { tekst = JSON.stringify(kern.beeld()); } catch (e) { console.error('[server] kern.beeld() faalde:', e); return eindig(res, 500, 'beeld niet beschikbaar'); }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return void res.end(hoofd ? undefined : tekst);
    }
    return eindig(res, 404, 'niet gevonden');
  }

  const wssApp = new WebSocketServer({ noServer: true, maxPayload: MAX_BERICHT });
  const wssCockpit = new WebSocketServer({ noServer: true, maxPayload: MAX_BERICHT });
  /** @type {WeakSet<WebSocket>} */
  const levend = new WeakSet();

  /** Eén keer per origin melden waarom een verbinding geweigerd wordt (begrensd tegen spam). @type {Set<string>} */
  const gemeld = new Set();
  const waarschuwOrigin = (/** @type {string} */ o) => {
    if (gemeld.has(o) || gemeld.size >= 100) return;
    gemeld.add(o);
    console.warn(`[server] origin geweigerd: ${o} (voeg hem toe aan origins als dit een eigen app is)`);
  };

  server.on('upgrade', (req, sock, kop) => {
    sock.on('error', () => {});
    let pad;
    try { pad = new URL(req.url ?? '/', 'http://hub').pathname; } catch { pad = ''; }
    // '/' telt als /app (CLAUDE.md noemt ?hub=ws://localhost:7700 zonder pad); een slash erachter mag.
    pad = pad.replace(/\/+$/, '') || '/app';
    const wss = pad === '/app' ? wssApp : pad === '/cockpit' ? wssCockpit : null;
    if (!wss) { sock.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    const origin = req.headers.origin;
    if (!originToegestaan(typeof origin === 'string' ? origin : undefined, origins, req.headers.host)) {
      waarschuwOrigin(String(origin));
      sock.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\norigin niet toegestaan');
      return;
    }
    // /cockpit van buiten: token bij de upgrade (URL of cookie). /app mag het ook in hallo sturen.
    const t = toegang(req);
    if (!t.ok && wss === wssCockpit) {
      sock.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Type: text/plain\r\n\r\ntoken nodig');
      return;
    }
    wss.handleUpgrade(req, sock, kop, (ws) => wss.emit('connection', ws, req, t.ok));
  });

  // Twee instanties van dezelfde app (twee tabs): de kern laat de nieuwste winnen en sluit de oude. Een
  // client volgens §3 verbindt dan opnieuw en zou de winnaar weer verdringen, eindeloos (~2 herstarts/s).
  // Daarom onthoudt de server welke inst verdrongen is: die wordt geweigerd (fout + close-code 4001) zolang
  // de app nog via een andere socket verbonden is. Een nieuwe inst (herladen tab) neemt het wel over; is de
  // winnaar weg, dan mag de verdrongen instantie terug.
  /** Per app de socket die als laatste een hallo voor die app doorgaf. @type {Map<string, { ws: WebSocket, inst: string }>} */
  const huidige = new Map();
  /** Per app de verdrongen insts (begrensd). @type {Map<string, Set<string>>} */
  const verdrongen = new Map();
  /** @param {string} app @param {string} inst */
  const markeerVerdrongen = (app, inst) => {
    let s = verdrongen.get(app);
    if (!s) {
      if (verdrongen.size >= 256) verdrongen.delete(/** @type {string} */ (verdrongen.keys().next().value));
      verdrongen.set(app, s = new Set());
    }
    if (s.size >= 16) s.delete(/** @type {string} */ (s.values().next().value));
    s.add(inst);
  };
  /** @type {WeakSet<WebSocket>} sockets die vervangen zijn: sluiten met 4001 in plaats van 1000 */
  const vervangen = new WeakSet();

  // /app — één Verbinding per socket.
  wssApp.on('connection', (ws, _req, /** @type {boolean} */ binnen = true) => {
    let welkomGestuurd = false;
    /** Zonder token bij de upgrade (LAN): pas na een hallo met het goede token naar de kern. */
    let bijKern = binnen;
    let geweigerd = false;                                       // token afgewezen: wat nog binnenkomt telt niet
    levend.add(ws);
    ws.on('pong', () => levend.add(ws));
    ws.on('error', () => {});
    /** @type {Verbinding} */
    const v = {
      app: null,
      stuur(b) {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Precies één welkom per verbinding: de server stuurt hem, een tweede (bv. van de kern) valt weg.
        if (b && /** @type {any} */ (b).t === 'welkom') { if (welkomGestuurd) return; welkomGestuurd = true; }
        const t = veiligJson(b);
        if (t !== null) try { ws.send(t); } catch { /* weg */ }
      },
      sluit() {
        try { if (vervangen.has(ws)) ws.close(4001, 'vervangen'); else ws.close(1000, 'gesloten door hub'); } catch { ws.terminate(); }
      },
    };
    /** Mag deze hallo door? Zo nee: weigeren en sluiten (zie boven). @param {{ app: string, inst: string }} h */
    const halloToegestaan = (h) => {
      if (v.app && v.app !== h.app) return true;               // de kern weigert dit zelf
      const nu = huidige.get(h.app);
      const ander = nu && nu.ws !== ws && nu.ws.readyState === WebSocket.OPEN ? nu : null;
      if (ander && ander.inst !== h.inst) {
        if (verdrongen.get(h.app)?.has(h.inst)) {
          v.stuur({ t: 'fout', reden: `vervangen: ${h.app} is al verbonden vanuit een andere instantie (tab); sluit die om deze te gebruiken` });
          vervangen.add(ws);
          v.sluit?.();
          return false;
        }
        markeerVerdrongen(h.app, ander.inst);
        vervangen.add(ander.ws);
      }
      verdrongen.get(h.app)?.delete(h.inst);
      huidige.set(h.app, { ws, inst: h.inst });
      return true;
    };
    let gehallood = false;
    let dicht = false;
    v.stuur({ t: 'welkom', hub: 'varve-hub', v: 1 });
    if (bijKern) veilig('kern.verbind', () => kern.verbind(v));
    ws.on('message', (data, binair) => {
      if (geweigerd) return;
      levend.add(ws);
      if (binair) return v.stuur({ t: 'fout', reden: 'alleen tekstberichten (JSON)' });
      const r = leesVanApp(String(data));
      if (!r.ok) return v.stuur({ t: 'fout', reden: r.fout });
      if ('onbekend' in r) return;
      if (!gehallood && r.bericht.t !== 'hallo') return v.stuur({ t: 'fout', reden: 'eerst hallo sturen' });
      let bericht = r.bericht;
      if (bericht.t === 'hallo') {
        const { token: gegeven, ...zonderToken } = bericht;
        bericht = zonderToken;                                   // het token gaat nooit naar de kern (of een logboek)
        if (!bijKern) {
          if (!tokenKlopt(gegeven, /** @type {string} */ (token))) {
            v.stuur({ t: 'fout', reden: `token nodig: verbind met ?token=… of stuur token in hallo (${gegeven === undefined ? 'geen token' : 'verkeerd token'})` });
            geweigerd = true;
            try { ws.close(CLOSE_TOKEN, 'token nodig'); } catch { ws.terminate(); }
            return;
          }
          bijKern = true;
          veilig('kern.verbind', () => kern.verbind(v));
        }
        if (!halloToegestaan(bericht)) return;
        gehallood = true;
      }
      const b = bericht;
      veilig('kern.ontvang', () => kern.ontvang(v, b));
    });
    ws.on('close', () => {
      if (dicht) return;
      dicht = true;
      for (const [app, h] of huidige) if (h.ws === ws) huidige.delete(app);
      if (bijKern) veilig('kern.verbreek', () => kern.verbreek(v));
    });
  });

  // /cockpit — kern-events eenmaal aanmelden, verdelen over alle cockpits.
  const uitzender = new CockpitUitzender({ beeld: () => kern.beeld(), maxAchterstand });
  const afmelden = [
    kern.bij('beeld', () => uitzender.beeld()),
    kern.bij('leds', (/** @type {any} */ x) => uitzender.leds(x)),
    kern.bij('invoer', (/** @type {unknown} */ g) => uitzender.invoer(g)),
  ];
  wssCockpit.on('connection', (ws) => {
    levend.add(ws);
    ws.on('pong', () => levend.add(ws));
    ws.on('error', () => {});
    const stuur = (/** @type {object} */ b) => { if (ws.readyState === WebSocket.OPEN) try { ws.send(JSON.stringify(b)); } catch { /* weg */ } };
    uitzender.voegToe(ws);
    /** Toetsen die deze cockpit virtueel ingedrukt houdt (noten én de voetschakelaar, CC64 op de APC):
     *  bij wegvallen loslaten, anders blijft een knop "hangen" (§10). Faders en knoppen zijn geen toetsen. */
    const ingedrukt = new Map();
    ws.on('message', (data, binair) => {
      levend.add(ws);
      if (binair) return stuur({ t: 'fout', reden: 'alleen tekstberichten (JSON)' });
      const r = leesVanCockpit(String(data));
      if (!r.ok) return stuur({ t: 'fout', reden: r.fout });
      if ('virtueel' in r) {
        const { dev, bytes } = r.virtueel;
        const st = bytes[0] & 0xf0, sleutel = `${dev}:${bytes[0] & 0x0f}:${bytes[1]}`;
        if (st === 0x90 && bytes[2] > 0) ingedrukt.set(sleutel, { dev, bytes: [0x80 | (bytes[0] & 0x0f), bytes[1], 0] });
        else if (st === 0x80 || st === 0x90) ingedrukt.delete(sleutel);
        else if (st === 0xb0 && dev === 'apc40' && vindCC(bytes[1], bytes[0] & 0x0f)?.soort === 'voet') {
          // Zelfde drempel als APC.ontleed: ≥ 64 = ingetrapt.
          const cc = `${dev}:cc${bytes[0] & 0x0f}:${bytes[1]}`;
          if (bytes[2] >= 64) ingedrukt.set(cc, { dev, bytes: [bytes[0], bytes[1], 0] });
          else ingedrukt.delete(cc);
        }
        return veilig('opVirtueel', () => opVirtueel?.(dev, bytes));
      }
      if ('kern' in r) veilig('kern.cockpit', () => kern.cockpit(r.kern));
    });
    ws.on('close', () => {
      uitzender.verwijder(ws);
      for (const { dev, bytes } of ingedrukt.values()) veilig('opVirtueel (loslaten)', () => opVirtueel?.(dev, bytes));
      ingedrukt.clear();
    });
  });

  // Half-open TCP opruimen: wie twee pings lang niets laat horen, wordt afgesloten (sluiten → verbreek).
  const pinger = pingMs > 0 ? setInterval(() => {
    for (const wss of [wssApp, wssCockpit]) for (const ws of wss.clients) {
      if (!levend.has(ws)) { ws.terminate(); continue; }
      levend.delete(ws);
      try { ws.ping(); } catch { /* weg */ }
    }
  }, pingMs) : null;
  pinger?.unref();

  try {
    await new Promise((goed, fout) => {
      server.once('error', fout);
      server.listen(poort, host, () => { server.off('error', fout); goed(undefined); });
    });
  } catch (e) {
    // Niets achterlaten op de kern: een volgende poging (andere poort) begint schoon.
    if (pinger) clearInterval(pinger);
    for (const f of afmelden) if (typeof f === 'function') f();
    uitzender.sluit();
    wssApp.close();
    wssCockpit.close();
    throw e;
  }
  server.on('error', (e) => console.error('[server] fout:', e));
  const info = /** @type {import('node:net').AddressInfo} */ (server.address());
  const hostInUrl = info.family === 'IPv6' ? `[${info.address}]` : info.address;

  let gestopt = false;
  return {
    adres: `http://${hostInUrl}:${info.port}`,
    poort: info.port,
    tokenVereist: !!token,
    async stop() {
      if (gestopt) return;
      gestopt = true;
      if (pinger) clearInterval(pinger);
      for (const f of afmelden) if (typeof f === 'function') f();
      uitzender.sluit();
      for (const wss of [wssApp, wssCockpit]) for (const ws of wss.clients) ws.terminate();
      await Promise.all([wssApp, wssCockpit].map((wss) => new Promise((r) => wss.close(() => r(undefined)))));
      server.closeAllConnections();
      await new Promise((r) => server.close(() => r(undefined)));
    },
  };
}
