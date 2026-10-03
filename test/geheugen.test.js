// Golf 4 · geheugen in de kern: exporteer/importeer (snapshots, truth:"hub"-waarden), slew_s voor elke zet
// van de hub zelf (cockpit, snapshot, replay, LPD8) maar niet voor directe APC-bewegingen, en flux per monitor.
import { describe, it, expect } from 'vitest';
import { opzet, meldAan, nepVerbinding, stuurApp, druk, los, tik, draai, lpdDruk, lpdLos, van, leeg, FL, MS, CONFIG } from './kern-hulp.js';
import { laadConfig } from '../src/config.js';

/** Een passieve app (zoals TD via MIDI): de hub onthoudt, met een trage parameter. */
const TH = {
  v: 1, app: 'td-test', naam: 'TD-test', truth: 'hub',
  params: [
    { id: 'mix', naam: 'Mix', soort: 'waarde', standaard: 0.5, hint: 'fader' },
    { id: 'gloed', naam: 'Gloed', soort: 'waarde', standaard: 0.2, hint: 'knop', slew_s: 2 },
    { id: 'modus', naam: 'Modus', soort: 'keuze', keuzes: ['a', 'b', 'c'], slew_s: 2 },
    { id: 'preset', naam: 'Preset', soort: 'trigger' },
  ],
};

const zetten = (v, id) => van(v, 'zet').filter((b) => b.id === id);
/** Strikt stijgend of dalend, en elke stap een tussenwaarde. */
const verloopt = (lijst) => lijst.length > 10 && lijst.every((b, i) => i === 0 || b.v !== lijst[i - 1].v);

