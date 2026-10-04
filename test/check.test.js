// @ts-check
// `varve-hub check`: elke controle met nep-bestanden, nep-fetch, nep-lsof en een nep-klok. Niets raakt de echte
// thuismap: thuis, hub-map en sets staan in een tijdelijke map.
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import * as nodeFs from 'node:fs';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, tekstVan, jsonVan, TEKEN, lokaal, hubAdres } from '../src/check/index.js';
import { laadConfig } from '../src/config.js';
import { NepKlok } from '../src/core/klok.js';
import { NepSysteem } from '../src/ports/nep.js';
import { startHub } from '../src/hub.js';

const lopend = /** @type {(() => Promise<void>|void)[]} */ ([]);
afterEach(async () => { for (const x of lopend.splice(0)) await x(); });

const GB = 1024 ** 3;
const dicht = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };

/** Een nep-MIDI-systeem met de genoemde apparaten. @param {string[]} namen */
const midiMet = (namen) => async () => { const s = new NepSysteem(); for (const n of namen) s.voegToe(n); return { systeem: s }; };

/** Een nep-spawn voor lsof: `antwoorden[args.join(' ')]` = stdout, of null = lsof bestaat niet. */
function nepSpawn(/** @type {(args: string[]) => string|null} */ antwoord) {
  /** @type {string[][]} */
  const aanroepen = [];
  const spawn = /** @type {any} */ ((/** @type {string} */ cmd, /** @type {string[]} */ args) => {
    aanroepen.push([cmd, ...args]);
    const p = /** @type {any} */ (new EventEmitter());
    p.stdout = new EventEmitter();
    p.kill = () => {};
    const uit = antwoord(args);
    queueMicrotask(() => {
      if (uit === null) { p.emit('error', Object.assign(new Error('spawn lsof ENOENT'), { code: 'ENOENT' })); return; }
      if (uit) p.stdout.emit('data', Buffer.from(uit));
      p.emit('close', uit ? 0 : 1);
    });
    return p;
  });
  return { spawn, aanroepen };
}

/** Een afgemaakte F0-proef: kop met begon, en aan het eind de samenvatting. @param {string} begon */
const F0_AF = (begon) => `{"v":1,"soort":"proef","naam":"f0-hardware","begon":"${begon}"}\n{"ms":1,"e":"stap","id":"welkom","status":"begin"}\n{"ms":9,"e":"samenvatting","bevindingen":{}}\n`;

/** Tijdelijke hub-map + thuismap met standaard alles goed (MIDI, profiel, F0, ruimte, Chrome). */
function opzet() {
  const root = mkdtempSync(join(tmpdir(), 'varve-check-'));
  lopend.push(() => rmSync(root, { recursive: true, force: true }));
  const hubMap = join(root, 'hub'), thuis = join(root, 'thuis'), bin = join(root, 'bin');
  for (const m of [hubMap, join(hubMap, 'proef'), join(hubMap, 'sets'), thuis, bin]) mkdirSync(m, { recursive: true });
  // Zoals de proef ze schrijft (src/proef/f0-hardware.js, src/cli.js nieuwLogboek, src/proef/runner.js).
  writeFileSync(join(hubMap, 'lpd8-profiel.json'), JSON.stringify({ model: 'mk2', bron: 'geleerd', pads: [], knoppen: [] }));
  writeFileSync(join(hubMap, 'proef', '20261003-2010-f0-hardware.jsonl'), F0_AF('2026-10-03T20:10:00.000Z'));
  writeFileSync(join(bin, 'chromium'), '#!/bin/sh\n'); chmodSync(join(bin, 'chromium'), 0o755);
  const config = { ...laadConfig(), avondmap: '~/avonden', geheugen: { pad: '~/.varve-hub/staat.json' } };
  /** @type {any} */
  const fs = { ...nodeFs, statfsSync: () => ({ bavail: 10 * GB / 4096, bsize: 4096 }) };
  const opties = /** @type {import('../src/check/index.js').CheckOpties} */ ({
    config, hubMap, thuis, env: { PATH: bin }, platform: 'linux', fs, fetch: /** @type {any} */ (dicht),
    laadMidi: midiMet(['APC40 mkII', 'LPD8 mk2']), klok: new NepKlok(), poortOpen: async () => false,
    spawn: nepSpawn(() => null).spawn, padenPad: join(hubMap, 'sets', 'paden.json'),
  });
  return { root, hubMap, thuis, bin, config, fs, opties };
}

/** @param {{ punten: any[] }} r @param {string} naam */
const punt = (r, naam) => r.punten.find((p) => p.naam === naam);

