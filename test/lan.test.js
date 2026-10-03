// src/lan.js: token op schijf, LAN-namen, mDNS als kindproces (nep-spawn + NepKlok), launchd/systemd-dienst.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NepKlok } from '../src/core/klok.js';
import {
  leesOfMaakToken, tokenPad, nieuwToken, isLoopbackHost, lanNamen, lanOrigins, lanAdressen, cockpitAdressen,
  mdnsCommando, kondigAan, inPad, dienstVoor, installeer, MDNS_TYPE, LAUNCHD_LABEL, SYSTEMD_NAAM,
  bonjourNaam, mdnsNaam, stabielNode, MDNS_POGINGEN,
} from '../src/lan.js';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
/** @type {string} */ let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'varve-home-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));
const mode = (/** @type {string} */ p) => statSync(p).mode & 0o777;

describe('token in ~/.varve-hub/token', () => {
  it('eerste keer: aangemaakt, 0600 in een 0700-map, URL-veilig en lang genoeg', () => {
    const t = leesOfMaakToken({ home });
    expect(t.nieuw).toBe(true);
    expect(t.pad).toBe(join(home, '.varve-hub', 'token'));
    expect(mode(t.pad)).toBe(0o600);
    expect(mode(dirname(t.pad))).toBe(0o700);
    expect(t.token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(encodeURIComponent(t.token)).toBe(t.token);
    expect(readFileSync(t.pad, 'utf8').trim()).toBe(t.token);
  });
  it('daarna: hetzelfde token, niet opnieuw gemaakt', () => {
    const a = leesOfMaakToken({ home });
    const b = leesOfMaakToken({ home, maak: () => { throw new Error('mag niet'); } });
    expect(b).toMatchObject({ token: a.token, nieuw: false, hersteld: false });
  });
  it('te ruime rechten worden hersteld naar 0600 en gemeld', () => {
    const a = leesOfMaakToken({ home });
    chmodSync(a.pad, 0o644);
    const b = leesOfMaakToken({ home });
    expect(b.hersteld).toBe(true);
    expect(mode(a.pad)).toBe(0o600);
  });
  it('leeg of onzin: een duidelijke fout, nooit stilletjes een ander token', () => {
    mkdirSync(join(home, '.varve-hub'));
    writeFileSync(tokenPad(home), '\n', { mode: 0o600 });
    expect(() => leesOfMaakToken({ home })).toThrow(/geen geldig token/);
    writeFileSync(tokenPad(home), 'met spatie en ; tekens', { mode: 0o600 });
    expect(() => leesOfMaakToken({ home })).toThrow(/geen geldig token/);
  });
  it('opnieuw: een nieuw token, weer 0600', () => {
    const a = leesOfMaakToken({ home });
    const b = leesOfMaakToken({ home, opnieuw: true });
    expect(b.nieuw).toBe(true);
    expect(b.token).not.toBe(a.token);
    expect(mode(b.pad)).toBe(0o600);
  });
  it('nieuwToken: elke keer anders', () => expect(nieuwToken()).not.toBe(nieuwToken()));
  it('tegelijk voor het eerst (dienst + `token`): wie later is leest het token van de ander, geen EEXIST', () => {
    const ander = 'token-van-het-andere-proces-0123456789';
    // Precies tussen "bestaat nog niet" en "op zijn plaats zetten" schrijft een ander proces het token.
    const t = leesOfMaakToken({ home, maak: () => { mkdirSync(join(home, '.varve-hub'), { recursive: true }); writeFileSync(tokenPad(home), ander + '\n', { mode: 0o600 }); return nieuwToken(); } });
    expect(t).toMatchObject({ token: ander, nieuw: false });
    expect(readdirSync(join(home, '.varve-hub'))).toEqual(['token']);   // geen tijdelijke bestanden achtergelaten
  });
  it.skipIf(process.getuid?.() === 0)('schrijven mislukt (zoals een volle schijf): geen leeg tokenbestand achtergelaten', () => {
    mkdirSync(join(home, '.varve-hub'), { mode: 0o700 });
    chmodSync(join(home, '.varve-hub'), 0o500);
    try { expect(() => leesOfMaakToken({ home })).toThrow(); } finally { chmodSync(join(home, '.varve-hub'), 0o700); }
    expect(existsSync(tokenPad(home))).toBe(false);
  });
  it('atomair: geen restjes, ook niet bij opnieuw', () => {
    const t = leesOfMaakToken({ home: mkdtempSync(join(tmpdir(), 'varve-home2-')) });
    expect(readdirSync(dirname(t.pad))).toEqual(['token']);
    const n = leesOfMaakToken({ home: dirname(dirname(t.pad)), opnieuw: true });
    expect(readdirSync(dirname(n.pad))).toEqual(['token']);
    expect(mode(n.pad)).toBe(0o600);
  });
});

describe('namen en adressen', () => {
  it('loopback-hosts zijn niet "op het netwerk"', () => {
    for (const h of [undefined, 'localhost', '127.0.0.1', '127.0.0.2', '::1']) expect(isLoopbackHost(h), String(h)).toBe(true);
    for (const h of ['0.0.0.0', '::', '192.168.1.10', 'studio.local']) expect(isLoopbackHost(h), h).toBe(false);
  });
  it('lanNamen: hostnaam en <naam>.local, kleine letters, ook als de hostnaam al .local heeft', () => {
    expect(lanNamen({ hostnaam: 'Clays-MacBook-Pro.local' })).toEqual(['clays-macbook-pro', 'clays-macbook-pro.local']);
    expect(lanNamen({ hostnaam: 'omarchy' })).toEqual(['omarchy', 'omarchy.local']);
    expect(lanNamen({ hostnaam: 'studio', extra: ['Studio.lan', 'localhost', 'kw@ad'] })).toEqual(['studio', 'studio.local', 'studio.lan']);
  });
  it('lanNamen: de Bonjour-naam van de Mac (scutil), ook als de hostnaam iets als x.fritz.box is', () => {
    const namen = lanNamen({ hostnaam: 'clays-mbp.fritz.box', bonjour: 'Clays-MacBook-Pro' });
    expect(namen).toContain('clays-macbook-pro.local');
    expect(namen).toContain('clays-mbp.fritz.box');
    expect(namen).toContain('clays-mbp.local');
    expect(namen).not.toContain('clays-mbp.fritz.box.local');
    expect(mdnsNaam(namen)).toBe('clays-macbook-pro.local');          // die tonen we (cockpit-adres, flux-regel)
    expect(lanNamen({ hostnaam: 'x.fritz.box', bonjour: null })).toEqual(['x.fritz.box', 'x.local']);
    expect(mdnsNaam(lanNamen({ hostnaam: 'kw@ad', bonjour: null }))).toBe(null);
  });
  it('bonjourNaam: scutil --get LocalHostName op macOS, anders null; een fout is null', () => {
    /** @type {string[][]} */ const aanroepen = [];
    expect(bonjourNaam({ platform: 'darwin', run: (b, a) => { aanroepen.push([b, ...a]); return 'Clays-MacBook-Pro\n'; } })).toBe('Clays-MacBook-Pro');
    expect(aanroepen).toEqual([['scutil', '--get', 'LocalHostName']]);
    expect(bonjourNaam({ platform: 'darwin', run: () => { throw new Error('geen scutil'); } })).toBe(null);
    expect(bonjourNaam({ platform: 'linux', run: () => { throw new Error('mag niet'); } })).toBe(null);
  });
  it('lanOrigins: http://<naam>:<poort>', () => {
    expect(lanOrigins(['studio', 'studio.local'], 7700)).toEqual(['http://studio:7700', 'http://studio.local:7700']);
  });
  it('lanAdressen: alleen IPv4 van echte netwerkkaarten', () => {
    expect(lanAdressen(/** @type {any} */ ({
      lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      en0: [{ family: 'IPv6', address: 'fe80::1', internal: false }, { family: 'IPv4', address: '192.168.1.20', internal: false }],
    }))).toEqual(['192.168.1.20']);
  });
  it('cockpitAdressen: .local-naam en IP, met ?token=', () => {
    expect(cockpitAdressen({ namen: ['studio', 'studio.local'], adressen: ['192.168.1.20'], poort: 7700, token: 'abc' }))
      .toEqual(['http://studio.local:7700/?token=abc', 'http://192.168.1.20:7700/?token=abc']);
  });
});

/** Nep-kindproces voor spawn. */
class NepKind extends EventEmitter {
  constructor() { super(); this.gedood = false; }
  kill() { this.gedood = true; return true; }
}

describe('mDNS-aankondiging', () => {
  it('macOS: dns-sd -R, Linux: avahi-publish -s; _varvehub._tcp op de http-poort; nooit het token', () => {
    const mac = mdnsCommando({ platform: 'darwin', poort: 7700, naam: 'Varve hub (studio)' });
    expect(mac?.bin).toBe('dns-sd');
    expect(mac?.args.slice(0, 5)).toEqual(['-R', 'Varve hub (studio)', MDNS_TYPE, 'local', '7700']);
    const linux = mdnsCommando({ platform: 'linux', poort: 7700, naam: 'Varve hub' });
    expect(linux?.bin).toBe('avahi-publish');
    expect(linux?.args.slice(0, 4)).toEqual(['-s', 'Varve hub', '_varvehub._tcp', '7700']);
    expect(linux?.args).toContain('pad=/cockpit');
    for (const c of [mac, linux]) expect(c?.args.join(' ')).not.toMatch(/token=(?!nodig)/);
    expect(mdnsCommando({ platform: 'win32', poort: 7700, naam: 'x' })).toBeNull();
  });

  it('bestaat het programma niet: een melding, geen kindproces', () => {
    const log = /** @type {string[]} */ ([]);
    const r = kondigAan({ poort: 7700, platform: 'linux', bestaat: () => false, spawn: () => { throw new Error('mag niet'); }, klok: new NepKlok(), log: (m) => log.push(String(m)) });
    expect(r.actief).toBe(false);
    expect(log.join('\n')).toMatch(/avahi-publish niet gevonden/);
    r.stop();
  });

  it('start het kindproces, herstart na een crash met oplopende pauze (klok), stop() doodt het', () => {
    const klok = new NepKlok();
    const kinderen = /** @type {NepKind[]} */ ([]);
    const log = /** @type {string[]} */ ([]);
    const r = kondigAan({
      poort: 7711, naam: 'Varve hub', platform: 'darwin', bestaat: (b) => b === 'dns-sd', klok, log: (m) => log.push(String(m)),
      spawn: /** @type {any} */ ((bin, args) => { const k = new NepKind(); Object.assign(k, { bin, args }); kinderen.push(k); return k; }),
    });
    expect(r.actief).toBe(true);
    expect(kinderen).toHaveLength(1);
    expect(/** @type {any} */ (kinderen[0]).args).toContain('7711');
    kinderen[0].emit('exit', 1, null);
    klok.loop(4999);
    expect(kinderen).toHaveLength(1);
    klok.loop(1);
    expect(kinderen).toHaveLength(2);                      // na 5 s
    kinderen[1].emit('exit', 1, null);
    klok.loop(9999);
    expect(kinderen).toHaveLength(2);
    klok.loop(1);
    expect(kinderen).toHaveLength(3);                      // na 10 s
    expect(log.some((m) => /opnieuw over 5 s/.test(m))).toBe(true);
    r.stop();
    expect(kinderen[2].gedood).toBe(true);
    kinderen[2].emit('exit', null, 'SIGTERM');             // het eigen stoppen is geen crash
    klok.loop(120000);
    expect(kinderen).toHaveLength(3);
  });

  it('stop() tijdens de pauze: geen nieuw kindproces meer', () => {
    const klok = new NepKlok();
    const kinderen = /** @type {NepKind[]} */ ([]);
    const r = kondigAan({ poort: 1, platform: 'linux', bestaat: () => true, klok, log: () => {}, spawn: /** @type {any} */ (() => { const k = new NepKind(); kinderen.push(k); return k; }) });
    kinderen[0].emit('error', new Error('ENOENT'));
    r.stop();
    klok.loop(120000);
    expect(kinderen).toHaveLength(1);
  });

  it('crasht de hub (exit van het proces), dan gaat het kindproces mee: geen wees die de dienst blijft aankondigen', () => {
    const proces = new EventEmitter();
    const kinderen = /** @type {NepKind[]} */ ([]);
    const r = kondigAan({ poort: 1, platform: 'linux', bestaat: () => true, klok: new NepKlok(), log: () => {}, proces: /** @type {any} */ (proces),
      spawn: /** @type {any} */ (() => { const k = new NepKind(); kinderen.push(k); return k; }) });
    expect(proces.listenerCount('exit')).toBe(1);
    proces.emit('exit', 1);
    expect(kinderen[0].gedood).toBe(true);
    r.stop();
    expect(proces.listenerCount('exit')).toBe(0);                     // netjes gestopt: geen listener achtergelaten
  });

  it(`na ${MDNS_POGINGEN} mislukte starts op rij: één duidelijke melding en klaar (geen eindeloos gelog)`, () => {
    const klok = new NepKlok();
    const proces = new EventEmitter();
    const kinderen = /** @type {NepKind[]} */ ([]);
    const log = /** @type {string[]} */ ([]);
    kondigAan({ poort: 1, platform: 'linux', bestaat: () => true, klok, log: (m) => log.push(String(m)), proces: /** @type {any} */ (proces),
      spawn: /** @type {any} */ (() => { const k = new NepKind(); kinderen.push(k); return k; }) });
    for (let i = 0; i < 20; i++) { kinderen.at(-1)?.emit('exit', 1, null); klok.loop(61000); }
    expect(kinderen).toHaveLength(MDNS_POGINGEN);
    expect(log.filter((m) => /geef ik het op/.test(m))).toHaveLength(1);
    expect(log.at(-1)).toMatch(/avahi-daemon/);
    expect(proces.listenerCount('exit')).toBe(0);
  });

  it('liep het kindproces een tijd goed, dan telt een latere crash weer als de eerste', () => {
    const klok = new NepKlok();
    const kinderen = /** @type {NepKind[]} */ ([]);
    const r = kondigAan({ poort: 1, platform: 'linux', bestaat: () => true, klok, log: () => {}, proces: /** @type {any} */ (new EventEmitter()),
      spawn: /** @type {any} */ (() => { const k = new NepKind(); kinderen.push(k); return k; }) });
    for (let i = 0; i < 10; i++) { klok.loop(61000); kinderen.at(-1)?.emit('exit', 1, null); klok.loop(5000); }
    expect(kinderen).toHaveLength(11);
    r.stop();
  });

  it('inPad vindt uitvoerbare programma\'s in PATH', () => {
    const bin = join(home, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'dns-sd'), '#!/bin/sh\n', { mode: 0o755 });
    writeFileSync(join(bin, 'niet-uitvoerbaar'), '', { mode: 0o644 });
    expect(inPad('dns-sd', `/bestaat/niet:${bin}`)).toBe(true);
    expect(inPad('niet-uitvoerbaar', bin)).toBe(false);
    expect(inPad('avahi-publish', bin)).toBe(false);
  });
});

