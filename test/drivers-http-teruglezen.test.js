// Teruglezen in de HTTP-driver (uurwerk): hub en tab blijven het eens (docs/VOLGENDE-KOPPELINGEN.md §3.3).
// Alles met een nep-klok en een nep-fetch die de uurwerk-brug nadoet (`GET /` en `GET /verb/toon`).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NepKlok } from '../src/core/klok.js';
import { leesVanApp } from '../src/protocol/berichten.js';
import { maakDriver, APPS_MAP } from '../src/drivers/index.js';
import {
  STANDAARD_LEES, maakLezer, leesTekst, leesPatch, verschilt, naarDraad, leesTerugleesConfig, verstuurdeDraad,
  LEES_TIMEOUT_MS, LEES_MIN_MS, ECHO_MARGE_MS, POST_TIMEOUT_MS, LEES_MAX_TEKENS, LEES_GRENS_S, MAX_TIMER_MS,
} from '../src/drivers/http.js';
import { laadConfig } from '../src/config.js';
import { opzet as kernOpzet, lpdKnop } from './kern-hulp.js';

const leesApp = (naam) => JSON.parse(readFileSync(join(APPS_MAP, naam), 'utf8'));
const UURWERK = leesApp('uurwerk.json');
const CFG = { teruglezen: { elke_s: 2, max_s: 30 } };
const rust = () => new Promise((r) => setImmediate(r));
/** Het log zonder de ene startregel ("teruglezen aan: …"). */
const zonderStart = (log) => log.filter((r) => !r.includes('teruglezen aan:'));

/** Een patch zoals uurwerk/taal.js `serialize` hem schrijft (macro's met twee decimalen, licht/samenhang weg bij 0). */
function patch({ onrust = 0, licht = 0, dicht = 0.5, samenhang = 0, bevroren = false, tuinman = true, stem = true } = {}) {
  return [
    'uurwerk "kiezel"',
    stem ? `stem dorisch D zaad 3 loops 8/5 stap 0.25s dicht ${dicht.toFixed(2)} aan klank sinus aanzet 0.01s los 1.2s ontstem 0 vol 0.70` : null,
    'galm1 mix 0.30',
    'slinger adem1 periode 7s -> galm1.mix 0.20..0.40',
    'master 0.60',
    licht ? `licht ${licht.toFixed(2)}` : null,
    samenhang ? `samenhang ${samenhang.toFixed(2)}` : null,
    tuinman ? `tuinman onrust ${onrust.toFixed(2)}${bevroren ? ' bevroren' : ''} op-tijd` : null,
    'wens "warmer"',
  ].filter(Boolean).join('\n') + '\n';
}

/** Kleine nep-kern: controleert elk bericht van de driver, onthoudt wat binnenkwam. */
class NepKern {
  constructor() { this.ontvangen = []; this.verbroken = []; }
  verbind() {}
  ontvang(v, ruw) {
    const r = leesVanApp(ruw);
    if (!r.ok || r.onbekend) throw new Error(`ongeldig bericht van driver: ${JSON.stringify(ruw)}`);
    if (r.bericht.t === 'hallo') v.app = r.bericht.app;
    this.ontvangen.push(r.bericht);
  }
  verbreek(v) { this.verbroken.push(v.app); }
  zets() { return this.ontvangen.filter((b) => b.t === 'zet').map(({ id, v }) => ({ id, v })); }
}

/** Nep-brug: `GET /` (gezondheid), `GET /verb/toon` (patch als JSON), `POST /verb`. */
function nepBrug(klok) {
  const f = async (url, init = {}) => {
    const methode = init.method ?? 'GET';
    f.oproepen.push({ url, methode, t: klok.nu(), body: init.body ? JSON.parse(init.body) : undefined });
    if (!f.draait) throw new Error('ECONNREFUSED');
    if (methode === 'POST') return { ok: f.verbOk, status: f.verbOk ? 200 : 503, text: async () => '{}' };
    if (url.endsWith('/verb/toon')) {
      if (f.toonHangt) return new Promise(() => {}); // negeert ook het afbreken
      if (f.toonStatus !== 200) return { ok: false, status: f.toonStatus, text: async () => JSON.stringify({ fout: 'geen browsertab verbonden' }) };
      if (f.ruw !== undefined) return { ok: true, status: 200, text: async () => f.ruw };
      return { ok: true, status: 200, text: async () => JSON.stringify({ tekst: f.tekst, woorden: ['warm'], samenval: null, suggesties: [] }, null, 1) };
    }
    return { ok: true, status: 200, text: async () => `Uurwerk-brug. tabs: ${f.tabs}\n` };
  };
  f.oproepen = [];
  f.draait = true;
  f.tabs = 1;
  f.verbOk = true;
  f.toonStatus = 200;
  f.toonHangt = false;
  f.tekst = patch();
  f.toon = () => f.oproepen.filter((o) => o.url.endsWith('/verb/toon'));
  f.posts = () => f.oproepen.filter((o) => o.methode === 'POST');
  return f;
}

