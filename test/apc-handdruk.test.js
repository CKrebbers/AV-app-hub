// De handdruk met de APC40 mkII (src/apparaten.js ApcSessie.init): de intro zoals het protocol hem voorschrijft
// (apparaat-id 0x7F), plus wat Ableton Live doet (identiteitsvraag op kanaal 0, intro met het eigen apparaat-id).
// Aanleiding: op de echte Mac antwoordde de APC niet op de omni-identiteitsvraag (doctor: "identiteit: geen
// antwoord") en voelde niets goed: precies wat je krijgt als de APC in de fabrieksmodus (0x40) blijft.
import { describe, it, expect } from 'vitest';
import { NepKlok } from '../src/core/klok.js';
import { NepSysteem } from '../src/ports/nep.js';
import { maakApparaten, HANDDRUK_MS } from '../src/apparaten.js';
import * as A from '../src/devices/apc40mk2.js';

const config = { hotplug_ms: 2000, led: { per_burst: 16, burst_ms: 4 }, apparaten: { apc40: { naam: 'apc40', modus: 0x42 }, lpd8: { naam: 'lpd8' } } };

/** Identiteitsantwoord van een echte APC40 mkII (protocol v1.2 p.5): 26 bytes, apparaat-id op index 13. */
const identiteit = (id) => [0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x29, 0x00, 0x19, 1, 2, 0, 3, id, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 0xf7];
const introAntwoord = [0xf0, 0x47, 0x00, 0x29, 0x61, 0x00, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0xf7];
const isIntro = (b) => b[0] === 0xf0 && b[1] === 0x47 && b[3] === 0x29 && b[4] === 0x60;

/**
 * Een nep-APC. `omni`: antwoordt hij op SysEx met kanaal/apparaat-id 0x7F (zoals het protocol belooft)?
 * `id`: zijn eigen apparaat-id. `stil`: antwoordt helemaal niet (SysEx komt niet aan).
 */
function opzet({ omni = true, id = 0, stil = false } = {}) {
  const klok = new NepKlok(), systeem = new NepSysteem();
  const app = maakApparaten({ systeem, klok, config });
  const apc = systeem.voegToe('APC40 mkII');
  const modus = { gezet: false, via: /** @type {number|null} */ (null) };
  apc.antwoord = (b) => {
    if (stil || b[0] !== 0xf0) return;
    const doel = b[1] === 0x7e ? b[2] : b[2];          // identiteit: kanaal; intro: apparaat-id
    if (doel === 0x7f ? !omni : doel !== id) return;
    if (b[1] === 0x7e && b[3] === 0x06 && b[4] === 0x01) apc.injecteer(identiteit(id));
    if (isIntro(b)) { modus.gezet = true; modus.via = b[2]; apc.injecteer(introAntwoord); }
  };
  const handdruk = [];
  app.apc.bij('handdruk', (h) => handdruk.push(h));
  app.start();
  return { klok, app, apc, modus, handdruk };
}

describe('APC-handdruk', () => {
  it('een APC die 0x7F negeert (zoals op de Mac): de hub vraagt op kanaal 0 en stuurt de intro met het eigen apparaat-id', () => {
    const { klok, apc, modus, handdruk, app } = opzet({ omni: false, id: 0 });
    klok.loop(100);
    expect(modus).toEqual({ gezet: true, via: 0 });
    const intros = apc.verstuurd.filter(isIntro);
    expect(intros).toEqual([A.intro(0x42), A.intro(0x42, 0)]);
    // na de tweede intro is het hele beeld opnieuw getekend (de modus-wissel kan de LEDs gewist hebben)
    const naTweede = apc.verstuurd.slice(apc.verstuurd.findIndex((b) => isIntro(b) && b[2] === 0) + 1);
    expect(naTweede.filter((b) => (b[0] & 0xf0) === 0x90 || (b[0] & 0xf0) === 0x80).length).toBeGreaterThanOrEqual(100);
    expect(handdruk).toEqual([{ ok: true, identiteit: true, apparaatId: 0, introAntwoord: true }]);
    klok.loop(HANDDRUK_MS * 2);
    expect(handdruk).toHaveLength(1);                   // geen valse melding achteraf
    expect(app.apc.handdruk.introAntwoord).toBe(true);
  });

  it('een APC die volgens het protocol op 0x7F antwoordt: geen tweede intro', () => {
    const { klok, apc, modus, handdruk } = opzet({ omni: true, id: 0 });
    klok.loop(100);
    expect(modus).toEqual({ gezet: true, via: 0x7f });
    expect(apc.verstuurd.filter(isIntro)).toEqual([A.intro(0x42)]);
    expect(handdruk.map((h) => h.ok)).toEqual([true]);
  });

  it('een APC die nergens op antwoordt: na HANDDRUK_MS één melding dat de modus niet gezet lijkt', () => {
    const { klok, handdruk } = opzet({ stil: true });
    klok.loop(HANDDRUK_MS - 10);
    expect(handdruk).toEqual([]);
    klok.loop(HANDDRUK_MS * 3);
    expect(handdruk).toEqual([{ ok: false, identiteit: false, apparaatId: null, introAntwoord: false }]);
  });

  it('een identiteit maar geen antwoord op de intro: de melding zegt dat de identiteit er wel was', () => {
    const { klok, apc, handdruk } = opzet({ omni: false, id: 5 });
    apc.antwoord = (b) => { if (b[1] === 0x7e && b[2] === 0x00) apc.injecteer(identiteit(5)); };
    klok.loop(HANDDRUK_MS + 100);
    expect(handdruk).toEqual([{ ok: false, identiteit: true, apparaatId: 5, introAntwoord: false }]);
    expect(apc.verstuurd.filter(isIntro).map((b) => b[2])).toEqual([0x7f, 5]);
  });

  it('opnieuw aansluiten begint een nieuwe handdruk; stoppen laat geen timer staan', async () => {
    const { klok, app, handdruk } = opzet({ stil: true });
    klok.loop(100);
    app.apc.init();                                     // bv. na een replug
    klok.loop(HANDDRUK_MS + 10);
    expect(handdruk).toHaveLength(1);                   // de eerste timer is vervangen, niet dubbel
    app.apc.init();
    const gestopt = app.stop();
    klok.loop(1000);                                    // zwart tekenen bij stoppen loopt over de (nep-)klok
    await gestopt;
    const voor = klok.timers.size;
    klok.loop(HANDDRUK_MS * 2);
    expect(handdruk).toHaveLength(1);
    expect(voor).toBe(0);
  });

  it('apparaatIdUit leest byte 14 van het identiteitsantwoord; korte of vreemde berichten geven null', () => {
    expect(A.apparaatIdUit(identiteit(0))).toBe(0);
    expect(A.apparaatIdUit(identiteit(0x7f))).toBe(0x7f);
    expect(A.apparaatIdUit([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x29, 0x00, 0x19, 0, 1, 0, 0xf7])).toBe(null);
    expect(A.apparaatIdUit([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x4c, 0, 0x19, 0, 0, 0, 0, 0, 0, 0xf7])).toBe(null);   // LPD8
    expect(A.ontleed(identiteit(3))).toMatchObject({ kind: 'identiteit', apparaatId: 3 });
  });
});
