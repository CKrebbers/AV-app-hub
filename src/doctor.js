// @ts-check
// `varve-hub doctor`: één overzicht van de machine. Uitvoer is bedoeld om te plakken.
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import dgram from 'node:dgram';
import { zoekNaam, zoekIngang } from './ports/poort.js';
import { laadHid, draaiendeNi, HINT } from './ports/hid.js';
import { laadLpd8Profiel, laadXboardProfiel, HUB_MAP } from './config.js';
import * as XB from './devices/xboard49.js';
import * as A from './devices/apc40mk2.js';
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
 *   wachtMs?: number, hubDraait?: () => Promise<boolean> }} o  laadHid/niProgrammas/wachtMs/hubDraait: tests geven nep
 * @returns {Promise<{ tekst: string, data: any }>}
 */
export async function doctor({ config, laadMidi, laadHid: hidLader = laadHid, niProgrammas = () => draaiendeNi(), wachtMs = 600,
  hubDraait = async () => !(await vrij(config.poorten.http, 'tcp')) }) {
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
        p.bijBericht((b) => { if (b[0] === 0xf0) ontvangen.push(b); });
        p.stuur([...A.IDENTITEIT_VRAAG]);
        await new Promise((res) => setTimeout(res, 600));
        const model = dev === 'lpd8' ? ontvangen.map((b) => L.modelUit(b)).find(Boolean) ?? null : null;
        if (dev === 'lpd8' && model) { p.stuur(L.vraagProgramma(model, 1)); await new Promise((res) => setTimeout(res, 600)); }
        const prog = dev === 'lpd8' ? ontvangen.map((b) => L.ontleedProgramma(b)).find((x) => x && 'pads' in x) : null;
        p.sluit();
        data[dev].identiteit = ontvangen[0] ?? null;
        if (dev === 'lpd8') Object.assign(data[dev], { model, programma1: prog ?? null });
        r.push(`      identiteit: ${ontvangen[0] ? ontvangen[0].map((x) => x.toString(16).padStart(2, '0')).join(' ') : 'geen antwoord'}`);
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
  await speelapparaten({ config, systeem, hidLader, niProgrammas, wachtMs, hubDraait, r, data, ok });

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

/**
 * Xboard49 (een MIDI-ingang) en Maschine MK2 (USB-HID): gevonden, bezet, komt er invoer? De Maschine wordt kort
 * geopend (zoals de APC hierboven), en wat Clay moet doen staat erbij (NI-programma's, Invoermonitoring).
 * @param {{ config: any, systeem: import('./ports/poort.js').Systeem|null, hidLader: () => Promise<{ systeem: import('./ports/hid.js').HidSysteem|null, reden?: string }>,
 *   niProgrammas: () => string[], wachtMs: number, hubDraait: () => Promise<boolean>, r: string[], data: any, ok: (b: boolean) => string }} o
 */
async function speelapparaten({ config, systeem, hidLader, niProgrammas, wachtMs, hubDraait, r, data, ok }) {
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
      : `  ✗ open, maar er komt niets binnen — ${HINT.invoer}`);
  } catch (e) {
    data.maschine.bezet = /** @type {Error} */ (e).message;
    r.push(`  ✗ bezet: ${/** @type {Error} */ (e).message} — ${HINT.bezet}`);
  }
  r.push('  (Invoermonitoring: Systeeminstellingen → Privacy en beveiliging → Invoermonitoring; Terminal of iTerm aan.)');
}
