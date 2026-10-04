// @ts-check
// docs/VOLGENDE-KOPPELINGEN.md is een onderzoek, maar wel een controleerbaar: elk manifest-voorstel moet
// slagen voor het protocol (PROTOCOL.md §4), elk project heeft dezelfde zeven onderdelen, en elke verwijzing
// naar een bestand van de hub (`pad:regel`) bestaat. Verwijzingen naar Clay's andere repo's worden alleen
// gecontroleerd als dat repo naast de hub staat (lokaal; in CI niet).
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { valideerManifest } from '../src/protocol/manifest.js';
import { scheidStatisch, valideerStatisch } from '../src/drivers/index.js';

const DOC = 'docs/VOLGENDE-KOPPELINGEN.md';
const hubPad = (/** @type {string} */ p) => new URL(`../${p}`, import.meta.url);
const tekst = existsSync(hubPad(DOC)) ? readFileSync(hubPad(DOC), 'utf8') : '';

/** Alle ```json-blokken, met het toets-label erboven (`<!-- toets: manifest|statisch -->`) als dat er staat. */
function jsonBlokken() {
  /** @type {{ toets: string|null, bron: string }[]} */
  const uit = [];
  for (const m of tekst.matchAll(/(?:<!--\s*toets:\s*(\w+)\s*-->\s*\n)?```json\n([\s\S]*?)\n```/g)) uit.push({ toets: m[1] ?? null, bron: m[2] });
  return uit;
}

