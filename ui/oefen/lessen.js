// @ts-check
// De lessen van de oefenruimte, en de "leraar" die bijhoudt waar je bent. Puur: geen DOM, geen timers.
// De leraar krijgt gebeurtenissen binnen en kijkt na elke gebeurtenis of de huidige stap gelukt is:
//   {soort:'beeld', beeld}  het cockpit-beeld van de hub (focus, slots, snapshots, globaal, pickup)
//   {soort:'invoer', g}     een controller-gebeurtenis (echt of virtueel), zoals de cockpit hem ziet
//   {soort:'app', app, b}   een bericht van de hub aan een oefen-app (zet/trig/focus/globaal)
//   {soort:'knop'}          de leerling drukte op "Begrepen" (alleen bij stappen met `knop`)
// Zo controleren de lessen wat er écht in de hub gebeurt, met dezelfde regels als op een avond.

import { maakIndeling, controlsVoor } from '../../src/core/indeling.js';
import { MANIFESTEN, ZON, ZEE } from './apps.js';
import { slewsVan } from '../opmaak.js';

/**
 * @typedef {{ soort: 'beeld', beeld: any } | { soort: 'invoer', g: any } | { soort: 'app', app: string, b: any } | { soort: 'knop' } | { soort: 'start' }} Gebeurtenis
 * @typedef {{
 *   beeld: any, ev: Gebeurtenis, mem: Record<string, any>, nu: number, focus: string|null,
 *   slot: (app: string) => string, naam: (app: string) => string, waar: (app: string, id: string) => string,
 *   acties: Acties,
 * }} Ctx
 * @typedef {{ zelfZetten?: (app: string, id: string, v: number) => void }} Acties
 * @typedef {{
 *   id: string, opdracht: (c: Ctx) => string, klaar: (c: Ctx) => boolean,
 *   begin?: (c: Ctx) => void, overslaanAls?: (c: Ctx) => boolean, hint?: string, knop?: string,
 *   wijs?: (c: Ctx) => string[],
 * }} Stap
 * @typedef {{ id: string, titel: string, intro: string, stappen: Stap[], geleerd: string }} Les
 */

// ── hulpjes voor de lessen ───────────────────────────────────────────────────

const INDELINGEN = { [ZON]: maakIndeling(MANIFESTEN[ZON]), [ZEE]: maakIndeling(MANIFESTEN[ZEE]) };

/** Zo lang telt een LPD8-druk als "lang" (bewaren). De hub zelf gebruikt 600 ms (LANG_MS in src/core/kern.js) op
 *  zijn eigen klok; de pagina meet bij aankomst van de invoer en kan dus iets afwijken. Daarom ruim erboven, en
 *  daaronder (tot TWIJFEL_MS) de vraag om een volle seconde vast te houden. */
const LANG_DRUK_MS = 750, TWIJFEL_MS = 450;
/** De oefening gebruikt snapshot 4 (pad 8): die overschrijft het minst waarschijnlijk iets van een echte avond. */
const OEFEN_SNAPSHOT = 4;

const RIJ_NAAM =['', 'onderste rij', '4e rij van boven', 'middelste rij', '2e rij van boven', 'bovenste rij'];

/** Een APC-control in gewone woorden. @param {string} ctrl */
export function beschrijfControl(ctrl) {
  let m;
  if ((m = /^fader(\d)$/.exec(ctrl))) return `fader ${m[1]}`;
  if ((m = /^dk(\d)$/.exec(ctrl))) return `device-knop ${m[1]} (rechts, onder "device control")`;
  if ((m = /^tk(\d)$/.exec(ctrl))) return `track-knop ${m[1]} (de bovenste rij draaiknoppen)`;
  if ((m = /^pad(\d)-(\d)$/.exec(ctrl))) return `de pad in kolom ${m[2]}, ${RIJ_NAAM[Number(m[1])]}`;
  return ctrl;
}

/** Waar staat parameter `id` van een oefen-app op de APC? @param {string} app @param {string} id */
export function waarOpApc(app, id) {
  const ind = INDELINGEN[app];
  if (!ind) return '?';
  const c = controlsVoor(ind, 0, id);
  if (!c.length) return '(niet op de APC)';
  const p = MANIFESTEN[app].params.find((x) => x.id === id);
  if (p?.soort === 'keuze') return `kolom ${/** @type {string} */ (/-(\d)$/.exec(c[0]))[1]} van het grid (${c.length} pads onder elkaar: ${p.keuzes?.join(', ')})`;
  return beschrijfControl(c[0]);
}

