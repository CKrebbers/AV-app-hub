// De kern en de speelapparaten (PROTOCOL §17, src/core/spelers.js): wie krijgt de Xboard49 en de Maschine,
// wat gebeurt er met een ingedrukte toets bij een focuswissel, en waar gaan de lampjes en schermen heen.
import { describe, it, expect } from 'vitest';
import { NepKlok } from '../src/core/klok.js';
import { Kern } from '../src/core/kern.js';
import * as XB from '../src/devices/xboard49.js';
import * as MS from '../src/devices/maschine-mk2.js';
import { CONFIG, FL, DJ, AVK, nepOppervlak, nepVerbinding, meldAan, stuurApp, druk, los, van, leeg } from './kern-hulp.js';

const SPELER = { ...DJ, speelt: ['xboard49', 'maschine-mk2'] };
const KERN_SPELER = { ...AVK, speelt: ['maschine-mk2'] };
const ALLEEN_XB = { v: 1, app: 'medisynth', naam: 'MediSynth', lease: true, speelt: ['xboard49'], params: [] };

function opzet() {
  const klok = new NepKlok();
  const opp = nepOppervlak();
  /** Het speeloppervlak van de Maschine: wat de kern erheen stuurt. */
  const maschine = { log: /** @type {any[]} */ ([]), led(m) { this.log.push(['led', m]); }, scherm(nr, d) { this.log.push(['scherm', nr, d.length, d[0]]); }, leeg() { this.log.push(['leeg']); } };
  const kern = new Kern({ klok, config: CONFIG, oppervlak: opp, speelOppervlakken: { 'maschine-mk2': maschine } });
  const xbOntleder = XB.maakOntleder(XB.standaardProfiel());
  const xb = (b) => kern.invoer(xbOntleder(b), b);
  const ms = (b) => kern.invoer(MS.ontleedMidi(b), b);
  return { klok, kern, opp, maschine, xb, ms };
}
const midi = (v, dev) => van(v, 'midi').filter((m) => m.dev === dev).map((m) => m.bytes);
const base64 = (n = 2048, x = 0) => Buffer.from(new Uint8Array(n).fill(x)).toString('base64');

