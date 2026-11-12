// End-to-end: de hele hub met een nep-USB-MIDI-interface (twee ingangen: de KP3+ op MIDI 1, de EFX-500 op MIDI 2),
// een NepKlok voor de tijd en een echte WebSocket-app (tools/nep-app.mjs). PROTOCOL §20 en §21.
import { describe, it, expect, afterEach } from 'vitest';
import { startHub } from '../src/hub.js';
import { NepSysteem } from '../src/ports/nep.js';
import { NepKlok } from '../src/core/klok.js';
import { laadConfig } from '../src/config.js';
import { NepApp } from '../tools/nep-app.mjs';

const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
const tot = async (fn, ms = 3000) => { const eind = Date.now() + ms; while (Date.now() < eind) { const x = fn(); if (x) return x; await wacht(10); } return fn(); };
const lopend = [];
afterEach(async () => { for (const x of lopend.splice(0)) await x(); });

export const KP3_POORT = 'USB MIDI Interface MIDI 1';
export const EFX_POORT = 'USB MIDI Interface MIDI 2';

async function opzet() {
  const basis = laadConfig();
  const config = {
    ...basis, hotplug_ms: 20,
    apparaten: {
      ...basis.apparaten,
      kp3plus: { ...basis.apparaten.kp3plus, poort_patroon: 'interface midi 1' },
      efx500: { ...basis.apparaten.efx500, poort_patroon: 'interface midi 2' },
    },
  };
  const systeem = new NepSysteem();
  const kp3 = systeem.voegToe(KP3_POORT, { uitgang: false });
  const efx = systeem.voegToe(EFX_POORT, { uitgang: false });
  const klok = new NepKlok();
  const log = [];
  const hub = await startHub({ config, systeem, klok, poort: 0, drivers: false, opname: false, log: (...x) => log.push(x.join(' ')) });
  lopend.push(() => hub.stop());
  klok.loop(300);   // hotplug: de sessies openen hun poort
  const url = hub.adres.replace('http', 'ws') + '/app';
  const app = (manifest) => { const a = new NepApp({ url, manifest }).start(); lopend.push(() => a.stop()); return a; };
  return { hub, kp3, efx, klok, app, systeem, log };
}

const MANIFEST = {
  v: 1, app: 'formula-lab', naam: 'Formula Lab', xy: { x: 'vorm', y: 'galm' },
  params: [{ id: 'vorm', naam: 'Vorm', soort: 'waarde', standaard: 0.25 }, { id: 'galm', naam: 'Galm', soort: 'waarde', standaard: 0.5 }],
};

describe('de hele hub met de KP3+ en de EFX-500', () => {
  it('nep-kloktikken op 120 BPM via de EFX-500 geven globaal.bpm 120, ook bij een verbonden app', async () => {
    const { hub, efx, klok, app } = await opzet();
    expect(hub.apparaten.efx?.verbonden).toBe(true);
    expect(efx.opties).toMatchObject({ alleenIngang: true, metKlok: true });   // de klok mag de poort door
    const a = app(MANIFEST);
    await tot(() => a.ontvangen.some((b) => b.t === 'globaal'));
    for (let i = 0; i < 30; i++) { efx.injecteer([0xf8]); klok.loop(60000 / (24 * 120)); }
    expect(hub.kern.globaal.bpm).toBe(120);
    expect(hub.kern.beeld().tempo).toMatchObject({ bpm: 120, bron: 'efx500' });
    expect(hub.kern.beeld().apparaten.efx500).toEqual({ verbonden: true, naam: EFX_POORT });
    await tot(() => a.ontvangen.some((b) => b.t === 'globaal' && b.waarden.bpm === 120));
    expect(a.ontvangen.filter((b) => b.t === 'globaal' && 'bpm' in b.waarden).at(-1).waarden.bpm).toBe(120);
  });

  it('de KP3+ beweegt X en Y van de app met focus en veert terug; hij opent alleen de ingang, zonder klok', async () => {
    const { hub, kp3, app } = await opzet();
    expect(hub.apparaten.kp3?.verbonden).toBe(true);
    expect(kp3.opties).toEqual({ alleenIngang: true });
    expect(hub.kern.beeld().apparaten.kp3plus).toEqual({ verbonden: true, naam: KP3_POORT });
    const a = app(MANIFEST);
    await tot(() => hub.kern.beeld().apps.some((x) => x.app === 'formula-lab' && x.status === 'actief'));
    hub.kern.focus('formula-lab');
    for (const b of [[0xb0, 92, 127], [0xb0, 12, 127], [0xb0, 13, 0], [0xb0, 92, 0]]) kp3.injecteer(b);
    const zets = () => a.ontvangen.filter((b) => b.t === 'zet' && b.bron === 'kp3plus').map((b) => [b.id, b.v]);
    await tot(() => zets().length === 4);
    expect(zets()).toEqual([['vorm', 1], ['galm', 0], ['vorm', 0.25], ['galm', 0.5]]);
  });

  it('losgetrokken: de cockpit ziet het, de klok valt meteen terug', async () => {
    const { hub, efx, klok, systeem } = await opzet();
    for (let i = 0; i < 30; i++) { efx.injecteer([0xf8]); klok.loop(60000 / (24 * 133)); }
    expect(hub.kern.globaal.bpm).toBe(133);
    systeem.verwijder(EFX_POORT);
    klok.loop(300);
    expect(hub.kern.beeld().apparaten.efx500).toMatchObject({ verbonden: false });
    expect(hub.kern.beeld().tempo).toMatchObject({ bron: 'laatste', bpm: 133, efx: { bpm: null } });
  });
});