/** De controls (als 'apc:<id>') waar parameter `id` op staat: die lichten op de virtuele APC op. @param {string} app @param {string} id */
const apcVan = (app, id) => controlsVoor(INDELINGEN[app], 0, id).map((c) => `apc:${c}`);
/** @param {string} app @returns {(c: Ctx) => string[]} */
const bankEnSel = (app) => (c) => ['apc:bank', `apc:sel${c.slot(app)}`];

/** Heel kort, zoals op de virtuele APC (`fader 1`, `knop 1`, `pad 5·2`, `kolom 1`). @param {string} app @param {string} id */
export function kortWaar(app, id) {
  const c = INDELINGEN[app] ? controlsVoor(INDELINGEN[app], 0, id) : [];
  if (!c.length) return '';
  const p = MANIFESTEN[app].params.find((x) => x.id === id);
  let m;
  if (p?.soort === 'keuze' && (m = /-(\d)$/.exec(c[0]))) return `kolom ${m[1]}`;
  if ((m = /^fader(\d)$/.exec(c[0]))) return `fader ${m[1]}`;
  if ((m = /^dk(\d)$/.exec(c[0]))) return `device-knop ${m[1]}`;
  if ((m = /^tk(\d)$/.exec(c[0]))) return `track-knop ${m[1]}`;
  if ((m = /^pad(\d)-(\d)$/.exec(c[0]))) return `pad ${m[1]}·${m[2]}`;
  return c[0];
}

/** @param {Ctx} c @returns {{ app: string, b: any } | null} */
const appBericht = (c) => (c.ev.soort === 'app' ? { app: c.ev.app, b: c.ev.b } : null);

/** Een `zet` aan `app` voor `id`, eventueel alleen van een bepaalde bron. @param {Ctx} c @param {string} app @param {string} id @param {string} [bron] */
function zet(c, app, id, bron) {
  const m = appBericht(c);
  if (!m || m.app !== app || m.b.t !== 'zet' || m.b.id !== id) return null;
  if (bron && m.b.bron !== bron) return null;
  return /** @type {{ v: number, bron?: string }} */ (m.b);
}

/** Houd het bereik bij dat een waarde doorliep; geeft max - min. @param {Record<string, any>} mem @param {string} k @param {number} v */
function bereik(mem, k, v) {
  const b = mem[k] ?? (mem[k] = { min: v, max: v });
  b.min = Math.min(b.min, v); b.max = Math.max(b.max, v);
  return b.max - b.min;
}

/** Stap: deze app moet focus hebben (overgeslagen als hij die al heeft). @param {string} app @returns {Stap} */
const focusOp = (app) => ({
  id: `focus-${app}`,
  overslaanAls: (c) => c.focus === app,
  opdracht: (c) => `Geef eerst de <b>${c.naam(app)}</b> focus: houd <b>Bank</b> vast en druk <b>Track Select ${c.slot(app)}</b>.`,
  klaar: (c) => c.focus === app,
  wijs: bankEnSel(app),
  hint: 'Bank zit rechts, naast Shift. Track Select is de rij knoppen met cijfers 1–8, net onder de rij vierkante stop-knoppen.',
});

const zonEnZeeActief = (/** @type {any} */ beeld) => [ZON, ZEE].every((id) => beeld?.apps?.some((/** @type {any} */ a) => a.app === id && a.status === 'actief'));

// ── de lessen ────────────────────────────────────────────────────────────────