describe('check: de hub en de controllers', () => {
  it('alles goed en de hub draait nog niet: alleen ! voor de hub, exitcode 0', async () => {
    const { opties } = opzet();
    const r = await check(opties);
    expect(punt(r, 'hub')).toMatchObject({ status: 'let', uitleg: expect.stringMatching(/draait nog niet \(poort 7700\)/) });
    expect(punt(r, 'apc40')).toMatchObject({ status: 'ok', uitleg: expect.stringMatching(/APC40 mkII/) });
    expect(punt(r, 'lpd8')).toMatchObject({ status: 'ok' });
    expect(r.punten.filter((p) => p.status === 'fout')).toEqual([]);
    expect(r.code).toBe(0);
  });

  it('hub draait niet en de LPD8 is geen MIDI-poort: ✗ met wat te doen; exitcode 1', async () => {
    const { opties } = opzet();
    const r = await check({ ...opties, laadMidi: midiMet(['APC40 mkII', 'IAC Driver Bus 1']) });
    expect(punt(r, 'lpd8')).toMatchObject({ status: 'fout', doen: expect.stringMatching(/steek de LPD8 in/) });
    expect(r.code).toBe(1);
  });

  it('geen MIDI-module: ✗ met npm install; geen MIDI-systeem: iets anders te doen', async () => {
    const { opties } = opzet();
    const a = await check({ ...opties, laadMidi: async () => ({ systeem: null, reden: '@julusian/midi niet geïnstalleerd (x)' }) });
    expect(punt(a, 'midi')).toMatchObject({ status: 'fout', doen: expect.stringMatching(/npm install/) });
    const b = await check({ ...opties, laadMidi: async () => ({ systeem: null, reden: 'MIDI-systeem niet beschikbaar (y)' }) });
    expect(punt(b, 'midi').doen).not.toMatch(/npm install/);
  });

  it('de hub draait (echte startHub): verbonden APC = ✓, ontbrekende LPD8 = ✗, en MIDI wordt dan niet gelezen', async () => {
    const { opties } = opzet();
    const systeem = new NepSysteem();
    systeem.voegToe('APC40 mkII');
    const hub = await startHub({ config: { ...opties.config, hotplug_ms: 20 }, systeem, poort: 0, drivers: false });
    lopend.push(() => hub.stop());
    for (let i = 0; i < 100 && !hub.kern.beeld().apparaten.apc40?.verbonden; i++) await new Promise((r) => setTimeout(r, 10));
    let midiGelezen = false;
    const r = await check({ ...opties, fetch, poort: hub.server.poort, laadMidi: async () => { midiGelezen = true; return { systeem: null }; } });
    expect(punt(r, 'hub')).toMatchObject({ status: 'ok', uitleg: expect.stringMatching(new RegExp(`draait op poort ${hub.server.poort}`)) });
    expect(punt(r, 'apc40')).toMatchObject({ status: 'ok', uitleg: expect.stringMatching(/verbonden met de hub/) });
    expect(punt(r, 'lpd8')).toMatchObject({ status: 'fout', uitleg: expect.stringMatching(/hub ziet de LPD8 niet/) });
    expect(midiGelezen).toBe(false);
    expect(r.hub).toBe(true);
    expect(r.code).toBe(1);
  });

  it('het adres van de hub: 127.0.0.1 bij loopback of 0.0.0.0; een eigen LAN-adres uit server.host met het token', () => {
    const token = () => 'a'.repeat(20);
    for (const host of [undefined, '127.0.0.1', 'localhost', '0.0.0.0', '::']) expect(hubAdres({ server: { host } }, token)).toEqual({ host: '127.0.0.1', metToken: '' });
    expect(hubAdres({ server: { host: '192.168.1.20' } }, token)).toEqual({ host: '192.168.1.20', metToken: `?token=${'a'.repeat(20)}` });
    expect(hubAdres({ server: { host: '192.168.1.20' } }, () => null)).toEqual({ host: '192.168.1.20', metToken: '' });
  });

  it('server.host is een LAN-adres: check vraagt de hub daar (met token), niet op 127.0.0.1', async () => {
    const { opties, config } = opzet();
    /** @type {string[]} */
    const gevraagd = [];
    await check({ ...opties, config: { ...config, server: { ...config.server, host: '192.168.1.20' } }, fetch: /** @type {any} */ (async (/** @type {string} */ u) => { gevraagd.push(u); return dicht(); }) });
    expect(gevraagd).toEqual(['http://192.168.1.20:7700/api/beeld']);
  });

  it('op de poort luistert iets dat geen HTTP spreekt: ✗ met het lsof-commando (niet: start de hub opnieuw)', async () => {
    const { opties } = opzet();
    const r = await check({ ...opties, fetch: /** @type {any} */ (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'UND_ERR_SOCKET', message: 'other side closed' } }); }) });
    expect(punt(r, 'hub')).toMatchObject({ status: 'fout', uitleg: expect.stringMatching(/geen HTTP spreekt \(other side closed\)/), doen: expect.stringMatching(/lsof -nP -iTCP:7700/) });
  });

  it('op de poort draait iets anders dan de hub: ✗', async () => {
    const { opties } = opzet();
    const server = http.createServer((_q, s) => { s.writeHead(404); s.end('nee'); });
    await new Promise((r) => server.listen(0, '127.0.0.1', () => r(null)));
    lopend.push(() => new Promise((r) => server.close(() => r())));
    const poort = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    const r = await check({ ...opties, fetch, poort });
    expect(punt(r, 'hub')).toMatchObject({ status: 'fout', uitleg: expect.stringMatching(/iets anders dan de hub \(HTTP 404\)/) });
    expect(r.code).toBe(1);
  });

  it('iets luistert maar antwoordt niet: na de time-out op de (nep-)klok ✗', async () => {
    const { opties } = opzet();
    const klok = new NepKlok();
    const bezig = check({ ...opties, klok, fetch: /** @type {any} */ ((_u, /** @type {any} */ o) => new Promise((_g, f) => o.signal.addEventListener('abort', () => f(new Error('afgebroken'))))) });
    await new Promise((r) => setTimeout(r, 0));
    klok.loop(2000);
    const r = await bezig;
    expect(punt(r, 'hub')).toMatchObject({ status: 'fout', uitleg: expect.stringMatching(/niet antwoordt/) });
  });
});

