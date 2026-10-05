// End-to-end: de hele hub met een nep-Xboard49 (MIDI-ingang), een nep-Maschine MK2 (HID) en echte WebSocket-apps.
// Een lease-app die speelt (tools/nep-app.mjs speelManifest) krijgt de MIDI van beide, zet pads terug op de
// Maschine en stuurt een scherm (PROTOCOL §17).
import { describe, it, expect, afterEach } from 'vitest';
import { startHub } from '../src/hub.js';
import { NepSysteem, NepHidSysteem } from '../src/ports/nep.js';
import { laadConfig } from '../src/config.js';
import * as MS from '../src/devices/maschine-mk2.js';
import { NepApp, voorbeeldManifest, speelManifest, nepScherm } from '../tools/nep-app.mjs';
import { nepMaschine, padFrame, rustFrame, XBOARD_NAAM } from './nep-speelapparaten.js';

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
const tot = async (fn, ms = 3000) => { const eind = Date.now() + ms; while (Date.now() < eind) { const x = fn(); if (x) return x; await wacht(10); } return fn(); };
const lopend = [];
afterEach(async () => { for (const x of lopend.splice(0)) await x(); });

async function opzet({ bezet = false } = {}) {
  const basis = laadConfig();
  const config = { ...basis, hotplug_ms: 20, apparaten: { ...basis.apparaten, 'maschine-mk2': { ...basis.apparaten['maschine-mk2'], stil_ms: 200 } } };
  const systeem = new NepSysteem();
  const xb = systeem.voegToe(XBOARD_NAAM, { uitgang: false });
  const hid = new NepHidSysteem();
  const m = nepMaschine(hid);
  hid.bijOpen = (p) => setTimeout(() => p.injecteer(rustFrame()), 1);
  if (bezet) hid.zetBezet(m.naam, true);
  const log = [];
  const hub = await startHub({ config, systeem, hid, poort: 0, drivers: false, log: (...x) => log.push(x.join(' ')) });
  lopend.push(() => hub.stop());
  const url = hub.adres.replace('http', 'ws') + '/app';
  const app = (manifest) => { const a = new NepApp({ url, manifest }).start(); lopend.push(() => a.stop()); return a; };
  return { hub, xb, m, hid, app, log };
}
const midiVan = (a, dev) => a.ontvangen.filter((b) => b.t === 'midi' && b.dev === dev).map((b) => b.bytes);

describe('de hele hub met de speelapparaten', () => {
  it('Xboard en Maschine spelen voor de lease-app met speelt, ook als een andere app de APC-focus heeft; LED\'s en scherm komen op de Maschine', async () => {
    const { hub, xb, m, app } = await opzet();
    const speler = app(speelManifest('varve-dj'));
    await tot(() => hub.kern.beeld().apps.length === 1);
    const fl = app(voorbeeldManifest('formula-lab'));
    await tot(() => hub.kern.beeld().apps.length === 2 && hub.apparaten.xboard.verbonden && hub.apparaten.maschine.status === 'verbonden');
    hub.kern.focus('formula-lab');
    expect(hub.kern.beeld().spelers).toEqual({ xboard49: 'varve-dj', 'maschine-mk2': 'varve-dj' });
    expect(hub.kern.beeld().apparaten).toMatchObject({ xboard49: { verbonden: true, naam: XBOARD_NAAM }, 'maschine-mk2': { verbonden: true, status: 'verbonden', hint: null } });

    // het scherm dat de nep-speler bij het openen stuurde, staat op het linkerscherm
    await tot(() => m.poort.verstuurd.some((r) => r[0] === 0xe0 && r.slice(9).some((x) => x)));
    const verwacht = MS.schermRapporten(0, Buffer.from(nepScherm(), 'base64'));
    const laatste = m.laatste();
    for (let i = 0; i < 8; i++) expect(laatste[`e0:${i}`]).toEqual(verwacht[i]);

    xb.injecteer([0x90, 60, 100]);
    xb.injecteer([0x80, 60, 0]);
    m.pad(1);
    await tot(() => midiVan(speler, 'xboard49').length === 2 && midiVan(speler, 'maschine-mk2').length === 2);
    expect(midiVan(speler, 'xboard49')).toEqual([[0x90, 60, 100], [0x80, 60, 0]]);
    expect(midiVan(speler, 'maschine-mk2')).toEqual([[0x90, 36, 102], [0x80, 36, 0]]);
    expect(fl.ontvangen.filter((b) => b.t === 'midi')).toEqual([]);

    // de speler zette pad 1 groen (en weer uit); houd hem nu ingedrukt: groen op de draad
    const voor = m.poort.verstuurd.length;
    const vast = padFrame(Array.from({ length: 16 }, (_, plek) => (plek === MS.plekVanPad(1) ? 1000 : 0)));
    m.stuur(vast);
    m.stuur(vast);
    const r80 = await tot(() => m.poort.verstuurd.slice(voor).find((r) => r[0] === 0x80 && r[1 + 3 * MS.plekVanPad(1) + 1] > 0));
    expect(r80.slice(1 + 3 * MS.plekVanPad(1), 4 + 3 * MS.plekVanPad(1))).toEqual(MS.paletRgb(21));

    // de Maschine eruit terwijl pad 1 in is: de speler krijgt zijn loslaten
    m.uittrekken();
    await tot(() => midiVan(speler, 'maschine-mk2').length === 4);
    expect(midiVan(speler, 'maschine-mk2').at(-1)).toEqual([0x80, 36, 0]);
    await tot(() => hub.kern.beeld().apparaten['maschine-mk2'].verbonden === false);
    expect(hub.kern.beeld().apparaten['maschine-mk2']).toMatchObject({ verbonden: false, status: 'zoekt' });
  });

  it('Maschine bezet: één regel in het hubvenster met wat te doen, en de cockpit ziet status en hint', async () => {
    const { hub, hid, m, log } = await opzet({ bezet: true });
    await tot(() => hub.apparaten.maschine.status === 'bezet');
    await wacht(100);
    expect(log.filter((r) => r.startsWith('Maschine:'))).toEqual([`Maschine: bezet (cannot open device with path ${m.naam}) — sluit Maschine 2 en Controller Editor; NIHardwareAgent en NIHostIntegrationAgent kunnen hem ook vasthouden (Activiteitenweergave). De hub probeert het elke ronde opnieuw`]);
    expect(hub.kern.beeld().apparaten['maschine-mk2']).toMatchObject({ verbonden: false, status: 'bezet', hint: expect.stringMatching(/Controller Editor/) });
    hid.zetBezet(m.naam, false);
    await tot(() => hub.apparaten.maschine.status === 'verbonden');
    expect(hub.kern.beeld().apparaten['maschine-mk2']).toMatchObject({ verbonden: true, status: 'verbonden' });
  });

  it('zonder HID start de hub gewoon; de cockpit zegt waarom de Maschine niet meedoet', async () => {
    const config = { ...laadConfig(), hotplug_ms: 20 };
    const hub = await startHub({ config, systeem: new NepSysteem(), hid: null, hidReden: 'node-hid niet geïnstalleerd (test)', poort: 0, drivers: false });
    lopend.push(() => hub.stop());
    expect(hub.kern.beeld().apparaten['maschine-mk2']).toMatchObject({ verbonden: false, status: 'geen-hid', hint: 'node-hid niet geïnstalleerd (test) — npm install haalt node-hid binnen' });
    expect(hub.kern.beeld().apparaten.xboard49).toMatchObject({ verbonden: false });
  });
});
