// @ts-check
// Oefenruimte: een gesimuleerde leerling doorloopt álle lessen tegen de echte hub (kern + server),
// met de echte oefen-apps (Zon, Zee) en de virtuele controllers via de cockpit — precies het pad
// dat de pagina in de browser gebruikt. Zo weten we dat elke les met het echte hubgedrag te halen is.
import { describe, it, expect, afterEach, vi } from 'vitest';
import WebSocket from 'ws';
import { startHub } from '../src/hub.js';
import { NepSysteem } from '../src/ports/nep.js';
import { laadConfig } from '../src/config.js';
import { valideerManifest } from '../src/protocol/manifest.js';
import { OP_ID } from '../src/devices/apc40mk2.js';
import { drukBytes, losBytes, ccBytes, lpdDruk, lpdLos, lpdKnop } from '../ui/midi.js';
import { OefenApp, MANIFESTEN, ZON, ZEE } from '../ui/oefen/apps.js';
import { Leraar, LESSEN, waarOpApc, beschrijfControl } from '../ui/oefen/lessen.js';

const wacht = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @template T @param {() => T} fn @param {number} [ms] @returns {Promise<T>} */
const tot = async (fn, ms = 4000) => { const eind = Date.now() + ms; while (Date.now() < eind) { const x = fn(); if (x) return x; await wacht(10); } return fn(); };
/** @type {(() => any)[]} */
const opruimen = [];
afterEach(async () => { for (const f of opruimen.splice(0)) await f(); });

async function opzet() {
  const hub = await startHub({ config: laadConfig(), systeem: new NepSysteem(), poort: 0, drivers: false, opname: false });
  opruimen.push(() => hub.stop());
  const ws = hub.adres.replace('http', 'ws');
  /** @type {Record<string, OefenApp>} */
  const apps = {};
  const leraar = new Leraar({ acties: { zelfZetten: (app, id, v) => apps[app].zelfZetten(id, v) }, nu: () => performance.now() });
  for (const m of [MANIFESTEN[ZON], MANIFESTEN[ZEE]]) {
    const a = new OefenApp({ manifest: m, url: `${ws}/app`, WebSocket });
    a.bij((b) => { if (!b.t.startsWith('_')) leraar.verwerk({ soort: 'app', app: a.app, b }); });
    a.start();
    opruimen.push(() => a.stop());
    apps[a.app] = a;
    await tot(() => hub.kern.beeld().apps.some((/** @type {any} */ x) => x.app === a.app)); // vaste volgorde: Zon slot 1
  }
  const cockpit = new WebSocket(`${ws}/cockpit`);
  opruimen.push(() => cockpit.close());
  cockpit.on('message', (d) => {
    const b = JSON.parse(String(d));
    if (b.t === 'beeld') leraar.verwerk({ soort: 'beeld', beeld: b });
    if (b.t === 'invoer') leraar.verwerk({ soort: 'invoer', g: b.g });
  });
  await new Promise((r) => cockpit.once('open', r));
  /** @param {'apc40'|'lpd8'} dev @param {number[]} bytes */
  const virtueel = (dev, bytes) => cockpit.send(JSON.stringify({ t: 'virtueel', dev, bytes }));
  const c = (/** @type {string} */ id) => /** @type {any} */ (OP_ID.get(id));
  const leerling = {
    druk: (/** @type {string} */ id) => virtueel('apc40', drukBytes(c(id))),
    los: (/** @type {string} */ id) => virtueel('apc40', losBytes(c(id))),
    async tik(/** @type {string} */ id) { this.druk(id); await wacht(20); this.los(id); await wacht(20); },
    async schuif(/** @type {string} */ id, /** @type {number} */ van, /** @type {number} */ naar, stap = 0.04) {
      const n = Math.max(1, Math.round(Math.abs(naar - van) / stap));
      for (let i = 0; i <= n; i++) { virtueel('apc40', ccBytes(c(id), van + (naar - van) * (i / n))); await wacht(8); }
    },
    async focus(/** @type {string} */ app) {
      const slot = hub.kern.beeld().apps.find((/** @type {any} */ a) => a.app === app).slot;
      this.druk('bank'); await wacht(20); await this.tik(`sel${slot}`); this.los('bank'); await wacht(30);
    },
    async knop(/** @type {number} */ k, /** @type {number} */ van, /** @type {number} */ naar, stap = 0.04) {
      const n = Math.max(1, Math.round(Math.abs(naar - van) / stap));
      for (let i = 0; i <= n; i++) { virtueel('lpd8', lpdKnop(k - 1, van + (naar - van) * (i / n))); await wacht(8); }
    },
    vast: (/** @type {number} */ p) => virtueel('lpd8', lpdDruk(p - 1)),
    laatLos: (/** @type {number} */ p) => virtueel('lpd8', lpdLos(p - 1)),
    async pad(/** @type {number} */ p, houdMs = 40) { virtueel('lpd8', lpdDruk(p - 1)); await wacht(houdMs); virtueel('lpd8', lpdLos(p - 1)); await wacht(30); },
  };
  return { hub, apps, leraar, leerling };
}

