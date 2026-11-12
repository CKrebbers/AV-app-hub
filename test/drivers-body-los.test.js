// @ts-check
// Antwoorden waarvan de driver de body niet leest, worden afgebroken (laatBodyLos in src/drivers/basis.js).
// Waarom: bij de repetitie (nov) viel node om met "AssertionError … assert(!this.paused) at Parser.finish" (undici)
// toen een body ongelezen bleef liggen en de server (python3 http.server) daarna de verbinding sloot. In de hub zou
// zo'n fout onafgehandeld zijn: de hub valt om (src/cli.js valOm). De bruggen antwoorden nu kort ('{}'), en dan
// gebeurt het niet; maar een app die ooit een lange foutpagina terugstuurt, mag de hub niet laten vallen.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NepKlok } from '../src/core/klok.js';
import { maakDriver, APPS_MAP } from '../src/drivers/index.js';
import { laatBodyLos } from '../src/drivers/basis.js';

const leesApp = (/** @type {string} */ n) => JSON.parse(readFileSync(join(APPS_MAP, n), 'utf8'));
const rust = () => new Promise((r) => setImmediate(r));

/** Een antwoord met een body die bijhoudt of hij is afgebroken. @param {boolean} ok @param {string} tekst */
function antwoord(ok, tekst) {
  const r = {
    ok, status: ok ? 200 : 500, afgebroken: false, gelezen: false,
    body: { cancel: async () => { r.afgebroken = true; } },
    text: async () => { r.gelezen = true; return tekst; },
  };
  return r;
}

const nepKern = { verbind() {}, ontvang() {}, verbreek() {} };

describe('laatBodyLos', () => {
  it('breekt een body af; nep-antwoorden zonder body, null en een cancel die weigert geven geen fout', async () => {
    const r = antwoord(true, '');
    laatBodyLos(r);
    expect(r.afgebroken).toBe(true);
    expect(() => laatBodyLos({ ok: true })).not.toThrow();
    expect(() => laatBodyLos(null)).not.toThrow();
    let gevangen = false;
    const weigert = { body: { cancel: () => ({ catch: () => { gevangen = true; } }) } };
    laatBodyLos(weigert);
    expect(gevangen).toBe(true);
    expect(() => laatBodyLos({ body: { cancel: () => { throw new Error('al gelezen'); } } })).not.toThrow();
  });
});

describe('HTTP-driver: POST /verb leest de body niet, en breekt hem dus af', () => {
  it('na een geslaagde en na een mislukte POST is de body afgebroken; GET / leest hem (tabs)', async () => {
    const klok = new NepKlok();
    /** @type {{ url: string, methode: string, r: ReturnType<typeof antwoord> }[]} */
    const oproepen = [];
    let verbOk = true;
    const fetch = /** @type {any} */ (async (/** @type {string} */ url, /** @type {any} */ init = {}) => {
      const methode = init.method ?? 'GET';
      const r = methode === 'POST' ? antwoord(verbOk, '{}') : antwoord(true, 'Uurwerk-brug. tabs: 1\n');
      oproepen.push({ url, methode, r });
      return r;
    });
    const d = maakDriver(leesApp('uurwerk.json'), { klok, fetch, config: {}, log: () => {} });
    d.start(/** @type {any} */ (nepKern));
    await rust(); await rust();
    d.verbinding.stuur({ t: 'zet', id: 'dicht', v: 0.3 });
    klok.loop(1000); await rust(); await rust();
    verbOk = false;
    d.verbinding.stuur({ t: 'zet', id: 'dicht', v: 0.7 });
    klok.loop(1000); await rust(); await rust();
    const posts = oproepen.filter((o) => o.methode === 'POST');
    expect(posts.length).toBeGreaterThanOrEqual(2);
    expect(posts.every((o) => o.r.afgebroken)).toBe(true);
    const check = oproepen.find((o) => o.methode === 'GET' && o.url.endsWith('/'));
    expect(check?.r.gelezen).toBe(true);
    d.stop();
  });
});

describe('TD-driver: een bridge die geen 200 geeft', () => {
  it('de body van het foutantwoord wordt afgebroken', async () => {
    const klok = new NepKlok();
    /** @type {ReturnType<typeof antwoord>[]} */
    const antwoorden = [];
    const fetch = /** @type {any} */ (async () => { const r = antwoord(false, '<html>' + 'x'.repeat(1000) + '</html>'); antwoorden.push(r); return r; });
    const d = maakDriver(leesApp('td-lab.json'), { klok, fetch, config: { apps: { 'td-lab': { poort: 9981 } } }, log: () => {} });
    d.start(/** @type {any} */ (nepKern));
    for (let i = 0; i < 5; i++) await rust();
    expect(antwoorden.length).toBeGreaterThanOrEqual(1);
    expect(antwoorden.every((r) => r.afgebroken && !r.gelezen)).toBe(true);
    d.stop();
  });
});
