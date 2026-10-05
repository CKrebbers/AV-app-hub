// @ts-check
// docs/VOLGENDE-KOPPELINGEN.md is een onderzoek, maar wel een controleerbaar: elk manifest-voorstel moet
// slagen voor het protocol (PROTOCOL.md §4), elk project heeft dezelfde zeven onderdelen, en elke verwijzing
// naar een bestand van de hub (`pad:regel`) bestaat, en de dragende verwijzingen staan op de regel die ze noemen.
// Verwijzingen naar Clay's andere repo's worden alleen gecontroleerd als dat repo op deze computer staat
// (sets/paden.json, anders /home/user/<repo>); anders staan ze als "skipped".
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { valideerManifest } from '../src/protocol/manifest.js';
import { scheidStatisch, valideerStatisch } from '../src/drivers/index.js';
import { laadPaden, thuisPad } from '../src/sets/set.js';

const DOC = 'docs/VOLGENDE-KOPPELINGEN.md';
const hubPad = (/** @type {string} */ p) => new URL(`../${p}`, import.meta.url);
const tekst = existsSync(hubPad(DOC)) ? readFileSync(hubPad(DOC), 'utf8') : '';

/** Alle ```json-blokken, met het toets-label erboven (`<!-- toets: manifest|statisch|aanvulling -->`) als dat er staat. */
function jsonBlokken() {
  /** @type {{ toets: string|null, bron: string }[]} */
  const uit = [];
  for (const m of tekst.matchAll(/(?:<!--\s*toets:\s*([\w-]+)\s*-->\s*\n)?```json\n([\s\S]*?)\n```/g)) uit.push({ toets: m[1] ?? null, bron: m[2] });
  return uit;
}

/**
 * Een aanvulling (`params+`, `driver.map+`, `driver.presets+`) toepassen op een manifest. Wat er al in staat
 * (zelfde param-id, zelfde preset-noot: het voorstel is intussen gebouwd, golf 6) wordt niet nog eens toegevoegd.
 * @param {any} basis @param {any} a
 */