/** Wacht tot de huidige les klaar is; anders een duidelijke fout met waar het bleef hangen. @param {Leraar} l */
async function lesGehaald(l, ms = 4000) {
  await tot(() => l.lesKlaar, ms);
  if (!l.lesKlaar) throw new Error(`les "${l.les.id}" bleef hangen op stap "${l.stap?.id}": ${l.toestand().opdracht}`);
}

describe('oefenruimte: lessen en oefen-apps', () => {
  it('de manifesten van Zon en Zee zijn geldig', () => {
    for (const m of Object.values(MANIFESTEN)) expect(valideerManifest(m)).toMatchObject({ ok: true });
  });

  it('beschrijft waar een parameter op de APC zit, in gewone woorden', () => {
    expect(waarOpApc(ZON, 'gloed')).toBe('fader 1');
    expect(waarOpApc(ZON, 'draai')).toMatch(/^device-knop 1/);
    expect(waarOpApc(ZON, 'tint')).toBe('kolom 1 van het grid (3 pads onder elkaar: geel, oranje, rood)');
    expect(waarOpApc(ZON, 'stralen')).toBe('de pad in kolom 2, bovenste rij');
    expect(waarOpApc(ZEE, 'schuim')).toMatch(/^device-knop 2/);
    expect(beschrijfControl('pad1-3')).toBe('de pad in kolom 3, onderste rij');
  });

  it('een gesimuleerde leerling haalt elke les, van welkom tot glijden', async () => {
    const { hub, apps, leraar, leerling } = await opzet();
    const ids = LESSEN.map((l) => l.id);
    expect(ids).toEqual(['welkom', 'focus', 'fader', 'pickup', 'knop', 'pads', 'wisselen', 'lpd8', 'slew', 'snapshot', 'paniek', 'tempo', 'opname', 'glijden']);

    leraar.gaNaar(0);
    await lesGehaald(leraar);

    // focus: naar de andere app en weer terug
    leraar.volgende();
    expect(leraar.les.id).toBe('focus');
    await leerling.focus(leraar.mem.doel);
    await tot(() => leraar.stap?.id === 'terug');
    await leerling.focus(leraar.mem.doel);
    await lesGehaald(leraar);

    // fader: eerst (zo nodig) de Zon focus, dan fader 1 heen en weer, dan fader 2
    leraar.volgende();
    if (leraar.stap?.id === `focus-${ZON}`) await leerling.focus(ZON);
    await leerling.schuif('fader1', 0, 1); await leerling.schuif('fader1', 1, 0);
    await tot(() => leraar.stap?.id === 'grootte');
    await leerling.schuif('fader2', 0, 1); await leerling.schuif('fader2', 1, 0);
    await lesGehaald(leraar);

    // pickup: fader 1 omlaag; de app zet zichzelf op 0.8; langzaam omhoog → pakt rond 0.8 op
    leraar.volgende();
    await leerling.schuif('fader1', 0.3, 0);
    await tot(() => leraar.stap?.id === 'oppakken');
    await tot(() => hub.kern.beeld().apps.find((/** @type {any} */ a) => a.app === ZON).waarden.gloed === 0.8);
    await leerling.schuif('fader1', 0, 1, 0.02);
    await lesGehaald(leraar);
    expect(apps[ZON].waarden.gloed).toBeGreaterThan(0.79);

    // device-knop 1
    leraar.volgende();
    await leerling.schuif('dk1', 0, 0.8);
    await lesGehaald(leraar);

    // pads: schakelaar, trigger, keuze
    leraar.volgende();
    await leerling.tik('pad5-2');
    await tot(() => leraar.stap?.id === 'flits');
    await leerling.tik('pad4-2');
    await tot(() => leraar.stap?.id === 'tint');
    await leerling.tik('pad3-1');
    await lesGehaald(leraar);
    expect(apps[ZON].waarden.tint).toBe(1);

    // wisselen naar de Zee: fader 1 = Golf, device-knop 2 = Schuim
    leraar.volgende();
    await leerling.focus(ZEE);
    await leerling.schuif('fader1', 0, 1);
    await tot(() => leraar.stap?.id === 'schuim');
    await leerling.schuif('dk2', 0, 1);
    await lesGehaald(leraar);

    // LPD8 K2: Zon én Zee
    leraar.volgende();
    await leerling.knop(2, 0, 1);
    await lesGehaald(leraar);

    // slew: K3 draaien en loslaten; de Galm glijdt nog door
    leraar.volgende();
    await leerling.knop(3, 0, 1, 0.1);
    await lesGehaald(leraar, 5000);

    // snapshot: lang = bewaren, iets veranderen, kort = laden
    leraar.volgende();
    await leerling.pad(8, 800);
    await tot(() => leraar.stap?.id === 'veranderen');
    await leerling.knop(2, 1, 0);
    await tot(() => leraar.stap?.id === 'laden');
    await leerling.pad(8, 40);
    await lesGehaald(leraar);

    // paniek: pad 1 een seconde vast, dan los
    leraar.volgende();
    leerling.vast(1);
    await tot(() => leraar.stap?.id === 'los', 3000);
    expect(apps[ZON].triggers.paniek).toBe(true);
    leerling.laatLos(1);
    await lesGehaald(leraar);

    // tempo: tap op pad 2, dan K7
    leraar.volgende();
    for (let i = 0; i < 4; i++) { await leerling.pad(2, 20); await wacht(350); }
    await tot(() => leraar.stap?.id === 'adem', 3000);
    await leerling.knop(7, 0, 1);
    await lesGehaald(leraar);

    // opname: alleen lezen
    leraar.volgende();
    leraar.verwerk({ soort: 'knop' });
    await lesGehaald(leraar);
    expect(leraar.allesKlaar).toBe(false);

    // glijden: K3 draaien → de Galm glijdt (beeld.slews van de echte kern); loslaten → na slew_s is hij er
    leraar.volgende();
    expect(leraar.les.id).toBe('glijden');
    await leerling.knop(3, 1, 0, 0.1);
    await tot(() => leraar.stap?.id === 'aangekomen');
    expect(hub.kern.beeld().slews).toEqual([expect.objectContaining({ app: ZEE, id: 'galm' })]);
    await lesGehaald(leraar, 5000);
    expect(hub.kern.beeld().slews).toEqual([]);
    expect(apps[ZEE].waarden.galm).toBe(hub.kern.beeld().apps.find((/** @type {any} */ a) => a.app === ZEE).waarden.galm);
    expect(leraar.allesKlaar).toBe(true);
    expect(leraar.toestand().gehaald).toHaveLength(LESSEN.length);
  }, 40000);

  it('glijden-les: telt alleen een slew van de Galm van de Zee, en is klaar als die weg is uit het beeld', () => {
    const l = new Leraar({ nu: () => 0 });
    const apps = [{ app: ZON, naam: 'Zon', slot: 1 }, { app: ZEE, naam: 'Zee', slot: 2 }];
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps, slews: [], nu: 0 } });
    l.gaNaar(LESSEN.findIndex((x) => x.id === 'glijden'));
    expect(l.lesIndex).toBe(LESSEN.length - 1);              // achteraan: de andere lessen houden hun nummer
    expect(l.toestand().wijs).toEqual(['lpd:k3']);
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps, slews: [{ app: ZON, id: 'gloed', doel: 1, eindMs: 500 }], nu: 0 } });
    expect(l.stap?.id).toBe('glijdt');
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps, slews: [{ app: ZEE, id: 'galm', doel: 0.9, eindMs: 3000 }], nu: 1000 } });
    expect(l.stap?.id).toBe('aangekomen');
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps, slews: [{ app: ZEE, id: 'galm', doel: 0.9, eindMs: 3000 }], nu: 2000 } });
    expect(l.lesKlaar).toBe(false);
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps, slews: [], nu: 3100 } });
    expect(l.lesKlaar).toBe(true);
    expect(l.allesKlaar).toBe(true);
  });

  it('pickup-les: een fader-zet die nog onderweg was overschrijft de "klik in de app" niet blijvend', () => {
    /** @type {[string, string, number][]} */
    const gezet = [];
    const l = new Leraar({ acties: { zelfZetten: (app, id, v) => gezet.push([app, id, v]) }, nu: () => 0 });
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps: [] } });
    l.gaNaar(LESSEN.findIndex((x) => x.id === 'pickup'));
    expect(l.stap?.id).toBe('omlaag');
    l.verwerk({ soort: 'invoer', g: { dev: 'apc40', el: 'fader1', kind: 'waarde', v: 0.02 } });
    expect(l.stap?.id).toBe('oppakken');
    expect(gezet).toEqual([[ZON, 'gloed', 0.8]]);
    // de laatste fader-zet van het omlaag schuiven komt nog binnen: de app zet zichzelf opnieuw op 80%
    l.verwerk({ soort: 'app', app: ZON, b: { t: 'zet', id: 'gloed', v: 0.01, bron: 'apc40' } });
    expect(gezet).toEqual([[ZON, 'gloed', 0.8], [ZON, 'gloed', 0.8]]);
    expect(l.lesKlaar).toBe(false);
    l.verwerk({ soort: 'invoer', g: { dev: 'apc40', el: 'fader1', kind: 'waarde', v: 0.4 } });
    l.verwerk({ soort: 'app', app: ZON, b: { t: 'zet', id: 'gloed', v: 0.81, bron: 'apc40' } });
    expect(l.lesKlaar).toBe(true);
  });

  it('begonnen vóór het eerste beeld (pagina laden): de stap begint opnieuw zodra het beeld er is, en slaagt niet vanzelf', () => {
    const l = new Leraar({ nu: () => 0 });
    l.gaNaar(LESSEN.findIndex((x) => x.id === 'tempo'));   // zoals oefen.js bij het laden met een bewaarde les
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps: [], globaal: { bpm: 120 } } });
    expect(l.stap?.id).toBe('tap');
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps: [], globaal: { bpm: 120 } } });
    expect(l.stap?.id).toBe('tap');
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps: [], globaal: { bpm: 96 } } });
    expect(l.stap?.id).toBe('adem');
  });

  it('opdrachten gebruiken alleen eigen teksten: een vreemde naam uit het beeld komt niet in de HTML', () => {
    const l = new Leraar({ nu: () => 0 });
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps: [{ app: ZEE, naam: '<img src=x onerror=alert(1)>', slot: '<b>2</b>' }, { app: ZON, naam: 'Zon', slot: 1 }] } });
    l.gaNaar(LESSEN.findIndex((x) => x.id === 'focus'));
    const t = /** @type {string} */ (l.toestand().opdracht);
    expect(t).not.toMatch(/<img|onerror|<b>2<\/b>/);
    expect(t).toMatch(/Track Select \?/);
  });

  it('paniek loslaten slaagt ook als de hub de paniek voorbij meldt zonder trig (hub herstart midden in de paniek)', () => {
    const l = new Leraar({ nu: () => 0 });
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps: [], globaal: { paniek: 1 } } });
    l.gaNaar(LESSEN.findIndex((x) => x.id === 'paniek'));
    for (const app of [ZON, ZEE]) l.verwerk({ soort: 'app', app, b: { t: 'trig', id: 'paniek', aan: true } });
    expect(l.stap?.id).toBe('los');
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps: [], globaal: { paniek: 1 } } });
    expect(l.lesKlaar).toBe(false);
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps: [], globaal: { paniek: 0 } } });
    expect(l.lesKlaar).toBe(true);
  });

  it('na een focusstap: wisselt de leerling van app, dan zegt de opdracht dat eerst', () => {
    const l = new Leraar({ nu: () => 0 });
    const apps = [{ app: ZON, naam: 'Zon', slot: 1 }, { app: ZEE, naam: 'Zee', slot: 2 }];
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps } });
    l.gaNaar(LESSEN.findIndex((x) => x.id === 'fader'));
    expect(l.toestand().opdracht).not.toMatch(/geen focus meer/);
    l.verwerk({ soort: 'beeld', beeld: { focus: ZEE, apps } });
    expect(l.toestand().opdracht).toMatch(/De <b>Zon<\/b> heeft geen focus meer: Bank \+ Track Select 1/);
  });

  it('snapshot bewaren: net te kort (rond de 600 ms van de hub) telt niet en vraagt om een volle seconde', () => {
    let nu = 0;
    const l = new Leraar({ nu: () => nu });
    l.verwerk({ soort: 'beeld', beeld: { focus: ZON, apps: [], snapshots: [4] } });
    l.gaNaar(LESSEN.findIndex((x) => x.id === 'snapshot'));
    const p8 = (/** @type {'druk'|'los'} */ kind) => l.verwerk({ soort: 'invoer', g: { dev: 'lpd8', el: 'p8', kind } });
    p8('druk'); nu += 620; p8('los');
    expect(l.stap?.id).toBe('bewaren');
    expect(l.toestand().opdracht).toMatch(/net te kort/);
    p8('druk'); nu += 900; p8('los');
    expect(l.stap?.id).toBe('veranderen');
  });

  it('OefenApp: 4001 (open in een andere tab) → rustig 30 s wachten, met reden; triggers worden gewist', async () => {
    vi.useFakeTimers();
    try {
      /** @type {any[]} */
      const sockets = [];
      class NepWS {
        constructor() { this.readyState = 0; this.verstuurd = []; sockets.push(this); }
        /** @param {string} d */ send(d) { this.verstuurd.push(JSON.parse(d)); }
        close() {}
      }
      const a = new OefenApp({ manifest: MANIFESTEN[ZON], url: 'ws://x/app', WebSocket: NepWS });
      /** @type {any[]} */
      const status = [];
      a.bij((b) => { if (b.t === '_status') status.push(b); });
      a.start();
      const s0 = sockets[0];
      s0.readyState = 1; s0.onopen();
      s0.onmessage({ data: JSON.stringify({ t: 'trig', id: 'flits', aan: true }) });
      expect(a.triggers.flits).toBe(true);
      s0.readyState = 3; s0.onclose({ code: 4001 });
      expect(a.reden).toBe('vervangen');
      expect(a.triggers).toEqual({});
      expect(status.at(-1)).toMatchObject({ verbonden: false, reden: 'vervangen' });
      vi.advanceTimersByTime(29000);
      expect(sockets).toHaveLength(1);
      vi.advanceTimersByTime(1500);
      expect(sockets).toHaveLength(2);
      // gewone storing: korte backoff, en die loopt op zolang de verbinding niet stabiel wordt
      const s1 = sockets[1];
      s1.readyState = 1; s1.onopen(); s1.readyState = 3; s1.onclose({ code: 1006 });
      vi.advanceTimersByTime(600);
      expect(sockets).toHaveLength(3);
      const s2 = sockets[2];
      s2.readyState = 1; s2.onopen(); s2.readyState = 3; s2.onclose({ code: 1006 });
      vi.advanceTimersByTime(600);
      expect(sockets).toHaveLength(3);          // nu 1 s
      vi.advanceTimersByTime(500);
      expect(sockets).toHaveLength(4);
      a.stop();
    } finally { vi.useRealTimers(); }
  });

  it('een stap die al vervuld is, slaat de leraar over (de Zon heeft al focus)', async () => {
    const { leraar } = await opzet();
    await tot(() => leraar.beeld?.focus === ZON);
    leraar.gaNaar(LESSEN.findIndex((l) => l.id === 'fader'));
    expect(leraar.stap?.id).toBe('gloed');
  });
});

