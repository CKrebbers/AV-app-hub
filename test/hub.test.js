// End-to-end: de hele hub (apparaten + kern + server) met een nep-APC, een nep-LPD8 en echte WebSocket-apps.
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { startHub } from '../src/hub.js';
import { NepSysteem } from '../src/ports/nep.js';
import { laadConfig } from '../src/config.js';
import { NepApp, voorbeeldManifest } from '../tools/nep-app.mjs';

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
const tot = async (fn, ms = 3000) => { const eind = Date.now() + ms; while (Date.now() < eind) { const x = fn(); if (x) return x; await wacht(10); } return fn(); };
const lopend = [];
afterEach(async () => { for (const x of lopend.splice(0)) await x(); });

async function opzet() {
  const config = { ...laadConfig(), hotplug_ms: 20 };
  const systeem = new NepSysteem();
  const apc = systeem.voegToe('APC40 mkII');
  const lpd8 = systeem.voegToe('LPD8 mk2');
  lpd8.antwoord = (b) => { if (b[1] === 0x7e) setTimeout(() => lpd8.injecteer([0xf0, 0x7e, 0, 6, 2, 0x47, 0x4c, 0, 0xf7]), 1); };
  const hub = await startHub({ config, systeem, poort: 0, drivers: false });
  lopend.push(() => hub.stop());
  const url = hub.adres.replace('http', 'ws') + '/app';
  const app = (naam) => { const a = new NepApp({ url, manifest: voorbeeldManifest(naam) }).start(); lopend.push(() => a.stop()); return a; };
  return { hub, apc, lpd8, app, url };
}

describe('de hele hub', () => {
  it('twee apps; Bank + Track Select 2 geeft app 2 de focus; fader 1 gaat (na pickup) naar die app', async () => {
    const { hub, apc, app } = await opzet();
    const a1 = app('formula-lab');
    await tot(() => hub.kern.beeld().apps.length === 1);
    const a2 = app('waterschaal');
    await tot(() => hub.kern.beeld().apps.length === 2 && hub.apparaten.apc.verbonden);
    expect(hub.kern.beeld().focus).toBe('formula-lab');

    apc.injecteer([0x90, 103, 127]);            // Bank in
    apc.injecteer([0x91, 51, 127]);             // Track Select 2
    apc.injecteer([0x81, 51, 127]);
    apc.injecteer([0x80, 103, 127]);            // Bank los
    await tot(() => hub.kern.beeld().focus === 'waterschaal');
    expect(hub.kern.beeld().focus).toBe('waterschaal');
    await tot(() => a2.ontvangen.some((b) => b.t === 'focus' && b.aan));

    // helder staat op 0.5: fader 1 van 0 naar 1 in stapjes → pas bij 0.5 neemt hij over
    for (let r = 0; r <= 127; r += 8) apc.injecteer([0xb0, 7, r]);
    const zetten = await tot(() => { const z = a2.ontvangen.filter((b) => b.t === 'zet' && b.id === 'helder'); return z.length ? z : null; }) ?? [];
    expect(zetten.length).toBeGreaterThan(0);
    expect(zetten[0].v).toBeGreaterThanOrEqual(0.48);
    expect(a1.ontvangen.filter((b) => b.t === 'zet' && b.id === 'helder')).toEqual([]);
  });

  it('LPD8-knop 2 (macro.helderheid) gaat naar elke app met die rol, zonder sprong', async () => {
    const { hub, lpd8, app } = await opzet();
    const a1 = app('formula-lab'), a2 = app('waterschaal');
    await tot(() => hub.kern.beeld().apps.length === 2 && hub.apparaten.lpd8.model === 'mk2');
    lpd8.injecteer([0xb0, 71, 20]);                 // ver van 0.5: nog niets
    await wacht(50);
    expect(a1.waarden.helder).toBe(0.5);
    for (let r = 20; r <= 100; r += 4) lpd8.injecteer([0xb0, 71, r]);   // draaien, kruist 0.5
    await tot(() => a1.waarden.helder !== 0.5 && a2.waarden.helder !== 0.5);
    expect(a1.waarden.helder).toBeCloseTo(100 / 127, 2);
    expect(a2.waarden.helder).toBeCloseTo(100 / 127, 2);
  });

  it('de cockpit krijgt beeld + apparaten, en een virtuele pad-druk komt als trigger bij de app', async () => {
    const { hub, app } = await opzet();
    const a = app('formula-lab');
    await tot(() => hub.kern.beeld().apps.length === 1 && hub.apparaten.apc.verbonden);
    const ws = new WebSocket(hub.adres.replace('http', 'ws') + '/cockpit');
    lopend.push(() => ws.close());
    const berichten = [];
    ws.on('message', (d) => berichten.push(JSON.parse(String(d))));
    await new Promise((r) => ws.once('open', r));
    const beeld = await tot(() => berichten.find((b) => b.t === 'beeld'));
    expect(beeld.apparaten.apc40.verbonden).toBe(true);
    expect(beeld.apps[0]).toMatchObject({ app: 'formula-lab', focus: true });
    // Zoek de pad van de trigger 'flits' via de indeling en druk hem virtueel in.
    const ind = hub.kern.apps.get('formula-lab').indeling;
    const [pad] = Object.entries(ind.vast ?? ind.controls ?? {}).find(([, t]) => t.id === 'flits') ?? Object.entries(Object.values(ind.paginas ?? {})[0] ?? {}).find(([, t]) => t.id === 'flits') ?? [];
    const kern = await import('../src/core/indeling.js');
    const tw = kern.toewijzingen(ind, 0);
    const padId = pad ?? Object.keys(tw).find((k) => tw[k].id === 'flits');
    const n = (await import('../src/devices/apc40mk2.js')).OP_ID.get(padId).n;
    ws.send(JSON.stringify({ t: 'virtueel', dev: 'apc40', bytes: [0x90, n, 127] }));
    await tot(() => a.ontvangen.some((b) => b.t === 'trig' && b.id === 'flits' && b.aan));
    ws.close();                                   // cockpit valt weg terwijl de pad nog "ingedrukt" is
    await tot(() => a.ontvangen.some((b) => b.t === 'trig' && b.id === 'flits' && !b.aan));
    expect(a.ontvangen.filter((b) => b.t === 'trig').map((b) => b.aan)).toEqual([true, false]);
  });

  it('een website van buiten mag de hub niet bedienen', async () => {
    const { hub } = await opzet();
    const ws = new WebSocket(hub.adres.replace('http', 'ws') + '/cockpit', { headers: { Origin: 'https://kwaadaardig.example' } });
    const uit = await new Promise((r) => { ws.once('open', () => r('open')); ws.once('error', () => r('geweigerd')); ws.once('unexpected-response', () => r('geweigerd')); });
    expect(uit).toBe('geweigerd');
  });
});
