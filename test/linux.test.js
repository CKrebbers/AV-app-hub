// De hub op Linux (docs/LINUX.md, uit de eerste Linux-test in de werkplaats, onderzoek/hub-linux.md):
// (a) de Maschine zonder udev-regel: "Permission denied" is 'geen-rechten' met de udev-hint, niet 'bezet' met de Mac-hint;
// (b) de avondmap per besturingssysteem ("auto"); (c) een set opent de apps in Chrome, anders xdg-open;
// (d) de drivers van TouchDesigner en Logic starten op Linux niet, met een duidelijke regel.
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { NepKlok } from '../src/core/klok.js';
import { NepSysteem, NepHidSysteem } from '../src/ports/nep.js';
import { maakApparaten } from '../src/apparaten.js';
import { startHub, maschineHint } from '../src/hub.js';
import { doctor } from '../src/doctor.js';
import { laadConfig } from '../src/config.js';
import { HINT, UDEV_REGEL, isRechtenFout, invoerHint } from '../src/ports/hid.js';
import { avondmapPad, standaardAvondmap } from '../src/opname/opnemer.js';
import { openInChrome, vindChrome, CHROME_LINUX } from '../src/sets/systeem.js';
import { startDrivers } from '../src/drivers/index.js';
import { nepMaschine, rustFrame } from './nep-speelapparaten.js';

const config = laadConfig();
const lopend = [];
afterEach(async () => { for (const x of lopend.splice(0)) await x(); });
const wacht = (ms) => new Promise((r) => setTimeout(r, ms));
const tot = async (fn, ms = 3000) => { const eind = Date.now() + ms; while (Date.now() < eind) { const x = fn(); if (x) return x; await wacht(10); } return fn(); };

