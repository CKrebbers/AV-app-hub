// @ts-check
// `varve-hub start --blijf`: valt de hub om, dan start de bewaker hem opnieuw (begrensd). Met een echt proces
// (kill -9 op de hub zelf) en met nep-kinderen voor de grenzen (crash-lus, vaste fout, netjes stoppen).
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { NepKlok } from '../src/core/klok.js';
import { bewaker, BLIJF_MAX } from '../src/blijf.js';
import { NepApp, voorbeeldManifest } from '../tools/nep-app.mjs';
import { startHubProces, ruimProcessenOp, cockpit, vrijePoort, maakMap, tot } from './herstart-hulp.js';

/** @type {(() => unknown)[]} */
const opruimen = [];
/** @type {number[]} hubs die de bewaker startte (alleen die van deze tests) */
const kinderen = [];
afterEach(async () => {
  for (const f of opruimen.splice(0).reverse()) await f();
  await ruimProcessenOp();
  for (const pid of kinderen.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* al weg */ } }
});

const leeft = (/** @type {number} */ pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe('start --blijf (echt proces)', () => {
  it('kill -9 op de hub: de bewaker start hem opnieuw, de app komt terug in zijn slot; SIGTERM stopt alles netjes', async () => {
    const poort = await vrijePoort();
    const staat = join(maakMap(), 'staat.json');
    const b = await startHubProces({ poort, staat, extra: ['--blijf'] });
    const eerste = Number(/proces (\d+)\)/.exec(await b.wachtOp(/bewaker: hub gestart \(proces \d+\)/))?.[1]);
    kinderen.push(eerste);
    let c = await cockpit(poort);
    const app = new NepApp({ url: `ws://127.0.0.1:${poort}/app`, manifest: voorbeeldManifest('app-x'), inst: 'x-1' }).start();
    opruimen.push(() => app.stop());
    await tot(() => c.beeld.apps.some((/** @type {any} */ a) => a.app === 'app-x' && a.status === 'actief'));
    const slot = c.beeld.apps.find((/** @type {any} */ a) => a.app === 'app-x').slot;
    await new Promise((r) => setTimeout(r, 1200));         // slot naar het geheugen
    c.sluit();

    process.kill(eerste, 'SIGKILL');
    await b.wachtOp(/bewaker: de hub viel om \(door SIGKILL\) — over 1 s opnieuw \(1\/5/);
    const tweede = Number(/proces (\d+)\) — herstart 1/.exec(await b.wachtOp(/bewaker: hub gestart \(proces \d+\) — herstart 1/))?.[1]);
    kinderen.push(tweede);
    expect(tweede).not.toBe(eerste);
    await b.wachtOp(/De vorige hub stopte niet netjes/);
    await b.wachtOp(/varve-hub draait[\s\S]*varve-hub draait/);
    c = await cockpit(poort);
    // De app herverbindt vanzelf (backoff tot 5 s) en krijgt zijn slot terug.
    await tot(() => c.beeld.apps.some((/** @type {any} */ a) => a.app === 'app-x' && a.status === 'actief'), 10000);
    expect(c.beeld.apps.find((/** @type {any} */ a) => a.app === 'app-x').slot).toBe(slot);
    c.sluit();

    b.sein('SIGTERM');
    expect((await b.einde).code).toBe(0);
    expect(leeft(tweede)).toBe(false);
    expect(existsSync(`${staat}.loopt`)).toBe(false);       // netjes gestopt: de volgende start is geen herstart
  }, 40000);
});

describe('start --blijf met een set die niet bestaat (echt proces)', () => {
  it('meldt het één keer en stopt meteen (exit 1), zonder de hub te starten of het een crash-lus te noemen', async () => {
    const poort = await vrijePoort();
    const b = await startHubProces({ poort, staat: join(maakMap(), 'staat.json'), extra: ['bestaatniet', '--blijf'], klaar: null });
    const e = await b.einde;
    expect(e.code).toBe(1);
    expect(b.uitvoer().match(/onbekende set "bestaatniet"/g)).toHaveLength(1);
    expect(b.uitvoer()).not.toMatch(/bewaker:/);
  }, 20000);
});