/** @type {Les[]} */
export const LESSEN = [
  {
    id: 'welkom',
    titel: 'Welkom: de hub',
    intro: 'De hub is het enige programma dat met je APC40 en LPD8 praat. Alle apps praten met de hub. '
      + 'Hier oefen je met twee eenvoudige apps, <b>Zon</b> en <b>Zee</b>, die precies zo met de hub praten als formula-lab of waterschaal. '
      + 'Geen controllers aangesloten? Gebruik de virtuele APC40 en LPD8 onderaan deze pagina: die sturen dezelfde signalen.',
    stappen: [{
      id: 'apps-actief',
      opdracht: () => 'Even wachten tot Zon en Zee verbonden zijn met de hub…',
      klaar: (c) => zonEnZeeActief(c.beeld),
      hint: 'Draait de hub? Start hem met npm start en herlaad deze pagina.',
    }],
    geleerd: 'Zon en Zee staan in de hub, elk met een eigen kleur en een vast <b>slot</b> (1–8). Dat slot gebruik je straks om een app te kiezen.',
  },
  {
    id: 'focus',
    titel: 'Focus: welke app bedien je met de APC?',
    intro: 'De APC bedient altijd één app tegelijk: de app met <b>focus</b>. Je kiest die met de <b>Bank</b>-knop (de hubtoets): '
      + 'zolang je Bank vasthoudt, toont de bovenste rij pads de apps in hun eigen kleur, en kies je een app met de <b>Track Select</b>-knoppen 1–8.',
    stappen: [
      {
        id: 'naar-ander',
        begin: (c) => { c.mem.doel = c.focus === ZEE ? ZON : ZEE; },
        opdracht: (c) => `Houd <b>Bank</b> vast, kijk naar de bovenste rij pads, en druk <b>Track Select ${c.slot(c.mem.doel)}</b> om de <b>${c.naam(c.mem.doel)}</b> focus te geven.`,
        klaar: (c) => c.focus === c.mem.doel,
        wijs: (c) => bankEnSel(c.mem.doel)(c),
        hint: 'Bank zit rechts, naast Shift. Track Select is de rij knoppen met cijfers 1–8, net onder de rij vierkante stop-knoppen.',
      },
      {
        id: 'terug',
        begin: (c) => { c.mem.doel = c.focus === ZEE ? ZON : ZEE; },
        opdracht: (c) => `Goed! Geef nu de <b>${c.naam(c.mem.doel)}</b> weer focus (Bank + Track Select ${c.slot(c.mem.doel)}).`,
        klaar: (c) => c.focus === c.mem.doel,
        wijs: (c) => bankEnSel(c.mem.doel)(c),
      },
    ],
    geleerd: '<b>Bank + Track Select</b> = van app wisselen. De app met focus pulseert in de bovenste padrij zolang je Bank vasthoudt.',
  },
  {
    id: 'fader',
    titel: 'Een fader bedient de app met focus',
    intro: 'De hub deelt de APC automatisch in voor de app met focus: faders voor de belangrijkste waarden, device-knoppen voor de rest, pads voor knoppen en keuzes.',
    stappen: [
      focusOp(ZON),
      {
        id: 'gloed',
        wijs: () => apcVan(ZON, 'gloed'),
        opdracht: (c) => `Schuif <b>${c.waar(ZON, 'gloed')}</b> helemaal op en neer. Dat is de <b>Gloed</b> van de Zon.`,
        klaar: (c) => { const z = zet(c, ZON, 'gloed', 'apc40'); return !!z && bereik(c.mem, 'gloed', z.v) >= 0.5; },
        hint: 'Reageert de zon niet meteen? Schuif de fader een keer helemaal heen en weer; waarom dat zo is, leer je in de volgende les.',
      },
      {
        id: 'grootte',
        wijs: () => apcVan(ZON, 'grootte'),
        opdracht: (c) => `En nu <b>${c.waar(ZON, 'grootte')}</b>: de <b>Grootte</b> van de Zon.`,
        klaar: (c) => { const z = zet(c, ZON, 'grootte', 'apc40'); return !!z && bereik(c.mem, 'grootte', z.v) >= 0.3; },
      },
    ],
    geleerd: 'Fader 1, 2, … zijn de belangrijkste waarden van de app met focus. De rechterkolom van deze pagina toont live wat de hub naar de app stuurt.',
  },
  {
    id: 'pickup',
    titel: 'Pickup: waarom een fader soms "niets doet"',
    intro: 'Een fader staat fysiek ergens, maar de app kan intussen een andere waarde hebben (iemand klikte in de app, of je wisselde van app). '
      + 'Om een sprong te voorkomen pakt de hub de fader pas op als hij <b>langs de huidige waarde</b> komt. Dat heet <b>pickup</b>.',
    stappen: [
      focusOp(ZON),
      {
        id: 'omlaag',
        wijs: () => apcVan(ZON, 'gloed'),
        opdracht: (c) => `Zet <b>${c.waar(ZON, 'gloed')}</b> (Gloed) helemaal <b>omlaag</b>.`,
        klaar: (c) => c.ev.soort === 'invoer' && c.ev.g?.el === 'fader1' && typeof c.ev.g.v === 'number' && c.ev.g.v <= 0.05,
      },
      {
        id: 'oppakken',
        wijs: () => apcVan(ZON, 'gloed'),
        begin: (c) => { c.acties.zelfZetten?.(ZON, 'gloed', 0.8); c.mem.vroeg = 0; },
        opdracht: () => 'Zojuist "klikte iemand in de app": de Gloed staat nu op <b>80%</b>, maar je fader staat onderaan. '
          + 'Schuif fader 1 <b>langzaam omhoog</b>. Tot ongeveer 80% gebeurt er niets; daar pakt de fader de zon op en vanaf dan beweegt hij mee.',
        klaar: (c) => {
          if (c.ev.soort === 'invoer' && c.ev.g?.el === 'fader1' && typeof c.ev.g.v === 'number' && c.ev.g.v < 0.7) c.mem.vroeg++;
          const z = zet(c, ZON, 'gloed', 'apc40');
          // Een fader-zet van vlak vóór de "klik in de app" kan nog onderweg zijn en de 80% overschrijven:
          // dan zet de app hem opnieuw (een niet-gevangen fader stuurt verder niets).
          if (z && z.v < 0.6) { c.acties.zelfZetten?.(ZON, 'gloed', 0.8); return false; }
          return !!z && c.mem.vroeg > 0;
        },
        hint: 'De balk "fader 1" in de rechterkolom toont waar je fader staat en waar de app staat. Pas als ze elkaar raken, pakt de fader op.',
      },
    ],
    geleerd: 'Doet een fader niets? Beweeg hem naar de waarde van de app toe: zodra hij er langs komt, pakt hij op. Hetzelfde geldt na het wisselen van app.',
  },
  {
    id: 'knop',
    titel: 'Device-knoppen en hun lichtring',
    intro: 'De acht device-knoppen rechts op de APC zijn voor de overige waarden van de app. Om elke knop zit een <b>lichtring</b> die de waarde toont, ook als die van ergens anders verandert.',
    stappen: [
      focusOp(ZON),
      {
        id: 'draai',
        wijs: () => apcVan(ZON, 'draai'),
        opdracht: (c) => `Draai aan <b>${c.waar(ZON, 'draai')}</b>: de Zon draait mee, en de ring om de knop loopt mee.`,
        klaar: (c) => { const z = zet(c, ZON, 'draai', 'apc40'); return !!z && bereik(c.mem, 'draai', z.v) >= 0.3; },
      },
    ],
    geleerd: 'Device-knoppen = de tweede laag waarden. De ring laat altijd de echte waarde zien.',
  },
  {
    id: 'pads',
    titel: 'Pads: aan/uit, flitsen en keuzes',
    intro: 'Het grid van pads is voor knoppen: een <b>schakelaar</b> (aan/uit), een <b>trigger</b> (zolang je drukt) en <b>keuzes</b> (een kolom pads, één per optie). De lampjes tonen de stand.',
    stappen: [
      focusOp(ZON),
      {
        id: 'stralen',
        wijs: () => apcVan(ZON, 'stralen'),
        opdracht: (c) => `Druk <b>${c.waar(ZON, 'stralen')}</b>: de <b>Stralen</b> gaan uit (of aan). Nog eens drukken zet ze terug.`,
        klaar: (c) => !!zet(c, ZON, 'stralen', 'apc40'),
      },
      {
        id: 'flits',
        wijs: () => apcVan(ZON, 'flits'),
        opdracht: (c) => `Druk <b>${c.waar(ZON, 'flits')}</b> voor een <b>Flits</b>: die duurt zolang je drukt.`,
        klaar: (c) => { const m = appBericht(c); return !!m && m.app === ZON && m.b.t === 'trig' && m.b.id === 'flits' && m.b.aan === true; },
      },
      {
        id: 'tint',
        begin: (c) => { c.mem.van = c.beeld?.apps?.find((/** @type {any} */ a) => a.app === ZON)?.waarden?.tint; },
        wijs: () => apcVan(ZON, 'tint'),
        opdracht: (c) => `Kies een andere <b>Tint</b>: ${c.waar(ZON, 'tint')}.`,
        klaar: (c) => { const z = zet(c, ZON, 'tint', 'apc40'); return !!z && z.v !== c.mem.van; },
      },
    ],
    geleerd: 'Pads volgen de app: met een andere app in focus betekenen ze iets anders. Stop All (rechts naast de stop-knoppen) is de paniek van de app met focus.',
  },
  {
    id: 'wisselen',
    titel: 'Wisselen: dezelfde fader, een andere app',
    intro: 'Nu zie je waarom focus zo handig is: met dezelfde handgrepen bedien je na een wissel een heel andere app.',
    stappen: [
      focusOp(ZEE),
      {
        id: 'golf',
        wijs: () => apcVan(ZEE, 'golf'),
        opdracht: (c) => `De Zee heeft nu focus. Schuif <b>${c.waar(ZEE, 'golf')}</b>: nu bedien je de <b>Golf</b> van de Zee. (Pakt hij niet meteen op? Dat is pickup.)`,
        klaar: (c) => !!zet(c, ZEE, 'golf', 'apc40'),
      },
      {
        id: 'schuim',
        wijs: () => apcVan(ZEE, 'schuim'),
        opdracht: (c) => `En <b>${c.waar(ZEE, 'schuim')}</b> is nu het <b>Schuim</b>.`,
        klaar: (c) => !!zet(c, ZEE, 'schuim', 'apc40'),
      },
    ],
    geleerd: 'Fader 1 was Gloed bij de Zon en is Golf bij de Zee. De cockpit en deze pagina laten altijd zien wat waar zit.',
  },
  {
    id: 'lpd8',
    titel: 'De LPD8: één knop voor alle apps',
    intro: 'De LPD8 werkt altijd, los van focus. Zijn acht knoppen zijn <b>rollen</b>: K1 intensiteit, K2 helderheid, K3 ruimte, K4 beweging, K5 kleur, K6 dichtheid, K7 adem, K8 balans. '
      + 'Elke app zegt zelf welke van zijn waarden bij welke rol hoort. Draai je aan een rol, dan gaan alle apps met die rol tegelijk mee.',
    stappen: [{
      id: 'k2', wijs: () => ['lpd:k2'],
      opdracht: () => 'Draai <b>K2 (helderheid)</b> op de LPD8, de tweede knop in de bovenste rij. Kijk: de <b>Gloed</b> van de Zon én de <b>Diepte</b> van de Zee bewegen samen.',
      klaar: (c) => {
        if (zet(c, ZON, 'gloed', 'lpd8')) c.mem.zon = true;
        if (zet(c, ZEE, 'diepte', 'lpd8')) c.mem.zee = true;
        return !!(c.mem.zon && c.mem.zee);
      },
      hint: 'Ook LPD8-knoppen hebben pickup: draai K2 eens helemaal van links naar rechts.',
    }],
    geleerd: 'APC = één app, precies. LPD8 = alle apps tegelijk, op gevoel. Welke app wat met een rol doet, bepaalt de app.',
  },
  {
    id: 'slew',
    titel: 'Slew: zachte overgangen',
    intro: 'Sommige apps willen geen sprongen (een trage synth zou klikken). Zo\'n app geeft een <b>slew</b>-tijd op, en de hub laat waarden die híj zet daarover glijden. '
      + 'De Galm van de Zee heeft 3 seconden. Directe APC-bewegingen glijden niet: die moeten direct voelen.',
    stappen: [{
      id: 'k3', wijs: () => ['lpd:k3'],
      opdracht: () => 'Draai <b>K3 (ruimte)</b> snel een flink eind, en laat dan los. Kijk naar de <b>Galm</b> van de Zee: die glijdt nog even door nadat je hand stilstaat.',
      klaar: (c) => {
        if (c.ev.soort === 'invoer' && c.ev.g?.dev === 'lpd8' && c.ev.g.el === 'k3') c.mem.handStil = c.nu;
        const z = zet(c, ZEE, 'galm', 'lpd8');
        return !!z && c.mem.handStil !== undefined && c.nu - c.mem.handStil >= 800;
      },
      hint: 'Pickup: draai K3 eerst eens helemaal heen en weer, dan een snelle draai en loslaten.',
    }],
    geleerd: 'Slew geldt voor alles wat de hub zelf zet: LPD8, snapshots, de cockpit. Zo klinkt een snapshot laden als een overgang, niet als een klap.',
  },
  {
    id: 'snapshot',
    titel: 'Snapshots: een moment bewaren',
    intro: 'Een <b>snapshot</b> is de stand van álle apps tegelijk. Op de LPD8 zijn pad 5–8 snapshot 1–4: <b>lang drukken = bewaren</b>, <b>kort drukken = terugzetten</b>. '
      + '(Op de APC: Bank + Scene 1–5 laadt, Bank + Shift + Scene bewaart.)',
    stappen: [
      {
        id: 'bewaren', wijs: () => ['lpd:p8'],
        begin: (c) => { c.mem.hadAl = (c.beeld?.snapshots ?? []).includes(OEFEN_SNAPSHOT); },
        opdracht: (c) => 'Houd <b>pad 8</b> op de LPD8 (bovenste rij, rechts) een seconde vast: snapshot 4 bewaart de huidige stand.'
          + (c.mem.twijfel ? ' <b>Dat was net te kort: houd hem een volle seconde vast.</b>' : '')
          + (c.mem.hadAl ? ' <i>(Je hebt al een snapshot 4: die wordt overschreven. Liever niet? Sla deze les over.)</i>' : ''),
        klaar: (c) => {
          if (c.ev.soort === 'invoer' && c.ev.g?.dev === 'lpd8' && c.ev.g.el === 'p8') {
            if (c.ev.g.kind === 'druk') c.mem.sinds = c.nu;
            else if (c.ev.g.kind === 'los' && c.mem.sinds !== undefined) {
              const ms = c.nu - c.mem.sinds;
              c.mem.lang = ms >= LANG_DRUK_MS;
              c.mem.twijfel = !c.mem.lang && ms >= TWIJFEL_MS;
            }
          }
          return !!c.mem.lang && (c.beeld?.snapshots ?? []).includes(OEFEN_SNAPSHOT);
        },
        hint: 'Echt een volle seconde vasthouden: kort drukken laadt, lang drukken bewaart.',
      },
      {
        id: 'veranderen',
        opdracht: () => 'Verander nu flink iets: schuif een fader, draai een LPD8-knop, wat je wilt.',
        klaar: (c) => {
          const m = appBericht(c);
          if (m && m.b.t === 'zet' && (m.b.bron === 'apc40' || m.b.bron === 'lpd8')) c.mem.n = (c.mem.n ?? 0) + 1;
          return (c.mem.n ?? 0) >= 5;
        },
      },
      {
        id: 'laden', wijs: () => ['lpd:p8'],
        opdracht: () => 'Druk <b>pad 8</b> nu <b>kort</b>: alles gaat terug naar de bewaarde stand (de Galm van de Zee glijdt terug).',
        klaar: (c) => { const m = appBericht(c); return !!m && m.b.t === 'zet' && m.b.bron === 'snapshot'; },
      },
    ],
    geleerd: 'Bewaar een snapshot zodra iets mooi is, dan kun je altijd terug. De hub onthoudt snapshots ook na een herstart.',
  },
  {
    id: 'paniek',
    titel: 'Paniek: alles rustig',
    intro: 'Gaat er iets mis (te hard, te fel)? <b>Pad 1</b> van de LPD8 <b>een seconde vasthouden</b> is paniek: elke app doet zijn eigen "rustig nu". '
      + 'Kort drukken doet niets, zodat je het niet per ongeluk raakt.',
    stappen: [
      {
        id: 'vast', wijs: () => ['lpd:p1'],
        opdracht: () => 'Houd <b>pad 1</b> (onderste rij, links) een seconde vast. De Zon dooft, de Zee wordt stil.',
        klaar: (c) => {
          const m = appBericht(c);
          if (m && m.b.t === 'trig' && m.b.id === 'paniek' && m.b.aan === true) c.mem[m.app] = true;
          return !!(c.mem[ZON] && c.mem[ZEE]);
        },
        hint: 'Echt een volle seconde vasthouden.',
      },
      {
        id: 'los', wijs: () => ['lpd:p1'],
        opdracht: () => 'Laat pad 1 los: de paniek is voorbij.',
        // Ook als de hub de paniek voorbij meldt zonder trig (bv. na een herstart van de hub midden in de paniek).
        klaar: (c) => {
          const m = appBericht(c);
          if (m && m.b.t === 'trig' && m.b.id === 'paniek' && m.b.aan === false) return true;
          return c.ev.soort === 'beeld' && Number(c.beeld?.globaal?.paniek ?? 0) === 0;
        },
      },
    ],
    geleerd: 'Pad 1 vasthouden = paniek voor alle apps. Stop All op de APC = paniek voor alleen de app met focus.',
  },
  {
    id: 'tempo',
    titel: 'Tempo en adem',
    intro: 'De hub heeft twee klokken die alle apps krijgen: een <b>tempo</b> (bpm) en een <b>adem</b> (een langzame golf, standaard 10 s per ademhaling). '
      + '<b>Pad 2</b> is tap-tempo, <b>K7</b> zet de lengte van de adem, <b>pad 3</b> laat de adem opnieuw beginnen.',
    stappen: [
      {
        id: 'tap', wijs: () => ['lpd:p2'],
        begin: (c) => { c.mem.bpm = c.beeld?.globaal?.bpm; },
        opdracht: () => 'Tik een paar keer op <b>pad 2</b>, rustig in de maat. Het tempo onder het tafereel verandert.',
        klaar: (c) => typeof c.beeld?.globaal?.bpm === 'number' && c.beeld.globaal.bpm !== c.mem.bpm,
        hint: 'Minstens twee tikken, niet te ver uit elkaar.',
      },
      {
        id: 'adem', wijs: () => ['lpd:k7'],
        begin: (c) => { c.mem.adem = c.beeld?.globaal?.['klok.adem_periode']; },
        opdracht: () => 'Draai <b>K7 (adem)</b>, de derde knop in de onderste rij: de adem onder het tafereel wordt langer of korter, en de hemel ademt mee.',
        klaar: (c) => { const v = c.beeld?.globaal?.['klok.adem_periode']; return typeof v === 'number' && v !== c.mem.adem; },
      },
    ],
    geleerd: 'Tempo en adem gelden voor alle apps. Apps die er iets mee doen (waterschaal, medisynth) lopen dan in de pas.',
  },
  {
    id: 'opname',
    titel: 'De avond opnemen',
    intro: '<b>Pad 4</b> zet het opnemen aan en uit. De hub schrijft dan alles wat je doet weg in <code>~/Movies/varve-avonden/&lt;datum-tijd&gt;/</code>. '
      + 'Met <code>npm run herhaal -- &lt;map&gt;</code> speel je die avond later terug. Hier hoef je het niet te proberen (het schrijft echt naar je schijf).',
    stappen: [{ id: 'begrepen', wijs: () => ['lpd:p4'], knop: 'Begrepen', opdracht: () => 'Lees het even door en druk op <b>Begrepen</b>.', klaar: (c) => c.ev.soort === 'knop' }],
    geleerd: 'Pad 4 = opnemen. Handig om na afloop terug te zien wat je deed, of om een mooie avond te bewaren.',
  },
  {
    // Achteraan, zodat de andere lessen hun nummer houden (docs/OEFENEN.md, de tests).
    id: 'glijden',
    titel: 'Glijden zien: waarom het zacht gaat',
    intro: 'Laad je een snapshot of draai je een LPD8-knop, dan zet niet jouw hand de waarde, maar de <b>hub</b>. '
      + 'Heeft een app een slew-tijd (de Galm van de Zee: 3 s), dan laat de hub zo\'n waarde naar het nieuwe doel <b>glijden</b>: '
      + 'een snapshot zet alles tegelijk om zonder klap. Alleen een directe APC-fader of -knop glijdt niet: daar is je hand zelf de overgang. '
      + 'Bij Zon en Zee (en in de cockpit) zie je het aan het <b>glij-teken</b>: een streep op het doel en <b>→ doel · resttijd</b>.',
    stappen: [
      {
        id: 'glijdt', wijs: () => ['lpd:k3'],
        opdracht: () => 'Draai <b>K3 (ruimte)</b> snel een flink eind. Kijk bij de <b>Galm</b> van de Zee: het glij-teken toont waar hij heen gaat en hoe lang hij nog glijdt.',
        klaar: (c) => c.ev.soort === 'beeld' && slewsVan(c.beeld, ZEE).has('galm'),
        hint: 'Pickup: draai K3 eerst eens helemaal heen en weer, dan een snelle draai.',
      },
      {
        id: 'aangekomen',
        opdracht: () => 'Laat K3 los en wacht: de resttijd telt af, en zodra de Galm op het doel is, verdwijnt het teken.',
        klaar: (c) => c.ev.soort === 'beeld' && !!c.beeld?.apps?.length && !slewsVan(c.beeld, ZEE).has('galm'),
      },
    ],
    geleerd: 'Glijdt iets nog, dan staat het doel al vast: de hub is het met je eens, alleen de app is er nog niet. Snapshots, LPD8 en de cockpit glijden; een directe APC-beweging niet.',
  },
];

