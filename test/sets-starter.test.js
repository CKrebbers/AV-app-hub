// @ts-check
// De starter met een nep-wereld: echte kern, nep-klok, nep-processen, nep-Chrome, nep-poorten.
// Getoetst wordt wat Clay merkt: wat er start, wat er opengaat, wanneer, welke melding, wat er bij Ctrl-C stopt.
import { describe, it, expect } from 'vitest';
import { NepKlok } from '../src/core/klok.js';
import { Kern } from '../src/core/kern.js';
import { kernToegang, startSet, STOP_MS } from '../src/sets/index.js';
import { CONFIG, NepApp, maakOppervlak, manifest, P } from './spec/hulp.js';

const HUB_POORT = 7700;
const HUB = `ws://localhost:${HUB_POORT}/app`;
const PADEN = { 'formula-lab': '/repos/formula-lab', medisynth: '/repos/medisynth', uurwerk: '/repos/uurwerk', 'av-kern': '/repos/av-kern', 'td-lab': '/repos/td-lab' };
const FL = CONFIG.apps['formula-lab'].poort;
const MS = CONFIG.apps.medisynth.poort;
const UW = CONFIG.apps.uurwerk.poort;
const AK = CONFIG.apps['av-kern'].poort;

const flManifest = manifest('formula-lab', [P.fader('a', { standaard: 0.5 }), P.schakelaar('smooth', { standaard: 0 }), P.trigger('take')], { truth: 'app', hb_s: 1 });
const msManifest = manifest('medisynth', [P.knop('ruimte', { standaard: 0.5 }), P.fader('niveau', { standaard: 1 })], { truth: 'app', hb_s: 1 });