describe('slew_s geldt voor elke zet van de hub, niet voor de APC', () => {
  it('cockpit: een trage parameter verloopt over slew_s (bron cockpit), een snelle springt meteen', () => {
    const { kern, klok } = opzet();
    const fl = meldAan(kern, FL);
    leeg(fl);
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'in1', v: 0.7 });
    expect(van(fl, 'zet')).toEqual([{ t: 'zet', id: 'in1', v: 0.7, bron: 'cockpit' }]);

    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'ruimte', v: 1 }); // standaard 0.4, slew_s 4
    expect(zetten(fl, 'ruimte')).toEqual([]);
    klok.loop(2000);
    const half = zetten(fl, 'ruimte');
    expect(verloopt(half)).toBe(true);
    expect(half.every((b) => b.bron === 'cockpit')).toBe(true);
    expect(half.at(-1).v).toBeCloseTo(0.4 + 0.6 * (1980 / 4000), 2);
    expect(kern.beeld().apps[0].waarden.ruimte).toBeCloseTo(half.at(-1).v, 5);
    klok.loop(2500);
    expect(zetten(fl, 'ruimte').at(-1)).toEqual({ t: 'zet', id: 'ruimte', v: 1, bron: 'cockpit' });
  });

  it('snapshot laden verloopt (bron snapshot); de waarden in de snapshot blijven gewoon het doel', () => {
    const { kern, klok } = opzet();
    const fl = meldAan(kern, FL, { staat: { in1: 0.2, ruimte: 0.1 } });
    kern.bewaar(1);
    stuurApp(kern, fl, { t: 'zet', id: 'in1', v: 0.9 });
    stuurApp(kern, fl, { t: 'zet', id: 'ruimte', v: 0.9 });
    leeg(fl);
    expect(kern.laad(1)).toBe(true);
    expect(van(fl, 'zet')).toEqual([{ t: 'zet', id: 'in1', v: 0.2, bron: 'snapshot' }]);
    klok.loop(1000);
    const r = zetten(fl, 'ruimte');
    expect(verloopt(r)).toBe(true);
    expect(r.every((b) => b.bron === 'snapshot' && b.v < 0.9 && b.v > 0.1)).toBe(true);
    // Nog eens laden tijdens de slew: hij loopt al naar 0.1, dus niet opnieuw beginnen.
    const n = r.length;
    kern.laad(1);
    klok.loop(3100);
    const alles = zetten(fl, 'ruimte');
    expect(alles.length).toBeGreaterThan(n);
    expect(alles.at(-1).v).toBe(0.1);
    expect(verloopt(alles)).toBe(true);
  });

  it('directe APC-beweging: de knop met slew_s geeft meteen een zet (bron apc40) en breekt een lopende slew af', () => {
    const { kern, klok } = opzet();
    const fl = meldAan(kern, FL);
    leeg(fl);
    draai(kern, 'dk1', 0.4); // ruimte (hint knop) staat op dk1; ringknop neemt direct over
    draai(kern, 'dk1', 0.6);
    expect(zetten(fl, 'ruimte').at(-1)).toEqual({ t: 'zet', id: 'ruimte', v: 76 / 127, bron: 'apc40' });

    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'ruimte', v: 0 });
    klok.loop(500);
    leeg(fl);
    draai(kern, 'dk1', 0.8);
    expect(van(fl, 'zet')).toEqual([{ t: 'zet', id: 'ruimte', v: 102 / 127, bron: 'apc40' }]);
    klok.loop(5000);
    expect(van(fl, 'zet')).toHaveLength(1); // de cockpit-slew is gestopt
    expect(kern.beeld().apps[0].waarden.ruimte).toBe(102 / 127);
  });

  it('een keuze of schakelaar met slew_s springt (geen tussenstanden door de opties)', () => {
    const { kern } = opzet();
    const th = meldAan(kern, TH);
    leeg(th);
    kern.cockpit({ t: 'zet', app: 'td-test', id: 'modus', v: 1 });
    expect(van(th, 'zet')).toEqual([{ t: 'zet', id: 'modus', v: 1, bron: 'cockpit' }]);
  });

  it('een LPD8-macro verloopt nog steeds, met bron lpd8', () => {
    const { kern, klok } = opzet();
    const fl = meldAan(kern, FL);
    const ms = meldAan(kern, MS);
    kern.invoer({ dev: 'lpd8', el: 'k3', kind: 'waarde', v: 0.4 }); // pickup: gevangen op de ruimte van formula-lab
    klok.loop(5000);
    leeg(fl, ms);
    kern.invoer({ dev: 'lpd8', el: 'k3', kind: 'waarde', v: 0.9 });
    klok.loop(1000);
    expect(zetten(fl, 'ruimte').every((b) => b.bron === 'lpd8')).toBe(true);
    expect(verloopt(zetten(fl, 'ruimte'))).toBe(true);
    expect(zetten(ms, 'galm')).toEqual([{ t: 'zet', id: 'galm', v: 0.9, bron: 'lpd8' }]);
  });

  it('replay na een herstart (nieuwe inst) verloopt vanaf de standaardwaarde; een netwerkhapering (zelfde inst) speelt direct af', () => {
    const { kern, klok } = opzet();
    meldAan(kern, TH, { inst: 'i1' });
    kern.cockpit({ t: 'zet', app: 'td-test', id: 'mix', v: 0.8 });
    kern.cockpit({ t: 'zet', app: 'td-test', id: 'gloed', v: 0.9 });
    klok.loop(2500);

    const hap = nepVerbinding();
    kern.verbind(hap);
    stuurApp(kern, hap, { t: 'hallo', app: 'td-test', inst: 'i1', v: 1 });
    expect(van(hap, 'zet').filter((b) => b.id !== 'modus')).toEqual([
      { t: 'zet', id: 'mix', v: 0.8, bron: 'replay' },
      { t: 'zet', id: 'gloed', v: 0.9, bron: 'replay' },
    ]);

    const nieuw = nepVerbinding();
    kern.verbind(nieuw);
    stuurApp(kern, nieuw, { t: 'hallo', app: 'td-test', inst: 'i2', v: 1 });
    expect(zetten(nieuw, 'mix')).toEqual([{ t: 'zet', id: 'mix', v: 0.8, bron: 'replay' }]);
    expect(zetten(nieuw, 'gloed')).toEqual([]);
    stuurApp(kern, nieuw, { t: 'manifest', manifest: TH });
    stuurApp(kern, nieuw, { t: 'staat', waarden: { mix: 0.5, gloed: 0.2 } }); // standaardwaarden: genegeerd
    klok.loop(1000);
    const g = zetten(nieuw, 'gloed');
    expect(verloopt(g)).toBe(true);
    expect(g.every((b) => b.bron === 'replay')).toBe(true);
    expect(g[0].v).toBeLessThan(0.25);
    expect(g.at(-1).v).toBeCloseTo(0.2 + 0.7 * (990 / 2000), 2);
    klok.loop(1500);
    expect(zetten(nieuw, 'gloed').at(-1).v).toBe(0.9);
    expect(kern.exporteer().waarden['td-test']).toMatchObject({ mix: 0.8, gloed: 0.9 });
  });
});