function opzet({ config = CFG, statisch = UURWERK, brug = {} } = {}) {
  const klok = new NepKlok(), kern = new NepKern(), fetch = nepBrug(klok);
  Object.assign(fetch, brug);
  const log = [];
  const d = maakDriver(statisch, { klok, fetch, config, log: (...a) => log.push(a.join(' ')) });
  d.start(kern);
  return { klok, kern, fetch, d, v: d.verbinding, log };
}

/** Laat de tijd lopen in stappen, met ruimte voor de beloften van fetch na elke stap. */
async function loop(klok, ms, stap = 100) {
  await rust(); // eerst wat al klaarstaat (bv. de eerste gezondheidscheck), anders verloopt zijn time-out
  for (let t = 0; t < ms; t += stap) { klok.loop(Math.min(stap, ms - t)); await rust(); }
}

// ───────────────────────── puur ─────────────────────────

describe('teruglezen: de patchtaal van uurwerk', () => {
  const { lezer, fouten } = maakLezer(STANDAARD_LEES.uurwerk, UURWERK, UURWERK.driver);

  it('de standaardregels passen op apps/uurwerk.json (alle macro\'s en bevries)', () => {
    expect(fouten).toEqual([]);
    expect([...lezer.regels.keys()].sort()).toEqual(['bevries', 'dicht', 'licht', 'onrust', 'samenhang']);
    expect(lezer.regels.get('licht')).toMatchObject({ lo: -1, hi: 1 }); // bereik uit driver.verbs
  });

  it('leest de macro\'s in eenheden van de app', () => {
    expect(leesTekst(lezer, patch({ onrust: 0.35, licht: -0.2, dicht: 0.62, samenhang: 0.27, bevroren: true })))
      .toEqual({ onrust: 0.35, licht: -0.2, dicht: 0.62, samenhang: 0.27, bevries: 1 });
    expect(leesTekst(lezer, patch({ onrust: 0.1 })).bevries).toBe(0);
  });

  it('ontbrekende regels: licht, samenhang en onrust zijn dan 0; dicht en bevries onbekend', () => {
    expect(leesTekst(lezer, 'uurwerk "x"\nmaster 0.50\n')).toEqual({ onrust: 0, licht: 0, samenhang: 0 });
    // vol 0.70 in de stem-regel is het synth-volume, niet dicht
    expect(leesTekst(lezer, patch({ dicht: 0.05 })).dicht).toBe(0.05);
  });

  it('afronding telt niet: hub 0,4567 ↔ tab 0,46 is gelijk, 0,60 niet; licht in eenheden -1..1', () => {
    const dicht = lezer.regels.get('dicht'), licht = lezer.regels.get('licht'), bevries = lezer.regels.get('bevries');
    expect(verschilt(lezer, dicht, 0.46, 0.4567)).toBe(false);
    expect(verschilt(lezer, dicht, 0.45, 0.455)).toBe(false); // precies op de rand van toFixed(2)
    expect(verschilt(lezer, dicht, 0.6, 0.4567)).toBe(true);
    expect(verschilt(lezer, licht, 0, 0.5)).toBe(false);
    expect(verschilt(lezer, licht, 0.01, 0.5)).toBe(true); // 0,01 in -1..1 is meer dan afronding
    expect(naarDraad(licht, 0.5)).toBe(0.75);
    expect(verschilt(lezer, bevries, 1, 1)).toBe(false);
    expect(verschilt(lezer, bevries, 0, 1)).toBe(true);
  });

  it('ongeldige regels vallen weg en worden gemeld; lees:false of geen geldige regel = geen lezer', () => {
    const r = maakLezer({ verb: 'toon', regels: { bestaat_niet: { patroon: 'x' }, bewaar: { patroon: 'x' }, dicht: { patroon: '(' }, licht: { patroon: '^licht (.+)$' } } }, UURWERK, UURWERK.driver);
    expect(r.fouten).toHaveLength(3);
    expect([...r.lezer.regels.keys()]).toEqual(['licht']);
    expect(maakLezer(false, UURWERK, UURWERK.driver)).toEqual({ lezer: null, fouten: [] });
    expect(maakLezer({ verb: '../x', regels: {} }, UURWERK, UURWERK.driver).lezer).toBeNull();
    expect(maakLezer({ verb: 'toon', regels: { dicht: { patroon: '(' } } }, UURWERK, UURWERK.driver).lezer).toBeNull();
    expect(maakLezer({ verb: 'toon', kop: 42, regels: { licht: { patroon: 'x' } } }, UURWERK, UURWERK.driver).lezer).toBeNull();
  });

  it('kopregel: zonder `uurwerk "…"` geen patch en geen waarden (ook niet uit ontbreekt); lege kop + geen regel = verse tab', () => {
    expect(leesPatch(lezer, '')).toEqual({ kop: false, vers: false, waarden: {} });
    expect(leesTekst(lezer, 'hallo\nmaster 0.50\n')).toEqual({});
    expect(leesPatch(lezer, 'uurwerk ""\nmaster 0.80\n')).toEqual({ kop: true, vers: true, waarden: { onrust: 0, licht: 0, samenhang: 0 } });
    expect(leesPatch(lezer, 'uurwerk ""\nlicht 0.20\n').vers).toBe(false); // de hub zette licht: geen verse tab
    expect(leesPatch(lezer, 'uurwerk "kiezel"\n').vers).toBe(false); // een tuin met zaad, alles op nul: echt
    expect(leesPatch(lezer, patch()).vers).toBe(false);
  });

  it('dubbele afronding: hub 0,45496 → verstuurd 0,4550 → tab 0,46 is geen wijziging (ook licht 0,30496 → 0,31)', () => {
    const dicht = lezer.regels.get('dicht'), licht = lezer.regels.get('licht');
    expect(verstuurdeDraad(UURWERK.driver.verbs.dicht, 0.45496)).toBe(0.455);
    expect(verschilt(lezer, dicht, 0.46, verstuurdeDraad(UURWERK.driver.verbs.dicht, 0.45496))).toBe(false);
    expect(verschilt(lezer, dicht, 0.13, verstuurdeDraad(UURWERK.driver.verbs.dicht, 0.12495))).toBe(false);
    const vLicht = (0.30496 + 1) / 2;
    expect(verschilt(lezer, licht, 0.31, verstuurdeDraad(UURWERK.driver.verbs.licht, vLicht))).toBe(false);
    expect(verschilt(lezer, licht, 0.32, verstuurdeDraad(UURWERK.driver.verbs.licht, vLicht))).toBe(true);
  });
});

