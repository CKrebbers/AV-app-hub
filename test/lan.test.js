// src/lan.js: token op schijf, LAN-namen, mDNS als kindproces (nep-spawn + NepKlok), launchd/systemd-dienst.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NepKlok } from '../src/core/klok.js';
import {
  leesOfMaakToken, tokenPad, nieuwToken, isLoopbackHost, lanNamen, lanOrigins, lanAdressen, cockpitAdressen,
  mdnsCommando, kondigAan, inPad, dienstVoor, installeer, MDNS_TYPE, LAUNCHD_LABEL, SYSTEMD_NAAM,
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
    expect(sh).toMatch(/cli\.js" installeer "\$@"/);
    expect(sh.split('\n').filter((r) => !r.trim().startsWith('#') && !/echo/.test(r)).join('\n')).not.toMatch(/\bsudo\b/);
    expect(mode(join(HUB, 'deploy', 'installeer.sh')) & 0o111).not.toBe(0);
  });
});
