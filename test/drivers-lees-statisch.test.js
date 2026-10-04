// @ts-check
// De statische controle (valideerStatisch, laadStatisch; ook `varve-hub check`) controleert het teruglezen van de
// HTTP-driver (driver.lees, of STANDAARD_LEES van de app) met dezelfde code als de driver bij het starten (maakLezer):
// een fout in apps/<app>.json → driver.lees valt dan al op vóór de avond, niet pas als één logregel tijdens het spelen.
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { valideerStatisch, laadStatisch, APPS_MAP } from '../src/drivers/index.js';
import { STANDAARD_LEES, maakLezer } from '../src/drivers/http.js';

/** @param {string} naam */
const leesApp = (naam) => JSON.parse(readFileSync(join(APPS_MAP, naam), 'utf8'));

describe('statische controle van het teruglezen (driver.lees)', () => {
  it('valideerStatisch controleert het teruglezen (driver.lees) zoals de driver: dezelfde fouten, statisch', () => {
    const u = leesApp('uurwerk.json');
    expect(u.driver.lees).toBeUndefined();                       // de echte: STANDAARD_LEES.uurwerk geldt
    expect(valideerStatisch(u)).toMatchObject({ ok: true });
    expect(valideerStatisch({ ...u, driver: { ...u.driver, lees: false } })).toMatchObject({ ok: true });
    expect(valideerStatisch({ ...u, driver: { ...u.driver, lees: STANDAARD_LEES.uurwerk } })).toMatchObject({ ok: true });
    const lees = { verb: 'toon', kop: '^uurwerk', regels: { onrust: { patroon: '^tuinman onrust ([' }, bewaar: { patroon: 'x' }, bestaat_niet: { patroon: 'y' }, licht: { patroon: '^licht (\\S+)' } } };
    const r = valideerStatisch({ ...u, driver: { ...u.driver, lees } });
    expect(r.ok).toBe(false);
    const fouten = r.ok ? [] : r.fouten;
    // precies wat maakLezer (de driver, bij het starten) meldt, met driver. ervoor; de geldige regel (licht) geeft niets
    const { lezer, fouten: vanDriver } = maakLezer(lees, u, u.driver);
    expect(lezer?.regels.has('licht')).toBe(true);              // de driver zou half werken: alleen licht teruglezen
    expect(fouten).toEqual(vanDriver.map((m) => `driver.${m}`));
    expect(fouten.join('\n')).toMatch(/driver\.lees\.regels\.onrust: ongeldig patroon/);
    expect(fouten.join('\n')).toMatch(/driver\.lees\.regels\.bewaar: een trigger wordt niet teruggelezen/);
    expect(fouten.join('\n')).toMatch(/driver\.lees\.regels\.bestaat_niet: geen param met die id/);
    const r2 = valideerStatisch({ ...u, driver: { ...u.driver, lees: 'ja' } });
    expect(r2.ok ? [] : r2.fouten).toEqual(['driver.lees moet een object zijn (of false)']);
    const r3 = valideerStatisch({ ...u, driver: { ...u.driver, lees: { verb: 'toon zo', regels: {} } } });
    expect(r3.ok ? [] : r3.fouten).toEqual(['driver.lees.verb moet een werkwoord zijn (letters, cijfers, _)']);
  });

  it('zonder driver.lees: STANDAARD_LEES van de app moet bij de params passen (een hernoemde param valt statisch op)', () => {
    const u = leesApp('uurwerk.json');
    const params = u.params.map((/** @type {any} */ p) => (p.id === 'dicht' ? { ...p, id: 'dichtheid' } : p));
    const { dicht, ...verbs } = u.driver.verbs;
    const r = valideerStatisch({ ...u, params, driver: { ...u.driver, verbs: { ...verbs, dichtheid: dicht } } });
    expect(r.ok ? [] : r.fouten).toEqual([expect.stringMatching(/^teruglezen \(STANDAARD_LEES\.uurwerk in src\/drivers\/http\.js; .*\): lees\.regels\.dicht: geen param met die id$/)]);
    // een andere app zonder lees en zonder standaard: geen teruglezen, geen fout
    expect(valideerStatisch({ ...u, app: 'constructor', driver: { ...u.driver } })).toMatchObject({ ok: true });
  });

  it('een kapotte lees-spec in een apps-map: laadStatisch slaat het bestand over met een leesbare melding', () => {
    const map = mkdtempSync(join(tmpdir(), 'apps-lees-'));
    try {
      const u = leesApp('uurwerk.json');
      writeFileSync(join(map, 'uurwerk.json'), JSON.stringify({ ...u, driver: { ...u.driver, lees: { verb: 'toon', regels: { onrust: { patroon: '(' } } } } }));
      const r = laadStatisch(map);
      expect(r.statisch).toEqual([]);
      expect(r.fouten).toEqual([{ bestand: 'uurwerk.json', fouten: [expect.stringMatching(/^driver\.lees\.regels\.onrust: ongeldig patroon \(.+\)$/), 'driver.lees: geen geldige regels'] }]);
    } finally { rmSync(map, { recursive: true, force: true }); }
  });

});
