// @ts-check
// De hub valt midden in de set om (kill -9) en komt terug: met echte processen (node src/cli.js start) en echte
// WebSocket-apps (tools/nep-app.mjs). Wat Clay merkt: elke app weer in zijn eigen slot en kleur (ook als ze in
// een andere volgorde terugkomen), de focus weer waar hij was, de Bank-LED's meteen goed, niets springt, en
// truth:"app"-waarden blijven van de app. Zie docs/HARDWARE-AVOND.md, "Als de hub omvalt".
import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { NepApp, voorbeeldManifest } from '../tools/nep-app.mjs';
import { startHubProces, ruimProcessenOp, cockpit, vrijePoort, maakMap, tot, wacht } from './herstart-hulp.js';

/** @type {(() => unknown)[]} */
const opruimen = [];
afterEach(async () => { for (const f of opruimen.splice(0).reverse()) await f(); await ruimProcessenOp(); });

const KLEUREN = { 'app-a': '#ff0000', 'app-b': '#00ff00', 'app-c': '#0000ff' };

/** @param {keyof typeof KLEUREN} id @param {'app'|'hub'} [truth] */
const manifestVan = (id, truth = 'app') => ({ ...voorbeeldManifest(id), naam: id, kleur: KLEUREN[id], truth: /** @type {const} */ (truth) });

/**
 * Een app die "gewoon doordraait" terwijl de hub weg is: zelfde inst, verbindt opnieuw met de hub.
 * @param {number} poort @param {keyof typeof KLEUREN} id @param {string} inst @param {'app'|'hub'} [truth]
 */
function app(poort, id, inst, truth = 'app') {
  const a = new NepApp({ url: `ws://127.0.0.1:${poort}/app`, manifest: manifestVan(id, truth), inst, herverbind: false }).start();
  opruimen.push(() => a.stop());
  return a;
}

/** @param {any} c @param {string} id */
const inBeeld = (c, id) => c.beeld?.apps.find((/** @type {any} */ x) => x.app === id);
/** @param {any} c @param {string[]} ids */
const allemaalActief = (c, ids) => ids.every((id) => inBeeld(c, id)?.status === 'actief');

/** Slot, kleur en focus per app, zoals de cockpit ze ziet. @param {any} c */
const indeling = (c) => Object.fromEntries(c.beeld.apps.map((/** @type {any} */ x) => [x.app, { slot: x.slot, kleur: x.kleur, focus: x.focus }]));

/** De bovenste padrij met Bank ingedrukt (app-slots, PROTOCOL §7). @param {any} c */
const slotLeds = (c) => Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`pad5-${i + 1}`, c.leds[`pad5-${i + 1}`] ?? {}]));
const BANK_IN = [0x90, 103, 127], BANK_UIT = [0x80, 103, 0];

