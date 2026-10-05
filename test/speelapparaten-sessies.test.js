// De sessies van de speelapparaten (src/apparaten.js): XboardSessie met een NepSysteem (alleen een ingang),
// MaschineSessie met een NepHidSysteem. Nep-klok: niets wacht echt.
import { describe, it, expect } from 'vitest';
import { NepKlok } from '../src/core/klok.js';
import { NepSysteem, NepHidSysteem } from '../src/ports/nep.js';
import { Logboek, leesLogboek } from '../src/core/logboek.js';
import { maakApparaten } from '../src/apparaten.js';
import * as MS from '../src/devices/maschine-mk2.js';
import { nepMaschine, rustFrame, XBOARD_NAAM, padFrame } from './nep-speelapparaten.js';

const BASIS = { hotplug_ms: 2000, led: { per_burst: 16, burst_ms: 4 }, apparaten: { apc40: { naam: 'apc40', modus: 0x42 }, lpd8: { naam: 'lpd8' } } };
const MASCHINE = { vid: '17cc', pid: '1140', stil_ms: 1500 };
const CONFIG = { ...BASIS, apparaten: { ...BASIS.apparaten, xboard49: { naam: 'xboard' }, 'maschine-mk2': MASCHINE } };

function opzet({ config = CONFIG, hid = new NepHidSysteem(), logboek = false } = {}) {
  const klok = new NepKlok(), systeem = new NepSysteem();
  const regels = [];
  const log = logboek ? new Logboek({ klok, schrijf: (r) => regels.push(r), kop: { soort: 'test' } }) : null;
  const app = maakApparaten({ systeem, hid, klok, config, logboek: log });
  /** @type {any[]} */ const meldingen = [];
  /** @type {any[]} */ const gebeurtenissen = [];
  for (const [dev, s] of [['xboard49', app.xboard], ['maschine-mk2', app.maschine]]) {
    if (!s) continue;
    for (const e of ['verbonden', 'weg', 'fout', 'status']) s.bij(e, (...a) => meldingen.push([dev, e, ...a.map((x) => (x instanceof Error ? x.message : x))]));
    s.bij('gebeurtenis', (g, b) => gebeurtenissen.push([g, b]));
  }
  return { klok, systeem, hid, app, meldingen, gebeurtenissen, regels };
}

describe('Xboard49-sessie', () => {
  it('opent alleen de ingang (het keyboard heeft geen uitgang), meldt gebeurtenissen en stuurt nooit iets', () => {
    const { klok, systeem, app, gebeurtenissen } = opzet();
    const xb = systeem.voegToe(XBOARD_NAAM, { uitgang: false });
    app.start(); klok.loop(10);
    expect(app.xboard.verbonden).toBe(true);
    expect(app.xboard.poort.naam).toBe(XBOARD_NAAM);
    xb.injecteer([0x90, 60, 100]);
    xb.injecteer([0xb0, 21, 5]);
    expect(gebeurtenissen.map(([g, b]) => [g.el, g.kind, b])).toEqual([['noot', 'druk', [0x90, 60, 100]], ['k1', 'waarde', [0xb0, 21, 5]]]);
    klok.loop(100);
    expect(xb.verstuurd).toEqual([]);
  });
  it('hotplug zoals de LPD8: eruit → weg, erin → weer verbonden', () => {
    const { klok, systeem, app, meldingen } = opzet();
    systeem.voegToe(XBOARD_NAAM, { uitgang: false });
    app.start(); klok.loop(10);
    systeem.verwijder(XBOARD_NAAM); klok.loop(300);
    systeem.voegToe(XBOARD_NAAM, { uitgang: false }); klok.loop(300);
    expect(meldingen.filter((m) => m[0] === 'xboard49').map((m) => m[1])).toEqual(['verbonden', 'weg', 'verbonden']);
  });
  it('een geleerd profiel geeft de knoppen hun naam', () => {
    const { klok, systeem, app, gebeurtenissen } = opzet();
    const xb = systeem.voegToe(XBOARD_NAAM, { uitgang: false });
    app.start(); klok.loop(10);
    app.xboard.zetProfiel({ bron: 'geleerd', knoppen: [{ n: 102 }] });
    xb.injecteer([0xb0, 102, 9]);
    expect(gebeurtenissen.at(-1)[0]).toMatchObject({ el: 'k1', raw: 9 });
  });
  it('zonder apparaten.xboard49 in config.json is er geen Xboard-sessie', () => {
    const { app } = opzet({ config: BASIS });
    expect(app.xboard).toBe(null);
    expect(app.maschine).toBe(null);
    expect(app.sessie('xboard49')).toBe(null);
    expect(app.sessie('apc40')).toBe(app.apc);
  });
});