/** Nep-kinderen: elke start geeft een kind dat de test laat eindigen. */
function nepWereld() {
  const klok = new NepKlok();
  /** @type {(EventEmitter & { pid: number, seinen: string[], kill: (s: string) => void })[]} */
  const kids = [];
  const sig = new EventEmitter();
  /** @type {string[]} */
  const log = [];
  const start = () => {
    const k = Object.assign(new EventEmitter(), { pid: 100 + kids.length, seinen: /** @type {string[]} */ ([]), kill: (/** @type {string} */ s) => { k.seinen.push(s); } });
    kids.push(k);
    return /** @type {any} */ (k);
  };
  const r = bewaker({ node: 'node', cli: 'cli.js', args: ['start'], klok, start, signalen: /** @type {any} */ (sig), log: (t) => log.push(t), wachtMs: 1000, vensterMs: 60000 });
  /** @param {number|null} code @param {string|null} [sein] */
  const valOm = (code, sein = null) => { /** @type {any} */ (kids.at(-1)).emit('exit', code, sein); };
  return { klok, kids, sig, log, r, valOm };
}

describe('bewaker (grenzen)', () => {
  it(`een crash-lus stopt na ${BLIJF_MAX} herstarts binnen het venster, met een melding`, async () => {
    const w = nepWereld();
    for (let i = 0; i < BLIJF_MAX; i++) { w.valOm(1); w.klok.loop(1000); }
    expect(w.kids).toHaveLength(BLIJF_MAX + 1);
    w.valOm(null, 'SIGSEGV');
    expect(await w.r).toEqual({ code: 1, herstarts: BLIJF_MAX });
    expect(w.log.at(-1)).toMatch(/viel 6 keer om binnen 60 s \(laatst door SIGSEGV\) — gestopt/);
  });

  it('valt hij af en toe om (verder uit elkaar dan het venster), dan blijft hij herstarten', async () => {
    const w = nepWereld();
    for (let i = 0; i < BLIJF_MAX * 2; i++) { w.valOm(1); w.klok.loop(61000); }
    expect(w.kids).toHaveLength(BLIJF_MAX * 2 + 1);
    w.sig.emit('SIGINT');
    expect(w.kids.at(-1)?.seinen).toEqual(['SIGINT']);
    w.valOm(0);
    expect(await w.r).toEqual({ code: 0, herstarts: BLIJF_MAX * 2 });
  });

  it('een vaste fout (poort bezet = 3) start niet opnieuw; netjes stoppen van de hub zelf (0) ook niet', async () => {
    const w = nepWereld();
    w.valOm(3);
    expect(await w.r).toEqual({ code: 3, herstarts: 0 });
    expect(w.log.at(-1)).toMatch(/vaste fout \(code 3\) — niet opnieuw gestart/);
    const w2 = nepWereld();
    w2.valOm(0);
    expect(await w2.r).toEqual({ code: 0, herstarts: 0 });
  });

  it('Ctrl-C dat dubbel binnenkomt (terminal + npm) gaat één keer naar de hub; een echte tweede Ctrl-C later wel', async () => {
    const w = nepWereld();
    w.sig.emit('SIGINT'); w.sig.emit('SIGINT');
    expect(w.kids[0].seinen).toEqual(['SIGINT']);
    w.klok.loop(1000);
    w.sig.emit('SIGINT');
    expect(w.kids[0].seinen).toEqual(['SIGINT', 'SIGINT']);
    w.valOm(1);                                            // zo stopt de hub bij een tweede Ctrl-C
    expect(await w.r).toEqual({ code: 1, herstarts: 0 });
  });

  it('Ctrl-C tussen een crash en de herstart: er start niets meer', async () => {
    const w = nepWereld();
    w.valOm(1);
    w.sig.emit('SIGINT');
    expect(await w.r).toEqual({ code: 0, herstarts: 1 });
    w.klok.loop(5000);
    expect(w.kids).toHaveLength(1);
    expect(w.sig.listenerCount('SIGINT')).toBe(0);
  });
});