/** Een sectie `## n. <naam>` tot de volgende `## `. @param {string} naam */
function sectie(naam) {
  const kop = new RegExp(`^## \\d+\\. ${naam}\\b.*$`, 'm');
  const m = kop.exec(tekst);
  if (!m) return '';
  const rest = tekst.slice(m.index + m[0].length);
  const eind = rest.search(/^## /m);
  return eind < 0 ? rest : rest.slice(0, eind);
}

describe('docs/VOLGENDE-KOPPELINGEN.md', () => {
  it('bestaat', () => {
    expect(tekst.length).toBeGreaterThan(1000);
  });

  const projecten = ['varve-radio', 'uurwerk', 'av-scene-kit', 'sediment', 'td-lab', 'anbernic-cam', 'musicgen-video-glitch'];
  it.each(projecten)('%s heeft een eigen sectie met wat het is, hub-stand, koppelvorm, regels, werk en open vragen', (p) => {
    const s = sectie(p);
    expect(s, `geen sectie "## n. ${p}"`).not.toBe('');
    for (const onderdeel of [/### \d+\.1 Wat het is/, /### \d+\.2 Huidige hub-stand/, /### \d+\.\d+ Beste koppelvorm/, /### \d+\.\d+ Regels/, /### \d+\.\d+ Werk en risico/, /### \d+\.\d+ Open vragen voor Clay/]) {
      expect(s, `${p}: ${onderdeel}`).toMatch(onderdeel);
    }
  });

  it('eindigt met een voorgestelde volgorde', () => {
    expect(sectie('Voorgestelde volgorde')).toMatch(/\| 1 \|/);
  });

  it('alle json-blokken zijn geldige JSON', () => {
    const blokken = jsonBlokken();
    expect(blokken.length).toBeGreaterThanOrEqual(6);
    for (const b of blokken) expect(() => JSON.parse(b.bron), b.bron.slice(0, 80)).not.toThrow();
  });

  it('elk manifest-voorstel (toets: manifest) slaagt voor het protocol (PROTOCOL.md §4)', () => {
    const voorstellen = jsonBlokken().filter((b) => b.toets === 'manifest');
    expect(voorstellen.map((b) => JSON.parse(b.bron).app)).toEqual(expect.arrayContaining(['varve-radio', 'td-lab', 'varve-eye']));
    for (const b of voorstellen) {
      const { manifest } = scheidStatisch(JSON.parse(b.bron));
      const r = valideerManifest(manifest);
      expect(r.ok ? [] : r.fouten, manifest.app).toEqual([]);
    }
  });

  it('elk voorstel voor een bestaande driver (toets: statisch) slaagt voor valideerStatisch', () => {
    const voorstellen = jsonBlokken().filter((b) => b.toets === 'statisch');
    expect(voorstellen.length).toBeGreaterThanOrEqual(1);
    for (const b of voorstellen) {
      const r = valideerStatisch(JSON.parse(b.bron));
      expect(r.ok ? [] : r.fouten).toEqual([]);
    }
  });

  it('het uurwerk-voorstel is het huidige apps/uurwerk.json plus paniek, niets kwijt', () => {
    const nu = JSON.parse(readFileSync(hubPad('apps/uurwerk.json'), 'utf8'));
    const voorstel = jsonBlokken().map((b) => JSON.parse(b.bron)).find((x) => x.app === 'uurwerk');
    expect(voorstel).toBeDefined();
    for (const p of nu.params) expect(voorstel.params.map((/** @type {any} */ q) => q.id)).toContain(p.id);
    for (const [id, v] of Object.entries(nu.driver.verbs)) expect(voorstel.driver.verbs[id], id).toEqual(v);
    expect(voorstel.params.find((/** @type {any} */ p) => p.id === 'paniek')?.soort).toBe('trigger');
  });

  it('elke td-lab-parameter heeft een TD-parameter, en de standaard is de TD-standaard op 0..1', () => {
    const td = jsonBlokken().map((b) => JSON.parse(b.bron)).find((x) => x.app === 'td-lab');
    for (const p of td.params) {
      if (p.id === 'paniek') continue;
      const d = td.driver.pars[p.id];
      expect(d, p.id).toBeDefined();
      expect(d.par ?? d.puls, p.id).toMatch(/^[A-Z][A-Za-z0-9]*$/);
      if (p.soort === 'waarde' && p.min !== undefined) expect(d.bereik, p.id).toEqual([p.min, p.max]);
    }
    for (const id of Object.keys(td.driver.paniek)) expect(td.params.map((/** @type {any} */ p) => p.id)).toContain(id);
  });

  it('elke verwijzing naar een hub-bestand (`pad:regel`) bestaat en heeft die regel', () => {
    const refs = [...tekst.matchAll(/`((?:src|apps|test|tools|docs|sets)\/[\w./-]+|config\.json|PROTOCOL\.md|STATUS\.md|IDEEEN\.md|ONDERZOEK\.md):(\d+)(?:[-,](\d+))*`/g)];
    expect(refs.length).toBeGreaterThan(10);
    for (const [, pad, regel] of refs) {
      expect(existsSync(hubPad(pad)), pad).toBe(true);
      const n = readFileSync(hubPad(pad), 'utf8').split('\n').length;
      expect(Number(regel), `${pad}:${regel}`).toBeLessThanOrEqual(n);
    }
  });

  it('noemt geen OSC-transport dat niet bestaat: 7701 staat in de hub alleen in de poortcheck', () => {
    expect(tekst).toMatch(/OSC bestaat niet in de hub/);
    const doctor = readFileSync(hubPad('src/doctor.js'), 'utf8');
    expect(doctor).toMatch(/config\.poorten\.osc/);
  });
});

// Claims over Clay's andere repo's: alleen als ze naast de hub staan (de cloud-werkplek, of Clay's Mac met
// dezelfde indeling). Zo merkt een volgende lezer het als een regelnummer is verschoven.
const thuis = '/home/user';
/** @type {{ repo: string, bestand: string, regel: number, bevat: string }[]} */
const claims = [
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1822, bevat: "channel('radio'" },
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1824, bevat: "event:'zender'},({payload})=>applyStationOverride(payload)" },
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1825, bevat: "event:'zender-uit'" },
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1923, bevat: 'pushOverride(albumId,startSec,slotIdx){' },
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1287, bevat: 'if(pendingStation)applyStationOverride(pendingStation)' },
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1190, bevat: 'STATION_OUD' },
  { repo: 'td-lab', bestand: 'bridge/td_bridge.py', regel: 137, bevat: "uri == '/ping'" },
  { repo: 'td-lab', bestand: 'bridge/callbacks.py', regel: 15, bevat: 'importlib.reload(td_bridge)' },
  { repo: 'td-lab', bestand: 'scripts/genesis.py', regel: 79, bevat: "parentshortcut = 'Genesis'" },
  { repo: 'td-lab', bestand: 'brain/director.py', regel: 177, bevat: 'w.par.Feed' },
  { repo: 'uurwerk', bestand: 'uur.js', regel: 122, bevat: 'macroLicht' },
  { repo: 'uurwerk', bestand: 'bridge/server.js', regel: 98, bevat: "'Uurwerk-brug. tabs: '" },
  { repo: 'uurwerk', bestand: 'taal.js', regel: 287, bevat: 'patch.macros.master' },
  { repo: 'av-scene-kit', bestand: 'td/td_build_hub.py', regel: 321, bevat: 'Hoogste waarde wint' },
  { repo: 'av-scene-kit', bestand: 'td/td_build_hub.py', regel: 837, bevat: 'if name not in seen' },
  { repo: 'av-scene-kit', bestand: 'td/td_build_hub.py', regel: 518, bevat: "'opacity'" },
  { repo: 'anbernic-cam', bestand: 'varve-eye/knulli/varve-eye/VarveEyeArt.py', regel: 2697, bevat: 'KNOP_ACTIES = {' },
  { repo: 'anbernic-cam', bestand: 'varve-eye/knulli/Varve Eye USB.sh', regel: 49, bevat: '10.42.0.2' },
  { repo: 'musicgen-video-glitch', bestand: 'src/main.py', regel: 67, bevat: 'output/generated_soundtrack.wav' },
];

describe('verwijzingen naar de andere repo\'s kloppen (alleen lokaal)', () => {
  it.each(claims)('$repo/$bestand:$regel', ({ repo, bestand, regel, bevat }) => {
    const pad = `${thuis}/${repo}/${bestand}`;
    if (!existsSync(pad)) return; // repo staat er niet (CI): niets te controleren
    const regels = readFileSync(pad, 'utf8').split('\n');
    expect(regels[regel - 1] ?? '', `${repo}/${bestand}:${regel}`).toContain(bevat);
    expect(tekst, `de doc noemt ${regel}`).toContain(String(regel));
  });
});