describe('teruglezen: het voorbeeld in docs/VOLGENDE-KOPPELINGEN.md §3.3', () => {
  it('driver.lees zonder dicht (blok "toets: lees") is geldig en gelijk aan STANDAARD_LEES min dicht', () => {
    const doc = readFileSync(new URL('../docs/VOLGENDE-KOPPELINGEN.md', import.meta.url), 'utf8');
    const blok = /<!--\s*toets:\s*lees\s*-->\s*\n```json\n([\s\S]*?)\n```/.exec(doc)?.[1];
    expect(blok).toBeTruthy();
    const { lees } = JSON.parse(blok);
    const { dicht, ...rest } = STANDAARD_LEES.uurwerk.regels;
    expect(lees).toEqual({ ...STANDAARD_LEES.uurwerk, regels: rest });
    const { lezer, fouten } = maakLezer(lees, UURWERK, UURWERK.driver);
    expect(fouten).toEqual([]);
    expect(leesTekst(lezer, patch({ dicht: 0.9, licht: 0.2 }))).toEqual({ onrust: 0, licht: 0.2, samenhang: 0, bevries: 0 });
  });
});

describe('teruglezen: config.json is de enige bron voor het interval', () => {
  it('config.json heeft teruglezen.elke_s (getal, met _doc) en max_s; de driver neemt ze over', () => {
    const cfg = laadConfig();
    expect(typeof cfg.teruglezen._doc).toBe('string');
    expect(cfg.teruglezen.elke_s).toBeGreaterThan(0);
    expect(cfg.teruglezen.max_s).toBeGreaterThanOrEqual(cfg.teruglezen.elke_s);
    const d = maakDriver(UURWERK, { klok: new NepKlok(), fetch: async () => ({ ok: true }), config: cfg }).driver;
    expect(d.leesMs).toBe(cfg.teruglezen.elke_s * 1000);
    expect(d.leesMaxMs).toBe(cfg.teruglezen.max_s * 1000);
    expect(d.lezer).not.toBeNull();
  });

  it('geen sleutel of elke_s 0 = uit; ongeldig → melding en 2 s; nooit vaker dan LEES_MIN_MS', () => {
    expect(leesTerugleesConfig(undefined)).toBeNull();
    expect(leesTerugleesConfig({ elke_s: 0 })).toBeNull();
    expect(leesTerugleesConfig({ elke_s: 3, max_s: 10 })).toEqual({ elkeMs: 3000, maxMs: 10000, meldingen: [] });
    const r = leesTerugleesConfig({ elke_s: '2s', max_s: 'veel' });
    expect(r).toMatchObject({ elkeMs: 2000, maxMs: 30000 });
    expect(r.meldingen).toHaveLength(2);
    expect(leesTerugleesConfig({ elke_s: 0.01 }).elkeMs).toBe(LEES_MIN_MS);
    expect(leesTerugleesConfig({ elke_s: 5, max_s: 1 }).maxMs).toBe(5000); // backoff nooit korter dan het interval
  });

  it('begrensd naar boven: elke_s en max_s hooguit LEES_GRENS_S (met melding), de wachttijd nooit boven 2^31-1 ms', () => {
    const r = leesTerugleesConfig({ elke_s: 3e6, max_s: 1e12 });
    expect(r).toMatchObject({ elkeMs: LEES_GRENS_S * 1000, maxMs: LEES_GRENS_S * 1000 });
    expect(r.meldingen).toHaveLength(2);
    const d = maakDriver(UURWERK, { klok: new NepKlok(), fetch: async () => ({ ok: true }), config: { teruglezen: { elke_s: 3e6 } } }).driver;
    d.leesFouten = 40;
    expect(d.leesWacht()).toBeLessThanOrEqual(MAX_TIMER_MS);
    d.leesMs = 2 ** 40; d.leesMaxMs = 2 ** 41; // ook als iemand de velden zelf zet
    expect(d.leesWacht()).toBe(MAX_TIMER_MS);
  });

  it('zonder config, of met lees:false in het manifest: geen enkele GET /verb/toon', async () => {
    for (const o of [{ config: {} }, { statisch: { ...UURWERK, driver: { ...UURWERK.driver, lees: false } } }]) {
      const { klok, fetch } = opzet(o);
      await loop(klok, 10000, 500);
      expect(fetch.toon()).toEqual([]);
    }
  });

  it('een ongeldige elke_s wordt één keer gemeld en dan 2 s gebruikt', async () => {
    const { klok, fetch, log } = opzet({ config: { teruglezen: { elke_s: 'vaak' } } });
    await loop(klok, 4000, 500);
    expect(log.filter((r) => r.includes('teruglezen.elke_s moet'))).toHaveLength(1);
    expect(fetch.toon().map((o) => o.t)).toEqual([2000, 4000]);
  });
});

