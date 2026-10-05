// De HID-laag (src/ports/hid.js) zonder node-hid of toestel: een nep-module met dezelfde vorm, en `doctor`
// met nep-systemen (Xboard49 als MIDI-ingang, Maschine op een NepHidSysteem).
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { laadHid, hidSysteemVan, draaiendeNi, NI_PROGRAMMAS, HINT } from '../src/ports/hid.js';
import { NepSysteem, NepHidSysteem } from '../src/ports/nep.js';
import { doctor } from '../src/doctor.js';
import { laadConfig } from '../src/config.js';
import { nepMaschine, rustFrame, XBOARD_NAAM } from './nep-speelapparaten.js';

/** Een nep-node-hid: devices(vid?, pid?) en new HID(pad, opties) als EventEmitter. */
function nepNodeHid({ toestellen = [{ path: 'IOService:/maschine', vendorId: 0x17cc, productId: 0x1140, product: 'Maschine Controller MK2' }], gooitBijOpen = null } = {}) {
  const geopend = [];
  class HID extends EventEmitter {
    constructor(pad, opties) {
      super();
      if (gooitBijOpen) throw new Error(gooitBijOpen);
      this.pad = pad; this.opties = opties; this.geschreven = []; this.dicht = false;
      geopend.push(this);
    }
    write(b) { this.geschreven.push([...b]); return b.length; }
    close() { this.dicht = true; }
  }
  return {
    geopend,
    devices: (vid, pid) => toestellen.filter((d) => (vid === undefined || d.vendorId === vid) && (pid === undefined || d.productId === pid)),
    HID,
  };
}

describe('HID-laag', () => {
  it('zonder node-hid: geen systeem, wel een reden (de hub start gewoon)', async () => {
    const r = await laadHid(() => Promise.reject(new Error("Cannot find package 'node-hid'\nstack")));
    expect(r.systeem).toBe(null);
    expect(r.reden).toBe("node-hid niet geïnstalleerd (Cannot find package 'node-hid')");
  });
  it('node-hid er wel, maar geen HID (zoals in de cloud): geen systeem', async () => {
    const r = await laadHid(async () => ({ default: { devices: () => { throw new Error('geen hidraw'); } } }));
    expect(r).toEqual({ systeem: null, reden: 'HID niet beschikbaar (geen hidraw)' });
  });
  it('met een (nep-)node-hid: opsommen, zoeken op VID:PID, openen met nonExclusive', async () => {
    const H = nepNodeHid();
    const { systeem } = await laadHid(async () => ({ default: H }));
    expect(systeem.apparaten()).toEqual([{ naam: 'IOService:/maschine', pad: 'IOService:/maschine', vid: 0x17cc, pid: 0x1140, product: 'Maschine Controller MK2' }]);
    expect(systeem.zoek(0x17cc, 0x1140)).toBe('IOService:/maschine');
    expect(systeem.zoek(0x17cc, 0x1142)).toBe(null);
    const p = systeem.open('IOService:/maschine', { nietExclusief: true });
    expect(H.geopend[0].opties).toEqual({ nonExclusive: true });
    expect(p.product).toBe('Maschine Controller MK2');
    const binnen = [];
    p.bijBericht((b) => binnen.push([...b]));
    H.geopend[0].emit('data', Buffer.from([0x20, 1, 2]));
    expect(binnen).toEqual([[0x20, 1, 2]]);
    p.stuur([0x80, 1, 2, 3]);
    expect(H.geopend[0].geschreven).toEqual([[0x80, 1, 2, 3]]);
    expect(p.levend()).toBe(true);
  });
  it('een leesfout (uittrekken): levend() false en sturen gooit; sluiten sluit het toestel', () => {
    const H = nepNodeHid();
    const p = hidSysteemVan(H).open('IOService:/maschine');
    expect(H.geopend[0].opties).toEqual({ nonExclusive: false });
    H.geopend[0].emit('error', new Error('could not read from HID device'));
    expect(p.levend()).toBe(false);
    expect(() => p.stuur([0x80])).toThrow(/weg/);
    p.sluit();
    expect(H.geopend[0].dicht).toBe(true);
  });
  it('bezet: openen gooit (de sessie zegt dan "bezet")', () => {
    const H = nepNodeHid({ gooitBijOpen: 'cannot open device with path IOService:/maschine' });
    expect(() => hidSysteemVan(H).open('IOService:/maschine')).toThrow(/cannot open/);
  });
  it('draaiendeNi: NI-programma\'s uit de proceslijst (ps -axo comm geeft volledige paden)', () => {
    const ps = () => [
      'COMM', '/sbin/launchd',
      '/Library/Application Support/Native Instruments/Hardware/NIHardwareAgent.app/Contents/MacOS/NIHardwareAgent',
      '/Applications/Native Instruments/Maschine 2/Maschine 2.app/Contents/MacOS/Maschine 2',
      '/usr/bin/NIHostIntegrationAgentXYZ',
    ].join('\n');
    expect(draaiendeNi(ps)).toEqual(['NIHardwareAgent', 'Maschine 2']);
    expect(draaiendeNi(() => { throw new Error('geen ps'); })).toEqual([]);
    expect(NI_PROGRAMMAS).toContain('NIHostIntegrationAgent');
  });
});

