import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NepKlok } from '../src/core/klok.js';
import { NepSysteem } from '../src/ports/nep.js';
import { maakDriver, APPS_MAP } from '../src/drivers/index.js';
import { VERSTUURD_MAX } from '../src/drivers/basis.js';

const leesApp = (/** @type {string} */ n) => JSON.parse(readFileSync(join(APPS_MAP, n), 'utf8'));

const rust = () => new Promise((r) => setImmediate(r));
/** Kern die alleen verbindt en alles slikt: hier gaat het om wat de driver zelf bewaart. */
const stilleKern = () => ({ verbind() {}, ontvang() {}, verbreek() {} });

describe('drivers bewaren hun diagnoselog begrensd (een avond spelen lekt geen geheugen)', () => {
  it('de grens is klein', () => {
    expect(VERSTUURD_MAX).toBeGreaterThan(0);
    expect(VERSTUURD_MAX).toBeLessThanOrEqual(1000);
  });

  it('MIDI: een bewegende fader naar TD laat driver.verstuurd niet onbegrensd groeien', () => {
    const klok = new NepKlok(), systeem = new NepSysteem();
    const d = /** @type {any} */ (maakDriver(leesApp('av-scene-kit.json'), { systeem, klok }));
    d.start(stilleKern());
    systeem.apparaten.get('VARVE-HUB TD').stuur = () => {}; // de nep-poort zelf hoeft niets te bewaren
    for (let i = 0; i < 20000; i++) d.verbinding.stuur({ t: 'zet', id: 'feedback', v: i % 2 });
    expect(d.driver.verstuurd.length).toBeLessThanOrEqual(VERSTUURD_MAX);
    expect(d.driver.verstuurd.at(-1)).toEqual([0xb0, 20, 127]); // het laatste bericht staat er wel in
    d.stop();
  });

  it('HTTP: een bewegende parameter naar uurwerk laat driver.verstuurd niet onbegrensd groeien', async () => {
    const klok = new NepKlok();
    const fetch = async () => ({ ok: true, status: 200, text: async () => 'tabs: 1' });
    const d = /** @type {any} */ (maakDriver(leesApp('uurwerk.json'), { klok, fetch }));
    d.start(stilleKern());
    for (let i = 0; i < 5000; i++) { d.verbinding.stuur({ t: 'zet', id: 'onrust', v: (i % 10) / 10 }); klok.loop(100); await rust(); } // rust: de gezondheidscheck slaagt
    expect(d.driver.verstuurd.length).toBeLessThanOrEqual(VERSTUURD_MAX);
    expect(d.driver.verstuurd.at(-1).args.waarde).toBe(0.9);
    d.stop();
  });
});
