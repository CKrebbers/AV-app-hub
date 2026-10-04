// @ts-check
// `varve-hub start <set>` en een hub die midden in de set omvalt (kill -9): de apps die de set startte draaien
// door. Na de herstart start de set ze niet dubbel, zet de beginsnapshot niet opnieuw (dan sprong alles terug
// naar het begin van de avond) en stopt Ctrl-C ze daarna toch gewoon. Echte processen: de hub en een nep-app
// (tools/nep-app.mjs) die de set zelf start, zonder poort (dus alleen te herkennen aan zijn proces).
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startCli, ruimProcessenOp, cockpit, vrijePoort, maakMap, maakConfig, tot, wacht, HUB_MAP } from './herstart-hulp.js';
import { bestaandProces, naarLogbestand } from '../src/sets/starter.js';
import { startProces } from '../src/sets/systeem.js';
import { echteKlok } from '../src/core/klok.js';

/** @type {number[]} procesgroepen van de nep-app (alleen die van deze test) */
const groepen = [];
afterEach(async () => {
  await ruimProcessenOp();
  for (const g of groepen.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch { /* al weg */ } }
});

const groepLeeft = (/** @type {number} */ pid) => { try { process.kill(-pid, 0); return true; } catch { return false; } };

describe('set-starter na een herstart van de hub', () => {
  it('start een app die nog draait niet dubbel, slaat de beginsnapshot over, en Ctrl-C stopt hem daarna toch', async () => {
    const map = maakMap();
    const config = maakConfig(map, { apps: { 'nep-a': { naam: 'Nep A', kleur: '#ff00ff', repo: 'hub' } } });
    const paden = join(map, 'paden.json');
    writeFileSync(paden, JSON.stringify({ hub: HUB_MAP }));
    const setPad = join(map, 'herstartproef.json');
    writeFileSync(setPad, JSON.stringify({
      naam: 'Herstartproef',
      apps: { 'nep-a': { start: { commando: `${JSON.stringify(process.execPath)} tools/nep-app.mjs --url {hub} --app nep-a` }, time_out_s: 20 } },
      snapshot: { 'nep-a': { helder: 0.2 } },
      focus: 'nep-a',
    }));
    const staat = join(map, 'staat.json');
    const poort = await vrijePoort();
    const args = ['start', setPad, '--zonder-midi', '--geen-drivers', '--zonder-chrome', '--poort', String(poort)];
    const env = { VARVE_HUB_PADEN: paden };
    const klaar = /Set "Herstartproef": 1\/1 klaar/;

    const hub1 = await startCli({ args, staat, config, env, klaar, ms: 25000 });
    expect(hub1.uitvoer()).toMatch(/nep-a: start "/);
    const pid = JSON.parse(readFileSync(`${staat}.loopt`, 'utf8')).apps['nep-a'];
    expect(Number.isInteger(pid)).toBe(true);
    groepen.push(pid);
    let c = await cockpit(poort);
    const helder = () => c.beeld.apps.find((/** @type {any} */ a) => a.app === 'nep-a')?.waarden.helder;
    await tot(() => helder() === 0.2);                     // de beginsnapshot
    c.stuur({ t: 'zet', app: 'nep-a', id: 'helder', v: 0.9 });   // daarna speelt Clay
    await tot(() => helder() === 0.9);
    c.sluit();

    hub1.sein('SIGKILL');
    await hub1.einde;
    expect(groepLeeft(pid)).toBe(true);                    // de app draait door

    const hub2 = await startCli({ args, staat, config, env, klaar, ms: 25000 });
    const uit = hub2.uitvoer();
    expect(uit).toMatch(/De vorige hub stopte niet netjes/);
    expect(uit).toMatch(new RegExp(`nep-a: draait nog sinds vóór de herstart van de hub \\(proces ${pid}\\) — niet opnieuw gestart`));
    expect(uit).not.toMatch(/nep-a: start "/);
    expect(uit).toMatch(/snapshot nep-a: overgeslagen \(draaide al/);
    c = await cockpit(poort);
    await tot(() => c.beeld.apps.find((/** @type {any} */ a) => a.app === 'nep-a')?.status === 'actief');
    await wacht(300);
    expect(helder()).toBe(0.9);                            // de stand van Clay, niet die van het begin van de avond
    expect(c.beeld.focus).toBe('nep-a');
    // Het loopbestand kent het overgenomen proces (voor nog een herstart).
    expect(JSON.parse(readFileSync(`${staat}.loopt`, 'utf8')).apps['nep-a']).toBe(pid);

    hub2.sein('SIGINT');
    expect((await hub2.einde).code).toBe(0);
    expect(await tot(() => !groepLeeft(pid), 5000)).toBe(true);
    expect(existsSync(`${staat}.loopt`)).toBe(false);
  }, 60000);

  it('bestaandProces: leeft zolang de groep bestaat, stuurt het sein naar de hele groep, en na leeg nooit meer', () => {
    /** @type {[number, string|number][]} */
    const seinen = [];
    let levend = true;
    const p = bestaandProces(4321, { kill: (pid, sein) => { seinen.push([pid, sein]); if (!levend) throw Object.assign(new Error('weg'), { code: 'ESRCH' }); }, groep: () => true });
    expect(p.leeft()).toBe(true);
    p.stop('SIGTERM');
    expect(seinen).toContainEqual([-4321, 'SIGTERM']);
    levend = false;
    expect(p.leeft()).toBe(false);
    levend = true;                                         // het nummer is hergebruikt: niet meer aankomen
    seinen.length = 0;
    p.stop('SIGKILL');
    expect(seinen).toEqual([]);
  });

  it('naarLogbestand: de uitvoer gaat naar <map>/<app>.log en komt toch bij de starter aan (staart, einde)', async () => {
    const map = join(maakMap(), 'uitvoer');
    const start = naarLogbestand({ startProces, pad: join(map, 'proef-app.log'), klok: echteKlok, tikMs: 20 });
    const p = start({ commando: 'echo hallo; echo "op stderr" >&2; exit 3', cwd: HUB_MAP, omgeving: {} });
    let uit = '';
    p.bij('uitvoer', (t) => { uit += t; });
    const einde = await new Promise((r) => p.bij('einde', r));
    expect(einde).toMatchObject({ code: 3 });
    expect(uit).toBe('hallo\nop stderr\n');
    expect(readFileSync(join(map, 'proef-app.log'), 'utf8')).toBe('hallo\nop stderr\n');
    await tot(() => !p.leeft());
  });
});