describe('kern: exporteer / importeer', () => {
  it('snapshots via Bank+Shift+Scene en LPD8 P5-P8, plus truth:"hub"-waarden; niet die van truth:"app"', () => {
    const { kern, klok } = opzet();
    meldAan(kern, FL, { staat: { in1: 0.2 } });
    meldAan(kern, TH);
    kern.cockpit({ t: 'zet', app: 'td-test', id: 'mix', v: 0.75 });
    druk(kern, 'bank'); druk(kern, 'shift'); tik(kern, 'scene5'); los(kern, 'shift'); los(kern, 'bank');
    lpdDruk(kern, 6); klok.loop(700); lpdLos(kern, 6); // P6 lang = snapshot 2
    const d = kern.exporteer();
    expect(Object.keys(d.snapshots)).toEqual(['2', '5']);
    expect(d.snapshots[5]['formula-lab']).toMatchObject({ in1: 0.2, in2: 0.5, ruimte: 0.4 });
    expect(d.snapshots[5]['td-test']).toEqual({ mix: 0.75, gloed: 0.2, modus: 0 });
    expect(d.waarden).toEqual({ 'td-test': { mix: 0.75, gloed: 0.2, modus: 0 } }); // geen formula-lab (truth:"app")
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
  });

  it('na importeer: snapshots staan klaar (Bank+Scene laadt), een truth:"hub"-app krijgt zijn waarden bij zijn manifest', () => {
    const een = opzet();
    meldAan(een.kern, FL, { staat: { in1: 0.2 } });
    meldAan(een.kern, TH);
    een.kern.cockpit({ t: 'zet', app: 'td-test', id: 'mix', v: 0.75 });
    een.kern.cockpit({ t: 'zet', app: 'td-test', id: 'gloed', v: 1 });
    een.kern.bewaar(3);
    een.klok.loop(3000);
    const data = JSON.parse(JSON.stringify(een.kern.exporteer())); // zoals van schijf

    const { kern, klok } = opzet();
    expect(kern.importeer(data)).toEqual({ ok: true, overgeslagen: 0 });
    klok.loop(200);
    expect(kern.beeld().snapshots).toEqual([3]);
    const fl = meldAan(kern, FL);
    const th = nepVerbinding();
    kern.verbind(th);
    stuurApp(kern, th, { t: 'hallo', app: 'td-test', inst: 'x', v: 1 });
    expect(van(th, 'zet')).toEqual([]); // nog geen manifest: de hub weet nog niet dat hij truth:"hub" is
    stuurApp(kern, th, { t: 'manifest', manifest: TH });
    expect(van(th, 'zet')).toEqual([
      { t: 'zet', id: 'mix', v: 0.75, bron: 'replay' },
      { t: 'zet', id: 'modus', v: 0, bron: 'replay' },
    ]);
    stuurApp(kern, th, { t: 'staat', waarden: { mix: 0.5, gloed: 0.2 } }); // de standaard van de app wint niet
    klok.loop(2100);
    expect(zetten(th, 'gloed').at(-1)).toEqual({ t: 'zet', id: 'gloed', v: 1, bron: 'replay' });
    expect(kern.beeld().apps.find((a) => a.app === 'td-test').waarden).toMatchObject({ mix: 0.75, gloed: 1 });

    leeg(fl);
    druk(kern, 'bank'); tik(kern, 'scene3'); los(kern, 'bank');
    expect(van(fl, 'zet')).toEqual([{ t: 'zet', id: 'in1', v: 0.2, bron: 'snapshot' }]);
  });

  it('bewaarde waarden van een app die deze sessie nog niet kwam, gaan bij de volgende export niet verloren', () => {
    const { kern } = opzet();
    kern.importeer({ v: 1, snapshots: {}, waarden: { 'td-test': { mix: 0.3 }, ander: { x: 1 } } });
    meldAan(kern, FL);
    expect(kern.exporteer().waarden).toEqual({ 'td-test': { mix: 0.3 }, ander: { x: 1 } });
    meldAan(kern, TH);
    expect(kern.exporteer().waarden).toEqual({ 'td-test': { mix: 0.3, gloed: 0.2, modus: 0 }, ander: { x: 1 } });
  });

  it('een lopende slew wordt met zijn doel bewaard, in het geheugen en in een snapshot', () => {
    const { kern, klok } = opzet();
    meldAan(kern, TH);
    kern.cockpit({ t: 'zet', app: 'td-test', id: 'gloed', v: 0.9 });
    klok.loop(500);
    expect(kern.beeld().apps[0].waarden.gloed).toBeLessThan(0.9);
    kern.bewaar(1);
    expect(kern.exporteer().waarden['td-test'].gloed).toBe(0.9);
    expect(kern.exporteer().snapshots[1]['td-test'].gloed).toBe(0.9);
  });

  it('onbruikbare data verandert niets; ongeldige onderdelen vallen weg, waarden worden geklemd', () => {
    const { kern } = opzet();
    kern.bewaar(1);
    for (const slecht of [null, 'tekst', [], 42, { v: 2, snapshots: {} }, {}]) {
      expect(kern.importeer(slecht).ok).toBe(false);
      expect(kern.beeld().snapshots).toEqual([1]);
    }
    const r = kern.importeer({
      v: 1,
      snapshots: { 1: { 'formula-lab': { in1: 2, 'Fout!': 0.5, in2: 'x' } }, nul: {}, 7: 'x', 4: { 'TD LAB': {} } },
      waarden: { 'td-test': { mix: -1, gloed: Number.MAX_VALUE }, kapot: 5 },
      onbekend: true,
    });
    expect(r.ok).toBe(true);
    expect(r.overgeslagen).toBe(6); // 'Fout!', in2:'x', 'nul', 7:'x', 'TD LAB', kapot
    expect(kern.exporteer()).toEqual({
      v: 1,
      snapshots: { 1: { 'formula-lab': { in1: 1 } }, 4: {} },
      waarden: { 'td-test': { mix: 0, gloed: 1 } },
      inst: {},
    });
  });

  it("'geheugen' meldt bewaren en truth:\"hub\"-wijzigingen, niet een truth:\"app\"-waarde", () => {
    const { kern } = opzet();
    let n = 0;
    kern.bij('geheugen', () => { n++; });
    const fl = meldAan(kern, FL);
    stuurApp(kern, fl, { t: 'zet', id: 'in1', v: 0.3 });
    kern.cockpit({ t: 'zet', app: 'formula-lab', id: 'in1', v: 0.6 });
    expect(n).toBe(0);
    kern.bewaar(2);
    expect(n).toBe(1);
    const th = meldAan(kern, TH);
    const na = n;
    stuurApp(kern, th, { t: 'zet', id: 'mix', v: 0.1 });
    expect(n).toBeGreaterThan(na);
  });
});

