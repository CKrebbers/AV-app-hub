// @ts-check
// Golf 8, punt 1 van docs/DUURTEST.md: een cockpit (tablet over wifi) die abrupt wegvalt terwijl hij een
// trigger vasthoudt, laat die trigger los (PROTOCOL.md §10). Echte kern (nep-klok) achter de echte server, cockpits
// over echte WebSockets; de apps zijn nep-verbindingen rechtstreeks op de kern.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startServer } from '../src/transports/server.js';
import { opzet, meldAan, stuurApp, nepVerbinding, druk, los, lpdDruk, lpdLos, FL, MS } from './kern-hulp.js';
import { PANIEK_MS } from '../src/core/kern.js';
import { wachtOp } from './nepkern.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/** @type {string} */ let uiMap;
/** @type {ReturnType<typeof opzet>} */ let o;
/** @type {Awaited<ReturnType<typeof startServer>>} */ let srv;
/** @type {(() => void)[]} */ let opruimen;

/** Een cockpit zoals ui/: verbonden en met een eerste beeld. @param {Awaited<ReturnType<typeof startServer>>} [s] @param {import('ws').ClientOptions} [opties] */
async function cockpit(s = srv, opties = {}) {
  const ws = new WebSocket(s.adres.replace(/^http/, 'ws') + '/cockpit', opties);
  /** @type {any[]} */
  const berichten = [];
  ws.on('message', (d) => { try { berichten.push(JSON.parse(String(d))); } catch { /* geen json */ } });
  ws.on('error', () => {});
  opruimen.push(() => ws.terminate());
  await new Promise((goed, fout) => { ws.once('open', goed); ws.once('error', fout); });
  await wachtOp(() => berichten.some((b) => b.t === 'beeld'));
  const c = {
    ws,
    /** @param {object} b */
    stuur: (b) => ws.send(JSON.stringify(b)),
    /** Abrupt weg (wifi van de tablet uit): geen nette afsluiting, geen loslaten vanuit de pagina. */
    weg: () => ws.terminate(),
  };
  return c;
}

/** Alle trig-berichten voor `id` die een (nep-)verbinding van een app ontving. @param {{ ontvangen: any[] }} v @param {string} id */
const trigs = (v, id) => v.ontvangen.filter((b) => b.t === 'trig' && b.id === id).map((b) => b.aan);
/** Wacht tot de kern iets van de cockpit verwerkte (berichten over een socket komen in volgorde aan). */
const even = (ms = 60) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  uiMap = mkdtempSync(join(tmpdir(), 'varve-ui-'));
  writeFileSync(join(uiMap, 'index.html'), '<!doctype html><title>Cockpit</title>');
  o = opzet();
  opruimen = [];
  srv = await startServer({ poort: 0, kern: o.kern, uiMap, srcMap: SRC });
});

afterEach(async () => {
  for (const f of opruimen) { try { f(); } catch { /* al dicht */ } }
  await srv.stop();
  o.kern.stop();
  rmSync(uiMap, { recursive: true, force: true });
});