// ───────────────────────── de driver ─────────────────────────

describe('teruglezen: de driver', () => {
  it('vraagt elke elke_s GET /verb/toon aan de brug (config.json-poort wint ook hier)', async () => {
    const { klok, fetch } = opzet({ config: { ...CFG, apps: { uurwerk: { poort: 9999 } } } });
    await loop(klok, 6000, 500);
    expect(fetch.toon().map((o) => [o.url, o.t])).toEqual([
      ['http://127.0.0.1:9999/verb/toon', 2000], ['http://127.0.0.1:9999/verb/toon', 4000], ['http://127.0.0.1:9999/verb/toon', 6000],
    ]);
  });

  it('afronding is geen wijziging: hub 0,4567 ↔ tab 0,46 → geen zet; tab 0,60 → precies één zet', async () => {
    const { klok, kern, fetch, v } = opzet();
    v.stuur({ t: 'zet', id: 'dicht', v: 0.4567 });
    fetch.tekst = patch({ dicht: 0.46 });
    await loop(klok, 6000, 500);
    expect(kern.zets()).toEqual([]);
    fetch.tekst = patch({ dicht: 0.6 });
    await loop(klok, 2000, 500);
    expect(kern.zets()).toEqual([{ id: 'dicht', v: 0.6 }]);
    await loop(klok, 6000, 500);
    expect(kern.zets()).toHaveLength(1); // de hub weet het nu: niet opnieuw
    expect(fetch.posts()).toHaveLength(1); // en de driver stuurt het niet terug naar de tab
  });

  it('een wijziging in de tab zelf (uur meer: licht +0,12, dicht +0,08) komt als zet van de app in de kern', async () => {
    const { klok, kern, fetch, v } = opzet();
    await loop(klok, 4000, 500);
    expect(kern.zets()).toEqual([]); // tab op de standaardwaarden: niets te melden
    v.stuur({ t: 'trig', id: 'uur_meer', aan: true });
    fetch.tekst = patch({ licht: 0.12, dicht: 0.58 });
    await loop(klok, 2000, 500);
    expect(kern.zets()).toEqual([{ id: 'licht', v: 0.56 }, { id: 'dicht', v: 0.58 }]);
  });

  it('bevries en onrust uit de tuinman-regel; zonder die regel blijft bevries onbekend', async () => {
    const { klok, kern, fetch } = opzet();
    fetch.tekst = patch({ onrust: 0.35, bevroren: true });
    await loop(klok, 2000, 500);
    expect(kern.zets()).toEqual([{ id: 'onrust', v: 0.35 }, { id: 'bevries', v: 1 }]);
    fetch.tekst = patch({ tuinman: false });
    await loop(klok, 2000, 500);
    expect(kern.zets().slice(2)).toEqual([{ id: 'onrust', v: 0 }]);
  });

  it('geen echo: wat de hub net stuurde en de tab nog niet toont, is geen wijziging (ook niet tijdens een faderbeweging)', async () => {
    const { klok, kern, fetch, v } = opzet();
    await loop(klok, 3000, 500);
    v.stuur({ t: 'zet', id: 'dicht', v: 0.3 }); // t=3000; de tab toont nog 0,50
    await loop(klok, 1000, 500);
    expect(fetch.toon().map((o) => o.t)).toContain(4000);
    expect(kern.zets()).toEqual([]);
    // een fader van 2 s: elke 100 ms een waarde, de tab loopt achter
    for (let i = 0; i < 20; i++) { v.stuur({ t: 'zet', id: 'dicht', v: 0.3 + i * 0.02 }); fetch.tekst = patch({ dicht: 0.3 + Math.max(0, i - 5) * 0.02 }); await loop(klok, 100, 100); }
    expect(kern.zets()).toEqual([]);
    fetch.tekst = patch({ dicht: 0.68 }); // de tab is bij: gelijk aan de laatste waarde van de hub
    await loop(klok, ECHO_MARGE_MS + 4000, 500);
    expect(kern.zets()).toEqual([]);
  });

  it('na de echo-marge telt een afwijking wel (iemand draaide in de tab)', async () => {
    const { klok, kern, fetch, v } = opzet();
    await loop(klok, 1000, 500);
    v.stuur({ t: 'zet', id: 'samenhang', v: 0.3 }); // t=1000
    fetch.tekst = patch({ samenhang: 0.3 });
    await loop(klok, ECHO_MARGE_MS + 2000, 500);
    expect(kern.zets()).toEqual([]);
    fetch.tekst = patch({ samenhang: 0.55 });
    await loop(klok, 2000, 500);
    expect(kern.zets()).toEqual([{ id: 'samenhang', v: 0.55 }]);
  });

  it('uurwerk draait niet (geen brug, of geen tab): geen enkele toon-vraag en niets in het log', async () => {
    for (const brug of [{ draait: false }, { tabs: 0 }]) {
      const { klok, kern, fetch, log } = opzet({ brug });
      await loop(klok, 60000, 1000);
      expect(fetch.toon()).toEqual([]);
      expect(zonderStart(log)).toEqual([]);
      expect(kern.zets()).toEqual([]);
    }
  });

  it('een verb mislukte (replay wacht): niet teruglezen, anders overschrijft de oude stand van de tab de hub', async () => {
    const { kern, fetch, d, v } = opzet({ brug: { verbOk: false } });
    await rust();
    v.stuur({ t: 'zet', id: 'onrust', v: 0.7 });
    await rust();
    expect(d.driver.gemist).toBe(true); // de volgende geslaagde check meldt opnieuw aan (replay)
    fetch.tekst = patch({ onrust: 0.1 });
    await d.driver.lees();
    expect(fetch.toon()).toEqual([]);
    expect(kern.zets()).toEqual([]);
    d.driver.gemist = false; // tegenproef: zonder wachtende replay wordt er wel gevraagd
    await d.driver.lees();
    expect(fetch.toon()).toHaveLength(1);
  });

  it('toon mislukt terwijl de brug gezond is: backoff 2 → 4 → 8 → 16 → 30 s, één logregel; daarna weer elke 2 s', async () => {
    const { klok, kern, fetch, log } = opzet({ brug: { toonStatus: 503 } });
    await loop(klok, 90000, 1000);
    expect(fetch.toon().map((o) => o.t)).toEqual([2000, 6000, 14000, 30000, 60000, 90000]);
    const fouten = () => zonderStart(log).filter((r) => r.includes('teruglezen'));
    expect(fouten()).toHaveLength(1);
    expect(fouten()[0]).toMatch(/teruglezen mislukt: HTTP 503: geen browsertab verbonden .*uitzetten: config\.json teruglezen\.elke_s = 0/);
    expect(kern.ontvangen.filter((b) => b.t === 'hb').length).toBeGreaterThan(40); // de brug is gezond: de hartslag loopt door
    fetch.toonStatus = 200;
    fetch.tekst = patch({ samenhang: 0.4 });
    await loop(klok, 34000, 1000);
    expect(fetch.toon().map((o) => o.t).slice(6)).toEqual([120000, 122000, 124000]);
    expect(fouten()).toEqual([expect.stringMatching(/teruglezen mislukt/), expect.stringMatching(/teruglezen werkt weer/)]);
    expect(kern.zets()).toEqual([{ id: 'samenhang', v: 0.4 }]);
  });

  it('een kapot antwoord (geen JSON, geen tekst) telt als mislukt, zonder te gooien', async () => {
    const { klok, kern, fetch, log } = opzet();
    fetch.tekst = 42; // { tekst: 42 }
    await loop(klok, 2000, 500);
    expect(log.some((r) => r.includes('geen "tekst"'))).toBe(true);
    expect(kern.zets()).toEqual([]);
    expect(fetch.toon()).toHaveLength(1);
  });

  it('een toon-vraag die blijft hangen wordt na LEES_TIMEOUT_MS opgegeven; de keten loopt door (met backoff)', async () => {
    const { klok, fetch, d, log } = opzet({ brug: { toonHangt: true } });
    await loop(klok, 2000 + LEES_TIMEOUT_MS + 4000, 100);
    expect(fetch.toon().map((o) => o.t)).toEqual([2000, 2000 + LEES_TIMEOUT_MS + 4000]);
    expect(log.filter((r) => r.includes(`geen antwoord binnen ${LEES_TIMEOUT_MS} ms`))).toHaveLength(1);
    expect(LEES_TIMEOUT_MS).toBeLessThan(2000); // altijd klaar voor de volgende ronde
    expect(LEES_TIMEOUT_MS).toBeLessThanOrEqual(POST_TIMEOUT_MS);
    d.stop();
    expect(klok.timers.size).toBe(0);
  });

  it('stop() midden in een toon-vraag: alle timers weg, de late uitslag telt niet', async () => {
    const klok = new NepKlok(), kern = new NepKern(), fetch = nepBrug(klok);
    /** @type {(x: any) => void} */
    let geef = () => {};
    const f = (url, init) => (url.endsWith('/verb/toon') ? new Promise((r) => { geef = r; }) : fetch(url, init));
    const d = maakDriver(UURWERK, { klok, fetch: f, config: CFG });
    d.start(kern);
    await rust();
    klok.loop(2000); await rust();
    d.stop();
    expect(klok.timers.size).toBe(0);
    geef({ ok: true, text: async () => JSON.stringify({ tekst: patch({ dicht: 0.9 }) }) });
    await rust(); await rust();
    expect(kern.zets()).toEqual([]);
    klok.loop(10000); await rust();
    expect(klok.timers.size).toBe(0);
  });

  it('meldt bij de start één keer dat teruglezen aan staat, en hoe het uit gaat', async () => {
    const { klok, log } = opzet();
    await loop(klok, 6000, 500);
    expect(log.filter((r) => r.includes('teruglezen aan:'))).toEqual([expect.stringMatching(/elke 2 s \(config\.json teruglezen\.elke_s; 0 = uit\)/)]);
  });

  it('dubbele afronding in de driver: hub 0,45496 ↔ tab 0,46 geeft geen zet', async () => {
    const { klok, kern, fetch, v } = opzet();
    v.stuur({ t: 'zet', id: 'dicht', v: 0.45496 });
    fetch.tekst = patch({ dicht: 0.46 });
    await loop(klok, ECHO_MARGE_MS + 6000, 500);
    expect(kern.zets()).toEqual([]);
  });

  it('geen patch (lege tekst, of een andere dienst op de poort): telt als mislukt, de hub gaat niet naar nul', async () => {
    for (const brug of [{ tekst: '' }, { ruw: '{"tekst":"hallo"}' }]) {
      const { klok, kern, fetch, log, v } = opzet({ brug });
      v.stuur({ t: 'zet', id: 'onrust', v: 0.6 });
      await loop(klok, ECHO_MARGE_MS + 4000, 500);
      expect(kern.zets()).toEqual([]);
      expect(zonderStart(log)).toEqual([expect.stringMatching(/teruglezen mislukt: geen kopregel/)]);
      expect(fetch.toon().length).toBeGreaterThan(0);
    }
  });

  it('een foutreden van buiten komt ingekort en op één regel in het log', async () => {
    const { klok, log } = opzet({ brug: { ruw: JSON.stringify({ fout: 'regel\n'.repeat(5000) }) } });
    await loop(klok, 2000, 500);
    const [r] = zonderStart(log);
    expect(r).toMatch(/^driver uurwerk teruglezen mislukt: regel regel/);
    expect(r).not.toContain('\n');
    expect(r.length).toBeLessThan(400);
  });

  it('een antwoord van meer dan LEES_MAX_TEKENS: "antwoord te groot", geen zet', async () => {
    const groot = JSON.stringify({ tekst: patch({ samenhang: 0.5 }) + 'x'.repeat(LEES_MAX_TEKENS) });
    const { klok, kern, log } = opzet({ brug: { ruw: groot } });
    await loop(klok, 2000, 500);
    expect(zonderStart(log)).toEqual([expect.stringMatching(/teruglezen mislukt: antwoord te groot/)]);
    expect(kern.zets()).toEqual([]);
  });

  it('na backoff valt de brug weg en komt terug: het volgende verzoek komt na elke_s, niet na de lopende backoff', async () => {
    const { klok, fetch, d } = opzet({ brug: { toonStatus: 503 } });
    await loop(klok, 31000, 1000); // toon om 2, 6, 14, 30 s mislukt: de volgende pas om 60 s
    expect(fetch.toon().map((o) => o.t)).toEqual([2000, 6000, 14000, 30000]);
    expect(d.driver.leesWacht()).toBe(30000);
    fetch.draait = false;
    await loop(klok, 5000, 1000);
    fetch.draait = true;
    fetch.toonStatus = 200;
    await loop(klok, 2000, 1000); // de gezondheidscheck ziet de brug weer (t = 38 s)
    const terug = klok.nu();
    await loop(klok, 3000, 500);
    const na = fetch.toon().map((o) => o.t).filter((t) => t > 36000);
    expect(na.length).toBeGreaterThan(0);
    expect(na[0] - terug).toBeLessThanOrEqual(2000);
  });

  it('een POST mislukt terwijl toon nog loopt (replay wacht): de uitslag van die ronde telt niet', async () => {
    const klok = new NepKlok(), kern = new NepKern(), brug = nepBrug(klok);
    /** @type {(x: any) => void} */
    let geef = () => {};
    const f = (url, init) => (url.endsWith('/verb/toon') ? new Promise((r) => { geef = r; }) : brug(url, init));
    const d = maakDriver(UURWERK, { klok, fetch: f, config: CFG });
    d.start(kern);
    await rust();
    klok.loop(2000); await rust(); // de toon-vraag loopt
    brug.verbOk = false;
    d.verbinding.stuur({ t: 'zet', id: 'onrust', v: 0.7 });
    await rust(); await rust();
    expect(d.driver.gemist).toBe(true);
    geef({ ok: true, text: async () => JSON.stringify({ tekst: patch({ samenhang: 0.55 }) }) });
    await rust(); await rust();
    expect(kern.zets()).toEqual([]); // ook samenhang (die de hub niet stuurde) niet
    d.stop();
  });

  it('twee tabs open: niet teruglezen (de brug laat het eerste antwoord winnen), één logregel; bij één tab weer wel', async () => {
    const { klok, kern, fetch, log } = opzet({ brug: { tabs: 2 } });
    fetch.tekst = patch({ samenhang: 0.4 });
    await loop(klok, 10000, 500);
    expect(fetch.toon()).toEqual([]);
    expect(kern.zets()).toEqual([]);
    expect(zonderStart(log)).toEqual([expect.stringMatching(/2 tabs open: teruglezen staat stil/)]);
    fetch.tabs = 1;
    await loop(klok, 4000, 500);
    expect(kern.zets()).toEqual([{ id: 'samenhang', v: 0.4 }]);
    expect(zonderStart(log)).toHaveLength(2);
  });

  it('een lege patch blijft leeg na de replay: dan neemt de driver hem wel over (iemand zette alles echt op nul)', async () => {
    const { klok, kern, fetch, v } = opzet();
    await loop(klok, 500, 500);
    v.stuur({ t: 'zet', id: 'samenhang', v: 0.4 });
    fetch.tekst = patch({ samenhang: 0.4 });
    await loop(klok, ECHO_MARGE_MS + 2000, 500);
    const hallos = () => kern.ontvangen.filter((b) => b.t === 'hallo').length;
    const voor = hallos();
    fetch.tekst = 'uurwerk ""\n';
    await loop(klok, 2000, 500);
    expect(hallos()).toBe(voor + 1); // eerst opnieuw aanmelden (replay)
    expect(kern.zets()).toEqual([]);
    await loop(klok, 2000, 500);
    expect(kern.zets()).toEqual([{ id: 'samenhang', v: 0 }]);
    expect(hallos()).toBe(voor + 1); // niet nog eens
  });
});

