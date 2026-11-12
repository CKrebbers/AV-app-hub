// doctor toont de APC-handdruk stap voor stap: welke identiteitsvraag en welke modus-instructie de APC beantwoordt.
import { describe, it, expect } from 'vitest';
import { doctor, draaiendeApcProgrammas } from '../src/doctor.js';
import { laadConfig } from '../src/config.js';
import { NepSysteem } from '../src/ports/nep.js';

const config = laadConfig();
const identiteit = (id) => [0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x29, 0x00, 0x19, 1, 2, 0, 3, id, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 0xf7];

/**
 * @param {{ omni?: boolean, id?: number, stil?: boolean, geenIntroAntwoord?: boolean, bijLuisteren?: number[][], programmas?: string[], hub?: boolean }} o
 *   geenIntroAntwoord: identiteit wel, maar nooit 0x61; bijLuisteren: wat Clay drukt terwijl doctor luistert
 */
async function draai({ omni = true, id = 0, stil = false, geenIntroAntwoord = false, bijLuisteren = [], programmas = [], hub = false } = {}) {
  const midi = new NepSysteem();
  const apc = midi.voegToe('APC40 mkII');
  const vragen = [];
  apc.antwoord = (b) => {
    if (stil || b[0] !== 0xf0) return;
    if (geenIntroAntwoord && b[1] === 0x47) return;
    if (b[2] === 0x7f ? !omni : b[2] !== id) return;
    if (b[1] === 0x7e) setTimeout(() => apc.injecteer(identiteit(id)), 1);
    if (b[1] === 0x47 && b[4] === 0x60) setTimeout(() => apc.injecteer([0xf0, 0x47, id, 0x29, 0x61, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0xf7]), 1);
  };
  const r = await doctor({ config, laadMidi: async () => ({ systeem: midi }), laadHid: async () => ({ systeem: null, reden: 'x' }),
    niProgrammas: () => [], wachtMs: 20, hubDraait: async () => hub, apcLuisterMs: 300, apcProgrammas: () => programmas,
    vraag: (t) => { vragen.push(t); setTimeout(() => { for (const b of bijLuisteren) apc.injecteer(b); }, 50); } });
  return { ...r, vragen };
}