class NepProces {
  /** @param {{ commando: string, cwd: string, omgeving: Record<string, string> }} o */
  constructor(o) {
    this.o = o;
    this.pid = 4242;
    /** @type {Record<string, ((x: any) => void)[]>} */
    this.l = { uitvoer: [], einde: [] };
    this.levend = true;
    /** Na SIGTERM dood? (false = een proces dat blijft hangen) */
    this.luistert = true;
    /** @type {string[]} */
    this.seinen = [];
  }
  /** @param {'uitvoer'|'einde'} n @param {(x: any) => void} fn */
  bij(n, fn) { this.l[n].push(fn); }
  /** @param {string} [s] */
  stop(s = 'SIGTERM') { this.seinen.push(s); if (this.luistert || s === 'SIGKILL') this.levend = false; }
  leeft() { return this.levend; }
  /** @param {string} t */
  zeg(t) { for (const f of this.l.uitvoer) f(t); }
  /** Het commando zelf eindigt; `groepLeeft`: wat het op de achtergrond zette, draait door (start.sh). @param {number} code */
  eindig(code, groepLeeft = false) { if (!groepLeeft) this.levend = false; for (const f of this.l.einde) f({ code }); }
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** @param {any} set @param {{ paden?: Record<string, string>, bestaat?: (p: string) => boolean, zonderChrome?: boolean }} [o] */
function wereld(set, o = {}) {
  const klok = new NepKlok();
  const kern = new Kern({ klok, config: CONFIG, oppervlak: maakOppervlak() });
  const bank = /** @type {any} */ ({ kern });
  /** @type {Set<number>} */
  const poorten = new Set();
  /** @type {string[]} */
  const geopend = [];
  /** @type {NepProces[]} */
  const processen = [];
  /** @type {string[]} */
  const log = [];
  /** @type {Map<string, NepApp>} */
  const apps = new Map();
  const s = startSet({
    set, config: CONFIG, paden: o.paden ?? PADEN, hub: kernToegang(kern), hubPoort: HUB_POORT, klok,
    startProces: (x) => { const p = new NepProces(x); processen.push(p); return p; },
    openUrl: o.zonderChrome ? null : (u) => { geopend.push(u); },
    // Pas kijken na de synchrone opzet van de test (een echte poortcontrole duurt ook even).
    poortOpen: async (p) => { await null; return poorten.has(p); },
    bestaat: o.bestaat ?? (() => true),
    log: (r) => log.push(r),
  });
  /** Laat tijd verstrijken; levende nep-apps houden hun hartslag bij. @param {number} ms */
  const tijd = async (ms) => {
    await flush();
    for (let t = 0; t < ms; t += 50) {
      klok.loop(Math.min(50, ms - t));
      for (const a of apps.values()) if (a.levend && a.verbonden) a.hb();
      await flush();
    }
  };
  /** Een app die verbindt (hallo, manifest, staat). @param {any} m @param {Record<string, number>} w @param {{ manifest?: boolean }} [x] */
  const verbind = (m, w, x) => { const a = new NepApp(bank, m, w).verbind(x); apps.set(m.app, a); return a; };
  return { s, klok, kern, poorten, geopend, processen, log, tijd, verbind, tekst: () => log.join('\n') };
}

describe('starter: een set klaarzetten', () => {
  const set = {
    naam: 'Proef',
    apps: {
      'formula-lab': { start: { commando: 'npm run dev -- --port {poort} --strictPort' }, url: 'http://localhost:{poort}/?hub={hub}' },
      medisynth: { start: { commando: 'npm run dev', map: 'app', omgeving: { HUB: '{hub}', P: '{poort}' } }, url: 'http://localhost:{poort}/?hub={hub}' },
    },
    snapshot: { 'formula-lab': { a: 0.25, smooth: 1 }, medisynth: { ruimte: 0.8 } },
    focus: 'medisynth',
  };

  it('start elk commando in de map van zijn repo met poort en hub ingevuld; Chrome pas als de poort open is', async () => {
    const w = wereld(set);
    await w.tijd(0);
    expect(w.processen.map((p) => p.o)).toEqual([
      { commando: `npm run dev -- --port ${FL} --strictPort`, cwd: '/repos/formula-lab', omgeving: {} },
      { commando: 'npm run dev', cwd: '/repos/medisynth/app', omgeving: { HUB: HUB, P: String(MS) } },
    ]);
    expect(w.geopend).toEqual([]);                      // nog niets luistert: geen foutpagina in Chrome
    w.poorten.add(FL);
    await w.tijd(300);
    expect(w.geopend).toEqual([`http://localhost:${FL}/?hub=${HUB}`]);
    w.poorten.add(MS);
    await w.tijd(300);
    expect(w.geopend).toEqual([`http://localhost:${FL}/?hub=${HUB}`, `http://localhost:${MS}/?hub=${HUB}`]);
    expect(w.geopend.length).toBe(2);                    // één keer per app, ook al kijkt de starter elke tik
    await w.s.stop();
  });

  it('wacht tot elke app zich meldt; daarna de beginsnapshot (alleen de app die het betreft) en de beginfocus', async () => {
    const w = wereld(set);
    await w.tijd(0);
    w.poorten.add(FL); w.poorten.add(MS);
    await w.tijd(300);
    const fl = w.verbind(flManifest, { a: 0.5, smooth: 0 });
    await w.tijd(1000);
    expect(fl.zetten()).toEqual([]);                     // nog niet: medisynth is er nog niet
    const ms = w.verbind(msManifest, { ruimte: 0.5, niveau: 1 });
    await w.tijd(1000);
    const u = await w.s.klaar;
    expect(u.map((x) => [x.app, x.hoe, x.klaar])).toEqual([['formula-lab', 'gestart', true], ['medisynth', 'gestart', true]]);
    expect(fl.zetten().map((b) => [b.id, b.v])).toEqual([['a', 0.25], ['smooth', 1]]);
    expect(ms.zetten().map((b) => [b.id, b.v])).toEqual([['ruimte', 0.8]]);
    expect(w.kern.beeld().focus).toBe('medisynth');
    expect(ms.focus()).toBe(true);
    expect(fl.focus()).toBe(false);
    expect(w.tekst()).toMatch(/Set "Proef": 2\/2 klaar/);
    await w.s.stop();
  });

  it('app die al draait wordt niet opnieuw gestart: poort bezet → alleen de URL; al verbonden → niets', async () => {
    // formula-lab: tab al open en verbonden; medisynth: alleen de dev-server draait (nog geen tab)
    const w = wereld(set);
    w.poorten.add(FL); w.poorten.add(MS);
    w.verbind(flManifest, { a: 0.5, smooth: 0 });
    await w.tijd(300);
    expect(w.processen).toEqual([]);
    expect(w.geopend).toEqual([`http://localhost:${MS}/?hub=${HUB}`]);
    expect(w.tekst()).toMatch(/formula-lab: draait al en is verbonden — niet opnieuw gestart/);
    expect(w.tekst()).toMatch(new RegExp(`medisynth: poort ${MS} is al bezet — draait al, niet opnieuw gestart`));
    w.verbind(msManifest, { ruimte: 0.5, niveau: 1 });
    await w.tijd(1000);
    expect((await w.s.klaar).map((x) => x.hoe)).toEqual(['al verbonden', 'draaide al']);
    await w.s.stop();
    expect(w.tekst()).not.toMatch(/Gestopt:/);           // niets van zichzelf om op te ruimen
  });

  it('een driver-app die de hub al kent maar waarvan de poort dicht is, telt niet als "draait al"', async () => {
    const w = wereld({ naam: 'Uur', apps: { uurwerk: { start: { commando: './start.sh' }, url: null } } });
    // De HTTP-driver meldt uurwerk aan, ook als de brug er (nog) niet is.
    w.verbind(manifest('uurwerk', [P.fader('licht')], { truth: 'hub', hb_s: 2 }), {});
    await w.tijd(0);
    expect(w.processen.map((p) => p.o.commando)).toEqual(['./start.sh']);
    // start.sh zet alles op de achtergrond en stopt meteen met code 0: geen fout.
    w.processen[0].eindig(0, true);
    await w.tijd(500);
    expect(w.s.uitslag()[0].melding).toBe('bezig');
    w.poorten.add(UW);
    await w.tijd(300);
    expect((await w.s.klaar)[0]).toMatchObject({ app: 'uurwerk', klaar: true });
    // Ctrl-C: de groep van start.sh (webserver + brug) leeft nog en gaat dicht.
    const stop = w.s.stop();
    await w.tijd(200);
    await stop;
    expect(w.processen[0].seinen).toEqual(['SIGTERM']);
    expect(w.processen[0].leeft()).toBe(false);
  });
});

describe('starter: als het misgaat, per app een melding die zegt waar het hangt', () => {
  it('time-out per app; de andere apps krijgen gewoon hun snapshot en focus', async () => {
    const set = {
      naam: 'Mis', time_out_s: 5,
      apps: {
        'formula-lab': { start: { commando: 'npm run dev' }, url: 'http://localhost:{poort}/?hub={hub}' },
        medisynth: { start: { commando: 'npm run dev' }, url: 'http://localhost:{poort}/?hub={hub}', time_out_s: 20 },
      },
      snapshot: { 'formula-lab': { a: 0.1 }, medisynth: { ruimte: 0.9 } },
      focus: 'formula-lab',
    };
    const w = wereld(set);
    await w.tijd(0);
    w.poorten.add(FL); w.poorten.add(MS);
    w.processen[0].zeg('VITE v5 ready\n  ➜  Local: http://localhost:5174/\n');
    await w.tijd(5100);
    expect(w.s.uitslag()[0].melding).toMatch(new RegExp(`niet klaar binnen 5 s — meldt zich niet bij de hub — is de tab open met die URL, en heeft deze versie van de app de hub-koppeling\\?; laatste uitvoer:\\n.*VITE v5 ready`));
    expect(w.s.uitslag()[1].melding).toBe('bezig');      // eigen, langere time-out
    const ms = w.verbind(msManifest, { ruimte: 0.5, niveau: 1 });
    await w.tijd(1000);
    const u = await w.s.klaar;
    expect(u.map((x) => x.klaar)).toEqual([false, true]);
    expect(ms.zetten().map((b) => [b.id, b.v])).toEqual([['ruimte', 0.9]]);
    expect(w.tekst()).toMatch(/snapshot formula-lab: overgeslagen \(app niet klaar\)/);
    expect(w.tekst()).toMatch(/focus: formula-lab is niet klaar — focus blijft medisynth/);
    expect(w.tekst()).toMatch(/formula-lab: MIS — niet klaar binnen 5 s/);
    expect(w.tekst()).toMatch(/1\/2 klaar — niet klaar: formula-lab/);
    await w.s.stop();
  });

  it('poort gaat niet open → dat staat er; hallo zonder manifest → dat staat er', async () => {
    const w = wereld({ naam: 'X', time_out_s: 2, apps: { 'formula-lab': { start: { commando: 'x' } }, medisynth: { start: { commando: 'y' } } } });
    w.poorten.add(MS);
    await w.tijd(0);
    w.verbind(msManifest, {}, { manifest: false });
    await w.tijd(2500);
    const u = await w.s.klaar;
    expect(u[0].melding).toMatch(new RegExp(`niet klaar binnen 2 s — poort ${FL} gaat niet open`));
    expect(u[1].melding).toMatch(/zei hallo, maar stuurde geen geldig manifest/);
    await w.s.stop();
  });

  it('een commando dat met een fout stopt: meteen gemeld met de laatste uitvoer, zonder op de time-out te wachten', async () => {
    const w = wereld({ naam: 'X', apps: { 'formula-lab': { start: { commando: 'npm run dev' } } } });
    await w.tijd(0);
    w.processen[0].zeg('Error: Port 5174 is already in use\n');
    w.processen[0].eindig(1);
    await w.tijd(300);
    const u = await w.s.klaar;
    expect(w.klok.nu()).toBeLessThan(1000);
    expect(u[0].melding).toMatch(/het startcommando stopte met code 1; laatste uitvoer:\n\s+Error: Port 5174 is already in use/);
  });

  it('geen pad in sets/paden.json, of een map die niet bestaat → niet gestart, met verwijzing naar het voorbeeld', async () => {
    const w = wereld({ naam: 'X', apps: { 'formula-lab': { start: { commando: 'x' } } } }, { paden: {} });
    await w.tijd(0);
    expect(w.processen).toEqual([]);
    expect((await w.s.klaar)[0]).toMatchObject({ hoe: 'niet gestart', klaar: false, melding: 'geen map voor repo "formula-lab" in sets/paden.json (voorbeeld: sets/paden.voorbeeld.json)' });
    const v = wereld({ naam: 'X', apps: { 'formula-lab': { start: { commando: 'x' } } } }, { bestaat: () => false });
    expect((await v.s.klaar)[0].melding).toMatch(/map \/repos\/formula-lab bestaat niet/);
  });

  it('snapshot: een onbekende parameter of een trigger wordt gemeld en overgeslagen', async () => {
    const w = wereld({ naam: 'X', apps: { 'formula-lab': { start: { commando: 'x' } } }, snapshot: { 'formula-lab': { a: 0.3, b: 0.5, take: 1 } } });
    w.poorten.add(FL);
    await w.tijd(0);
    const fl = w.verbind(flManifest, { a: 0.5, smooth: 0 });
    await w.tijd(1000);
    await w.s.klaar;
    expect(fl.zetten().map((b) => b.id)).toEqual(['a']);
    expect(fl.trigs()).toEqual([]);
    expect(w.tekst()).toMatch(/snapshot formula-lab\.b: geen parameter met die id in het manifest \(wel: a, smooth, take\)/);
    expect(w.tekst()).toMatch(/snapshot formula-lab\.take: is een trigger — overgeslagen/);
    await w.s.stop();
  });
});

describe('starter: soorten apps', () => {
  it('wacht "poort" (av-kern vóór 25 okt): klaar als de poort open is, zonder hub; Chrome gaat open', async () => {
    const w = wereld({ naam: 'X', apps: { 'av-kern': { start: { commando: 'npm run dev', omgeving: { BROWSER: 'none' } }, url: 'http://localhost:{poort}/?hub={hub}', wacht: 'poort', opmerking: 'hub-koppeling pas na 25 okt' } } });
    await w.tijd(0);
    expect(w.processen[0].o.omgeving).toEqual({ BROWSER: 'none' });
    w.poorten.add(AK);
    await w.tijd(300);
    expect((await w.s.klaar)[0]).toMatchObject({ app: 'av-kern', klaar: true });
    expect(w.geopend).toEqual([`http://localhost:${AK}/?hub=${HUB}`]);
    expect(w.tekst()).toMatch(/av-kern: hub-koppeling pas na 25 okt/);
    expect(w.tekst()).toMatch(new RegExp(`av-kern: klaar \\(poort ${AK} open\\)`));
    await w.s.stop();
  });

  it('zonder Chrome (--zonder-chrome): de URL staat in de uitvoer, op hetzelfde moment', async () => {
    const w = wereld({ naam: 'X', apps: { 'formula-lab': { start: { commando: 'x' }, url: 'http://localhost:{poort}/?hub={hub}' } } }, { zonderChrome: true });
    await w.tijd(0);
    expect(w.tekst()).not.toMatch(/open zelf/);
    w.poorten.add(FL);
    await w.tijd(300);
    expect(w.tekst()).toMatch(new RegExp(`formula-lab: open zelf in Chrome → http://localhost:${FL}/\\?hub=${HUB}`));
    await w.s.stop();
  });

  it('handmatig (TD): niets gestart, de instructie met de map uit paden.json; klaar zodra hij zich meldt', async () => {
    const w = wereld({ naam: 'X', apps: { 'td-lab': { handmatig: 'open {repo}/project.toe in TouchDesigner' } } });
    await w.tijd(0);
    expect(w.processen).toEqual([]);
    expect(w.tekst()).toMatch(/td-lab: start niet vanzelf — open \/repos\/td-lab\/project\.toe in TouchDesigner/);
    w.verbind(manifest('td-lab', [P.fader('x')], { hb_s: 1 }), { x: 0 });
    await w.tijd(500);
    expect((await w.s.klaar)[0]).toMatchObject({ hoe: 'handmatig', klaar: true });
  });
});

describe('starter: Ctrl-C ruimt op wat hij zelf startte', () => {
  it('SIGTERM naar eigen processen; wie blijft hangen krijgt na STOP_MS SIGKILL; wat al draaide blijft', async () => {
    const w = wereld({ naam: 'X', apps: { 'formula-lab': { start: { commando: 'x' } }, medisynth: { start: { commando: 'y' } }, uurwerk: { start: { commando: './start.sh' } } } });
    w.poorten.add(UW);                                  // uurwerk draaide al
    await w.tijd(0);
    expect(w.processen.map((p) => p.o.commando)).toEqual(['x', 'y']);
    w.processen[1].luistert = false;                    // medisynth reageert niet op SIGTERM
    const stop = w.s.stop();
    await w.tijd(STOP_MS - 100);
    expect(w.processen[0].seinen).toEqual(['SIGTERM']);
    expect(w.processen[1].seinen).toEqual(['SIGTERM']);
    await w.tijd(200);
    await stop;
    expect(w.processen[1].seinen).toEqual(['SIGTERM', 'SIGKILL']);
    expect(w.tekst()).toMatch(/medisynth: stopt niet na 3 s — SIGKILL/);
    expect(w.tekst()).toMatch(/Gestopt: formula-lab, medisynth$/m);
    // Stoppen tijdens het wachten beëindigt ook de wachtlus.
    const u = await w.s.klaar;
    expect(u.map((x) => x.melding)).toEqual(['gestopt', 'gestopt', 'gestopt']);
  });
});