describe('doctor: speelapparaten', () => {
  const config = laadConfig();
  async function draai({ midi = new NepSysteem(), hid = new NepHidSysteem(), ni = [], hidReden = null } = {}) {
    return doctor({
      config, laadMidi: async () => ({ systeem: midi }),
      laadHid: async () => (hid ? { systeem: hid } : { systeem: null, reden: hidReden }), niProgrammas: () => ni, wachtMs: 20,
    });
  }
  it('Xboard49 als MIDI-ingang, Maschine gevonden en er komt invoer', async () => {
    const midi = new NepSysteem();
    midi.voegToe(XBOARD_NAAM, { uitgang: false });
    const hid = new NepHidSysteem();
    nepMaschine(hid);
    hid.bijOpen = (p) => setTimeout(() => p.injecteer(rustFrame()), 1);
    const { tekst, data } = await draai({ midi, hid });
    expect(tekst).toMatch(/Speelapparaten/);
    expect(tekst).toMatch(/✔ xboard49: E-MU Xboard49/);
    expect(tekst).toMatch(/✔ maschine-mk2 \(17cc:1140\): Maschine Controller MK2/);
    expect(tekst).toMatch(/✔ invoer komt binnen/);
    expect(tekst).toMatch(/Invoermonitoring/);
    expect(data.xboard49.naam).toBe(XBOARD_NAAM);
    expect(data.maschine.frames).toBeGreaterThan(0);
  }, 15000);
  it('Maschine bezet, NI-agent draait: zeg wat te doen', async () => {
    const hid = new NepHidSysteem();
    const m = nepMaschine(hid);
    hid.zetBezet(m.naam, true);
    const { tekst } = await draai({ hid, ni: ['NIHardwareAgent'] });
    expect(tekst).toMatch(/! draait nu: NIHardwareAgent/);
    expect(tekst).toMatch(/✗ bezet: cannot open device/);
    expect(tekst).toContain(HINT.bezet);
  }, 15000);
  it('open maar niets binnen: de Invoermonitoring-hint', async () => {
    const hid = new NepHidSysteem();
    nepMaschine(hid);
    const { tekst } = await draai({ hid });
    expect(tekst).toContain(`✗ open, maar er komt niets binnen — ${HINT.invoer}`);
  }, 15000);
  it('geen node-hid en geen keyboard: ✗ met wat te doen', async () => {
    const { tekst } = await draai({ hid: null, hidReden: 'node-hid niet geïnstalleerd (x)' });
    expect(tekst).toMatch(/✗ xboard49: niet gevonden/);
    expect(tekst).toMatch(/✗ maschine-mk2: geen HID: node-hid niet geïnstalleerd \(x\) — npm install/);
  }, 15000);
});