/** Korte spiekbrief: alles op één plek. */
export const SPIEKBRIEF = [
  ['Bank + Track Select 1–8', 'app kiezen (focus)'],
  ['Faders, device-knoppen, pads', 'de app met focus bedienen'],
  ['Fader doet niets', 'pickup: beweeg hem langs de waarde van de app'],
  ['Stop All', 'paniek van de app met focus'],
  ['Bank + Scene 1–5', 'snapshot laden (Bank + Shift + Scene = bewaren)'],
  ['LPD8 K1–K8', 'rollen voor alle apps: intensiteit, helderheid, ruimte, beweging, kleur, dichtheid, adem, balans'],
  ['LPD8 pad 1 (1 s vasthouden)', 'paniek, alle apps'],
  ['LPD8 pad 2 / pad 3', 'tap-tempo / adem opnieuw'],
  ['LPD8 pad 4', 'avond opnemen aan/uit'],
  ['LPD8 pad 5–8', 'snapshot 1–4: kort = laden, lang = bewaren'],
];

// ── de leraar ────────────────────────────────────────────────────────────────

/**
 * Houdt bij in welke les en stap je zit, en schuift door als een stap lukt.
 * `bij(fn)` meldt elke verandering (voor de pagina).
 */
export class Leraar {
  /** @param {{ lessen?: Les[], acties?: Acties, nu?: () => number, klaar?: string[] }} [o] */
  constructor({ lessen = LESSEN, acties = {}, nu = () => Date.now(), klaar = [] } = {}) {
    this.lessen = lessen;
    this.acties = acties;
    this.nu = nu;
    /** @type {any} */ this.beeld = null;
    this.lesIndex = 0;
    this.stapIndex = 0;
    this.lesKlaar = false;
    /** @type {Record<string, any>} */ this.mem = {};
    /** @type {Set<string>} les-ids die al eens gelukt zijn */
    this.gehaald = new Set(klaar);
    /** @type {Set<() => void>} */ this.luisteraars = new Set();
    this.begonnen = false;
  }