describe('check: bestanden van de hub', () => {
  it('LPD8-profiel: ontbreekt = !, kapot = ✗ (de hub start dan niet), geleerd = ✓ met model en datum', async () => {
    const { opties, hubMap } = opzet();
    const vandaag = lokaal(nodeFs.statSync(join(hubMap, 'lpd8-profiel.json')).mtime).slice(0, 10);
    expect(punt(await check(opties), 'lpd8-profiel')).toMatchObject({ status: 'ok', uitleg: `LPD8-profiel geleerd (mk2, ${vandaag})` });
    writeFileSync(join(hubMap, 'lpd8-profiel.json'), '{kapot');
    // git checkout werkt niet voor een bestand dat nooit gecommit is: opzij zetten wel
    expect(punt(await check(opties), 'lpd8-profiel')).toMatchObject({ status: 'fout', doen: expect.stringMatching(/^zet het opzij \(mv lpd8-profiel\.json/) });
    // geldige JSON maar geen profiel: de ontleder zoekt in pads en knoppen
    writeFileSync(join(hubMap, 'lpd8-profiel.json'), '{}');
    expect(punt(await check(opties), 'lpd8-profiel')).toMatchObject({ status: 'fout', uitleg: expect.stringMatching(/niet de vorm van een profiel/) });
    // null: de hub valt terug op de standaardnoten
    writeFileSync(join(hubMap, 'lpd8-profiel.json'), 'null');
    expect(punt(await check(opties), 'lpd8-profiel').status).toBe('let');
    nodeFs.rmSync(join(hubMap, 'lpd8-profiel.json'));
    expect(punt(await check(opties), 'lpd8-profiel')).toMatchObject({ status: 'let', doen: expect.stringMatching(/npm run proef/) });
  });

  it('F0-proef: alleen een synthetische of een andere proef telt niet; een echte wel, met datum', async () => {
    const { opties, hubMap } = opzet();
    nodeFs.rmSync(join(hubMap, 'proef', '20261003-2010-f0-hardware.jsonl'));
    writeFileSync(join(hubMap, 'proef', 'synthetisch-f0.jsonl'), '{"v":1,"soort":"proef","naam":"f0-hardware","synthetisch":true}\n');
    writeFileSync(join(hubMap, 'proef', '20261001-1200-opname-sessie.jsonl'), '{"v":1,"soort":"opname","naam":"opname-sessie"}\n');
    expect(punt(await check(opties), 'proef').status).toBe('let');
    writeFileSync(join(hubMap, 'proef', '20261004-2130-f0-hardware.jsonl'), F0_AF('2026-10-04T21:30:00.000Z'));
    // De stempel is UTC; check toont lokale tijd.
    expect(punt(await check(opties), 'proef')).toMatchObject({ status: 'ok', uitleg: `de F0-proef is gedaan (1×, laatst ${lokaal(new Date('2026-10-04T21:30:00.000Z'))})` });
  });

  it('F0-proef afgebroken (geen samenvatting): ! begonnen maar niet afgemaakt; telt niet mee bij een afgemaakte', async () => {
    const { opties, hubMap } = opzet();
    const afgebroken = '{"v":1,"soort":"proef","naam":"f0-hardware","begon":"2026-10-04T08:00:00.000Z"}\n{"ms":1,"e":"stap","id":"welkom","status":"begin"}\n';
    writeFileSync(join(hubMap, 'proef', '20261004-0800-f0-hardware.jsonl'), afgebroken);
    // naast de afgemaakte van 3 okt: 1×, laatst 3 okt
    expect(punt(await check(opties), 'proef').uitleg).toBe(`de F0-proef is gedaan (1×, laatst ${lokaal(new Date('2026-10-03T20:10:00.000Z'))})`);
    nodeFs.rmSync(join(hubMap, 'proef', '20261003-2010-f0-hardware.jsonl'));
    expect(punt(await check(opties), 'proef')).toMatchObject({ status: 'let', uitleg: expect.stringMatching(/begonnen maar niet afgemaakt/) });
  });

  it('F0-proef: opnames in de proefmap worden niet gelezen', async () => {
    const { opties, hubMap, fs } = opzet();
    writeFileSync(join(hubMap, 'proef', '20261004-2200-speelsessie.jsonl'), '{"v":1,"soort":"opname"}\n');
    /** @type {string[]} */
    const gelezen = [];
    const r = await check({ ...opties, fs: { ...fs, readFileSync: /** @type {any} */ ((/** @type {string} */ p, /** @type {any} */ o) => { gelezen.push(String(p)); return nodeFs.readFileSync(p, o); }) } });
    expect(punt(r, 'proef').status).toBe('ok');
    expect(gelezen.some((p) => p.includes('speelsessie'))).toBe(false);
  });

  it('geheugen: afwezig of leesbaar = ✓; kapot = ✗ en het bestand blijft staan (check verandert niets); .kapot = !', async () => {
    const { opties, thuis } = opzet();
    expect(punt(await check(opties), 'geheugen')).toMatchObject({ status: 'ok', uitleg: expect.stringMatching(/nog geen geheugen \(~\/\.varve-hub\/staat\.json\)/) });
    mkdirSync(join(thuis, '.varve-hub'));
    const pad = join(thuis, '.varve-hub', 'staat.json');
    writeFileSync(pad, '{"v":1,"snapshots":{}}');
    expect(punt(await check(opties), 'geheugen').status).toBe('ok');
    writeFileSync(pad, '{"v":2,"snapshots":{}}');
    expect(punt(await check(opties), 'geheugen')).toMatchObject({ status: 'fout', uitleg: expect.stringMatching(/onbekende versie \(2\)/) });
    writeFileSync(pad, '{half');
    const r = await check(opties);
    expect(punt(r, 'geheugen')).toMatchObject({ status: 'fout', uitleg: expect.stringMatching(/kapot/) });
    expect(readFileSync(pad, 'utf8')).toBe('{half');
    expect(existsSync(`${pad}.kapot`)).toBe(false);
    writeFileSync(`${pad}.kapot`, '{oud');
    expect(punt(await check(opties), 'geheugen-kapot').status).toBe('let');
  });

  it('geheugen onleesbaar: een map = ✗ met eigen uitleg; geen rechten = ✗ met ls -l; geen geheugen.pad = !', async () => {
    const { opties, thuis, config } = opzet();
    mkdirSync(join(thuis, '.varve-hub', 'staat.json'), { recursive: true });
    expect(punt(await check(opties), 'geheugen')).toMatchObject({ status: 'fout', uitleg: expect.stringMatching(/geheugen\.pad wijst naar een map/) });
    const fsGeenRechten = { ...opties.fs, readFileSync: /** @type {any} */ ((/** @type {string} */ p, /** @type {any} */ o) => { if (String(p).endsWith('staat.json')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return nodeFs.readFileSync(p, o); }) };
    expect(punt(await check({ ...opties, fs: /** @type {any} */ (fsGeenRechten) }), 'geheugen')).toMatchObject({
      status: 'fout', uitleg: expect.stringMatching(/niet te lezen \(EACCES\): de hub begint leeg en zet het opzij als \.kapot/), doen: expect.stringMatching(/ls -l ~\/\.varve-hub\/staat\.json/),
    });
    expect(punt(await check({ ...opties, config: { ...config, geheugen: {} } }), 'geheugen')).toMatchObject({ status: 'let', uitleg: expect.stringMatching(/geheugen\.pad/) });
  });

  it('$VARVE_HUB_STAAT gaat voor (zoals in de hub)', async () => {
    const { opties, root } = opzet();
    const eigen = join(root, 'elders.json');
    writeFileSync(eigen, 'nee');
    const r = await check({ ...opties, env: { ...opties.env, VARVE_HUB_STAAT: eigen } });
    expect(punt(r, 'geheugen')).toMatchObject({ status: 'fout', uitleg: expect.stringContaining(eigen) });
  });

  it.each([[3 * GB, 'ok'], [1.5 * GB, 'let'], [400 * 1024 ** 2, 'fout']])('avondmap met %d bytes vrij → %s', async (vrij, status) => {
    const { opties, fs } = opzet();
    /** @type {string[]} */
    const gevraagd = [];
    const r = await check({ ...opties, fs: { ...fs, statfsSync: (/** @type {string} */ p) => { gevraagd.push(p); return { bavail: vrij / 512, bsize: 512 }; } } });
    expect(punt(r, 'avondmap').status).toBe(status);
    // De map bestaat nog niet: de schijf van de map erboven telt (de thuismap).
    expect(gevraagd).toEqual([opties.thuis]);
    expect(punt(r, 'avondmap').uitleg).toMatch(/~\/avonden \(wordt aangemaakt in ~\)/);
  });

  it('avondmap: een bestand = ✗; meer dan één map ontbreekt = !; een schijf die niet is aangesloten = !; geen avondmap = !', async () => {
    const { opties, thuis, config } = opzet();
    writeFileSync(join(thuis, 'avonden'), 'geen map');
    expect(punt(await check(opties), 'avondmap')).toMatchObject({ status: 'fout', uitleg: expect.stringMatching(/is een bestand, geen map/) });
    const diep = await check({ ...opties, config: { ...config, avondmap: '~/Fims/varve/avonden' } });
    expect(punt(diep, 'avondmap')).toMatchObject({ status: 'let', uitleg: expect.stringMatching(/~\/Fims\/varve ook niet \(wel ~\)/), doen: expect.stringMatching(/kijk het pad na/) });
    const schijf = await check({ ...opties, config: { ...config, avondmap: '/Volumes/Extern-varve-check/avonden' }, fs: { ...opties.fs, existsSync: (/** @type {string} */ p) => p === '/Volumes' || p === '/' } });
    expect(punt(schijf, 'avondmap')).toMatchObject({ status: 'let', doen: expect.stringMatching(/sluit de schijf aan/) });
    expect(punt(await check({ ...opties, config: { ...config, avondmap: undefined } }), 'avondmap')).toMatchObject({ status: 'let', uitleg: expect.stringMatching(/geen avondmap in config\.json/) });
  });

  it('avondmap: de vrije ruimte niet na te gaan (statfs faalt) = !', async () => {
    const { opties, fs } = opzet();
    const r = await check({ ...opties, fs: { ...fs, statfsSync: () => { throw new Error('ENOSYS'); } } });
    expect(punt(r, 'avondmap')).toMatchObject({ status: 'let', uitleg: expect.stringMatching(/niet na te gaan \(ENOSYS\)/) });
  });

  it('avondmap niet schrijfbaar: ✗', async () => {
    const { opties, fs } = opzet();
    const r = await check({ ...opties, fs: { ...fs, accessSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } } });
    expect(punt(r, 'avondmap')).toMatchObject({ status: 'fout', uitleg: expect.stringMatching(/niet schrijfbaar/) });
  });
});

describe('check: Chrome', () => {
  it('macOS: /Applications/Google Chrome.app = ✓, zonder = ✗', async () => {
    const { opties, fs } = opzet();
    const met = await check({ ...opties, platform: 'darwin', fs: { ...fs, existsSync: (/** @type {string} */ p) => p === '/Applications/Google Chrome.app' || nodeFs.existsSync(p) } });
    expect(punt(met, 'chrome').status).toBe('ok');
    const zonder = await check({ ...opties, platform: 'darwin', fs: { ...fs, existsSync: (/** @type {string} */ p) => !p.includes('Google Chrome') && nodeFs.existsSync(p) } });
    expect(punt(zonder, 'chrome')).toMatchObject({ status: 'fout' });
    const thuisApp = join(opties.thuis ?? '', 'Applications', 'Google Chrome.app');
    const inThuis = await check({ ...opties, platform: 'darwin', fs: { ...fs, existsSync: (/** @type {string} */ p) => p === thuisApp || (!p.includes('Google Chrome') && nodeFs.existsSync(p)) } });
    expect(punt(inThuis, 'chrome')).toMatchObject({ status: 'ok', uitleg: 'Chrome aanwezig (~/Applications/Google Chrome.app)' });
  });

  it('Linux: chromium in PATH = ✓, niets in PATH = !', async () => {
    const { opties, root } = opzet();
    expect(punt(await check(opties), 'chrome')).toMatchObject({ status: 'ok', uitleg: expect.stringMatching(/chromium/) });
    expect(punt(await check({ ...opties, env: { PATH: join(root, 'leeg') } }), 'chrome').status).toBe('let');
  });
});

describe('check --lan: het token', () => {
  it('zonder --lan geen tokenpunt; met --lan: ontbreekt = ✗, te ruim = !, 0600 = ✓, onzin = ✗', async () => {
    const { opties, thuis } = opzet();
    expect(punt(await check(opties), 'token')).toBeUndefined();
    const lan = { ...opties, lan: true };
    expect(punt(await check(lan), 'token')).toMatchObject({ status: 'fout', doen: expect.stringMatching(/node src\/cli\.js token/) });
    const pad = join(thuis, '.varve-hub', 'token');
    mkdirSync(join(thuis, '.varve-hub'), { recursive: true });
    writeFileSync(pad, 'a'.repeat(43) + '\n', { mode: 0o644 }); chmodSync(pad, 0o644);
    expect(punt(await check(lan), 'token')).toMatchObject({ status: 'let', uitleg: expect.stringMatching(/644/), doen: expect.stringMatching(/chmod 600 .* token --nieuw/) });
    chmodSync(pad, 0o600);
    expect(punt(await check(lan), 'token')).toMatchObject({ status: 'ok', uitleg: expect.stringMatching(/600/) });
    writeFileSync(pad, 'kort\n');
    expect(punt(await check(lan), 'token').status).toBe('fout');
    // check maakt of herstelt niets
    expect((nodeFs.statSync(pad).mode & 0o777).toString(8)).toBe('600');
    // de map ~/.varve-hub: ruimer dan 700 = !
    chmodSync(join(thuis, '.varve-hub'), 0o755);
    expect(punt(await check(lan), 'token-map')).toMatchObject({ status: 'let', doen: 'chmod 700 ~/.varve-hub' });
    chmodSync(join(thuis, '.varve-hub'), 0o700);
    expect(punt(await check(lan), 'token-map')).toBeUndefined();
  });
});

describe('check met een set', () => {
  /** Een set met formula-lab (vite), waterschaal (python3), varve-dj en av-kern (wacht op de poort). */
  function metSet() {
    const o = opzet();
    writeFileSync(join(o.hubMap, 'sets', 'avond.json'), JSON.stringify({
      naam: 'Avond',
      apps: {
        'formula-lab': { start: { commando: 'npm run dev -- --port {poort} --strictPort' }, url: 'http://localhost:{poort}/?hub={hub}' },
        waterschaal: { start: { commando: 'python3 -m http.server {poort}' }, url: 'http://localhost:{poort}/td/waterschaal-lokaal.html?hub={hub}' },
        'varve-dj': { start: { commando: 'node server/index.js', omgeving: { PORT: '{poort}' } }, url: 'http://localhost:{poort}/?hub={hub}' },
        'av-kern': { start: { commando: 'npm run dev -- --port {poort}' }, url: 'http://localhost:{poort}/?hub={hub}', wacht: 'poort' },
      },
    }));
    const repos = join(o.thuis, 'Projects');
    const map = (/** @type {string} */ r) => join(repos, r);
    for (const r of ['formula-lab', 'waterschaal', 'youtube-mixer', 'av-kern']) mkdirSync(map(r), { recursive: true });
    writeFileSync(o.opties.padenPad ?? '', JSON.stringify({ 'formula-lab': '~/Projects/formula-lab', waterschaal: '~/Projects/waterschaal', 'youtube-mixer': '~/Projects/youtube-mixer', 'av-kern': '~/Projects/av-kern' }));
    // formula-lab: vite geïnstalleerd, koppeling erin
    writeFileSync(join(map('formula-lab'), 'package.json'), JSON.stringify({ devDependencies: { vite: '^5' } }));
    mkdirSync(join(map('formula-lab'), 'node_modules', 'vite'), { recursive: true });
    mkdirSync(join(map('formula-lab'), 'src', 'sync'), { recursive: true });
    writeFileSync(join(map('formula-lab'), 'src', 'sync', 'hub.js'), '// koppeling');
    // waterschaal: het HTML-bestand met ?hub=
    mkdirSync(join(map('waterschaal'), 'td'));
    writeFileSync(join(map('waterschaal'), 'td', 'waterschaal-lokaal.html'), "<script>const hub = new URLSearchParams(location.search).get('hub');</script>");
    // youtube-mixer: geen deps (regel van Varve DJ), patch toegepast
    writeFileSync(join(map('youtube-mixer'), 'package.json'), JSON.stringify({ name: 'varve' }));
    mkdirSync(join(map('youtube-mixer'), 'src', 'control'), { recursive: true });
    writeFileSync(join(map('youtube-mixer'), 'src', 'control', 'hub.js'), '// koppeling');
    // av-kern: nog geen koppeling (vóór 25 okt), wel node_modules
    writeFileSync(join(map('av-kern'), 'package.json'), JSON.stringify({ devDependencies: { vite: '^5' } }));
    mkdirSync(join(map('av-kern'), 'node_modules', 'vite'), { recursive: true });
    return { ...o, map, opties: { ...o.opties, set: 'avond' } };
  }

  it('alles op orde: per app map, node_modules, poort vrij en koppeling ✓; av-kern zonder koppeling maar wacht=poort = !', async () => {
    const { opties } = metSet();
    const r = await check(opties);
    expect(punt(r, 'paden').status).toBe('ok');
    for (const n of ['formula-lab.map', 'formula-lab.node_modules', 'formula-lab.poort', 'formula-lab.koppeling', 'waterschaal.koppeling', 'varve-dj.koppeling', 'av-kern.node_modules']) {
      expect(punt(r, n)?.status, n).toBe('ok');
    }
    expect(punt(r, 'formula-lab.poort').uitleg).toMatch(/poort 5174 vrij/);
    // python3 en een package.json zonder deps: geen node_modules-punt
    expect(punt(r, 'waterschaal.node_modules')).toBeUndefined();
    expect(punt(r, 'varve-dj.node_modules')).toBeUndefined();
    expect(punt(r, 'av-kern.koppeling')).toMatchObject({ status: 'let', doen: expect.stringMatching(/koppelingen\/av-kern/) });
    expect(r.code).toBe(0);
  });

  it('koppeling ontbreekt (formula-lab) of het HTML-bestand kent geen hub (waterschaal): ✗ met de uitleg', async () => {
    const { opties, map } = metSet();
    nodeFs.rmSync(join(map('formula-lab'), 'src', 'sync', 'hub.js'));
    writeFileSync(join(map('waterschaal'), 'td', 'waterschaal-lokaal.html'), '<script>// oud</script>');
    const r = await check(opties);
    for (const n of ['formula-lab.koppeling', 'waterschaal.koppeling']) {
      expect(punt(r, n)).toMatchObject({ status: 'fout', doen: expect.stringContaining('de app meldt zich niet bij de hub tot de koppeling erin zit (zie koppelingen/ of de PR)') });
    }
    expect(punt(r, 'formula-lab.koppeling').uitleg).toMatch(/src\/sync\/hub\.js ontbreekt/);
    expect(r.code).toBe(1);
  });

  it('youtube-mixer zonder de patch: ✗ en verwijst naar koppelingen/varve-dj', async () => {
    const { opties, map } = metSet();
    nodeFs.rmSync(join(map('youtube-mixer'), 'src'), { recursive: true });
    expect(punt(await check(opties), 'varve-dj.koppeling')).toMatchObject({ status: 'fout', doen: expect.stringMatching(/koppelingen\/varve-dj\/LEESMIJ\.md/) });
  });

  it('map bestaat niet, of vite niet geïnstalleerd: ✗ met het commando', async () => {
    const { opties, map } = metSet();
    nodeFs.rmSync(map('waterschaal'), { recursive: true });
    nodeFs.rmSync(join(map('formula-lab'), 'node_modules'), { recursive: true });
    const r = await check(opties);
    expect(punt(r, 'waterschaal.map')).toMatchObject({ status: 'fout', uitleg: expect.stringMatching(/~\/Projects\/waterschaal bestaat niet/) });
    expect(punt(r, 'formula-lab.node_modules')).toMatchObject({ status: 'fout', doen: 'cd ~/Projects/formula-lab && npm install' });
    mkdirSync(join(map('formula-lab'), 'node_modules', 'iets'), { recursive: true });
    expect(punt(await check(opties), 'formula-lab.node_modules').uitleg).toMatch(/vite staat niet in node_modules/);
  });

  it('sets/paden.json ontbreekt: ✗ met het cp-commando; geen ✗ per app daarbovenop', async () => {
    const { opties } = metSet();
    nodeFs.rmSync(opties.padenPad ?? '');
    const r = await check(opties);
    expect(punt(r, 'paden')).toMatchObject({ status: 'fout', doen: expect.stringMatching(/cp sets\/paden\.voorbeeld\.json sets\/paden\.json/) });
    expect(r.punten.filter((p) => p.status === 'fout')).toHaveLength(1);
  });

  it('een repo die niet in paden.json staat: ✗ voor die app', async () => {
    const { opties } = metSet();
    writeFileSync(opties.padenPad ?? '', JSON.stringify({ 'formula-lab': '~/Projects/formula-lab' }));
    expect(punt(await check(opties), 'waterschaal.map')).toMatchObject({ status: 'fout', uitleg: expect.stringMatching(/geen map voor repo "waterschaal"/) });
  });

  it('poort bezet door de app zelf, ook met een slash achter het pad in paden.json of via een symlink: ✓', async () => {
    const { opties, map, root } = metSet();
    const bezet = async (/** @type {number} */ p) => p === 5174;
    const lsof = (/** @type {string} */ cwd) => nepSpawn((args) => (args.includes('-iTCP:5174') ? 'p4242\ncnode\n' : args.includes('4242') ? `p4242\nfcwd\nn${cwd}\n` : ''));
    writeFileSync(opties.padenPad ?? '', JSON.stringify({ 'formula-lab': '~/Projects/formula-lab/' }));
    const slash = await check({ ...opties, poortOpen: bezet, spawn: lsof(map('formula-lab')).spawn });
    expect(punt(slash, 'formula-lab.poort')).toMatchObject({ status: 'ok', uitleg: expect.stringMatching(/al door Formula Lab bezet/) });
    // paden.json wijst via een symlink; lsof geeft het echte pad
    symlinkSync(map('formula-lab'), join(root, 'fl-link'));
    writeFileSync(opties.padenPad ?? '', JSON.stringify({ 'formula-lab': join(root, 'fl-link') }));
    const link = await check({ ...opties, poortOpen: bezet, spawn: lsof(nodeFs.realpathSync(map('formula-lab'))).spawn });
    expect(punt(link, 'formula-lab.poort')).toMatchObject({ status: 'ok', uitleg: expect.stringMatching(/al door Formula Lab bezet/) });
    // macOS: hoofdletters tellen niet; Linux wel
    const anders = lsof(map('formula-lab').replace('formula-lab', 'Formula-Lab'));
    writeFileSync(opties.padenPad ?? '', JSON.stringify({ 'formula-lab': '~/Projects/formula-lab' }));
    expect(punt(await check({ ...opties, platform: 'darwin', poortOpen: bezet, spawn: anders.spawn, fs: { ...opties.fs, existsSync: (/** @type {string} */ p) => p === '/Applications/Google Chrome.app' || nodeFs.existsSync(p) } }), 'formula-lab.poort').status).toBe('ok');
    expect(punt(await check({ ...opties, poortOpen: bezet, spawn: anders.spawn }), 'formula-lab.poort').status).toBe('fout');
  });

  it('python3 naast een package.json mét dependencies: geen node_modules-punt (alleen npm/node/vite hebben het nodig)', async () => {
    const { opties, map } = metSet();
    writeFileSync(join(map('waterschaal'), 'package.json'), JSON.stringify({ devDependencies: { vite: '^5' } }));
    expect(punt(await check(opties), 'waterschaal.node_modules')).toBeUndefined();
  });

  it('de hub draait niet: de startregel noemt de set (als die bestaat) en --lan', async () => {
    const { opties } = metSet();
    expect(punt(await check({ ...opties, lan: true }), 'hub').doen).toBe('start hem straks met npm start -- avond --lan');
    const r = await check({ ...opties, set: 'bestaatniet' });
    expect(punt(r, 'hub').doen).toBe('start hem straks met npm start');
    expect(punt(r, 'set').doen).toMatch(/kijk de naam na: de sets die er zijn staan hierboven/);
  });

  it('poort bezet: door de app zelf = ✓, door iets anders = ✗ met pid, zonder lsof = !', async () => {
    const { opties, map } = metSet();
    const bezet = async (/** @type {number} */ p) => p === 5174;
    const lsof = (/** @type {string} */ cwd) => nepSpawn((args) => (args.includes('-iTCP:5174') ? 'p4242\ncnode\n' : args.includes('4242') ? `p4242\nfcwd\nn${cwd}\n` : ''));
    const zelf = await check({ ...opties, poortOpen: bezet, spawn: lsof(join(map('formula-lab'), 'node_modules', '.bin')).spawn });
    expect(punt(zelf, 'formula-lab.poort')).toMatchObject({ status: 'ok', uitleg: expect.stringMatching(/al door Formula Lab bezet \(pid 4242\)/) });
    const ander = await check({ ...opties, poortOpen: bezet, spawn: lsof('/tmp/iets-anders').spawn });
    expect(punt(ander, 'formula-lab.poort')).toMatchObject({ status: 'fout', uitleg: expect.stringMatching(/bezet door node \(pid 4242, in \/tmp\/iets-anders\), niet door Formula Lab/), doen: expect.stringMatching(/kill 4242/) });
    expect(ander.code).toBe(1);
    const geenLsof = await check({ ...opties, poortOpen: bezet });
    expect(punt(geenLsof, 'formula-lab.poort')).toMatchObject({ status: 'let', uitleg: expect.stringMatching(/geen lsof/) });
  });

  /** Een nep-hub die dit beeld geeft. @param {any[]} apps */
  const hubMet = (apps) => /** @type {any} */ (async () => new Response(JSON.stringify({ apps, apparaten: { apc40: { verbonden: true }, lpd8: { verbonden: true } } }), { status: 200 }));

  it('een app die al verbonden is met de draaiende hub én zijn poort open heeft: één ✓, verder niets nagegaan', async () => {
    const { opties, map } = metSet();
    nodeFs.rmSync(map('formula-lab'), { recursive: true });
    const r = await check({ ...opties, fetch: hubMet([{ app: 'formula-lab', status: 'actief' }]), poortOpen: async (p) => p === 5174 });
    expect(punt(r, 'formula-lab.hub')).toMatchObject({ status: 'ok', uitleg: expect.stringMatching(/verbonden met de hub/) });
    expect(punt(r, 'formula-lab.map')).toBeUndefined();
    expect(punt(r, 'hub').uitleg).toMatch(/1 app\(s\) verbonden\)/);
  });

  it('zoals de starter: actief maar de poort dicht telt niet als verbonden; een andere id met hetzelfde begin ook niet', async () => {
    const { opties } = metSet();
    const r = await check({ ...opties, fetch: hubMet([{ app: 'formula-lab', status: 'actief' }, { app: 'waterschaal-oud', status: 'actief' }]) });
    expect(punt(r, 'formula-lab.hub')).toBeUndefined();
    expect(punt(r, 'formula-lab.poort')).toMatchObject({ status: 'ok', uitleg: 'formula-lab: poort 5174 vrij' });
    expect(punt(r, 'waterschaal.hub')).toBeUndefined();
  });

  it('per_monitor (flux): flux-<monitor> telt wel als flux', async () => {
    const { opties, hubMap } = metSet();
    writeFileSync(join(hubMap, 'sets', 'flux.json'), JSON.stringify({ naam: 'Flux', apps: { flux: { start: null, handmatig: 'start de screensaver' } } }));
    const r = await check({ ...opties, set: 'flux', fetch: hubMet([{ app: 'flux-dp-1', status: 'actief' }]) });
    expect(punt(r, 'flux.hub')).toMatchObject({ status: 'ok' });
  });

  it('uurwerk (HTTP-driver): actief in het beeld maar de brug draait niet (poort dicht) = geen ✓, de gewone punten', async () => {
    const { opties, hubMap, thuis } = metSet();
    writeFileSync(join(hubMap, 'sets', 'klok.json'), JSON.stringify({ naam: 'Klok', apps: { uurwerk: { start: { commando: './start.sh' }, url: null } } }));
    writeFileSync(opties.padenPad ?? '', JSON.stringify({ uurwerk: '~/Projects/uurwerk' }));
    mkdirSync(join(thuis, 'Projects', 'uurwerk'), { recursive: true });
    const r = await check({ ...opties, set: 'klok', fetch: hubMet([{ app: 'uurwerk', status: 'actief' }]) });
    expect(punt(r, 'uurwerk.hub')).toBeUndefined();
    expect(punt(r, 'uurwerk.map').status).toBe('ok');
    expect(punt(r, 'uurwerk.poort')).toMatchObject({ status: 'ok', uitleg: 'uurwerk: poort 8766 vrij' });
    // een driver telt niet als verbonden app
    expect(punt(r, 'hub').uitleg).toMatch(/\(0 app\(s\) verbonden, 1 driver\(s\)\)/);
  });

  it('echte startHub met drivers en de set scene-kit: av-scene-kit houdt de ! voor handmatig (TD kan dicht zijn)', async () => {
    const { opties, thuis } = metSet();
    writeFileSync(opties.padenPad ?? '', JSON.stringify({ 'av-scene-kit': '~/Projects/av-scene-kit', 'youtube-mixer': '~/Projects/youtube-mixer' }));
    mkdirSync(join(thuis, 'Projects', 'av-scene-kit', 'td'), { recursive: true });
    writeFileSync(join(thuis, 'Projects', 'av-scene-kit', 'td', 'td_build_hub.py'), '# koppeling');
    const systeem = new NepSysteem();
    const geenNet = /** @type {any} */ (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); });
    const hub = await startHub({ config: { ...opties.config, drivers: { uitstel_ms: 0 } }, systeem, poort: 0, fetch: geenNet });
    lopend.push(() => hub.stop());
    for (let i = 0; i < 100 && hub.kern.beeld().apps.find((a) => a.app === 'av-scene-kit')?.status !== 'actief'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(hub.kern.beeld().apps.find((a) => a.app === 'av-scene-kit')?.status).toBe('actief');
    const { setsMap: _weg, ...zonderSets } = /** @type {any} */ (opties);
    const r = await check({ ...zonderSets, setsMap: join(import.meta.dirname, '..', 'sets'), set: 'scene-kit', fetch, poort: hub.server.poort });
    expect(punt(r, 'av-scene-kit.hub')).toBeUndefined();
    expect(punt(r, 'av-scene-kit.handmatig')).toMatchObject({ status: 'let', uitleg: expect.stringMatching(/start je zelf \(de hub ziet alleen zijn eigen driver/), doen: expect.stringMatching(/TouchDesigner/) });
    expect(punt(r, 'hub').uitleg).toMatch(/\(0 app\(s\) verbonden, \d+ driver\(s\)\)/);
  });

  it('onbekende set: ✗ met de sets die er wel zijn', async () => {
    const { opties } = metSet();
    const r = await check({ ...opties, set: 'bestaatniet' });
    expect(punt(r, 'set')).toMatchObject({ status: 'fout', uitleg: expect.stringMatching(/onbekende set "bestaatniet" — beschikbaar: avond/) });
    expect(r.code).toBe(1);
  });

  it('handmatige app (Scene Kit): ! met wat je zelf moet doen, {repo} ingevuld', async () => {
    const { opties, hubMap, thuis } = metSet();
    writeFileSync(join(hubMap, 'sets', 'td.json'), JSON.stringify({ naam: 'TD', apps: { 'av-scene-kit': { start: null, handmatig: "exec(open('{repo}/td/td_build_hub.py').read())" } } }));
    writeFileSync(opties.padenPad ?? '', JSON.stringify({ 'av-scene-kit': '~/Projects/av-scene-kit' }));
    mkdirSync(join(thuis, 'Projects', 'av-scene-kit', 'td'), { recursive: true });
    const r = await check({ ...opties, set: 'td' });
    expect(punt(r, 'av-scene-kit.handmatig')).toMatchObject({ status: 'let', doen: `exec(open('${join(thuis, 'Projects', 'av-scene-kit')}/td/td_build_hub.py').read())` });
    expect(punt(r, 'av-scene-kit.koppeling').status).toBe('fout');
  });
});