describe('kern: speelapparaten — wie speelt', () => {
  it('de app met APC-focus speelt als hij het apparaat in speelt heeft', () => {
    const { kern, xb } = opzet();
    const dj = meldAan(kern, SPELER);
    leeg(dj);
    xb([0x90, 60, 100]);
    expect(van(dj, 'midi')).toEqual([{ t: 'midi', dev: 'xboard49', bytes: [0x90, 60, 100] }]);
    expect(kern.beeld().spelers).toEqual({ xboard49: 'varve-dj', 'maschine-mk2': 'varve-dj' });
  });
  it('heeft de focus-app het niet, dan de laatst gefocuste die het wel heeft', () => {
    const { kern, xb, ms } = opzet();
    const dj = meldAan(kern, SPELER);
    const fl = meldAan(kern, FL);
    kern.focus('formula-lab');
    leeg(dj, fl);
    xb([0x90, 60, 100]);
    ms([0x90, 36, 90]);
    expect(midi(dj, 'xboard49')).toEqual([[0x90, 60, 100]]);
    expect(midi(dj, 'maschine-mk2')).toEqual([[0x90, 36, 90]]);
    expect(van(fl, 'midi')).toEqual([]);
  });
  it('per apparaat apart: de Maschine naar av-kern (focus), de Xboard blijft bij Varve DJ', () => {
    const { kern, xb, ms } = opzet();
    const dj = meldAan(kern, SPELER);
    const avk = meldAan(kern, KERN_SPELER);
    kern.focus('av-kern');
    leeg(dj, avk);
    xb([0x90, 60, 100]);
    ms([0x91, 36, 127]);
    expect(midi(dj, 'xboard49')).toEqual([[0x90, 60, 100]]);
    expect(midi(avk, 'maschine-mk2')).toEqual([[0x91, 36, 127]]);
    expect(midi(dj, 'maschine-mk2')).toEqual([]);
    kern.focus('varve-dj');
    leeg(dj, avk);
    ms([0x81, 36, 0]);   // los: naar wie het indrukken kreeg
    ms([0x91, 37, 127]);
    expect(midi(avk, 'maschine-mk2')).toEqual([[0x81, 36, 0]]);
    expect(midi(dj, 'maschine-mk2')).toEqual([[0x91, 37, 127]]);
  });
  it('nooit gefocust: de eerste in slotvolgorde die het speelt', () => {
    const { kern, xb } = opzet();
    const fl = meldAan(kern, FL);          // krijgt de focus (eerste app)
    const ms = meldAan(kern, ALLEEN_XB);
    const dj = meldAan(kern, SPELER);
    leeg(fl, ms, dj);
    xb([0x90, 60, 1]);
    expect(midi(ms, 'xboard49')).toEqual([[0x90, 60, 1]]);
    expect(midi(dj, 'xboard49')).toEqual([]);
  });
  it('niemand speelt: dan gaat het nergens heen (en een app zonder speelt krijgt nooit iets)', () => {
    const { kern, xb } = opzet();
    const fl = meldAan(kern, FL);
    const dj = meldAan(kern, DJ);
    kern.focus('varve-dj');
    leeg(fl, dj);
    xb([0x90, 60, 1]);
    xb([0xb0, 21, 5]);
    expect(van(fl, 'midi')).toEqual([]);
    expect(van(dj, 'midi')).toEqual([]);
    expect(kern.beeld().spelers).toEqual({ xboard49: null, 'maschine-mk2': null });
  });
  it('de hubtoets (Bank) doet niets met de speelapparaten: het keyboard blijft spelen', () => {
    const { kern, xb } = opzet();
    const dj = meldAan(kern, SPELER);
    leeg(dj);
    druk(kern, 'bank');
    xb([0x90, 60, 1]);
    los(kern, 'bank');
    expect(midi(dj, 'xboard49')).toEqual([[0x90, 60, 1]]);
  });
  it('valt de spelende app weg, dan speelt de volgende; komt hij terug en heeft hij focus, dan weer hij', () => {
    const { kern, xb } = opzet();
    const dj = meldAan(kern, SPELER);
    const ms = meldAan(kern, ALLEEN_XB);
    leeg(dj, ms);
    kern.verbreek(dj);
    xb([0x90, 60, 1]);
    expect(midi(ms, 'xboard49')).toEqual([[0x90, 60, 1]]);
    const dj2 = meldAan(kern, SPELER, { inst: 'i2' });
    kern.focus('varve-dj');
    xb([0x90, 61, 1]);
    expect(midi(dj2, 'xboard49')).toEqual([[0x90, 61, 1]]);
  });
  it('een nieuw manifest zonder speelt: die app speelt niet meer', () => {
    const { kern, xb } = opzet();
    const dj = meldAan(kern, SPELER);
    stuurApp(kern, dj, { t: 'manifest', manifest: DJ });
    leeg(dj);
    xb([0x90, 60, 1]);
    expect(van(dj, 'midi')).toEqual([]);
  });
});