// ───────────────────────── met de echte kern ─────────────────────────

describe('teruglezen met de echte kern', () => {
  it('de teruggelezen waarde staat in de kern, gaat niet terug naar de tab, en de LPD8-pickup volgt (bron app, §11)', async () => {
    const { klok, kern } = kernOpzet();
    const fetch = nepBrug(klok);
    const d = maakDriver(UURWERK, { klok, fetch, config: CFG });
    d.start(kern);
    await rust();
    // K2 (macro.helderheid = uurwerk licht) oppakken op 0,5: de hub zet licht en stuurt het naar de tab
    lpdKnop(kern, 2, 64 / 127);
    await rust();
    const posts = fetch.posts().length;
    expect(posts).toBe(1);
    expect(kern.lpdPickups.get('k2')).toMatchObject({ gevangen: true });
    // iemand zet in de tab licht op 0,50 (= 0,75 op de draad)
    fetch.tekst = patch({ licht: 0.5 });
    await loop(klok, 4000, 500);
    expect(kern.apps.get('uurwerk').waarden.licht).toBe(0.75);
    expect(fetch.posts()).toHaveLength(posts); // geen echo-lus: de kern stuurt een zet van de app niet terug
    expect(kern.lpdPickups.get('k2')).toMatchObject({ doel: 0.75, gevangen: false }); // K2 wacht weer
    // en daarna blijft het stil: hub en tab zijn het eens
    await loop(klok, 10000, 1000);
    expect(fetch.posts()).toHaveLength(posts);
    d.stop();
  });

  it('de tab herlaadt tussen twee gezondheidschecks (tabs: 0 nooit gezien): de hub houdt zijn waarden en speelt ze af', async () => {
    const { klok, kern } = kernOpzet();
    // een tab met staat: macro's uit POST /verb, serialize zoals taal.js (vers geladen: geen zaad, geen stem/tuinman)
    let tab = { zaad: 'kiezel', onrust: 0, licht: 0, samenhang: 0, dicht: 0.5 };
    const brug = nepBrug(klok);
    const f = async (url, init = {}) => {
      if ((init.method ?? 'GET') === 'POST') {
        const b = JSON.parse(init.body);
        if (b.verb === 'macro') tab[b.args.naam] = Math.round(b.args.waarde * 100) / 100;
      }
      brug.tekst = [
        `uurwerk "${tab.zaad}"`,
        tab.dicht !== null ? `stem dorisch D zaad 3 loops 8 stap 0.25s dicht ${tab.dicht.toFixed(2)} aan` : null,
        tab.licht ? `licht ${tab.licht.toFixed(2)}` : null,
        tab.samenhang ? `samenhang ${tab.samenhang.toFixed(2)}` : null,
        tab.zaad || tab.onrust ? `tuinman onrust ${tab.onrust.toFixed(2)} op-tijd` : null,
      ].filter(Boolean).join('\n') + '\n';
      return brug(url, init);
    };
    const d = maakDriver(UURWERK, { klok, fetch: f, config: CFG, log: () => {} });
    d.start(kern);
    await loop(klok, 500, 50);
    for (const [id, v] of [['onrust', 0.6], ['licht', 0.8], ['samenhang', 0.4]]) kern.cockpit({ t: 'zet', app: 'uurwerk', id, v });
    await loop(klok, 6000, 50);
    const waarden = () => { const w = kern.apps.get('uurwerk').waarden; return { onrust: w.onrust, licht: w.licht, samenhang: w.samenhang }; };
    expect(waarden()).toEqual({ onrust: 0.6, licht: 0.8, samenhang: 0.4 });
    // F5: 300 ms weg, midden tussen twee checks; de verse tab heeft de lege standaardstand
    await loop(klok, 2100 - (klok.nu() % 2000), 50);
    tab = { zaad: '', onrust: 0, licht: 0, samenhang: 0, dicht: null };
    await loop(klok, 300, 50);
    await loop(klok, 8000, 50);
    expect(waarden()).toEqual({ onrust: 0.6, licht: 0.8, samenhang: 0.4 }); // niet naar 0 / 0,5 / 0
    expect(tab).toMatchObject({ onrust: 0.6, licht: 0.6, samenhang: 0.4 }); // de replay zette de tab terug (licht −1..1)
    d.stop();
  });
});