describe('dienst: launchd en systemd --user', () => {
  const hubMap = '/Users/Clay Krebbers/code/av-app-hub & co';
  const node = '/opt/homebrew/bin/node';

  it('launchd: ~/Library/LaunchAgents/nl.varve.hub.plist met KeepAlive, log en het pad van deze checkout', () => {
    const d = dienstVoor({ platform: 'darwin', home, hubMap, node });
    expect(d.soort).toBe('launchd');
    expect(d.pad).toBe(join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`));
    expect(d.inhoud).toMatch(/<key>Label<\/key>\s*<string>nl\.varve\.hub<\/string>/);
    expect(d.inhoud).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(d.inhoud).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(d.inhoud).toContain(`<string>${join(home, 'Library', 'Logs', 'varve-hub.log')}</string>`);
    expect(d.inhoud).toContain(`<string>${node}</string>`);
    expect(d.inhoud).toContain('<string>/Users/Clay Krebbers/code/av-app-hub &amp; co/src/cli.js</string>');
    expect(d.inhoud).toMatch(/<string>start<\/string>\s*<string>--lan<\/string>/);
    expect(d.inhoud).not.toMatch(/\{\{/);
    expect(d.laad).toBe(`launchctl bootstrap gui/$(id -u) ${d.pad}`);
    expect(dienstVoor({ platform: 'darwin', home: '/Users/Clay K', hubMap, node }).laad).toBe("launchctl bootstrap gui/$(id -u) '/Users/Clay K/Library/LaunchAgents/nl.varve.hub.plist'");
    expect(d.ontlaad).toBe('launchctl bootout gui/$(id -u)/nl.varve.hub');
    expect(d.laad + d.ontlaad).not.toMatch(/sudo/);
  });

  it('systemd: ~/.config/systemd/user/varve-hub.service met Restart=on-failure, paden tussen aanhalingstekens', () => {
    const d = dienstVoor({ platform: 'linux', home, hubMap: '/home/clay/av 100%', node: '/usr/bin/node', lan: false });
    expect(d.soort).toBe('systemd');
    expect(d.pad).toBe(join(home, '.config', 'systemd', 'user', SYSTEMD_NAAM));
    expect(d.inhoud).toMatch(/^Restart=on-failure$/m);
    expect(d.inhoud).toMatch(/^WantedBy=default\.target$/m);
    expect(d.inhoud).toMatch(/^ExecStart="\/usr\/bin\/node" "\/home\/clay\/av 100%%\/src\/cli\.js" "start"$/m);
    expect(d.inhoud).toMatch(/^WorkingDirectory=\/home\/clay\/av 100%%$/m);
    expect(d.laad).toBe('systemctl --user daemon-reload && systemctl --user enable --now varve-hub.service');
    expect(d.laad + d.ontlaad).not.toMatch(/sudo/);
  });

  it('een pad met $, & en een spatie: het dienstbestand blijft heel (geen vervangpatronen, systemd vult $ niet in)', () => {
    for (const map of ['/x/geld$&werk', '/x/geld$`x', "/x/geld$'x", '/x/a$$b & c $HOME']) {
      const mac = dienstVoor({ platform: 'darwin', home, hubMap: map, node });
      const xml = map.replace(/&/g, '&amp;');
      expect(mac.inhoud).toContain(`<key>WorkingDirectory</key>\n  <string>${xml}</string>`);
      expect(mac.inhoud).toContain(`<string>${xml}/src/cli.js</string>`);
      expect(mac.inhoud.match(/<plist/g)).toHaveLength(1);
      const lin = dienstVoor({ platform: 'linux', home, hubMap: map, node: '/usr/bin/node' });
      expect(lin.inhoud).toMatch(/^\[Unit\]$/m);
      expect(lin.inhoud.match(/^ExecStart=/gm)).toHaveLength(1);
      expect(lin.inhoud.match(/^WorkingDirectory=/gm)).toHaveLength(1);
      expect(lin.inhoud).toContain(`WorkingDirectory=${map}\n`);
      expect(lin.inhoud).toContain(`ExecStart="/usr/bin/node" "${map.replace(/\$/g, '$$$$')}/src/cli.js" "start" "--lan"\n`);
    }
  });

  it('node: het pad zoals de shell het vindt (symlink in PATH), niet het opgeloste Cellar-/nvm-pad', () => {
    const cellar = join(home, 'Cellar', 'node', '22.9.0', 'bin');
    const bin = join(home, 'homebrew', 'bin');
    mkdirSync(cellar, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(cellar, 'node'), '#!/bin/sh\n', { mode: 0o755 });
    symlinkSync(join(cellar, 'node'), join(bin, 'node'));
    const PATH = `relatief/bin:/bestaat/niet:${bin}`;
    expect(stabielNode({ PATH, execPath: join(cellar, 'node') })).toBe(join(bin, 'node'));
    expect(stabielNode({ PATH: '/bestaat/niet', execPath: '/x/node' })).toBe('/x/node');
    const d = dienstVoor({ platform: 'linux', home, hubMap: '/h', PATH });
    expect(d.node).toBe(join(bin, 'node'));
    expect(d.inhoud).toContain(`ExecStart="${join(bin, 'node')}"`);
  });

  it('installeer waarschuwt bij een node in een versiemap en zegt: na een node-update opnieuw installeren', () => {
    const nvm = installeer({ platform: 'darwin', home, hubMap: HUB, node: '/Users/clay/.nvm/versions/node/v22.9.0/bin/node', uid: 501 }).regels.join('\n');
    expect(nvm).toMatch(/versiemap/);
    expect(nvm).toMatch(/node src\/cli\.js installeer opnieuw/);
    expect(nvm).toMatch(/node src\/cli\.js installeer --weg/);
    expect(nvm).not.toMatch(/varve-hub installeer/);                  // zonder npm link bestaat `varve-hub` niet
    const brew = installeer({ platform: 'darwin', home, hubMap: HUB, node: '/opt/homebrew/Cellar/node/22.9.0/bin/node', uid: 501 }).regels.join('\n');
    expect(brew).toMatch(/versiemap/);
    expect(installeer({ platform: 'darwin', home, hubMap: HUB, node, uid: 501 }).regels.join('\n')).not.toMatch(/versiemap/);
  });

  it('systemd: geen eindeloze herstart bij een vaste fout (3 poort bezet, 4 geen token); geen systeemtargets', () => {
    const d = dienstVoor({ platform: 'linux', home, hubMap: '/h', node: '/usr/bin/node' });
    expect(d.inhoud).toMatch(/^RestartPreventExitStatus=3 4$/m);
    expect(d.inhoud).not.toMatch(/^(After|Wants)=.*(network-online|sound)\.target/m);
    const mac = dienstVoor({ platform: 'darwin', home, hubMap: '/h', node });
    expect(mac.inhoud).toMatch(/<key>VARVE_HUB_DIENST<\/key>\s*<string>launchd<\/string>/);
  });

  it('andere platforms: een duidelijke fout', () => {
    expect(() => dienstVoor({ platform: 'win32', home, hubMap })).toThrow(/geen dienst voor platform win32/);
  });

  it('installeer schrijft het bestand en zegt welke regel te draaien; nog eens = bijwerken', () => {
    const r = installeer({ platform: 'darwin', home, hubMap: HUB, node, uid: 501 });
    expect(existsSync(r.pad)).toBe(true);
    expect(readFileSync(r.pad, 'utf8')).toContain(join(HUB, 'src', 'cli.js'));
    expect(existsSync(join(home, 'Library', 'Logs'))).toBe(true);
    expect(r.regels.join('\n')).toMatch(/Geschreven: .*nl\.varve\.hub\.plist/);
    expect(r.regels.join('\n')).toMatch(/launchctl bootstrap gui\/\$\(id -u\)/);
    const nog = installeer({ platform: 'darwin', home, hubMap: HUB, node, uid: 501 });
    expect(nog.regels.join('\n')).toMatch(/Bijgewerkt[\s\S]*launchctl bootout[\s\S]*launchctl bootstrap/);
  });

  it('installeer --weg haalt het bestand (en de enable-koppeling van systemd) weg en zegt hoe te stoppen', () => {
    const r = installeer({ platform: 'linux', home, hubMap: HUB, node, uid: 1000 });
    const wants = join(home, '.config', 'systemd', 'user', 'default.target.wants');
    mkdirSync(wants, { recursive: true });
    writeFileSync(join(wants, SYSTEMD_NAAM), '');           // wat `systemctl --user enable` zou aanleggen
    const weg = installeer({ platform: 'linux', home, hubMap: HUB, node, uid: 1000, weg: true });
    expect(existsSync(r.pad)).toBe(false);
    expect(existsSync(join(wants, SYSTEMD_NAAM))).toBe(false);
    expect(weg.regels.join('\n')).toMatch(/Weggehaald[\s\S]*systemctl --user stop varve-hub\.service/);
    const nogEens = installeer({ platform: 'linux', home, hubMap: HUB, node, uid: 1000, weg: true });
    expect(nogEens.regels[0]).toMatch(/Er stond geen systemd-dienst/);
  });

  it('nooit als root (sudo)', () => {
    expect(() => installeer({ platform: 'linux', home, hubMap: HUB, uid: 0 })).toThrow(/niet als root of met sudo/);
    expect(existsSync(join(home, '.config'))).toBe(false);
  });

  it('de sjablonen in deploy/ en het installeerscript bestaan; het script gebruikt nooit sudo', () => {
    for (const f of ['nl.varve.hub.plist', 'varve-hub.service', 'installeer.sh']) expect(existsSync(join(HUB, 'deploy', f)), f).toBe(true);
    const sh = readFileSync(join(HUB, 'deploy', 'installeer.sh'), 'utf8');
    expect(sh).toMatch(/cli\.js" installeer --node "\$\(command -v node\)" "\$@"/);
    expect(sh.split('\n').filter((r) => !r.trim().startsWith('#') && !/echo/.test(r)).join('\n')).not.toMatch(/\bsudo\b/);
    expect(mode(join(HUB, 'deploy', 'installeer.sh')) & 0o111).not.toBe(0);
  });
});