describe('kern: speelapparaten — niets blijft hangen', () => {
  it('een ingedrukte toets bij een focuswissel: het loslaten gaat naar wie het indrukken kreeg', () => {
    const { kern, xb } = opzet();
    const dj = meldAan(kern, SPELER);
    const ms = meldAan(kern, ALLEEN_XB);
    kern.focus('varve-dj');
    xb([0x90, 60, 100]);
    xb([0xb0, 64, 127]);   // pedaal in
    kern.focus('medisynth');
    leeg(dj, ms);
    xb([0x80, 60, 0]);
    xb([0x90, 62, 90]);
    xb([0xb0, 64, 0]);     // pedaal op: ook naar Varve DJ
    expect(midi(dj, 'xboard49')).toEqual([[0x80, 60, 0], [0xb0, 64, 0]]);
    expect(midi(ms, 'xboard49')).toEqual([[0x90, 62, 90]]);
  });
  it('note-on met velocity 0 telt als loslaten; een loslaten van iets wat niemand vasthield gaat nergens heen', () => {
    const { kern, xb } = opzet();
    const dj = meldAan(kern, SPELER);
    leeg(dj);
    xb([0x90, 60, 0]);
    expect(van(dj, 'midi')).toEqual([]);
    xb([0x90, 60, 50]);
    xb([0x90, 60, 0]);
    expect(midi(dj, 'xboard49')).toEqual([[0x90, 60, 50], [0x90, 60, 0]]);
  });
  it('dezelfde toets nog eens in bij een andere app (geen loslaten tussendoor): de eerste krijgt eerst zijn loslaten', () => {
    const { kern, xb } = opzet();
    const dj = meldAan(kern, SPELER);
    const ms = meldAan(kern, ALLEEN_XB);
    kern.focus('varve-dj');
    xb([0x90, 60, 100]);
    kern.focus('medisynth');
    leeg(dj, ms);
    xb([0x90, 60, 80]);
    expect(midi(dj, 'xboard49')).toEqual([[0x80, 60, 0]]);
    expect(midi(ms, 'xboard49')).toEqual([[0x90, 60, 80]]);
  });
  it('polyfone aftertouch van de Maschine volgt de pad naar wie hem indrukte', () => {
    const { kern, ms } = opzet();
    const dj = meldAan(kern, SPELER);
    const avk = meldAan(kern, KERN_SPELER);
    kern.focus('varve-dj');
    ms([0x90, 40, 90]);
    kern.focus('av-kern');
    leeg(dj, avk);
    ms([0xa0, 40, 70]);
    ms([0xa0, 41, 70]);    // een pad die niet ingedrukt is: weg
    ms([0x80, 40, 0]);
    expect(midi(dj, 'maschine-mk2')).toEqual([[0xa0, 40, 70], [0x80, 40, 0]]);
    expect(midi(avk, 'maschine-mk2')).toEqual([]);
  });
  it('valt het apparaat weg, dan krijgt elke app het loslaten van wat hij nog vasthield', () => {
    const { kern, xb } = opzet();
    const dj = meldAan(kern, SPELER);
    const ms = meldAan(kern, ALLEEN_XB);
    kern.focus('varve-dj');
    xb([0x90, 60, 100]);
    xb([0xb0, 64, 127]);
    kern.focus('medisynth');
    xb([0x91, 62, 90]);
    leeg(dj, ms);
    kern.apparaatWeg('xboard49');
    expect(midi(dj, 'xboard49')).toEqual([[0x80, 60, 0], [0xb0, 64, 0]]);
    expect(midi(ms, 'xboard49')).toEqual([[0x81, 62, 0]]);
    leeg(dj, ms);
    kern.apparaatWeg('xboard49');
    xb([0x80, 60, 0]);
    expect(van(dj, 'midi')).toEqual([]);
  });
  it('paniek van de Xboard (CC 120/123): naar wie speelt én wie op dat kanaal nog iets vasthoudt', () => {
    const { kern, xb } = opzet();
    const dj = meldAan(kern, SPELER);
    const ms = meldAan(kern, ALLEEN_XB);
    kern.focus('varve-dj');
    xb([0x90, 60, 100]);
    kern.focus('medisynth');
    leeg(dj, ms);
    xb([0xb0, 123, 0]);
    xb([0x80, 60, 0]);     // al losgelaten door de paniek: nergens heen
    expect(midi(dj, 'xboard49')).toEqual([[0xb0, 123, 0]]);
    expect(midi(ms, 'xboard49')).toEqual([[0xb0, 123, 0]]);
  });
  it('paniek laat het pedaal staan: wie het indrukte krijgt de paniek, en later ook het loslaten', () => {
    const { kern, xb } = opzet();
    const dj = meldAan(kern, SPELER);
    const ms = meldAan(kern, ALLEEN_XB);
    kern.focus('varve-dj');
    xb([0xb0, 64, 127]);
    kern.focus('medisynth');
    leeg(dj, ms);
    xb([0xb0, 123, 0]);
    xb([0xb0, 64, 0]);
    expect(midi(dj, 'xboard49')).toEqual([[0xb0, 123, 0], [0xb0, 64, 0]]);
    expect(midi(ms, 'xboard49')).toEqual([[0xb0, 123, 0]]);
  });
});