describe('config.json: apps zoals de koppelingen zich aanmelden', () => {
  const cfg = laadConfig();

  it('kleuren van Varve DJ, Waterschaal en MediSynth; flux komt via WebSocket', () => {
    expect(cfg.apps['varve-dj'].kleur).toBe('#4ad9c4');
    expect(cfg.apps.waterschaal.kleur).toBe('#c99a57');
    expect(cfg.apps.medisynth.kleur).toBe('#5a6fa8');
    expect(cfg.apps.flux.koppeling).toBe('ws');
    expect(cfg.geheugen.pad).toBe('~/.varve-hub/staat.json');
  });

  it('flux-<monitor> krijgt de flux-kleur en de naam met monitor, ook vóór en zonder kleur in het manifest', () => {
    const { kern, klok } = opzet(cfg);
    const v = nepVerbinding();
    kern.verbind(v);
    stuurApp(kern, v, { t: 'hallo', app: 'flux-dp-1', inst: 'a', v: 1 });
    klok.loop(200);
    expect(kern.beeld().apps[0]).toMatchObject({ app: 'flux-dp-1', naam: 'Flux (dp-1)', kleur: '#9b1b30', status: 'nieuw' });
    stuurApp(kern, v, { t: 'manifest', manifest: { v: 1, app: 'flux-dp-1', naam: 'Flux (DP-1)', params: [{ id: 'tempo', naam: 'Tempo', soort: 'waarde' }] } });
    expect(kern.beeld().apps[0]).toMatchObject({ naam: 'Flux (DP-1)', kleur: '#9b1b30' });

    // twee monitoren: twee apps, elk met een eigen slot en dezelfde kleur
    const w = nepVerbinding();
    kern.verbind(w);
    stuurApp(kern, w, { t: 'hallo', app: 'flux-hdmi-a-1', inst: 'b', v: 1 });
    const apps = kern.beeld().apps;
    expect(apps.map((a) => [a.app, a.naam, a.kleur, a.slot])).toEqual([
      ['flux-dp-1', 'Flux (DP-1)', '#9b1b30', 1],
      ['flux-hdmi-a-1', 'Flux (hdmi-a-1)', '#9b1b30', 2],
    ]);
  });

  it('alleen apps met per_monitor vallen terug; een gewone id met streepje niet', () => {
    const { kern } = opzet(cfg);
    for (const app of ['flux', 'fluxx', 'medisynth-2', 'waterschaal-td']) {
      const v = nepVerbinding();
      kern.verbind(v);
      stuurApp(kern, v, { t: 'hallo', app, inst: app, v: 1 });
    }
    expect(kern.beeld().apps.map((a) => [a.app, a.naam, a.kleur])).toEqual([
      ['flux', 'Flux', '#9b1b30'],
      ['fluxx', 'fluxx', '#ffffff'],
      ['medisynth-2', 'medisynth-2', '#ffffff'],
      ['waterschaal-td', 'waterschaal-td', '#ffffff'],
    ]);
  });

  it('de test-config van de kern blijft werken zonder per_monitor', () => {
    const { kern } = opzet(CONFIG);
    const v = nepVerbinding();
    kern.verbind(v);
    stuurApp(kern, v, { t: 'hallo', app: 'flux-dp-1', inst: 'a', v: 1 });
    expect(kern.beeld().apps[0]).toMatchObject({ naam: 'flux-dp-1', kleur: '#ffffff' });
  });
});