describe('(a) de Maschine zonder udev-regel', () => {
  it('herkent een rechtenfout (hidapi, EACCES, EPERM), en niets anders', () => {
    expect(isRechtenFout(new Error("cannot open device with path /dev/hidraw2: Failed to open a device with path '/dev/hidraw2': Permission denied"))).toBe(true);
    expect(isRechtenFout(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(true);
    expect(isRechtenFout(new Error('EPERM: operation not permitted'))).toBe(true);
    expect(isRechtenFout(new Error('cannot open device with path IOService:/x'))).toBe(false);
    expect(HINT.rechten).toMatch(/udev-regel nodig, zie docs\/LINUX\.md/);
    expect(HINT.rechten).toContain(UDEV_REGEL);
    expect(UDEV_REGEL).toBe('SUBSYSTEM=="hidraw", ATTRS{idVendor}=="17cc", ATTRS{idProduct}=="1140", MODE="0660", TAG+="uaccess"');
  });

  it('de sessie: meteen geen-rechten (niet pas na twee rondes, en niet bezet); weer zoekt als hij weg is', () => {
    const hid = new NepHidSysteem();
    const m = nepMaschine(hid);
    hid.zetGeenRechten(m.naam, true);
    const klok = new NepKlok();
    const app = maakApparaten({ systeem: new NepSysteem(), hid, klok, config: { ...config, hotplug_ms: 20 } });
    const fouten = [];
    app.maschine?.bij('fout', (e, soort) => fouten.push(soort));
    app.start();
    klok.loop(25);
    expect(app.maschine?.status).toBe('geen-rechten');
    expect(app.maschine?.statusReden).toMatch(/Permission denied/);
    expect(fouten).toEqual(['openen']);
    klok.loop(200);
    expect(fouten).toEqual(['openen']);   // één melding per storing
    hid.verwijder(m.naam);
    klok.loop(25);
    expect(app.maschine?.status).toBe('zoekt');
    app.maschine?.stop(); app.apc.stop(); app.lpd8.stop();
  });

  it('de hub: één regel met de udev-hint, en de cockpit krijgt die hint', async () => {
    const hid = new NepHidSysteem();
    const m = nepMaschine(hid);
    hid.zetGeenRechten(m.naam, true);
    const log = [];
    const hub = await startHub({ config: { ...config, hotplug_ms: 20 }, systeem: new NepSysteem(), hid, poort: 0, drivers: false, opname: false, log: (...x) => log.push(x.join(' ')) });
    lopend.push(() => hub.stop());
    await tot(() => hub.apparaten.maschine?.status === 'geen-rechten');
    await tot(() => log.some((r) => r.startsWith('Maschine:')));
    expect(log.filter((r) => r.startsWith('Maschine:'))).toEqual([expect.stringMatching(/^Maschine: geen rechten \(.*Permission denied\) — udev-regel nodig, zie docs\/LINUX\.md/)]);
    expect(hub.kern.beeld().apparaten['maschine-mk2']).toMatchObject({ status: 'geen-rechten', hint: HINT.rechten });
  });

  it('maschineHint en invoerHint per platform: op Linux geen macOS-Invoermonitoring', () => {
    expect(maschineHint('geen-rechten')).toBe(HINT.rechten);
    expect(maschineHint('geen-invoer', null, 'linux')).toBe(HINT.invoerLinux);
    expect(maschineHint('geen-invoer', null, 'darwin')).toBe(HINT.invoer);
    expect(invoerHint('linux')).not.toMatch(/Invoermonitoring|macOS/);
  });

  /** @param {NepHidSysteem} hid */
  const doctorLinux = (hid) => doctor({ config, laadMidi: async () => ({ systeem: new NepSysteem() }), laadHid: async () => ({ systeem: hid }), niProgrammas: () => [], wachtMs: 20, hubDraait: async () => false, platform: 'linux' });

  it('doctor op Linux: "geen rechten" met de udev-hint, niet "bezet" met de Mac-hint, en geen Invoermonitoring-regel', async () => {
    const hid = new NepHidSysteem();
    const m = nepMaschine(hid);
    hid.zetGeenRechten(m.naam, true);
    const { tekst, data } = await doctorLinux(hid);
    expect(tekst).toMatch(/✗ geen rechten: .*Permission denied — udev-regel nodig, zie docs\/LINUX\.md/);
    expect(tekst).not.toMatch(/bezet|Controller Editor|Invoermonitoring|Activiteitenweergave/);
    expect(data.maschine.rechten).toMatch(/Permission denied/);
  }, 15000);

  it('doctor op Linux: open maar niets binnen geeft de Linux-hint', async () => {
    const hid = new NepHidSysteem();
    nepMaschine(hid);
    const { tekst } = await doctorLinux(hid);
    expect(tekst).toContain(`✗ open, maar er komt niets binnen — ${HINT.invoerLinux}`);
    expect(tekst).not.toMatch(/Invoermonitoring/);
  }, 15000);

  it('doctor op Linux met invoer: gewoon ✔', async () => {
    const hid = new NepHidSysteem();
    nepMaschine(hid);
    hid.bijOpen = (p) => setTimeout(() => p.injecteer(rustFrame()), 1);
    const { tekst } = await doctorLinux(hid);
    expect(tekst).toMatch(/✔ invoer komt binnen/);
  }, 15000);
});

describe('(b) de avondmap per besturingssysteem', () => {
  it('config.json zegt "auto"', () => {
    expect(JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8')).avondmap).toBe('auto');
  });
  it('macOS: ~/Movies/varve-avonden', () => {
    expect(avondmapPad({ avondmap: 'auto' }, '/Users/clay', '/hub', { platform: 'darwin' })).toBe('/Users/clay/Movies/varve-avonden');
  });
  it('Linux: de XDG-videomap; is die niet ingesteld (xdg-user-dir geeft dan ~ of niets), dan ~/Videos', () => {
    expect(avondmapPad({ avondmap: 'auto' }, '/home/clay', '/hub', { platform: 'linux', videos: () => '/home/clay/Video\'s' })).toBe('/home/clay/Video\'s/varve-avonden');
    expect(avondmapPad({ avondmap: 'auto' }, '/home/clay', '/hub', { platform: 'linux', videos: () => null })).toBe('/home/clay/Videos/varve-avonden');
    expect(standaardAvondmap('/home/clay', { platform: 'linux', videos: () => null })).toBe('/home/clay/Videos/varve-avonden');
  });
  it('een eigen pad in config.json blijft winnen; zonder sleutel: geen opname', () => {
    expect(avondmapPad({ avondmap: '/mnt/werk/avonden' }, '/home/clay', '/hub', { platform: 'linux', videos: () => '/x' })).toBe('/mnt/werk/avonden');
    expect(avondmapPad({}, '/home/clay')).toBe(null);
  });
});

describe('(c) een set opent de apps in Chrome', () => {
  /** Nep-spawn: Chrome start (spawn-event) en blijft lopen; xdg-open stopt met 0. Een opdracht in `kapot` geeft een fout. */
  function nep(kapot = /** @type {string[]} */ ([])) {
    const aanroepen = [];
    const start = /** @type {any} */ ((cmd, args) => {
      aanroepen.push([cmd, ...args]);
      const p = Object.assign(new EventEmitter(), { unref() {} });
      setImmediate(() => {
        if (kapot.includes(cmd)) p.emit('error', Object.assign(new Error(`spawn ${cmd} ENOENT`), { code: 'ENOENT' }));
        else if (cmd === 'xdg-open') p.emit('exit', 0);
        else p.emit('spawn');
      });
      return p;
    });
    return { start, aanroepen };
  }
  const alles = () => true;

  it('vindChrome: eerst config.json (linux.chrome), anders google-chrome-stable, google-chrome, chromium, chromium-browser in PATH', () => {
    expect(CHROME_LINUX).toEqual(['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']);
    expect(vindChrome({ pad: '/a:/b', kan: (p) => p === '/b/chromium' })).toBe('/b/chromium');
    expect(vindChrome({ pad: '/a:/b', kan: (p) => p === '/b/chromium' || p === '/a/google-chrome-stable' })).toBe('/a/google-chrome-stable');
    expect(vindChrome({ chrome: '/opt/chrome/chrome', pad: '/a', kan: alles })).toBe('/opt/chrome/chrome');
    expect(vindChrome({ chrome: 'brave', pad: '/a', kan: (p) => p === '/a/brave' })).toBe('/a/brave');
    expect(vindChrome({ chrome: '/weg/chrome', pad: '/a', kan: () => false })).toBe(null);
    expect(vindChrome({ pad: '', kan: alles })).toBe(null);
  });

  it('Linux met Chrome: <chrome> --new-window <url>; gelukt zodra hij start (hij blijft draaien)', async () => {
    const { start, aanroepen } = nep();
    await openInChrome('linux', start, { pad: '/usr/bin', kan: (p) => p === '/usr/bin/google-chrome-stable' })('http://localhost:5174/?hub=ws://localhost:7700/app');
    expect(aanroepen).toEqual([['/usr/bin/google-chrome-stable', '--new-window', 'http://localhost:5174/?hub=ws://localhost:7700/app']]);
  });

  it('lukt Chrome niet, dan xdg-open (met een regel in de log)', async () => {
    const { start, aanroepen } = nep(['/usr/bin/google-chrome-stable']);
    const log = [];
    await openInChrome('linux', start, { pad: '/usr/bin', kan: alles, log: (t) => log.push(t) })('http://x/');
    expect(aanroepen).toEqual([['/usr/bin/google-chrome-stable', '--new-window', 'http://x/'], ['xdg-open', 'http://x/']]);
    expect(log).toEqual([expect.stringMatching(/google-chrome-stable lukt niet: .*ENOENT — ik probeer xdg-open/)]);
  });

  it('macOS blijft open -a "Google Chrome"', async () => {
    const aanroepen = [];
    const start = /** @type {any} */ ((cmd, args) => { aanroepen.push([cmd, ...args]); const p = Object.assign(new EventEmitter(), { unref() {} }); setImmediate(() => p.emit('exit', 0)); return p; });
    await openInChrome('darwin', start)('http://x/');
    expect(aanroepen).toEqual([['open', '-a', 'Google Chrome', 'http://x/']]);
  });
});

describe('(d) TouchDesigner en Logic op Linux', () => {
  /** @param {string} platform */
  function drivers(platform) {
    const log = [];
    const r = startDrivers({ kern: /** @type {any} */ ({}), klok: new NepKlok(), systeem: new NepSysteem(), fetch: /** @type {any} */ (async () => { throw new Error('geen net'); }), config: { ...config, apps: { ...config.apps, 'td-lab': { ...config.apps['td-lab'], autostart: true } } }, uitstel_ms: 10 ** 9, log: (...a) => log.push(a.join(' ')), platform });
    r.stop();
    return { namen: r.drivers.map((d) => d.driver.manifest.app).sort(), log };
  }
  it('config.json noemt av-scene-kit, sediment en td-lab in linux.drivers_uit', () => {
    expect(config.linux.drivers_uit).toEqual(['av-scene-kit', 'sediment', 'td-lab']);
  });
  it('op Linux starten alleen de andere drivers (uurwerk), met per overgeslagen driver één duidelijke regel', () => {
    const { namen, log } = drivers('linux');
    expect(namen).toEqual(['uurwerk']);
    expect(log.filter((r) => /overgeslagen op Linux/.test(r))).toEqual([
      expect.stringMatching(/av-scene-kit: overgeslagen op Linux \(de hub maakt poort "VARVE-HUB TD" niet aan\) — TouchDesigner en Logic draaien hier niet\. Toch nodig\? Haal "av-scene-kit" uit config\.json → linux\.drivers_uit/),
      expect.stringMatching(/td-lab: overgeslagen op Linux — /),
      expect.stringMatching(/sediment: overgeslagen op Linux \(de hub maakt poort "VARVE-HUB Logic" niet aan\)/),
    ]);   // in de volgorde van config.json → apps
  });
  it('op macOS verandert er niets', () => {
    expect(drivers('darwin').namen).toEqual(['av-scene-kit', 'sediment', 'td-lab', 'uurwerk']);
  });
});
