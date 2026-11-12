// @ts-check
// `varve-hub doctor`: één overzicht van de machine. Uitvoer is bedoeld om te plakken.
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import dgram from 'node:dgram';
import { zoekNaam, zoekIngang } from './ports/poort.js';
import { laadHid, draaiendeNi, HINT, invoerHint, isRechtenFout } from './ports/hid.js';
import { laadLpd8Profiel, laadXboardProfiel, HUB_MAP } from './config.js';
import * as XB from './devices/xboard49.js';
import * as KP3 from './devices/kp3plus.js';
import * as EFX from './devices/efx500.js';
import { KlokMeter } from './core/klokbron.js';
import * as A from './devices/apc40mk2.js';
import { isModusBewijs } from './apparaten.js';
import * as L from './devices/lpd8.js';

/** @param {string} cmd @param {string[]} args */
const probeer = (cmd, args) => { try { return execFileSync(cmd, args, { cwd: HUB_MAP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

/** Is er iets dat luistert op deze TCP-poort? @param {number} poort */
export const tcpOpen = (poort) => new Promise((r) => {
  const s = net.connect({ host: '127.0.0.1', port: poort });
  const klaar = (/** @type {boolean} */ ok) => { s.destroy(); r(ok); };
  s.once('connect', () => klaar(true)); s.once('error', () => klaar(false)); s.setTimeout(400, () => klaar(false));
});
/** Kunnen wij deze poort zelf nog binden? (false = iemand anders gebruikt hem) @param {number} poort @param {'tcp'|'udp'} soort */
export const vrij = (poort, soort) => new Promise((r) => {
  if (soort === 'udp') {
    const s = dgram.createSocket('udp4');
    s.once('error', () => { s.close(); r(false); });
    s.bind(poort, '127.0.0.1', () => s.close(() => r(true)));
  } else {
    const s = net.createServer();
    s.once('error', () => r(false));
    s.listen(poort, '127.0.0.1', () => s.close(() => r(true)));
  }
});

/**
 * @param {{ config: any, laadMidi: () => Promise<{ systeem: import('./ports/poort.js').Systeem|null, reden?: string }>,
 *   laadHid?: () => Promise<{ systeem: import('./ports/hid.js').HidSysteem|null, reden?: string }>, niProgrammas?: () => string[],
 *   wachtMs?: number, hubDraait?: () => Promise<boolean>, platform?: string, apcLuisterMs?: number,
 *   apcProgrammas?: () => string[], vraag?: (tekst: string) => void }} o  laadHid/niProgrammas/wachtMs/hubDraait/platform/
 *   apcLuisterMs/apcProgrammas: tests geven nep; vraag: toont een opdracht meteen (de rest komt pas aan het eind)
 * @returns {Promise<{ tekst: string, data: any }>}
 */
export async function doctor({ config, laadMidi, laadHid: hidLader = laadHid, niProgrammas = () => draaiendeNi(), wachtMs = 600,
  hubDraait = async () => !(await vrij(config.poorten.http, 'tcp')), platform = process.platform,
  apcLuisterMs = 3000, apcProgrammas = () => draaiendeApcProgrammas(), vraag = () => {} }) {
  const r = [];
  const data = /** @type {any} */ ({});
  const ok = (/** @type {boolean|null|undefined} */ b) => (b ? '✔' : '✗');

  data.node = process.version;
  data.platform = `${process.platform} ${process.arch}`;
  data.git = probeer('git', ['rev-parse', '--short', 'HEAD']);
  data.tak = probeer('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  data.gewijzigd = (probeer('git', ['status', '--porcelain', '.']) ?? '').split('\n').filter(Boolean).length;
  r.push('varve-hub doctor', `  node ${data.node} · ${data.platform} · git ${data.git ?? '?'} (${data.tak ?? '?'})${data.gewijzigd ? ` · ${data.gewijzigd} lokale wijzigingen` : ''}`);

  r.push('', 'MIDI');
  const { systeem, reden } = await laadMidi();
  data.midi = { beschikbaar: !!systeem, reden: reden ?? null };
  if (!systeem) {
    r.push(`  ✗ geen MIDI: ${reden}`);
  } else {
    const l = systeem.lijst();
    data.midi.poorten = l;
    r.push(`  ingangen: ${l.ingangen.join(' · ') || '(geen)'}`, `  uitgangen: ${l.uitgangen.join(' · ') || '(geen)'}`);
    for (const [dev, patroon] of [['apc40', config.apparaten.apc40.naam], ['lpd8', config.apparaten.lpd8.naam]]) {
      const naam = zoekNaam(l, new RegExp(patroon, 'i'));
      data[dev] = { naam };
      r.push(`  ${ok(!!naam)} ${dev}: ${naam ?? 'niet gevonden'}`);
      if (!naam) continue;
      try {
        const p = systeem.open(naam);
        /** @type {number[][]} */
        const ontvangen = [];
        /** Alle berichten (niet alleen SysEx): zo is te zien of er wel noten en CC's binnenkomen terwijl SysEx uitblijft. */
        const alle = { n: 0, /** @type {number[][]} */ laatste: [] };
        p.bijBericht((b) => { alle.n++; if (b[0] === 0xf0) ontvangen.push(b); else alle.laatste.push(b); });
        p.stuur([...A.IDENTITEIT_VRAAG]);
        await new Promise((res) => setTimeout(res, 600));
        if (dev === 'apc40') await apcHanddruk({ config, p, ontvangen, alle, r, data, ok, hubDraait, apcLuisterMs, apcProgrammas, vraag });
        const model = dev === 'lpd8' ? ontvangen.map((b) => L.modelUit(b)).find(Boolean) ?? null : null;
        if (dev === 'lpd8' && model) { p.stuur(L.vraagProgramma(model, 1)); await new Promise((res) => setTimeout(res, 600)); }
        const prog = dev === 'lpd8' ? ontvangen.map((b) => L.ontleedProgramma(b)).find((x) => x && 'pads' in x) : null;
        p.sluit();
        data[dev].identiteit = ontvangen.find((b) => b[1] === 0x7e && b[3] === 0x06 && b[4] === 0x02) ?? null;
        if (dev === 'lpd8') Object.assign(data[dev], { model, programma1: prog ?? null });
        if (dev !== 'apc40') r.push(`      identiteit: ${ontvangen[0] ? ontvangen[0].map((x) => x.toString(16).padStart(2, '0')).join(' ') : 'geen antwoord'}`);
        if (dev === 'lpd8') {
          r.push(`      model: ${model ?? 'onbekend'}`);
          if (prog && 'pads' in prog) r.push(`      programma 1: pads ${prog.pads.map((x) => x.note).join(',')} · knoppen CC ${prog.knoppen.map((x) => x.cc).join(',')}`);
        }
      } catch (e) {
        r.push(`      ✗ openen mislukt: ${/** @type {Error} */ (e).message}`);
      }
    }
  }
  const prof = laadLpd8Profiel();
  data.lpd8Profiel = prof ? prof.bron : null;
  r.push(`  LPD8-profiel: ${prof ? `${prof.bron} (lpd8-profiel.json)` : 'nog niet geleerd — draai de proef'}`);

  r.push('', 'Speelapparaten (PROTOCOL §17)');
  await speelapparaten({ config, systeem, hidLader, niProgrammas, wachtMs, hubDraait, r, data, ok, platform });

  r.push('', 'KP3+ en EFX-500 (MIDI-DIN via een USB-MIDI-interface; PROTOCOL §20, §21)');
  await kp3EnEfx({ config, systeem, wachtMs, hubDraait, r, data, ok });

  r.push('', 'Poorten van de hub');
  for (const [naam, poort, soort] of [['http/ws', config.poorten.http, 'tcp'], ['osc', config.poorten.osc, 'udp']]) {
    const v = await vrij(poort, /** @type {'tcp'|'udp'} */ (soort));
    data[`poort_${naam}`] = v;
    r.push(`  ${ok(v)} ${poort}/${soort} (${naam}) ${v ? 'vrij' : 'BEZET'}`);
  }
  r.push('', 'Bekende apps (draait er iets?)');
  data.apps = {};
  for (const [app, p] of Object.entries(config.bekende_apps)) {
    const aan = p.tcp ? await tcpOpen(p.tcp) : !(await vrij(p.udp, 'udp'));
    data.apps[app] = aan;
    r.push(`  ${aan ? '●' : '○'} ${app} ${p.tcp ? `:${p.tcp}/tcp` : `:${p.udp}/udp`}`);
  }
  return { tekst: r.join('\n'), data };
}

/** Programma's die zelf een intro naar de APC sturen (op macOS delen ze de poort en vechten ze om modus en lampjes). */
export const APC_PROGRAMMAS = Object.freeze([['Ableton Live', /Ableton Live|(^|\/)Live$/], ['Bitwig Studio', /Bitwig/]]);

/**
 * Welke van die programma's draaien er nu? Leest de proceslijst (`ps`); lukt dat niet, dan een lege lijst.
 * @param {() => string} [ps] tests geven een eigen lijst
 */
export function draaiendeApcProgrammas(ps = () => execFileSync('ps', ['-axo', 'comm'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) {
  let tekst = '';
  try { tekst = ps(); } catch { return []; }
  const regels = tekst.split('\n').map((x) => x.trim()).filter(Boolean);
  return APC_PROGRAMMAS.filter(([, re]) => regels.some((x) => re.test(x))).map(([naam]) => naam);
}

/** Wat te doen als de APC niets beantwoordt of niets stuurt. De mkII krijgt stroom via USB (geen adapter) en heeft een aan/uit-knop. */
export const APC_HINT = 'Kijk: de aan/uit-knop achterop aan; de kabel rechtstreeks in de Mac (of in een USB-hub met eigen voeding), of een andere kabel of poort; Ableton Live, Bitwig en Chrome-tabs met Varve DJ of av-kern zonder ?hub= helemaal dicht; draait de hub, stop hem dan voor deze test.';

/**
 * De APC-handdruk stap voor stap (protocol v1.2 tegenover Ableton Live), zodat zichtbaar is wát de APC beantwoordt.
 * Een ontbrekend antwoord op de intro (0x61) zegt nog niet dat de modus niet staat (alleen Akai's protocol noemt dat
 * antwoord): dan luistert doctor even naar Track Select (in de fabrieksmodus 0x40 stuurt die niets, in 0x41/0x42 noot 51).
 * @param {{ config: any, p: import('./ports/poort.js').Poort, ontvangen: number[][], alle: { n: number, laatste: number[][] },
 *   r: string[], data: any, ok: (b: boolean) => string, hubDraait: () => Promise<boolean>, apcLuisterMs: number,
 *   apcProgrammas: () => string[], vraag: (t: string) => void }} o
 */
async function apcHanddruk({ config, p, ontvangen, alle, r, data, ok, hubDraait, apcLuisterMs, apcProgrammas, vraag }) {
  const dev = 'apc40';
  const wacht = (ms = 600) => new Promise((res) => setTimeout(res, ms));
  /** @param {number[]} vraagBytes @param {(b: number[]) => boolean} past */
  const probeer = async (vraagBytes, past) => { const van = ontvangen.length; p.stuur(vraagBytes); await wacht(); return ontvangen.slice(van).find(past) ?? null; };
  const isId = (/** @type {number[]} */ b) => b[1] === 0x7e && b[3] === 0x06 && b[4] === 0x02;
  const isIntroAntw = (/** @type {number[]} */ b) => b[1] === 0x47 && b[3] === 0x29 && b[4] === 0x61;
  const hex = (/** @type {number[]} */ b) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');
  const andere = [...apcProgrammas()];
  if (await hubDraait()) andere.push(`de hub zelf (poort ${config.poorten.http})`);
  if (andere.length) r.push(`  ! draait nu: ${andere.join(', ')} — die sturen zelf een intro naar de APC; op de Mac delen ze de poort en vechten ze om modus en lampjes. Sluit ze voor een zuivere test`);
  const omni = ontvangen.find(isId) ?? null;
  // Nog eens omni, nu een halve seconde na het openen: antwoordt alleen deze, dan lag het aan de timing direct na het openen.
  const omniLater = await probeer([...A.IDENTITEIT_VRAAG], isId);
  const kanaal0 = await probeer([...A.IDENTITEIT_VRAAG_LIVE], isId);
  const ident = omni ?? omniLater ?? kanaal0;
  const id = A.apparaatIdUit(ident ?? []);
  const product = ident && ident.length > 6 ? ident[6] : null;
  const modus = config.apparaten.apc40.modus ?? A.MODUS.alternatief;
  const intro7f = await probeer(A.intro(modus), isIntroAntw);
  const introId = intro7f || id === null || id === A.BROADCAST ? null : await probeer(A.intro(modus, id), isIntroAntw);
  const intro0 = intro7f || introId || id === 0 ? null : await probeer(A.intro(modus, 0), isIntroAntw);
  const antwoord = !!(intro7f || introId || intro0);
  r.push(`      identiteit (omni, zoals het protocol, direct na openen): ${omni ? hex(omni) : 'geen antwoord'}`);
  r.push(`      identiteit (omni, 0,5 s later): ${omniLater ? hex(omniLater) : 'geen antwoord'}`);
  r.push(`      identiteit (kanaal 0, zoals Ableton Live): ${kanaal0 ? hex(kanaal0) : 'geen antwoord'}${id !== null ? ` · apparaat-id ${id}` : ''}`);
  if (product !== null) {
    r.push(`      product: 0x${product.toString(16)}${product === 0x29 ? ' (APC40 mkII)' : product === 0x73 ? ' — dat is de originele APC40, niet de mkII: die werkt anders en de hub kan hem niet bedienen' : ' — geen APC40 mkII (0x29)'}`);
  }
  r.push(`      modus-instructie (intro, id 0x7f): ${intro7f ? '✔ antwoord' : '✗ geen antwoord'}`);
  if (id !== null && id !== A.BROADCAST && !intro7f) r.push(`      modus-instructie (intro, id ${id}): ${introId ? '✔ antwoord' : '✗ geen antwoord'}`);
  if (!intro7f && !introId && id !== 0) r.push(`      modus-instructie (intro, id 0): ${intro0 ? '✔ antwoord' : '✗ geen antwoord'}`);
  // Geen antwoord op de intro: Track Select beslist.
  let trackSelect = false, invoer = 0;
  if (!antwoord && apcLuisterMs > 0) {
    const tekst = `      → druk nu op Track Select 1 en beweeg fader 1 (doctor luistert ${Math.round(apcLuisterMs / 100) / 10} s)`;
    r.push(tekst);
    vraag(tekst.trim());
    const n0 = alle.n, l0 = alle.laatste.length;
    await wacht(apcLuisterMs);
    invoer = alle.n - n0;
    trackSelect = alle.laatste.slice(l0).some(isModusBewijs);
  }
  const gezet = antwoord || trackSelect;
  data[dev].handdruk = { omni: omni ?? null, omniLater, kanaal0, apparaatId: id, product, intro7f: !!intro7f, introId: !!introId, intro0: !!intro0, trackSelect, invoerTijdensLuisteren: invoer, gezet };
  r.push(`      ontvangen van de APC: ${alle.n} berichten (${ontvangen.length} SysEx)`);
  if (antwoord) r.push(`  ${ok(true)} apc40 gaat in de hub-modus (0x${modus.toString(16)})`);
  else if (trackSelect) r.push(`  ${ok(true)} apc40: Track Select komt binnen, dus de hub-modus staat (deze APC antwoordt alleen niet op de intro; dat is niet erg)`);
  else if (invoer > 0) r.push(`  ${ok(false)} apc40: wel invoer, maar Track Select stuurt niets: hij staat nog in de fabrieksmodus (0x40). ${APC_HINT}`);
  else r.push(`  ${ok(false)} apc40: geen antwoord op de modus-instructie en er kwam niets binnen${apcLuisterMs > 0 ? ' (ook geen fader of knop)' : ''}. ${APC_HINT}`);
}

/**
 * KP3+ en EFX-500: alleen een MIDI-ingang, achter een USB-MIDI-interface (de poortnaam is die van de interface). Gevonden
 * of niet, met wat er in config.json staat. Van de EFX luistert doctor even naar de klok (als de hub niet draait: die
 * heeft de poort dan al) en zegt welk tempo hij meet. Er wordt niets naar de apparaten gestuurd.
 * @param {{ config: any, systeem: import('./ports/poort.js').Systeem|null, wachtMs: number, hubDraait: () => Promise<boolean>,
 *   r: string[], data: any, ok: (b: boolean) => string }} o
 */
async function kp3EnEfx({ config, systeem, wachtMs, hubDraait, r, data, ok }) {
  const ingangen = systeem ? systeem.lijst().ingangen : [];
  for (const [dev, label, patroon] of /** @type {const} */ ([['kp3plus', 'KP3+', KP3.patroon(config)], ['efx500', 'EFX-500', EFX.patroon(config)]])) {
    const cfg = config.apparaten?.[dev] ?? {};
    if (!patroon) { data[dev] = { inConfig: false }; r.push(`  - ${dev}: niet in config.json (apparaten.${dev}.poort_patroon) — de hub opent hem niet`); continue; }
    if (!systeem) { data[dev] = { naam: null }; r.push(`  ✗ ${dev}: geen MIDI (zie boven)`); continue; }
    const naam = zoekIngang({ ingangen }, patroon);
    data[dev] = { naam, patroon: cfg.poort_patroon };
    // Niet gevonden is geen fout: zonder KP3+ of EFX-500 speel je gewoon (tempo via tap), net als in check.
    r.push(naam ? `  ${ok(true)} ${dev} (${label}): ${naam}`
      : `  ○ ${dev} (${label}): niet aangesloten — zonder speel je gewoon${dev === 'efx500' ? ' (tempo via tap)' : ''}. Gebruik je hem wel: hij hangt aan een USB-MIDI-interface, dus zet een stukje van de naam van die ingang (zie de ingangen hierboven) in config.json → apparaten.${dev}.poort_patroon (nu "${cfg.poort_patroon}")`);
    if (dev === 'kp3plus') {
      const i = KP3.instellingen(config);
      const cc = (/** @type {number|null} */ n) => (n === null ? '–' : `CC ${n}`);
      data[dev].instellingen = i;
      r.push(`      X ${cc(i.cc.x)} · Y ${cc(i.cc.y)} · aanraken ${cc(i.cc.aanraak)} · kanaal ${i.kanaal === null ? 'elk' : i.kanaal + 1} · XY → ${i.xy.x} / ${i.xy.y}${i.hold ? ' · hold' : ''} (te meten: node src/cli.js proef kp3plus)`);
      continue;
    }
    if (!naam) continue;
    if (await hubDraait()) {
      data[dev].hubDraait = true;
      r.push(`  - klok niet gemeten: de hub draait (poort ${config.poorten.http}) en heeft de poort; het tempo staat in de cockpit (beeld.tempo)`);
      continue;
    }
    // Even luisteren naar de klok (een tel op 40 BPM duurt 1,5 s; standaard 2,5 × wachtMs).
    const meter = new KlokMeter();
    const t0 = performance.now();
    let anders = 0;
    try {
      const p = systeem.open(naam, { alleenIngang: true, metKlok: true });
      p.bijBericht((b) => { if (b[0] === EFX.KLOK.tik) meter.tik(performance.now()); else anders++; });
      await new Promise((res) => setTimeout(res, wachtMs * 2.5));
      p.sluit();
    } catch (e) {
      data[dev].fout = /** @type {Error} */ (e).message;
      r.push(`      ✗ openen mislukt: ${/** @type {Error} */ (e).message}`);
      continue;
    }
    const s = Math.round((performance.now() - t0) / 100) / 10;
    Object.assign(data[dev], { tikken: meter.tikken, bpm: meter.bpm, anders });
    r.push(meter.tikken === 0 ? `      geen klok in ${s} s — staat er muziek op de ingang (of tik TAP)? De EFX-500 stuurt alleen klok als hij een tempo heeft`
      : `      ${meter.tikken} kloktikken in ${s} s${meter.bpm !== null ? ` · ${meter.bpm} BPM` : ' · nog geen hele tel'}${anders ? ` · ook ${anders} andere berichten` : ''}`);
  }
}

/**
 * Xboard49 (een MIDI-ingang) en Maschine MK2 (USB-HID): gevonden, bezet, komt er invoer? De Maschine wordt kort
 * geopend (zoals de APC hierboven), en wat Clay moet doen staat erbij (NI-programma's, Invoermonitoring).
 * @param {{ config: any, systeem: import('./ports/poort.js').Systeem|null, hidLader: () => Promise<{ systeem: import('./ports/hid.js').HidSysteem|null, reden?: string }>,
 *   niProgrammas: () => string[], wachtMs: number, hubDraait: () => Promise<boolean>, r: string[], data: any, ok: (b: boolean) => string, platform: string }} o
 */
async function speelapparaten({ config, systeem, hidLader, niProgrammas, wachtMs, hubDraait, r, data, ok, platform }) {
  const xcfg = config.apparaten?.xboard49;
  const xpatroon = XB.patroon(config);   // zoals de hub: zonder naam doet de Xboard niet mee
  if (!xpatroon) r.push('  - xboard49: niet in config.json (apparaten.xboard49.naam) — de hub opent hem niet');
  else if (!systeem) r.push('  ✗ xboard49: geen MIDI (zie boven)');
  else {
    const naam = zoekIngang(systeem.lijst(), xpatroon);
    const xprof = laadXboardProfiel();
    data.xboard49 = { naam, profiel: xprof ? xprof.bron : null };
    r.push(`  ${ok(!!naam)} xboard49: ${naam ?? `niet gevonden (geen MIDI-ingang met "${xcfg.naam}" in de naam; zie de ingangen hierboven en zet een stukje van de naam in config.json → apparaten.xboard49.naam)`}`);
    r.push(`      knoppen: ${xprof ? `${xprof.bron} (xboard49-profiel.json)` : 'nog niet geleerd — node src/cli.js proef speelapparaten'}`);
  }
  const mcfg = config.apparaten?.['maschine-mk2'];
  if (!mcfg) { r.push('  - maschine-mk2: niet in config.json (apparaten.maschine-mk2)'); return; }
  const vid = parseInt(String(mcfg.vid), 16), pid = parseInt(String(mcfg.pid), 16);
  const hid = await hidLader();
  const ni = niProgrammas();
  data.maschine = { hid: !!hid.systeem, reden: hid.reden ?? null, ni };
  if (!hid.systeem) { r.push(`  ✗ maschine-mk2: geen HID: ${hid.reden} — npm install haalt node-hid binnen`); return; }
  /** @type {import('./ports/hid.js').HidApparaat[]} */
  let gevonden = [];
  try { gevonden = hid.systeem.apparaten().filter((a) => a.vid === vid && a.pid === pid); } catch (e) {
    data.maschine.fout = /** @type {Error} */ (e).message;
    r.push(`  ✗ maschine-mk2: HID-toestellen niet op te sommen (${/** @type {Error} */ (e).message})`);
    return;
  }
  data.maschine.gevonden = gevonden.map((a) => a.product ?? a.naam);
  r.push(`  ${ok(gevonden.length > 0)} maschine-mk2 (${mcfg.vid}:${mcfg.pid}): ${gevonden.length ? gevonden[0].product ?? 'gevonden' : 'niet gevonden — USB erin en aan?'}`);
  if (ni.length) r.push(`  ! draait nu: ${ni.join(', ')} — die kunnen de Maschine vasthouden; ${HINT.bezet}`);
  if (!gevonden.length) return;
  // Draait de hub, dan heeft die de Maschine (exclusief): openen zou "bezet" zeggen. Zijn status staat in de cockpit.
  if (await hubDraait()) {
    data.maschine.hubDraait = true;
    r.push(`  - niet geopend: de hub draait (poort ${config.poorten.http}) en heeft hem; zijn status staat in de cockpit (beeld.apparaten)`);
    return;
  }
  let frames = 0;
  try {
    const p = hid.systeem.open(gevonden[0].naam, { nietExclusief: mcfg.niet_exclusief === true });
    p.bijBericht(() => { frames++; });
    await new Promise((res) => setTimeout(res, wachtMs));
    p.sluit();
    data.maschine.frames = frames;
    r.push(frames > 0 ? `  ✔ invoer komt binnen (${frames} rapporten in ${wachtMs / 1000} s; in rust ±750 per seconde)`
      : `  ✗ open, maar er komt niets binnen — ${invoerHint(platform)}`);
  } catch (e) {
    // Linux zonder udev-regel: "Permission denied". Dat is geen ander programma: de udev-hint, niet de Mac-hint.
    if (isRechtenFout(e)) {
      data.maschine.rechten = /** @type {Error} */ (e).message;
      r.push(`  ✗ geen rechten: ${/** @type {Error} */ (e).message} — ${HINT.rechten}`);
    } else {
      data.maschine.bezet = /** @type {Error} */ (e).message;
      r.push(`  ✗ bezet: ${/** @type {Error} */ (e).message} — ${HINT.bezet}`);
    }
  }
  if (platform === 'darwin') r.push('  (Invoermonitoring: Systeeminstellingen → Privacy en beveiliging → Invoermonitoring; Terminal of iTerm aan.)');
}
