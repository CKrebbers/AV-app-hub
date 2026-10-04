// @ts-check
// De hub valt om door een fout in zijn eigen code (uncaught exception, of een promise die niemand afvangt), midden in
// een set. Dat is het omvallen waar `--blijf` voor is: de apps van de set moeten doorspelen, net als bij kill -9, en
// de volgende start neemt ze over (niet dubbel, geen beginsnapshot). Echte processen: de hub met een `--import`-module
// (test/herstart-gooi.mjs) die op ons teken gooit, en een nep-app die de set zelf start.
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startCli, startHubProces, ruimProcessenOp, cockpit, vrijePoort, maakMap, nepSet, groepLeeft, tot, wacht } from './herstart-hulp.js';

/** @type {number[]} procesgroepen van de nep-app (alleen die van deze test) */
const groepen = [];
afterEach(async () => {
  for (const g of groepen.splice(0)) { try { process.kill(-g, 'SIGKILL'); } catch { /* al weg */ } }
  await ruimProcessenOp();
});

const GOOI = join(import.meta.dirname, 'herstart-gooi.mjs');

/** Env waarmee de hub op ons teken gooit. @param {string} merk @param {'throw'|'reject'} [hoe] */
const gooiEnv = (merk, hoe = 'throw') => {
  writeFileSync(merk, '');
  return { NODE_OPTIONS: `--import ${JSON.stringify(GOOI)}`, VARVE_TEST_GOOI: merk, VARVE_TEST_GOOI_HOE: hoe };
};

describe('de hub valt om door een fout (geen kill -9)', () => {
  it('de apps van de set spelen door; de herstart neemt ze over, zonder ze dubbel te starten of terug te zetten', async () => {
    const map = maakMap();
    const poort = await vrijePoort();
    const s = nepSet(map, poort);
    const merk = join(map, 'gooi');
    const env = { ...s.env, ...gooiEnv(merk) };

    const hub1 = await startCli({ args: s.args, staat: s.staat, config: s.config, env, klaar: s.klaar, ms: 25000 });
    const pid = JSON.parse(readFileSync(`${s.staat}.loopt`, 'utf8')).apps['nep-a'];
    groepen.push(pid);
    let c = await cockpit(poort);
    const helder = () => c.beeld.apps.find((/** @type {any} */ a) => a.app === 'nep-a')?.waarden.helder;
    await tot(() => helder() === 0.2);                     // de beginsnapshot
    c.stuur({ t: 'zet', app: 'nep-a', id: 'helder', v: 0.9 });
    await tot(() => helder() === 0.9);
    c.sluit();

    writeFileSync(`${merk}.nu`, '');                       // nu gooit de hub
    const e = await hub1.einde;
    expect(e.code).toBe(1);
    await wacht(500);
    expect(groepLeeft(pid)).toBe(true);                    // de app speelt door (geen SIGTERM uit het exit-vangnet)
    expect(existsSync(`${s.staat}.loopt`)).toBe(true);     // de volgende start weet dat de hub omviel
    expect(hub1.uitvoer()).toMatch(/De hub viel om door een fout: Error: proef: een fout in de hub/);

    const hub2 = await startCli({ args: s.args, staat: s.staat, config: s.config, env, klaar: s.klaar, ms: 25000 });
    const uit = hub2.uitvoer();
    expect(uit).toMatch(/De vorige hub stopte niet netjes/);
    expect(uit).toMatch(new RegExp(`nep-a: draait nog sinds vóór de herstart van de hub \\(proces ${pid}\\) — niet opnieuw gestart`));
    expect(uit).not.toMatch(/nep-a: start "/);
    expect(uit).toMatch(/snapshot nep-a: overgeslagen \(draaide al/);
    c = await cockpit(poort);
    await tot(() => c.beeld.apps.find((/** @type {any} */ a) => a.app === 'nep-a')?.status === 'actief');
    await wacht(300);
    expect(helder()).toBe(0.9);                            // de stand van Clay, niet die van het begin van de avond
    hub2.sein('SIGINT');
    expect((await hub2.einde).code).toBe(0);
    expect(await tot(() => !groepLeeft(pid), 5000)).toBe(true);
  }, 60000);

  it('een promise die niemand afvangt: ook dan blijft het loopbestand staan en weet de volgende start dat de hub omviel', async () => {
    const map = maakMap();
    const poort = await vrijePoort();
    const staat = join(map, 'staat.json');
    const merk = join(map, 'gooi');
    const env = gooiEnv(merk, 'reject');
    const hub1 = await startHubProces({ poort, staat, env });
    writeFileSync(`${merk}.nu`, '');
    expect((await hub1.einde).code).toBe(1);
    expect(existsSync(`${staat}.loopt`)).toBe(true);
    const hub2 = await startHubProces({ poort, staat, env });
    await hub2.wachtOp(/De vorige hub stopte niet netjes/);
    expect(hub1.uitvoer()).toMatch(/De hub viel om door een fout: Error: proef: een afgewezen promise/);
  }, 30000);
});