describe('check: uitvoer', () => {
  it('tekst: per groep een kop, ✓/!/✗, en → wat te doen alleen bij ! en ✗; slotregel telt', () => {
    const t = tekstVan({ set: 'dj', code: 1, punten: [
      { groep: 'hub', naam: 'hub', status: 'ok', uitleg: 'de hub draait', doen: 'niets' },
      { groep: 'apparaten', naam: 'lpd8', status: 'fout', uitleg: 'LPD8 weg', doen: 'steek hem in' },
      { groep: 'apparaten', naam: 'apc40', status: 'let', uitleg: 'APC raar', doen: 'kijk' },
    ] });
    expect(t).toBe([
      'varve-hub check — set dj', '', 'Hub', '  ✓ de hub draait', '', 'Controllers', '  ✗ LPD8 weg', '      → steek hem in',
      '  ! APC raar', '      → kijk', '', '1 × ✗, 1 × ! — los eerst de ✗ op en draai check opnieuw.',
    ].join('\n'));
    expect(TEKEN).toEqual({ ok: '✓', let: '!', fout: '✗' });
  });

  it('json: ok, code en per punt het teken', async () => {
    const { opties } = opzet();
    const j = jsonVan(await check(opties));
    expect(j.ok).toBe(true);
    expect(j.punten.find((p) => p.naam === 'hub')).toMatchObject({ status: 'let', teken: '!' });
  });
});