function pasAanvullingToe(basis, a) {
  const m = structuredClone(basis);
  const ids = new Set(m.params.map((/** @type {any} */ p) => p.id));
  m.params = [...m.params, ...(a['params+'] ?? []).filter((/** @type {any} */ p) => !ids.has(p.id))];
  m.driver.map = { ...m.driver.map, ...(a['driver.map+'] ?? {}) };
  const noten = new Set((m.driver.presets ?? []).map((/** @type {any} */ p) => p.noot));
  if (a['driver.presets+']) m.driver.presets = [...(m.driver.presets ?? []), ...a['driver.presets+'].filter((/** @type {any} */ p) => !noten.has(p.noot))];
  return m;
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

  it('elke aanvulling (toets: aanvulling) op een bestaand apps/<app>.json slaagt daarna voor valideerStatisch', () => {
    const aanvullingen = jsonBlokken().filter((b) => b.toets === 'aanvulling').map((b) => JSON.parse(b.bron));
    expect(aanvullingen.map((a) => a.app).sort()).toEqual(['av-scene-kit', 'sediment']);
    for (const a of aanvullingen) {
      const nu = JSON.parse(readFileSync(hubPad(`apps/${a.app}.json`), 'utf8'));
      const r = valideerStatisch(pasAanvullingToe(nu, a));
      expect(r.ok ? [] : r.fouten, a.app).toEqual([]);
      expect(a['params+'].map((/** @type {any} */ p) => p.id), a.app).toContain('paniek');
    }
  });

  it('het uurwerk-voorstel is precies het huidige apps/uurwerk.json plus master_terug en paniek', () => {
    // Sinds golf 6 staan master_terug en paniek in apps/uurwerk.json zelf: het voorstel moet nu precies het bestand
    // zijn, ook in naam, groep en volgorde van die twee (een afwijking valt dan op).
    const nu = JSON.parse(readFileSync(hubPad('apps/uurwerk.json'), 'utf8'));
    const voorstel = jsonBlokken().map((b) => JSON.parse(b.bron)).find((x) => x.app === 'uurwerk');
    expect(voorstel).toBeDefined();
    // geen ongemerkte wijzigingen (slew_s, max_hz): lagen in uurwerk ontstaan per seconde, dat los je niet in de hub op
    expect(voorstel.params).toEqual(nu.params);
    expect(voorstel.params.slice(-2).map((/** @type {any} */ p) => p.id)).toEqual(['master_terug', 'paniek']);
    const { verbs: _v, _bron: _b, ...rest } = voorstel.driver, { verbs: _n, _bron: _bn, ...restNu } = nu.driver;
    expect(rest).toEqual(restNu);
    expect(voorstel.driver.verbs).toEqual(nu.driver.verbs);
    expect(voorstel.params.find((/** @type {any} */ p) => p.id === 'paniek')?.soort).toBe('trigger');
  });

  it('uurwerk-paniek wacht niet: meet_seconden geeft volgens uurwerk/brug.js:61 nul seconden (anders > POST_TIMEOUT_MS)', () => {
    const voorstel = jsonBlokken().map((b) => JSON.parse(b.bron)).find((x) => x.app === 'uurwerk');
    // uurwerk/brug.js:61 — gecontroleerd in de claims hieronder
    const wachtS = (/** @type {unknown} */ m) => Math.max(0, Math.min(15, Number(m) || 2.5));
    for (const id of ['paniek', 'master_terug']) {
      const v = voorstel.driver.verbs[id];
      expect(v.verb, id).toBe('pas_toe');
      expect(wachtS(v.args.meet_seconden), `${id}: meet_seconden ${v.args.meet_seconden}`).toBe(0);
    }
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
    // de HUD ligt over het beeld (td-lab/scripts/genesis.py:362-365): zonder hud 0 blijft er tekst op zwart
    expect(td.driver.paniek.hud).toBe(0);
  });

  it('elke verwijzing naar een hub-bestand (`pad:regel`) bestaat en heeft die regel (vangnet)', () => {
    const refs = [...tekst.matchAll(/`((?:src|apps|test|tools|docs|sets)\/[\w./-]+|config\.json|PROTOCOL\.md|STATUS\.md|IDEEEN\.md|ONDERZOEK\.md):(\d+)(?:[-,](\d+))*`/g)];
    expect(refs.length).toBeGreaterThan(10);
    for (const [, pad, regel] of refs) {
      expect(existsSync(hubPad(pad)), pad).toBe(true);
      const n = readFileSync(hubPad(pad), 'utf8').split('\n').length;
      expect(Number(regel), `${pad}:${regel}`).toBeLessThanOrEqual(n);
    }
  });

  // De dragende hub-verwijzingen op inhoud: draait ook in CI.
  /** @type {{ pad: string, regel: number, bevat: string }[]} */
  const hubClaims = [
    { pad: 'src/core/kern.js', regel: 858, bevat: '#paniek(' },
    { pad: 'src/core/kern.js', regel: 768, bevat: "'stopall'" },
    { pad: 'src/drivers/midi.js', regel: 156, bevat: '#uit(a)' },
    { pad: 'src/drivers/midi.js', regel: 206, bevat: '#meldPreset' },
    { pad: 'src/drivers/midi.js', regel: 230, bevat: 'globaal' },
    { pad: 'src/drivers/http.js', regel: 25, bevat: 'POST_TIMEOUT_MS = 2000' },
    { pad: 'src/drivers/http.js', regel: 75, bevat: 'huisregel 6' },
    { pad: 'src/drivers/http.js', regel: 151, bevat: 'r.ok === false' },
    { pad: 'src/drivers/http.js', regel: 168, bevat: '#zet(' },
    { pad: 'src/drivers/http.js', regel: 198, bevat: 'alleen bij indrukken' },
    { pad: 'src/drivers/http.js', regel: 206, bevat: 'globaal' },
    { pad: 'src/drivers/http.js', regel: 236, bevat: 'tabs === 0' },
    { pad: 'src/drivers/index.js', regel: 28, bevat: 'DRIVER_SOORTEN' },
    { pad: 'src/doctor.js', regel: 99, bevat: "'osc'" },
    { pad: 'src/transports/server.js', regel: 88, bevat: 'originToegestaan' },
    { pad: 'tools/genereer-manifesten.mjs', regel: 122, bevat: 'VERBODEN_CC = [0, 1, 7, 10, 11, 32, 64, 120, 121, 122, 123' },
    { pad: 'test/drivers.test.js', regel: 389, bevat: 'alle 22 parameters op eigen CC' },
    { pad: 'test/drivers.test.js', regel: 753, bevat: 'actueel t.o.v. de bronnen' },
    // golf 6: de td-lab-driver is gebouwd (src/drivers/td.js); §6.2/§6.5 zeggen dat nu ook
    { pad: 'PROTOCOL.md', regel: 20, bevat: 'driver** `td`' },
    { pad: 'PROTOCOL.md', regel: 21, bevat: '**bestaat niet.**' },
    { pad: 'config.json', regel: 56, bevat: '"td-lab"' },
    { pad: 'config.json', regel: 120, bevat: '"koppeling": "td"' },
  ];
  // Binnen een klein venster rond de genoemde regel: de hub verandert verder (een paar regels erbij in kern.js), en
  // een verwijzing die een paar regels verschoof klopt inhoudelijk nog. Staat het er niet meer in de buurt, dan faalt hij.
  const VENSTER = 5;
  it.each(hubClaims)('$pad:$regel bevat "$bevat"', ({ pad, regel, bevat }) => {
    const regels = readFileSync(hubPad(pad), 'utf8').split('\n');
    const buurt = regels.slice(Math.max(0, regel - 1 - VENSTER), regel + VENSTER);
    expect(buurt.some((r) => r.includes(bevat)), `${pad}:${regel} (±${VENSTER}) bevat "${bevat}"`).toBe(true);
    expect(tekst, `de doc verwijst naar ${pad}:${regel}`).toContain(`${pad}:${regel}`);
  });

  it('noemt geen OSC-transport dat niet bestaat: 7701 staat in de hub alleen in de poortcheck', () => {
    expect(tekst).toMatch(/OSC bestaat niet in de hub/);
    const doctor = readFileSync(hubPad('src/doctor.js'), 'utf8');
    expect(doctor).toMatch(/config\.poorten\.osc/);
  });
});

