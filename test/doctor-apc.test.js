// doctor toont de APC-handdruk stap voor stap: welke identiteitsvraag en welke modus-instructie de APC beantwoordt.
import { describe, it, expect } from 'vitest';
import { doctor } from '../src/doctor.js';
import { laadConfig } from '../src/config.js';
import { NepSysteem } from '../src/ports/nep.js';

const config = laadConfig();
const identiteit = (id) => [0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x29, 0x00, 0x19, 1, 2, 0, 3, id, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 0xf7];

/** @param {{ omni?: boolean, id?: number, stil?: boolean }} o */
async function draai({ omni = true, id = 0, stil = false } = {}) {
  const midi = new NepSysteem();
  const apc = midi.voegToe('APC40 mkII');
  apc.antwoord = (b) => {
    if (stil || b[0] !== 0xf0) return;
    if (b[2] === 0x7f ? !omni : b[2] !== id) return;
    if (b[1] === 0x7e) setTimeout(() => apc.injecteer(identiteit(id)), 1);
    if (b[1] === 0x47 && b[4] === 0x60) setTimeout(() => apc.injecteer([0xf0, 0x47, id, 0x29, 0x61, 0, 4, 0, 0, 0, 0, 0, 0, 0, 0, 0xf7]), 1);
  };
  return doctor({ config, laadMidi: async () => ({ systeem: midi }), laadHid: async () => ({ systeem: null, reden: 'x' }),
    niProgrammas: () => [], wachtMs: 20, hubDraait: async () => false });
}

describe('doctor: APC-handdruk', () => {
  it('een APC die 0x7F negeert: omni geen antwoord, kanaal 0 wel, de intro met het eigen id zet de modus', async () => {
    const { tekst, data } = await draai({ omni: false, id: 0 });
    expect(tekst).toMatch(/identiteit \(omni, zoals het protocol\): geen antwoord/);
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
  it('een APC die op niets antwoordt: zeg dat hij in de fabrieksmodus blijft en wat te doen', async () => {
    const { tekst, data } = await draai({ stil: true });
    expect(tekst).toMatch(/✗ apc40 reageert op geen enkele modus-instructie: hij blijft in de fabrieksmodus/);
    expect(tekst).toMatch(/firmware bijwerken/);
    expect(data.apc40.handdruk.gezet).toBe(false);
  }, 15000);
});
