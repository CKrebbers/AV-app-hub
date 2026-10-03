import { describe, it, expect } from 'vitest';
import { NepKlok } from '../src/core/klok.js';
import { NepSysteem } from '../src/ports/nep.js';
import { maakApparaten } from '../src/apparaten.js';
import * as A from '../src/devices/apc40mk2.js';

const config = { hotplug_ms: 2000, led: { per_burst: 16, burst_ms: 4 }, apparaten: { apc40: { naam: 'apc40', modus: 0x42 }, lpd8: { naam: 'lpd8' } } };

function opzet() {
  const klok = new NepKlok(), systeem = new NepSysteem();
  const app = maakApparaten({ systeem, klok, config });
  return { klok, systeem, app };
}

describe('APC-sessie', () => {
  it('zet bij aansluiten eerst de modus, dan ringtypes, dan alle LEDs', () => {
    const { klok, systeem, app } = opzet();
    const apc = systeem.voegToe('APC40 mkII');
    app.start(); klok.loop(100);
    expect(apc.verstuurd[0]).toEqual(A.intro(0x42));
    expect(apc.verstuurd.slice(1, 17).every((b) => b[0] === 0xb0 && (b[1] < 32 || b[1] > 55))).toBe(true);
    expect(apc.verstuurd).toHaveLength(1 + 16 + 125);
  });
  it('uittrekken en terugsteken: weg-melding, daarna opnieuw init en hetzelfde beeld', () => {
    const { klok, systeem, app } = opzet();
    systeem.voegToe('APC40 mkII');
    const meldingen = [];
    app.apc.bij('weg', () => meldingen.push('weg'));
    app.apc.bij('verbonden', () => meldingen.push('verbonden'));
    app.start(); klok.loop(100);
    app.apc.zet('pad3-3', { kleur: 45 }); app.apc.teken(); klok.loop(10);
    systeem.verwijder('APC40 mkII'); klok.loop(2000);
    expect(app.apc.verbonden).toBe(false);
    const nieuw = systeem.voegToe('APC40 mkII'); klok.loop(2000);
    expect(meldingen).toEqual(['verbonden', 'weg', 'verbonden']);
    expect(nieuw.verstuurd[0]).toEqual(A.intro(0x42));
    expect(nieuw.verstuurd).toContainEqual([0x90, 18, 45]);
    expect(nieuw.verstuurd).toHaveLength(1 + 16 + 125);
  });
  it('meldt gebeurtenissen uit binnenkomende MIDI', () => {
    const { klok, systeem, app } = opzet();
    const apc = systeem.voegToe('APC40 mkII');
    const g = [];
    app.apc.bij('gebeurtenis', (e) => g.push(e));
    app.start(); klok.loop(10);
    apc.injecteer([0xb2, 7, 100]);
    expect(g).toEqual([{ dev: 'apc40', el: 'fader3', kind: 'waarde', v: 100 / 127, raw: 100 }]);
  });
  it('stop() zet alles uit via de wachtrij en sluit dan pas de poort', async () => {
    const { klok, systeem, app } = opzet();
    const apc = systeem.voegToe('APC40 mkII');
    app.start(); klok.loop(100);
    for (let i = 1; i <= 8; i++) app.apc.zet(`pad5-${i}`, { kleur: 5 });
    for (let i = 1; i <= 8; i++) app.apc.zet(`sel${i}`, { aan: true });
    for (let i = 1; i <= 8; i++) app.apc.zet(`tk${i}`, { waarde: 1 });
    app.apc.teken(); klok.loop(20);
    apc.verstuurd.length = 0;
    const klaar = app.stop();
    klok.loop(0); expect(apc.verstuurd).toHaveLength(16); // eerste portie, niet alles tegelijk
    klok.loop(20); await klaar;
    expect(apc.verstuurd).toHaveLength(24);
    expect(apc.open).toBe(false);
  });
});

describe('LPD8-sessie', () => {
  it('vraagt identiteit, herkent mk2 en gebruikt dan het fabrieksprofiel', () => {
    const { klok, systeem, app } = opzet();
    const lpd = systeem.voegToe('LPD8 mk2');
    lpd.antwoord = (b) => { if (b[1] === 0x7e) lpd.injecteer([0xf0, 0x7e, 0x00, 0x06, 0x02, 0x47, 0x4c, 0x00, 0x19, 0x00, 0xf7]); };
    const g = [];
    app.lpd8.bij('gebeurtenis', (e) => g.push(e));
    app.start(); klok.loop(10);
    expect(app.lpd8.model).toBe('mk2');
    lpd.injecteer([0x99, 37, 90]);
    lpd.injecteer([0xb0, 72, 127]);
    expect(g.slice(-2)).toEqual([
      { dev: 'lpd8', el: 'p2', kind: 'druk', v: 90 / 127, raw: 90 },
      { dev: 'lpd8', el: 'k3', kind: 'waarde', v: 1, raw: 127 },
    ]);
  });
});