// Het voorgestelde herstel van het takeover-lek (§2.3), gedraaid op het codeblok uit de doc met een nep-klok en
// nep-functies (geen LIVE-bestand nodig). Het venster van 5 s mag een echte tweede skip niet weggooien.
describe('§2.3 volgZender (codeblok "toets: zender-sein")', () => {
  const blok = /<!--\s*toets:\s*zender-sein\s*-->\s*\n```js\n([\s\S]*?)\n```/.exec(tekst)?.[1] ?? '';
  const code = blok.slice(blok.indexOf('let zenderSein'));

  function opzet({ admin = false } = {}) {
    const ctx = {
      T: 1e12, timers: /** @type {{ at: number, fn: () => any }[]} */ ([]), reads: 0, row: /** @type {any} */ ({ active: false }),
      ovr: /** @type {any} */ (null), me: { isAdmin: admin },
    };
    const h = vm.createContext({ ctx });
    vm.runInContext(`
      const Date = { now: () => ctx.T };
      function setTimeout(fn, ms) { ctx.timers.push({ at: ctx.T + ms, fn }); }
      const me = ctx.me;
      const cloud = { ovrLees: async () => { ctx.reads++; return { ...ctx.row }; } };
      function applyStationOverride(p) { ctx.ovr = { station: true, albumId: p.albumId }; return true; }
      function endStationOverride() { ctx.ovr = null; }
      Object.defineProperty(globalThis, 'ovr', { get: () => ctx.ovr });
      ${code}
      ctx.volgZender = volgZender;
    `, h);
    const op = (/** @type {number} */ ms, /** @type {() => any} */ fn) => ctx.timers.push({ at: ctx.T + ms, fn });
    async function tot(/** @type {number} */ ms) {
      const eind = ctx.T + ms;
      for (;;) {
        ctx.timers.sort((a, b) => a.at - b.at);
        const t = ctx.timers[0];
        if (!t || t.at > eind) break;
        ctx.timers.shift();
        ctx.T = t.at;
        await t.fn();
      }
      ctx.T = eind;
    }
    const rij = (/** @type {string} */ album) => () => { ctx.row = { active: true, album_id: album, start_sec: 0, slot_idx: 1, set_at: new Date(ctx.T).toISOString(), by_name: 'Clay' }; };
    return { ctx, op, tot, rij };
  }

  it('het codeblok bestaat en definieert volgZender', () => {
    expect(code).toMatch(/function volgZender\(/);
  });

  it('vervalst seintje bij een inactieve rij doet niets', async () => {
    const { ctx, tot } = opzet();
    ctx.volgZender();
    await tot(10000);
    expect(ctx.ovr).toBe(null);
    expect(ctx.reads).toBe(2);
  });

  it('actieve rij → overname na 1,5 s; inactieve rij daarna → terug naar live', async () => {
    const { ctx, op, tot, rij } = opzet();
    ctx.volgZender();
    op(300, rij('B'));
    await tot(1600);
    expect(ctx.ovr?.albumId).toBe('B');
    await tot(60000);
    ctx.row = { active: false };
    ctx.volgZender();
    await tot(2000);
    expect(ctx.ovr).toBe(null);
  });

  it('de beheerder leest niets', async () => {
    const { ctx, tot } = opzet({ admin: true });
    ctx.volgZender();
    await tot(10000);
    expect(ctx.reads).toBe(0);
  });

  it('tien seintjes in 1 s → drie leesacties', async () => {
    const { ctx, op, tot } = opzet();
    for (let i = 0; i < 10; i++) op(i * 100, () => ctx.volgZender());
    await tot(20000);
    expect(ctx.reads).toBe(3);
  });

  it('tweede skip binnen 5 s, schrijfactie landt na de lezing op 5 s → de luisteraar volgt de tweede', async () => {
    const { ctx, op, tot, rij } = opzet();
    ctx.volgZender(); // skip 1, seintje t=0
    op(300, rij('B'));
    op(4800, () => ctx.volgZender()); // skip 2, seintje t=4,8 s (binnen het venster)
    op(5200, rij('C')); // de rij van skip 2 landt na de lezing op 5 s
    await tot(120000);
    expect(ctx.ovr?.albumId).toBe('C');
  });
});

// Claims over Clay's andere repo's: alleen als ze op deze computer staan (sets/paden.json, anders /home/user/<repo>,
// de cloud-werkplek). Ontbreekt een repo, dan staat de test als "skipped", niet als groen.
const paden = (() => { try { return laadPaden(); } catch { return /** @type {Record<string, string>} */ ({}); } })();
const repoMap = (/** @type {string} */ repo) => (paden[repo] ? thuisPad(paden[repo]) : join('/home/user', repo));
/** @type {{ repo: string, bestand: string, regel: number, bevat: string }[]} */
const claims = [
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1822, bevat: "channel('radio'" },
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1824, bevat: "event:'zender'},({payload})=>applyStationOverride(payload)" },
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1825, bevat: "event:'zender-uit'" },
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1923, bevat: 'pushOverride(albumId,startSec,slotIdx){' },
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1932, bevat: "event:'zender',payload" },
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1934, bevat: 'this.ovrSchrijf({active:true' },
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1915, bevat: 'refreshOverride(albumId,pos,slotIdx){' },
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1287, bevat: 'if(pendingStation)applyStationOverride(pendingStation)' },
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1190, bevat: 'STATION_OUD' },
  { repo: 'varve-radio', bestand: 'files Varve Radio/varve-radio-v2.LIVE.html', regel: 1301, bevat: 'albumById(ovr.albumId)' },
  { repo: 'varve-radio', bestand: 'files Varve Radio/tests/draai.py', regel: 12, bevat: 'constanten' },
  { repo: 'td-lab', bestand: 'bridge/td_bridge.py', regel: 137, bevat: "uri == '/ping'" },
  { repo: 'td-lab', bestand: 'bridge/td_bridge.py', regel: 124, bevat: "out['ok'] = False" },
  { repo: 'td-lab', bestand: 'bridge/td_bridge.py', regel: 146, bevat: "response['statusCode'] = 200" },
  { repo: 'td-lab', bestand: 'bridge/callbacks.py', regel: 15, bevat: 'importlib.reload(td_bridge)' },
  { repo: 'td-lab', bestand: 'bridge/callbacks.py', regel: 16, bevat: 'try:' },
  { repo: 'td-lab', bestand: 'scripts/genesis.py', regel: 79, bevat: "parentshortcut = 'Genesis'" },
  { repo: 'td-lab', bestand: 'scripts/genesis.py', regel: 362, bevat: "'hudswitch'" },
  { repo: 'td-lab', bestand: 'scripts/genesis.py', regel: 365, bevat: "index=M + 'Hud'" },
  { repo: 'td-lab', bestand: 'scripts/genesis.py', regel: 383, bevat: 'Seedamt = 1' },
  { repo: 'td-lab', bestand: 'scripts/genesis.py', regel: 101, bevat: "'Seedthresh'" },
  { repo: 'td-lab', bestand: 'brain/director.py', regel: 177, bevat: 'w.par.Feed' },
  { repo: 'uurwerk', bestand: 'uur.js', regel: 121, bevat: "S.set('density'" },
  { repo: 'uurwerk', bestand: 'uur.js', regel: 122, bevat: 'macroLicht' },
  { repo: 'uurwerk', bestand: 'uur.js', regel: 134, bevat: 'E.master.gain' },
  { repo: 'uurwerk', bestand: 'brug.js', regel: 51, bevat: 'await R().start()' },
  { repo: 'uurwerk', bestand: 'brug.js', regel: 58, bevat: 'applyText' },
  { repo: 'uurwerk', bestand: 'brug.js', regel: 61, bevat: 'Math.max(0, Math.min(15, +meet_seconden || 2.5))' },
  { repo: 'uurwerk', bestand: 'bridge/server.js', regel: 98, bevat: "'Uurwerk-brug. tabs: '" },
  { repo: 'uurwerk', bestand: 'taal.js', regel: 287, bevat: 'patch.macros.master' },
  { repo: 'uurwerk', bestand: 'taal.js', regel: 316, bevat: 'setInterval(() => this.poll(), 1000)' },
  { repo: 'uurwerk', bestand: 'taal.js', regel: 214, bevat: "toFixed(2)" },
  // golf 6: de uurwerk-paniek blijft niet staan (§3.4): wat de master terugzet op 0,8
  { repo: 'uurwerk', bestand: 'mod.js', regel: 761, bevat: "R().Taal.applyText(p.tekst, 'tuinman')" },
  { repo: 'uurwerk', bestand: 'mod.js', regel: 412, bevat: 'R().Taal.applyText(m.tekst' },
  { repo: 'uurwerk', bestand: 'uur.js', regel: 89, bevat: "Rk.Taal.applyText(opts.tekst || u.tekst, 'uur')" },
  { repo: 'uurwerk', bestand: 'nacht.js', regel: 75, bevat: 'Rk.Taal.applyText(tekstVoor' },
  { repo: 'uurwerk', bestand: 'taal.js', regel: 339, bevat: "applyText(l.voor, 'terug')" },
  // golf 6: All Notes Off laat Sediments noten los met hun eigen Release (§5.4)
  { repo: 'sediment', bestand: 'src/dsp/Voice.cpp', regel: 108, bevat: 'if (allowTailOff)' },
  { repo: 'av-scene-kit', bestand: 'td/td_build_hub.py', regel: 321, bevat: 'Hoogste waarde wint' },
  { repo: 'av-scene-kit', bestand: 'td/td_build_hub.py', regel: 837, bevat: 'if name not in seen' },
  { repo: 'av-scene-kit', bestand: 'td/td_build_hub.py', regel: 517, bevat: "'dim'" },
  { repo: 'av-scene-kit', bestand: 'td/td_build_hub.py', regel: 518, bevat: "'opacity'" },
  { repo: 'anbernic-cam', bestand: 'varve-eye/knulli/varve-eye/VarveEyeArt.py', regel: 2697, bevat: 'KNOP_ACTIES = {' },
  { repo: 'anbernic-cam', bestand: 'varve-eye/knulli/varve-eye/VarveEyeArt.py', regel: 2731, bevat: '_decor_aanuit' },
  { repo: 'anbernic-cam', bestand: 'varve-eye/knulli/varve-eye/VarveEyeArt.py', regel: 2750, bevat: '"knop-omhoog"' },
  { repo: 'anbernic-cam', bestand: 'varve-eye/knulli/varve-eye/VarveEyeArt.py', regel: 2756, bevat: '"effect-parameter"' },
  { repo: 'anbernic-cam', bestand: 'varve-eye/knulli/Varve Eye USB.sh', regel: 49, bevat: '10.42.0.2' },
  { repo: 'musicgen-video-glitch', bestand: 'src/main.py', regel: 67, bevat: 'output/generated_soundtrack.wav' },
  { repo: 'musicgen-video-glitch', bestand: 'src/main.py', regel: 90, bevat: '"--output"' },
];

describe('verwijzingen naar de andere repo\'s kloppen (alleen waar het repo staat)', () => {
  for (const { repo, bestand, regel, bevat } of claims) {
    const pad = join(repoMap(repo), bestand);
    it.skipIf(!existsSync(pad))(`${repo}/${bestand}:${regel}`, () => {
      const regels = readFileSync(pad, 'utf8').split('\n');
      expect(regels[regel - 1] ?? '', `${repo}/${bestand}:${regel}`).toContain(bevat);
      expect(tekst, `de doc verwijst naar :${regel}`).toContain(`:${regel}`);
    });
  }
});