describe('golf 4 review: geheugen over een herstart', () => {
  it('kern.stop() midden in een slew: exporteer geeft nog steeds het doel, niet de tussenwaarde', () => {
    const { kern, klok } = opzet();
    meldAan(kern, TH);
    kern.cockpit({ t: 'zet', app: 'td-test', id: 'gloed', v: 1 });
    klok.loop(400);
    expect(kern.beeld().apps[0].waarden.gloed).toBeLessThan(0.5);
    kern.stop();
    expect(kern.exporteer().waarden['td-test'].gloed).toBe(1);
  });

  it('de inst gaat mee: dezelfde inst na een hub-herstart = direct afspelen (geen dip), een nieuwe = verlopen vanaf standaard', () => {
    const een = opzet();
    meldAan(een.kern, TH, { inst: 'tab-1' });
    een.kern.cockpit({ t: 'zet', app: 'td-test', id: 'mix', v: 0.8 });
    een.kern.cockpit({ t: 'zet', app: 'td-test', id: 'gloed', v: 0.9 });
    een.klok.loop(2500);
    const data = JSON.parse(JSON.stringify(een.kern.exporteer()));
    expect(data.inst).toEqual({ 'td-test': 'tab-1' });

    // De app draaide gewoon door en verbindt opnieuw met dezelfde inst: hij heeft 0.9 nog.
    const zelfde = opzet();
    zelfde.kern.importeer(data);
    const z = meldAan(zelfde.kern, TH, { inst: 'tab-1', staat: { mix: 0.8, gloed: 0.9 } });
    expect(zetten(z, 'gloed')).toEqual([{ t: 'zet', id: 'gloed', v: 0.9, bron: 'replay' }]);
    zelfde.klok.loop(2500);
    expect(zetten(z, 'gloed')).toHaveLength(1); // geen terugval naar de standaard en weer omhoog
    expect(zelfde.kern.exporteer().inst).toEqual({ 'td-test': 'tab-1' });

    // Een verse app (nieuwe inst) staat op zijn standaard: van daaruit verlopen.
    const nieuw = opzet();
    nieuw.kern.importeer(data);
    const n = meldAan(nieuw.kern, TH, { inst: 'tab-2' });
    expect(zetten(n, 'gloed')).toEqual([]);
    nieuw.klok.loop(2500);
    const g = zetten(n, 'gloed');
    expect(verloopt(g)).toBe(true);
    expect(g.at(-1).v).toBe(0.9);
    expect(nieuw.kern.exporteer().inst).toEqual({ 'td-test': 'tab-2' });
  });

  it('een bewaarde app die terugkomt als truth:"app" verdwijnt uit het geheugen', () => {
    const { kern } = opzet();
    kern.importeer({ v: 1, snapshots: {}, waarden: { 'td-test': { mix: 0.3 } }, inst: { 'td-test': 'oud' } });
    let n = 0;
    kern.bij('geheugen', () => { n++; });
    meldAan(kern, { ...TH, truth: 'app' });
    expect(kern.exporteer().waarden).toEqual({});
    expect(kern.exporteer().inst).toEqual({});
    expect(n).toBeGreaterThan(0); // en dat gaat naar schijf
  });

  it('ongeldige inst wordt overgeslagen', () => {
    const { kern } = opzet();
    const r = kern.importeer({ v: 1, snapshots: {}, waarden: { 'td-test': { mix: 0.3 }, b: { x: 0.1 } }, inst: { 'td-test': 5, b: 'ok' } });
    expect(r).toEqual({ ok: true, overgeslagen: 1 });
    expect(kern.exporteer().inst).toEqual({ b: 'ok' });
  });

  it('flux per monitor: een manifest-naam zonder monitor krijgt hem erachter, zodat twee monitoren te onderscheiden zijn', () => {
    const { kern } = opzet(laadConfig());
    const man = (app) => ({ v: 1, app, naam: 'Flux', params: [{ id: 'tempo', naam: 'Tempo', soort: 'waarde' }] });
    meldAan(kern, man('flux-dp-1'), { inst: 'a' });
    meldAan(kern, man('flux-hdmi-1'), { inst: 'b' });
    meldAan(kern, { ...man('flux-dp-2'), naam: 'Flux DP-2' }, { inst: 'c' });
    meldAan(kern, { ...man('flux'), naam: 'Flux' }, { inst: 'd' });
    expect(kern.beeld().apps.map((a) => [a.app, a.naam, a.kleur])).toEqual([
      ['flux-dp-1', 'Flux (dp-1)', '#9b1b30'],
      ['flux-hdmi-1', 'Flux (hdmi-1)', '#9b1b30'],
      ['flux-dp-2', 'Flux DP-2', '#9b1b30'], // staat er al in: niet dubbel
      ['flux', 'Flux', '#9b1b30'],
    ]);
  });
});