  /** @param {() => void} fn @returns {() => void} */
  bij(fn) { this.luisteraars.add(fn); return () => this.luisteraars.delete(fn); }
  #meld() { for (const f of this.luisteraars) f(); }

  get les() { return this.lessen[this.lesIndex]; }
  get stap() { return this.lesKlaar ? null : this.les.stappen[this.stapIndex] ?? null; }

  /** @param {Gebeurtenis} ev @returns {Ctx} */
  #ctx(ev) {
    const apps = this.beeld?.apps ?? [];
    const app = (/** @type {string} */ id) => apps.find((/** @type {any} */ a) => a.app === id);
    return {
      beeld: this.beeld, ev, mem: this.mem, nu: this.nu(), focus: this.beeld?.focus ?? null,
      // Alleen eigen teksten in de opdracht (die gaat als HTML de pagina in): de naam uit het eigen manifest,
      // het slot als getal. Een app die zich als oefen-zee meldt met een rare naam, komt er zo niet in.
      slot: (id) => { const s = Number(app(id)?.slot); return Number.isInteger(s) && s > 0 ? String(s) : '?'; },
      naam: (id) => MANIFESTEN[id]?.naam ?? '?',
      waar: waarOpApc,
      acties: this.acties,
    };
  }

  /** Begin (of herbegin) les i. @param {number} i */
  gaNaar(i) {
    this.lesIndex = Math.max(0, Math.min(this.lessen.length - 1, i));
    this.stapIndex = 0;
    this.lesKlaar = false;
    this.begonnen = true;
    this.#beginStap();
    this.#meld();
  }

  /** Naar de volgende les (na "Volgende"). */
  volgende() { if (this.lesIndex < this.lessen.length - 1) this.gaNaar(this.lesIndex + 1); }

  /** Is dit de laatste les, en is die klaar? */
  get allesKlaar() { return this.lesKlaar && this.lesIndex === this.lessen.length - 1; }

  #beginStap() {
    // Stappen die al vervuld zijn (bv. de app heeft al focus) slaan we over.
    for (;;) {
      const s = this.stap;
      if (!s) return;
      this.mem = {};
      const c = this.#ctx({ soort: 'start' });
      if (s.overslaanAls?.(c)) { this.#volgendeStap(false); continue; }
      s.begin?.(c);
      return;
    }
  }

  /** @param {boolean} [begin] */
  #volgendeStap(begin = true) {
    this.stapIndex++;
    if (this.stapIndex >= this.les.stappen.length) {
      this.lesKlaar = true;
      this.gehaald.add(this.les.id);
      return;
    }
    if (begin) this.#beginStap();
  }

  /** Verwerk één gebeurtenis. @param {Gebeurtenis} ev */
  verwerk(ev) {
    const eersteBeeld = ev.soort === 'beeld' && !this.beeld;
    if (ev.soort === 'beeld') this.beeld = ev.beeld;
    if (!this.begonnen) return;
    // Begon de les vóór het eerste beeld (bij het laden van de pagina), dan legden begin() en overslaanAls()
    // nog niets vast (focus, tempo, snapshots onbekend): nu de stap opnieuw beginnen.
    if (eersteBeeld && !this.lesKlaar) { this.#beginStap(); this.#meld(); return; }
    const s = this.stap;
    if (!s) { if (ev.soort === 'beeld') this.#meld(); return; }
    let gelukt = false;
    try { gelukt = s.klaar(this.#ctx(ev)); } catch (e) { console.error(e); }
    if (gelukt) this.#volgendeStap();
    if (gelukt || ev.soort === 'beeld') this.#meld();
  }

  /** Na een focusstap in deze les: is de focus intussen naar een andere app gegaan? Dan eerst dat zeggen. @param {Ctx} c */
  #focusWaarschuwing(c) {
    const i = this.les.stappen.findIndex((s) => s.id.startsWith('focus-'));
    if (i < 0 || this.stapIndex <= i || !c.beeld) return '';
    const app = this.les.stappen[i].id.slice('focus-'.length);
    return c.focus === app ? '' : `<span class="focus-weg">De <b>${c.naam(app)}</b> heeft geen focus meer: Bank + Track Select ${c.slot(app)}.</span> `;
  }

  /** Wat de pagina moet tonen. */
  toestand() {
    const les = this.les;
    const c = this.#ctx({ soort: 'start' });
    return {
      lesIndex: this.lesIndex, aantal: this.lessen.length, les,
      stapIndex: this.stapIndex, lesKlaar: this.lesKlaar, allesKlaar: this.allesKlaar,
      opdracht: this.stap ? this.#focusWaarschuwing(c) + this.stap.opdracht(c) : null,
      hint: this.stap?.hint ?? null,
      knop: this.stap?.knop ?? null,
      wijs: this.stap?.wijs ? this.stap.wijs(c) : [],
      gehaald: [...this.gehaald],
    };
  }
}