describe('golf 8: een cockpit die wegvalt laat zijn triggers los', () => {
  it('abrupt weg terwijl hij de paniek-trigger vasthoudt → de app hoort trig paniek aan:false', async () => {
    const fl = meldAan(o.kern, FL);
    const c = await cockpit();
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'paniek', v: 1 });
    await wachtOp(() => trigs(fl, 'paniek').length === 1);
    expect(trigs(fl, 'paniek')).toEqual([true]);
    c.weg();
    await wachtOp(() => trigs(fl, 'paniek').length === 2);
    expect(trigs(fl, 'paniek')).toEqual([true, false]);
  });

  it('meerdere triggers in meerdere apps: allemaal los; twee keer indrukken = één keer los', async () => {
    const fl = meldAan(o.kern, FL), ms = meldAan(o.kern, MS);
    const c = await cockpit();
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'take', v: 1 });
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'take', v: 1 });
    c.stuur({ t: 'zet', app: 'medisynth', id: 'paniek', v: 0.5 });
    await wachtOp(() => trigs(ms, 'paniek').length === 1);
    c.weg();
    await wachtOp(() => trigs(fl, 'take').length === 3 && trigs(ms, 'paniek').length === 2);
    await even();
    expect(trigs(fl, 'take')).toEqual([true, true, false]);
    expect(trigs(ms, 'paniek')).toEqual([true, false]);
  });

  it('netjes losgelaten en dan weg: niet nog eens los', async () => {
    const fl = meldAan(o.kern, FL);
    const c = await cockpit();
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'paniek', v: 1 });
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'paniek', v: 0 });
    await wachtOp(() => trigs(fl, 'paniek').length === 2);
    c.weg();
    await even(100);
    expect(trigs(fl, 'paniek')).toEqual([true, false]);
  });

  it('een waarde, een onbekende app of parameter: bij wegvallen geen zet (een fader springt niet naar 0)', async () => {
    const fl = meldAan(o.kern, FL);
    const c = await cockpit();
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'in1', v: 0.7 });
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'bestaat-niet', v: 1 });
    c.stuur({ t: 'zet', app: 'spook', id: 'paniek', v: 1 });
    await wachtOp(() => fl.ontvangen.some((b) => b.t === 'zet' && b.id === 'in1'));
    const voor = fl.ontvangen.length;
    c.weg();
    await even(100);
    expect(fl.ontvangen.slice(voor)).toEqual([]);
    expect(o.kern.apps.get('formula-lab')?.waarden.in1).toBeCloseTo(0.7, 5);
  });

  it('twee cockpits houden dezelfde trigger vast: pas los als de laatste wegvalt', async () => {
    const fl = meldAan(o.kern, FL);
    const a = await cockpit(), b = await cockpit();
    a.stuur({ t: 'zet', app: 'formula-lab', id: 'paniek', v: 1 });
    b.stuur({ t: 'zet', app: 'formula-lab', id: 'paniek', v: 1 });
    await wachtOp(() => trigs(fl, 'paniek').length === 2);
    a.weg();
    await even(100);
    expect(trigs(fl, 'paniek')).toEqual([true, true]);           // b houdt hem nog bewust vast
    b.weg();
    await wachtOp(() => trigs(fl, 'paniek').length === 3);
    await even();
    expect(trigs(fl, 'paniek')).toEqual([true, true, false]);
  });

  it('twee cockpits houden vast, de ene laat netjes los (→ uit), de andere valt weg → niet nog eens los', async () => {
    const fl = meldAan(o.kern, FL);
    const a = await cockpit(), b = await cockpit();
    a.stuur({ t: 'zet', app: 'formula-lab', id: 'take', v: 1 });
    await wachtOp(() => trigs(fl, 'take').length === 1);
    b.stuur({ t: 'zet', app: 'formula-lab', id: 'take', v: 1 });
    b.stuur({ t: 'zet', app: 'formula-lab', id: 'take', v: 0 });
    await wachtOp(() => trigs(fl, 'take').length === 3);
    expect(trigs(fl, 'take')).toEqual([true, true, false]);     // een nette v:0 gaat direct door, ook als a nog vasthoudt
    a.weg();
    await even(100);
    expect(trigs(fl, 'take')).toEqual([true, true, false]);     // de trigger staat al uit: geen tweede aan:false
    // a's oude druk telt niet meer: een nieuwe cockpit die indrukt en wegvalt, laat wel weer los.
    const c = await cockpit();
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'take', v: 1 });
    c.weg();
    await wachtOp(() => trigs(fl, 'take').length === 5);
    expect(trigs(fl, 'take')).toEqual([true, true, false, true, false]);
  });

  it('tablet verbindt opnieuw (oude socket half-open houdt vast), laat op de nieuwe los; de oude valt weg → niet nog eens los', async () => {
    const fl = meldAan(o.kern, FL);
    const oud = await cockpit();
    oud.stuur({ t: 'zet', app: 'formula-lab', id: 'take', v: 1 });
    await wachtOp(() => trigs(fl, 'take').length === 1);
    const nieuw = await cockpit();
    nieuw.stuur({ t: 'zet', app: 'formula-lab', id: 'take', v: 0 });   // de pagina laat los zonder zelf te hebben ingedrukt
    await wachtOp(() => trigs(fl, 'take').length === 2);
    oud.weg();
    await even(100);
    expect(trigs(fl, 'take')).toEqual([true, false]);
    nieuw.stuur({ t: 'zet', app: 'formula-lab', id: 'take', v: 1 });  // en daarna werkt vasthouden + wegvallen gewoon
    await wachtOp(() => trigs(fl, 'take').length === 3);
    nieuw.weg();
    await wachtOp(() => trigs(fl, 'take').length === 4);
    expect(trigs(fl, 'take')).toEqual([true, false, true, false]);
  });

  it('LPD8 P1 houdt de paniek vast, de cockpit ook, de cockpit valt weg → de paniek loopt door tot P1 los is', async () => {
    const fl = meldAan(o.kern, FL);
    lpdDruk(o.kern, 1);
    o.klok.loop(PANIEK_MS + 50);
    expect(o.kern.beeld().globaal).toMatchObject({ paniek: 1 });
    const c = await cockpit();
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'paniek', v: 1 });
    await wachtOp(() => trigs(fl, 'paniek').length === 2);
    c.weg();
    await even(100);
    expect(trigs(fl, 'paniek')).toEqual([true, true]);
    lpdLos(o.kern, 1);
    expect(trigs(fl, 'paniek')).toEqual([true, true, false]);
  });

  it('Stop All op de APC vast, de cockpit houdt de paniek ook, de cockpit valt weg → de paniek loopt door tot Stop All los is', async () => {
    const fl = meldAan(o.kern, FL);
    druk(o.kern, 'stopall');
    const c = await cockpit();
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'paniek', v: 1 });
    await wachtOp(() => trigs(fl, 'paniek').length === 2);
    c.weg();
    await even(100);
    expect(trigs(fl, 'paniek')).toEqual([true, true]);
    los(o.kern, 'stopall');
    expect(trigs(fl, 'paniek')).toEqual([true, true, false]);
  });

  it('een APC-pad houdt de trigger vast, de cockpit ook, de cockpit valt weg → aan tot de pad los is', async () => {
    const fl = meldAan(o.kern, FL);
    druk(o.kern, 'pad5-2');                                       // take (zie de indeling van FL)
    const c = await cockpit();
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'take', v: 1 });
    await wachtOp(() => trigs(fl, 'take').length === 2);
    c.weg();
    await even(100);
    expect(trigs(fl, 'take')).toEqual([true, true]);
    los(o.kern, 'pad5-2');
    expect(trigs(fl, 'take')).toEqual([true, true, false]);
  });

  it('P1-paniek op de LPD8 houdt alleen "paniek" vast: een andere trigger van de cockpit gaat bij wegvallen wel los', async () => {
    const fl = meldAan(o.kern, FL);
    lpdDruk(o.kern, 1);
    o.klok.loop(PANIEK_MS + 50);
    const c = await cockpit();
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'take', v: 1 });
    await wachtOp(() => trigs(fl, 'take').length === 1);
    c.weg();
    await wachtOp(() => trigs(fl, 'take').length === 2);
    expect(trigs(fl, 'take')).toEqual([true, false]);
    expect(trigs(fl, 'paniek')).toEqual([true]);
    lpdLos(o.kern, 1);
  });

  // Bekende grens (docs/DUURTEST.md golf 8 punt 1): de kern telt per trigger de bronnen nog niet. Een nette `zet v:0` van een
  // cockpit gaat direct door als aan:false, ook als Stop All, P1 of een APC-pad dezelfde trigger nog vasthoudt.
  it.todo('Stop All (of P1) vast en een cockpit laat dezelfde paniek netjes los (v:0) → de paniek loopt door tot Stop All los is');

  it('nieuw manifest tussen indrukken en wegvallen, trigger bestaat nog → los', async () => {
    const fl = meldAan(o.kern, FL);
    const c = await cockpit();
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'paniek', v: 1 });
    await wachtOp(() => trigs(fl, 'paniek').length === 1);
    stuurApp(o.kern, fl, { t: 'manifest', manifest: { ...FL, naam: 'Formula Lab 2', params: FL.params.filter((p) => p.id !== 'take') } });
    c.weg();
    await wachtOp(() => trigs(fl, 'paniek').length === 2);
    expect(trigs(fl, 'paniek')).toEqual([true, false]);
  });

  it('nieuw manifest waarin de trigger een waarde werd of verdween → geen zet (de waarde blijft staan)', async () => {
    const fl = meldAan(o.kern, FL);
    const c = await cockpit();
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'take', v: 1 });
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'paniek', v: 1 });
    await wachtOp(() => trigs(fl, 'paniek').length === 1);
    const params = FL.params
      .filter((p) => p.id !== 'paniek')
      .map((p) => (p.id === 'take' ? { id: 'take', naam: 'Take', soort: 'waarde', standaard: 0.6 } : p));
    stuurApp(o.kern, fl, { t: 'manifest', manifest: { ...FL, params } });
    const voor = fl.ontvangen.length;
    c.weg();
    await even(100);
    expect(fl.ontvangen.slice(voor)).toEqual([]);
    expect(o.kern.apps.get('formula-lab')?.waarden.take).toBeCloseTo(0.6, 5);
  });

  it('de app viel tussendoor weg en kwam terug op een nieuwe verbinding → het loslaten gaat daarheen', async () => {
    const oud = meldAan(o.kern, FL);
    const c = await cockpit();
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'paniek', v: 1 });
    await wachtOp(() => trigs(oud, 'paniek').length === 1);
    o.kern.verbreek(/** @type {any} */ (oud));
    const nieuw = nepVerbinding();
    o.kern.verbind(/** @type {any} */ (nieuw));
    stuurApp(o.kern, nieuw, { t: 'hallo', app: 'formula-lab', inst: 'i1', v: 1 });  // zelfde inst: netwerkhapering
    c.weg();
    await wachtOp(() => trigs(nieuw, 'paniek').length === 1);
    expect(trigs(nieuw, 'paniek')).toEqual([false]);
    expect(trigs(oud, 'paniek')).toEqual([true]);
  });

  it('de app viel weg en is er nog niet: geen fout, en daarna werkt alles gewoon', async () => {
    const oud = meldAan(o.kern, FL);
    const c = await cockpit();
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'paniek', v: 1 });
    await wachtOp(() => trigs(oud, 'paniek').length === 1);
    o.kern.verbreek(/** @type {any} */ (oud));
    c.weg();
    await even(100);
    expect(trigs(oud, 'paniek')).toEqual([true]);                 // weg is weg (zoals bij de APC)
    const nieuw = meldAan(o.kern, FL, { inst: 'i2' });
    const d = await cockpit();
    d.stuur({ t: 'zet', app: 'formula-lab', id: 'paniek', v: 1 });
    await wachtOp(() => trigs(nieuw, 'paniek').length === 1);
    d.weg();
    await wachtOp(() => trigs(nieuw, 'paniek').length === 2);
    expect(trigs(nieuw, 'paniek')).toEqual([true, false]);
  });

  it('een kapot frame (fout op de socket) → de server sluit hem en laat de trigger los', async () => {
    const fl = meldAan(o.kern, FL);
    const c = await cockpit();
    c.stuur({ t: 'zet', app: 'formula-lab', id: 'paniek', v: 1 });
    await wachtOp(() => trigs(fl, 'paniek').length === 1);
    // Een ongemaskeerd frame met een onbekende opcode: voor de server een protocolfout.
    /** @type {any} */ (c.ws)._socket.write(Buffer.from([0x83, 0x00]));
    await wachtOp(() => trigs(fl, 'paniek').length === 2);
    expect(trigs(fl, 'paniek')).toEqual([true, false]);
  });

  it('een tablet die stil wegvalt (geen pong meer, half-open TCP) → na de time-out los', async () => {
    const s2 = await startServer({ poort: 0, kern: o.kern, uiMap, srcMap: SRC, pingMs: 50 });
    try {
      const fl = meldAan(o.kern, FL);
      const c = await cockpit(s2, { autoPong: false });
      c.stuur({ t: 'zet', app: 'formula-lab', id: 'paniek', v: 1 });
      await wachtOp(() => trigs(fl, 'paniek').length === 1);
      await wachtOp(() => trigs(fl, 'paniek').length === 2, 2000);
      expect(trigs(fl, 'paniek')).toEqual([true, false]);
      expect(c.ws.readyState).not.toBe(WebSocket.OPEN);
    } finally { await s2.stop(); }
  });
});