describe('Maschine-sessie', () => {
  it('zonder HID: status geen-hid, start doet niets', () => {
    const { klok, app } = opzet({ hid: null });
    app.start(); klok.loop(5000);
    expect(app.maschine.status).toBe('geen-hid');
    expect(app.maschine.verbonden).toBe(false);
  });
  it('zonder geldige vid/pid in config.json: geen-hid, met de reden', () => {
    const { app } = opzet({ config: { ...CONFIG, apparaten: { ...CONFIG.apparaten, 'maschine-mk2': { vid: 'zz' } } } });
    expect(app.maschine.status).toBe('geen-hid');
    expect(app.maschine.statusReden).toMatch(/vid\/pid/);
  });
  it('vindt hem op VID:PID, opent (exclusief, tenzij niet_exclusief) en tekent alles één keer', () => {
    const { klok, hid, app, meldingen } = opzet();
    const m = nepMaschine(hid);
    app.start(); klok.loop(50);
    expect(app.maschine.verbonden).toBe(true);
    expect(app.maschine.naam).toBe('Maschine Controller MK2');
    expect(m.poort.opties).toEqual({ nietExclusief: false });
    expect(meldingen).toContainEqual(['maschine-mk2', 'status', 'verbonden', null]);
    // de eerste repaint: 3 LED-rapporten + 2 × 8 schermstukken, alles uit
    expect(m.poort.verstuurd.map((r) => r.length).sort()).toEqual([...Array(16).fill(265), 32, 49, 57].sort());
    expect(m.poort.verstuurd.filter((r) => r.length !== 265).every((r) => r.slice(1).every((x) => x === 0))).toBe(true);
  });
  it('HID-schrijven gaat in kleine porties: standaard 4 rapporten per burst_ms (per_burst in config.json)', () => {
    const { klok, hid, app } = opzet();
    const m = nepMaschine(hid);
    app.start();
    klok.loop(0);
    expect(m.poort.verstuurd).toHaveLength(4);
    klok.loop(4);
    expect(m.poort.verstuurd).toHaveLength(8);
    const anders = opzet({ config: { ...CONFIG, apparaten: { ...CONFIG.apparaten, 'maschine-mk2': { ...MASCHINE, per_burst: 2 } } } });
    expect(anders.app.maschine.rij.perBurst).toBe(2);
  });
  it('niet_exclusief: true gaat mee naar het openen', () => {
    const { klok, hid, app } = opzet({ config: { ...CONFIG, apparaten: { ...CONFIG.apparaten, 'maschine-mk2': { ...MASCHINE, niet_exclusief: true } } } });
    const m = nepMaschine(hid);
    app.start(); klok.loop(50);
    expect(m.poort.opties).toEqual({ nietExclusief: true });
  });
  it('rapporten → virtuele MIDI: pads, knoppen, draaiknoppen, masterwiel', () => {
    const { klok, hid, app, gebeurtenissen } = opzet();
    const m = nepMaschine(hid);
    app.start(); klok.loop(50);
    m.rust(10);
    expect(gebeurtenissen).toEqual([]);
    m.pad(1);
    m.tik('shift');
    m.wiel(1);
    m.draai(2, 16);
    expect(gebeurtenissen.map(([g, b]) => [g.el, g.kind, b])).toEqual([
      ['pad1', 'druk', [0x90, 36, 102]], ['pad1', 'los', [0x80, 36, 0]],
      ['shift', 'druk', [0x91, 39, 127]], ['shift', 'los', [0x81, 39, 0]],
      ['masterwiel', 'delta', [0xb0, 24, 1]],
      ['enc3', 'delta', [0xb0, 18, 12]],
    ]);
  });
  it('bezet (een NI-programma heeft hem): één fout-melding, en elke ronde opnieuw proberen', () => {
    const { klok, hid, app, meldingen } = opzet();
    const m = nepMaschine(hid);
    hid.zetBezet(m.naam, true);
    app.start(); klok.loop(50);
    expect(app.maschine.status).toBe('bezet');
    klok.loop(10000);
    expect(meldingen.filter((x) => x[1] === 'fout')).toEqual([['maschine-mk2', 'fout', `cannot open device with path ${m.naam}`, 'openen']]);
    hid.zetBezet(m.naam, false);
    klok.loop(2100);
    expect(app.maschine.status).toBe('verbonden');
    expect(app.maschine.verbonden).toBe(true);
  });
  it('bezet en dan uitgetrokken: weer zoeken (en een volgende keer bezet krijgt weer een melding)', () => {
    const { klok, hid, app, meldingen } = opzet();
    const m = nepMaschine(hid);
    hid.zetBezet(m.naam, true);
    app.start(); klok.loop(50);
    m.uittrekken(); klok.loop(2100);
    expect(app.maschine.status).toBe('zoekt');
    const nieuw = m.insteken();
    hid.zetBezet(nieuw.naam, true);
    klok.loop(2100);
    expect(meldingen.filter((x) => x[1] === 'fout')).toHaveLength(2);
  });
  it('open maar geen enkel rapport (macOS-Invoermonitoring): geen-invoer, één melding; komt er toch iets, dan weer verbonden', () => {
    const { klok, hid, app, meldingen } = opzet();
    const m = nepMaschine(hid);
    app.start(); klok.loop(1000);
    expect(app.maschine.status).toBe('verbonden');
    klok.loop(1000);
    expect(app.maschine.status).toBe('geen-invoer');
    klok.loop(10000);
    expect(meldingen.filter((x) => x[1] === 'fout')).toEqual([['maschine-mk2', 'fout', 'open, maar er komt geen enkel rapport binnen', 'invoer']]);
    m.rust(1);
    expect(app.maschine.status).toBe('verbonden');
  });
  it('lampjes en schermen: samengevoegd per tik, alleen wat veranderde', () => {
    const { klok, hid, app } = opzet();
    const m = nepMaschine(hid);
    app.start(); klok.loop(50);
    m.poort.verstuurd.length = 0;
    app.maschine.led([0x90, 36, 5]);
    app.maschine.led([0x90, 37, 21]);
    app.maschine.led([0x91, MS.KNOP_NR.get('play'), 127]);
    expect(m.poort.verstuurd).toEqual([]);
    klok.loop(1);
    expect(m.poort.verstuurd.map((r) => r[0])).toEqual([0x80, 0x81]);
    const b = MS.testbeeld('schaak');
    m.poort.verstuurd.length = 0;
    app.maschine.scherm(0, b); klok.loop(50);
    expect(m.poort.verstuurd.map((r) => [r[0], r[3]])).toEqual(Array.from({ length: 8 }, (_, i) => [0xe0, i * 8]));
    m.poort.verstuurd.length = 0;
    app.maschine.scherm(0, b); klok.loop(50);
    expect(m.poort.verstuurd).toEqual([]);
    app.maschine.leeg(); klok.loop(50);
    expect(m.poort.verstuurd.map((r) => r[0])).toEqual([0x80, 0x81, ...Array(8).fill(0xe0)]);
  });
  it('opnieuw insteken: alles opnieuw getekend (ook wat er al stond)', () => {
    const { klok, hid, app } = opzet();
    const m = nepMaschine(hid);
    app.start(); klok.loop(50);
    m.rust(1);
    app.maschine.led([0x90, 40, 45]); klok.loop(50);
    m.uittrekken(); klok.loop(2100);
    expect(app.maschine.verbonden).toBe(false);
    const nieuw = m.insteken(); klok.loop(2100);
    expect(app.maschine.verbonden).toBe(true);
    const r80 = nieuw.verstuurd.find((r) => r[0] === 0x80);
    const o = 1 + 3 * MS.plekVanPad(5);
    expect(r80.slice(o, o + 3)).toEqual(MS.paletRgb(45));
    expect(nieuw.verstuurd.filter((r) => r[0] === 0xe0 || r[0] === 0xe1)).toHaveLength(16);
  });
  it('een kabel die even los was (leesfout: levend() false): sluiten, opnieuw openen', () => {
    const { klok, hid, app, meldingen } = opzet();
    const m = nepMaschine(hid);
    app.start(); klok.loop(50);
    m.poort.sluit();          // de poort zegt dat hij dood is; het toestel staat nog in de lijst
    klok.loop(2100);
    expect(meldingen.filter((x) => x[0] === 'maschine-mk2' && (x[1] === 'weg' || x[1] === 'verbonden')).map((x) => x[1])).toEqual(['verbonden', 'weg', 'verbonden']);
  });
  it('logboek: in rust niets van de 750 rapporten per seconde, behalve tijdens neemRuwOp; knoppen altijd', () => {
    const { klok, hid, app, regels } = opzet({ logboek: true });
    const m = nepMaschine(hid);
    app.start(); klok.loop(50);
    const voor = regels.length;
    m.rust(750);
    expect(regels.length).toBe(voor);
    app.maschine.neemRuwOp(5);
    m.rust(20);
    const ruw = leesLogboek(regels.join('\n')).regels.filter((r) => Array.isArray(r) && r[1] === 'in' && r[2] === 'maschine-mk2');
    expect(ruw).toHaveLength(5);
    m.tik('play');
    m.pad(3);
    const { regels: alles } = leesLogboek(regels.join('\n'));
    const virt = alles.filter((r) => Array.isArray(r) && r[2] === 'maschine-mk2-midi').map((r) => r[3]);
    expect(virt).toEqual([[0x91, 36, 127], [0x81, 36, 0], [0x90, 38, 102], [0x80, 38, 0]]);
    // elk logregel 'in' wordt gevolgd door zijn gebeurtenis (de golden test leest ze in paren)
    alles.forEach((r, i) => { if (Array.isArray(r) && r[1] === 'in') expect(alles[i + 1].e).toBe('gebeurtenis'); });
    // schermen niet byte voor byte
    expect(alles.some((r) => Array.isArray(r) && r[1] === 'uit' && r[3].length === 265)).toBe(false);
    expect(alles.some((r) => r.e === 'uit' && r.scherm === 0 && r.stuk === 7)).toBe(true);
  });
  it('stop(): lampjes uit en schermen leeg, wachten tot het verstuurd is, dan dicht', async () => {
    const { klok, hid, app } = opzet();
    const m = nepMaschine(hid);
    app.start(); klok.loop(50);
    app.maschine.led([0x90, 36, 5]);
    app.maschine.scherm(1, MS.testbeeld('strepen'));
    klok.loop(50);
    m.poort.verstuurd.length = 0;
    const klaar = app.stop();
    klok.loop(50);
    await klaar;
    expect(m.poort.verstuurd.map((r) => r[0])).toEqual([0x80, ...Array(8).fill(0xe1)]);
    expect(m.poort.open).toBe(false);
  });
  it('een pad die bij het aansluiten al ingedrukt is: na twee rapporten een slag, en hij gaat netjes los', () => {
    const { klok, hid, app, gebeurtenissen } = opzet();
    const m = nepMaschine(hid);
    app.start(); klok.loop(50);
    m.stuur(padFrame([900]));
    m.stuur(padFrame([900]));
    expect(gebeurtenissen.map(([g]) => g.kind)).toEqual(['druk']);
    m.stuur(rustFrame());
    expect(gebeurtenissen.map(([g]) => g.kind)).toEqual(['druk', 'los']);
  });
});