describe('herstart van de hub (kill -9, opnieuw starten)', () => {
  it('elke app krijgt weer zijn slot en kleur, ook in een andere volgorde; de focus en de Bank-LEDs kloppen meteen', async () => {
    const poort = await vrijePoort();
    const staat = join(maakMap(), 'staat.json');
    let hub = await startHubProces({ poort, staat });
    let c = await cockpit(poort);
    // Eerste keer: A, B, C in die volgorde; Clay zet de focus op B.
    const eerst = [];
    for (const [i, [id, inst]] of /** @type {const} */ ([['app-a', 'a-1'], ['app-b', 'b-1'], ['app-c', 'c-1']]).entries()) {
      eerst.push(app(poort, id, inst));
      await tot(() => allemaalActief(c, [id]));
      expect(inBeeld(c, id).slot).toBe(i + 1);
    }
    c.stuur({ t: 'focus', app: 'app-b' });
    await tot(() => c.beeld.focus === 'app-b');
    c.virtueel('apc40', BANK_IN);
    await tot(() => slotLeds(c)['pad5-2'].anim?.soort === 'puls');
    const voor = { indeling: indeling(c), leds: slotLeds(c) };
    c.virtueel('apc40', BANK_UIT);
    await wacht(1300);                       // geheugen: hooguit eens per seconde naar schijf
    c.sluit();
    for (const a of eerst) a.stop();

    hub.sein('SIGKILL');
    await hub.einde;
    hub = await startHubProces({ poort, staat });
    c = await cockpit(poort);
    // Terug in een andere volgorde: C, A, B (zelfde inst: de tabs draaiden gewoon door).
    for (const [id, inst] of /** @type {const} */ ([['app-c', 'c-1'], ['app-a', 'a-1'], ['app-b', 'b-1']])) {
      app(poort, id, inst);
      await tot(() => allemaalActief(c, [id]));
    }
    await tot(() => c.beeld.focus === 'app-b');
    expect(indeling(c)).toEqual(voor.indeling);
    c.virtueel('apc40', BANK_IN);
    await tot(() => JSON.stringify(slotLeds(c)) === JSON.stringify(voor.leds));
    expect(slotLeds(c)).toEqual(voor.leds);
  }, 30000);

  it('na de herstart springt er niets (APC-fader en LPD8-knop wachten), truth:"app" blijft van de app, truth:"hub" en snapshots komen terug', async () => {
    const poort = await vrijePoort();
    const staat = join(maakMap(), 'staat.json');
    let hub = await startHubProces({ poort, staat });
    let c = await cockpit(poort);
    const a1 = app(poort, 'app-a', 'a-1');
    await tot(() => allemaalActief(c, ['app-a']));
    const h1 = app(poort, 'app-b', 'b-1', 'hub');
    await tot(() => allemaalActief(c, ['app-b']));
    a1.zelfZetten('helder', 0.8);                                   // de app zelf (muis): truth "app"
    c.stuur({ t: 'zet', app: 'app-b', id: 'helder', v: 0.7 });      // de hub onthoudt: truth "hub"
    await tot(() => h1.waarden.helder === 0.7);
    c.stuur({ t: 'snapshot', nr: 2, actie: 'bewaar' });
    await tot(() => c.beeld.snapshots?.includes(2));
    await wacht(1300);
    c.sluit(); a1.stop(); h1.stop();

    hub.sein('SIGKILL');
    await hub.einde;
    hub = await startHubProces({ poort, staat });
    c = await cockpit(poort);
    expect(c.beeld.snapshots).toEqual([2]);
    // De tabs draaiden door: zelfde inst, en ze hebben hun waarden nog.
    const a2 = new NepApp({ url: `ws://127.0.0.1:${poort}/app`, manifest: manifestVan('app-a'), inst: 'a-1', herverbind: false });
    a2.waarden.helder = 0.8;
    a2.start(); opruimen.push(() => a2.stop());
    await tot(() => allemaalActief(c, ['app-a']));
    const h2 = new NepApp({ url: `ws://127.0.0.1:${poort}/app`, manifest: manifestVan('app-b', 'hub'), inst: 'b-1', herverbind: false });
    h2.waarden.helder = 0.7;
    h2.start(); opruimen.push(() => h2.stop());
    await tot(() => allemaalActief(c, ['app-b']));
    await tot(() => h2.ontvangen.some((b) => b.t === 'zet' && b.id === 'helder'));
    expect(h2.ontvangen.filter((b) => b.t === 'zet')).toContainEqual({ t: 'zet', id: 'helder', v: 0.7, bron: 'replay' });
    expect(c.beeld.focus).toBe('app-a');

    // De fysieke fader staat ergens anders (0,1) dan de waarde van de app (0,8): niets springt, de LED knippert.
    c.virtueel('apc40', [0xb0, 7, 13]);                              // fader 1 = CC 7, kanaal 1
    c.virtueel('lpd8', [0xb0, 71, 13]);                              // K2 = macro.helderheid
    await wacht(300);
    expect(a2.ontvangen.filter((b) => b.t === 'zet')).toEqual([]);
    expect(h2.ontvangen.filter((b) => b.t === 'zet' && b.bron !== 'replay')).toEqual([]);
    expect(c.beeld.pickup.fader1).toMatchObject({ id: 'helder', doel: 0.8, gevangen: false });
    expect(c.leds.stop1).toEqual({ knipper: true });
    // Pas als de fader de waarde kruist, neemt hij over.
    c.virtueel('apc40', [0xb0, 7, 108]);
    await tot(() => a2.ontvangen.some((b) => b.t === 'zet'));
    expect(a2.ontvangen.filter((b) => b.t === 'zet')).toEqual([{ t: 'zet', id: 'helder', v: 108 / 127, bron: 'apc40' }]);
  }, 30000);
});