describe('kern: speelapparaten — lampjes en schermen terug', () => {
  it('LED\'s met dev gaan naar de Maschine als die app speelt, en worden bewaard', () => {
    const { kern, maschine } = opzet();
    const dj = meldAan(kern, SPELER);
    maschine.log.length = 0;
    stuurApp(kern, dj, { t: 'led', dev: 'maschine-mk2', bytes: [[0x90, 36, 5], [0x91, 36, 127]] });
    expect(maschine.log).toEqual([['led', [0x90, 36, 5]], ['led', [0x91, 36, 127]]]);
  });
  it('zonder dev blijft een LED-bericht voor de APC (zoals altijd); de Xboard krijgt niets', () => {
    const { kern, maschine, opp } = opzet();
    const dj = meldAan(kern, SPELER);
    maschine.log.length = 0;
    opp.gestuurd.length = 0;
    stuurApp(kern, dj, { t: 'led', bytes: [[0x90, 1, 45]] });
    stuurApp(kern, dj, { t: 'led', dev: 'xboard49', bytes: [[0x90, 1, 45]] });
    expect(opp.gestuurd).toEqual([[0x90, 1, 45]]);
    expect(maschine.log).toEqual([]);
  });
  it('wisselt wie speelt: alles uit, dan de bewaarde lampjes en schermen van de nieuwe (volledige repaint)', () => {
    const { kern, maschine } = opzet();
    const dj = meldAan(kern, SPELER);
    const avk = meldAan(kern, KERN_SPELER);
    // av-kern speelt nog niet (Varve DJ heeft de focus): alleen bewaren
    maschine.log.length = 0;
    stuurApp(kern, avk, { t: 'led', dev: 'maschine-mk2', bytes: [[0x90, 40, 21], [0x90, 40, 45]] });
    stuurApp(kern, avk, { t: 'scherm', dev: 'maschine-mk2', nr: 1, data: base64(2048, 0xff) });
    expect(maschine.log).toEqual([]);
    kern.focus('av-kern');
    expect(maschine.log).toEqual([['leeg'], ['led', [0x90, 40, 45]], ['scherm', 1, 2048, 0xff]]);
    stuurApp(kern, dj, { t: 'led', dev: 'maschine-mk2', bytes: [[0x90, 36, 5]] });
    maschine.log.length = 0;
    kern.focus('varve-dj');
    expect(maschine.log).toEqual([['leeg'], ['led', [0x90, 36, 5]]]);
    // dezelfde focus nog eens: geen repaint
    maschine.log.length = 0;
    kern.focus('varve-dj');
    expect(maschine.log).toEqual([]);
  });
  it('valt de enige speler weg: de Maschine gaat uit; een app zonder maschine-mk2 in speelt kan er niets op zetten', () => {
    const { kern, maschine } = opzet();
    const dj = meldAan(kern, SPELER);
    const ms = meldAan(kern, ALLEEN_XB);
    maschine.log.length = 0;
    stuurApp(kern, ms, { t: 'led', dev: 'maschine-mk2', bytes: [[0x90, 36, 5]] });
    stuurApp(kern, ms, { t: 'scherm', dev: 'maschine-mk2', nr: 0, data: base64() });
    expect(maschine.log).toEqual([]);
    kern.verbreek(dj);
    expect(maschine.log).toEqual([['leeg']]);
  });
  it('een app die zonder manifest wegvalt, wordt vergeten, ook in de focusvolgorde', () => {
    const { kern, xb } = opzet();
    const v = nepVerbinding();
    kern.verbind(v);
    stuurApp(kern, v, { t: 'hallo', app: 'medisynth', inst: 'a', v: 1 });   // krijgt de focus, stuurt nooit een manifest
    expect(kern.spel.focusVolgorde).toEqual(['medisynth']);
    kern.verbreek(v);
    expect(kern.spel.focusVolgorde).toEqual([]);
    const dj = meldAan(kern, SPELER);
    leeg(dj);
    xb([0x90, 60, 1]);
    expect(midi(dj, 'xboard49')).toEqual([[0x90, 60, 1]]);
  });
  it('het beeld noemt per app wat hij speelt', () => {
    const { kern } = opzet();
    meldAan(kern, SPELER);
    meldAan(kern, FL);
    const apps = kern.beeld().apps;
    expect(apps.find((a) => a.app === 'varve-dj').speelt).toEqual(['xboard49', 'maschine-mk2']);
    expect('speelt' in apps.find((a) => a.app === 'formula-lab')).toBe(false);
  });
});