describe('doctor: APC-handdruk', () => {
  it('een APC die 0x7F negeert: omni geen antwoord, kanaal 0 wel, de intro met het eigen id zet de modus', async () => {
    const { tekst, data } = await draai({ omni: false, id: 0 });
    expect(tekst).toMatch(/identiteit \(omni, zoals het protocol, direct na openen\): geen antwoord/);
    expect(tekst).toMatch(/identiteit \(omni, 0,5 s later\): geen antwoord/);
    expect(tekst).toMatch(/product: 0x29 \(APC40 mkII\)/);
    expect(tekst).toMatch(/identiteit \(kanaal 0, zoals Ableton Live\): f0 7e .* · apparaat-id 0/);
    expect(tekst).toMatch(/modus-instructie \(intro, id 0x7f\): ✗ geen antwoord/);
    expect(tekst).toMatch(/modus-instructie \(intro, id 0\): ✔ antwoord/);
    expect(tekst).toMatch(/✔ apc40 gaat in de hub-modus/);
    expect(data.apc40.handdruk).toMatchObject({ apparaatId: 0, intro7f: false, introId: true, intro0: false, gezet: true });
    expect(data.apc40.identiteit).toEqual(identiteit(0));
  }, 15000);
  it('een APC volgens het protocol: alles in één keer', async () => {
    const { tekst, data } = await draai({ omni: true, id: 0 });
    expect(tekst).toMatch(/modus-instructie \(intro, id 0x7f\): ✔ antwoord/);
    expect(tekst).not.toMatch(/intro, id 0\)/);
    expect(data.apc40.handdruk.gezet).toBe(true);
  }, 15000);
  it('een APC die op niets antwoordt en niets stuurt: zeg dat er niets binnenkomt en wat te doen (geen adapter, geen firmware)', async () => {
    const { tekst, data, vragen } = await draai({ stil: true });
    expect(vragen).toEqual([expect.stringMatching(/druk nu op Track Select 1 en beweeg fader 1/)]);
    expect(tekst).toMatch(/✗ apc40: geen antwoord op de modus-instructie en er kwam niets binnen \(ook geen fader of knop\)/);
    expect(tekst).toMatch(/aan\/uit-knop achterop/);
    // De mkII krijgt stroom via USB (User Guide v1.0); een firmware-updater van Akai is nergens te vinden.
    expect(tekst).not.toMatch(/stroomadapter|firmware/);
    expect(tekst).toMatch(/ontvangen van de APC: 0 berichten/);
    expect(data.apc40.handdruk).toMatchObject({ gezet: false, trackSelect: false, invoerTijdensLuisteren: 0 });
  }, 15000);
  it('geen antwoord op de intro, maar Track Select komt binnen: de modus staat (geen vals alarm)', async () => {
    const { tekst, data } = await draai({ geenIntroAntwoord: true, bijLuisteren: [[0x90, 51, 127], [0x80, 51, 0], [0xb0, 7, 90]] });
    expect(tekst).toMatch(/modus-instructie \(intro, id 0x7f\): ✗ geen antwoord/);
    expect(tekst).toMatch(/✔ apc40: Track Select komt binnen, dus de hub-modus staat/);
    expect(tekst).not.toMatch(/fabrieksmodus/);
    expect(data.apc40.handdruk).toMatchObject({ gezet: true, trackSelect: true });
  }, 15000);
  it('alleen de fader komt binnen, Track Select niet: hij staat in de fabrieksmodus (0x40)', async () => {
    const { tekst, data } = await draai({ geenIntroAntwoord: true, bijLuisteren: [[0xb0, 7, 90], [0xb0, 7, 91]] });
    expect(tekst).toMatch(/✗ apc40: wel invoer, maar Track Select stuurt niets: hij staat nog in de fabrieksmodus \(0x40\)/);
    expect(data.apc40.handdruk).toMatchObject({ gezet: false, trackSelect: false, invoerTijdensLuisteren: 2 });
  }, 15000);
  it('Ableton Live of de hub draait ook: een waarschuwing (ze delen de poort en sturen hun eigen intro)', async () => {
    const { tekst } = await draai({ programmas: ['Ableton Live'], hub: true });
    expect(tekst).toMatch(/! draait nu: Ableton Live, de hub zelf \(poort \d+\) — die sturen zelf een intro naar de APC/);
  }, 15000);
  it('de originele APC40 (product 0x73) heet anders dan de mkII: doctor zegt het', async () => {
    const midi = new NepSysteem();
    const apc = midi.voegToe('Akai APC40');
    apc.antwoord = (b) => { if (b[1] === 0x7e) setTimeout(() => apc.injecteer([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x73, 0x00, 0x19, 1, 2, 0, 3, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 0xf7]), 1); };
    const { tekst } = await doctor({ config, laadMidi: async () => ({ systeem: midi }), laadHid: async () => ({ systeem: null, reden: 'x' }),
      niProgrammas: () => [], wachtMs: 20, hubDraait: async () => false, apcLuisterMs: 0, apcProgrammas: () => [] });
    expect(tekst).toMatch(/product: 0x73 — dat is de originele APC40, niet de mkII/);
  }, 15000);
  it('draaiendeApcProgrammas: Ableton Live en Bitwig uit de proceslijst (ps -axo comm geeft volledige paden)', () => {
    const ps = () => ['/Applications/Ableton Live 12 Suite.app/Contents/MacOS/Live', '/usr/bin/login', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].join('\n');
    expect(draaiendeApcProgrammas(ps)).toEqual(['Ableton Live']);
    expect(draaiendeApcProgrammas(() => '/Applications/Bitwig Studio.app/Contents/MacOS/BitwigStudio\n')).toEqual(['Bitwig Studio']);
    expect(draaiendeApcProgrammas(() => { throw new Error('geen ps'); })).toEqual([]);
  });
});
