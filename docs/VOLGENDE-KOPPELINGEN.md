# Volgende koppelingen — onderzoek (golf 5)

*4 okt 2026 · onderzoek, geen code in de apps. Gelezen (alleen lezen, niets gewijzigd): td-lab `d674a86`,
varve-radio `893619c`, musicgen-video-glitch `68869a2`, anbernic-cam `016d995`, sediment `2301486`,
uurwerk `b7972c1`, av-scene-kit `0c3a35d`, flux-screensaver tak `claude/varve-hub-koppeling` (`ac8070e`),
hub `a28f0a3`. Verwijzingen zijn `repo/pad:regel`. Paden die beginnen met `src/`, `apps/`, `sets/`, `tools/`, `test/` of `docs/`, en `config.json`/`PROTOCOL.md`/`STATUS.md`/`IDEEEN.md`/`ONDERZOEK.md`, zijn van de hub; binnen de sectie van een project is een ander kaal pad (`uur.js:122`, `:1824`) van dat project.
De voorstellen voor manifesten hieronder worden door `test/volgende-koppelingen.test.js` gevalideerd
tegen `src/protocol/manifest.js` (en, waar de driver al bestaat, tegen `valideerStatisch`). Aanvullingen op een
bestaand `apps/<app>.json` (`"params+"`, `"driver.map+"`, `"driver.presets+"`: `+` = toevoegen aan wat er staat) past
de test toe op dat bestand en valideert het resultaat; het codeblok van §2.3 draait de test met nep-functies.
Dragende regelverwijzingen worden op inhoud gecontroleerd (hub altijd; andere repo's alleen als ze op deze computer
staan, anders "overgeslagen").*

---

## 0. In het kort

| Project | Nu in de hub | Beste koppelvorm | Code in de app? | Werk | Eerst nodig |
|---|---|---|---|---|---|
| **varve-radio** | niets | eerst het **takeover-lek dichten**; daarna hooguit een lokale manifest-app (mengpaneel) | ja, klein (1 bestand, achter `?hub=`) | lek S · koppeling M | Clay's OK + één deploy |
| **uurwerk** | HTTP-driver, werkt | driver houden; **paniek** erbij (alleen manifest) en **teruglezen** (driver leest `toon`) | nee | S + M | — |
| **av-scene-kit** | MIDI-driver, actueel | driver houden; **paniek-pad** in TD | ja, TD-hub (1 tak in `td_build_hub.py`) | S | TD-sessie van av-scene-kit |
| **sediment** | MIDI-driver, actueel | driver houden; paniek = CC 123 (in de generator) | nee (Logic-instelling) | S-M | proef in Logic |
| **td-lab** | niets (config zegt "osc", die bestaat niet) | **driver in de hub** over de bestaande exec-bridge (:9981) | nee | M | `/genesis` gebouwd in TD |
| **anbernic-cam** | niets (IDEEEN.md) | eerst **app** op de Mac (WS `/app`); later **bron** via `/cockpit` over wifi | ja, 1 nieuw Python-bestand | M · M | hardware-avond, USB-vraag |
| **musicgen-video-glitch** | niets | **geen live koppeling**; naverwerking van de avondmap (`gebaren.jsonl` → prompts) | ja, 1 script in dat repo | S-M | eerst de bekende bugs |

**Over het "takeover-lek" van varve-radio:** varve-radio bevat **geen enkele regel MIDI** (geen `requestMIDIAccess`,
geen APC, geen WebSocket — `grep -rniE "midi|apc|requestMIDI|sysex|websocket"` over het hele repo geeft niets).
Huisregel 1 wordt daar dus niet geschonden. Het lek is de **overname van de zender**: iedereen met de publieke
anon-key kan de uitzending voor alle luisteraars verzetten (ONDERZOEK.md §3 punt 9). Precieze plek, gevolg en
kleinste herstel: §2.3.

---

## 1. Hoe koppelen — de vier vormen (samengevat uit PROTOCOL.md)

| Vorm | Wanneer | Wat de app moet kunnen | Waar het zit |
|---|---|---|---|
| **manifest-app** via WS `/app` | app kan een WebSocket openen en zijn waarden melden | `hallo` + `manifest` + `staat`, `zet`/`trig` uitvoeren | PROTOCOL §3–§4, `src/transports/server.js` |
| **driver** in de hub | app kan zich niet aanmelden (TD, Logic, HTTP-API) | niets; de hub spreekt de taal van de app | PROTOCOL §2, `src/drivers/`, `apps/<app>.json` |
| **lease** | app heeft al een complete APC-stack | ruwe MIDI ontvangen, LED-bytes terug | PROTOCOL §5 (Varve DJ, av-kern) |
| **OSC/MIDI** | — | — | MIDI = de driver van nu. **OSC bestaat niet in de hub**: 7701 komt alleen voor in `src/doctor.js:91` (poortcheck); er is geen luisteraar. Een OSC-koppeling vraagt dus eerst een nieuw transport. Let op: `PROTOCOL.md:19` belooft nog wel "hub luistert op 7701" (bijwerken bij §6.5). |

Nieuwe driver-soorten komen bij `src/drivers/index.js:26` (`DRIVER_SOORTEN`) en `:33-41` (`maakDriver`), plus
een eigen bestand naast `midi.js`/`http.js` en de validatie in `valideerStatisch`.

**Paniek in het algemeen.** De kern stuurt `trig paniek` alleen naar apps die een trigger met id `paniek` in hun
manifest hebben (`src/core/kern.js:727-732`; Stop All: `src/core/kern.js:642`). Geen enkele driver-app heeft die nu
(`apps/*.json`), en beide drivers negeren `globaal` (`src/drivers/midi.js:209`, `src/drivers/http.js:156`).
**LPD8-P1 doet nu dus niets voor TD, Sediment en uurwerk.** Daarom staat paniek bij elk project hieronder.

---

## 2. varve-radio

### 2.1 Wat het is en hoe het draait
- Deterministische 24-uurszender op https://varve.nl/radio/: iedereen hoort op hetzelfde klokmoment hetzelfde;
  het dagschema komt uit een zaad (`varve-radio/files Varve Radio/CLAUDE.md`).
- **Eén HTML-bestand** zonder build: `files Varve Radio/varve-radio-v2.LIVE.html` (2153 regels), plus Supabase
  (tabellen met RLS, realtime-kanaal `radio`). Supabase-js komt van jsdelivr (`:1795`). Geen lokale poort: statisch
  gehost bij TransIP (`deploy-radio.sh`).
- UI: zenderband, kanaalkeuze (12 kanalen), mengpaneel met een tweede laag: `volA`/`volB` 0–100 (`:329`, `:345`,
  `:882`), snelheden `[0.75,1,1.25,1.5,2]` (`:887`), alles per luisteraar in localStorage. Beheer (Bestuur) alleen voor
  `CONFIG.ADMIN_EMAIL` (`:521`).
- Testen: `python3 tests/draai.py` (184 controles; functies worden vers uit het LIVE-bestand gehaald,
  `tests/suites.json`).

### 2.2 Huidige hub-stand
Niets. Niet in `config.json`, geen manifest, geen driver. Alleen genoemd in ONDERZOEK.md §2, §3 punt 9 en §7
("**nooit** via de `zender`-broadcast; eerst het lek dichten").

### 2.3 Het takeover-lek — waar, wat, kleinste herstel

**Waar** (`varve-radio/files Varve Radio/varve-radio-v2.LIVE.html`):

| Regel | Wat er staat |
|---|---|
| `:520` | de anon-key staat in de paginabron (zo hoort het bij Supabase; daarom moet alles wat iedereen raakt achter RLS) |
| `:1822` | `this.sb.channel('radio', …)` — een **publiek** broadcast-kanaal: iedereen met de anon-key mag erop zenden |
| `:1824` | `.on('broadcast',{event:'zender'},({payload})=>applyStationOverride(payload))` — **de payload van wie dan ook wordt uitgevoerd** |
| `:1825` | idem voor `zender-uit` → `endStationOverride(payload)` |
| `:1179-1199` | `applyStationOverride(p)` vertrouwt `p.albumId`, `p.start`, `p.setAt`, `p.by`. Controles: kanaal (`:1182`, en zonder `kanaal` geldt hij op **alle** kanalen), "ben ik zelf beheerder" (`:1183`), en ouderdom (`:1190`) — maar tegen een `setAt` die de afzender zelf kiest |
| `:1287` | `if(pendingStation)applyStationOverride(pendingStation)` — een vervalste payload die nog niet kon landen, wordt elke tik opnieuw geprobeerd |
| `:1923-1929` | de enige "is dit de beheerder"-controle zit bij het **zenden** (`pushOverride`: `if(!me.isAdmin)`) — in de browser van de afzender, dus te omzeilen met één regel in de console |
| `:1946-1950` | zelfde patroon voor de chat: iedereen kan `{who:'📻 ZENDER', text:'Clay …'}` broadcasten (geen XSS: `appendChat` gebruikt `textContent`, `:1987-1988`) |

De database-weg is wél dicht: `live_override` mag alleen `is_admin()` schrijven
(`files Varve Radio/varve-radio-zender-skip.sql:24-26`, `varve-radio-kanalen.sql:95-96`; volgens `CLAUDE.md`
geverifieerd: anon krijgt `42501`).

**Wat er gebeurt.** Iemand opent de radio, en typt in de console
`supabase.createClient(URL, ANON).channel('radio').subscribe()` gevolgd door
`.send({type:'broadcast', event:'zender', payload:{albumId:'<bestaand id>', start:0, setAt:new Date().toISOString(), by:'Clay'}})`.
Elke luisteraar op elk kanaal springt naar dat album; de badge zegt "ZENDER — Clay heeft de uitzending verzet"
(`:1147`), het eigen tempo gaat op slot (`:1021`) en de terugknop verdwijnt (`:1145`). **Eén bericht houdt de
luisteraars vast tot het album afloopt**: tijdens een zender-overname controleert de tik alleen het einde van het album
en de drift (`:1301-1313`), niet de ouderdom. En de ouderdomscontrole zelf (`STATION_OUD = 180`, `:1177`, `:1190`) is
te omzeilen met een `setAt` in de toekomst: `(now-setAt)/1000` wordt dan negatief. Beperking: alleen bestaande albums (de lijst is publiek leesbaar),
geen eigen URL's. Met `zender-uit` kan dezelfde persoon een echte overname van Clay afbreken.

**Kleinste herstel (alleen client, geen DDL, één deploy):** het realtime-bericht wordt alleen nog een **seintje**;
de inhoud komt uit `live_override`, die alleen de beheerder kan schrijven.

<!-- toets: zender-sein -->
```js
// :1824-1825 — de payload wordt niet meer gelezen
      .on('broadcast',{event:'zender'},()=>volgZender())
      .on('broadcast',{event:'zender-uit'},()=>volgZender())

// nieuw, top-level (na endStationOverride, :1204). Een realtime-bericht kan iedereen met de anon-key
// sturen; de rij in live_override alleen de beheerder (RLS). pushOverride stuurt het seintje vóór het
// schrijven (:1932 vóór :1934), en die twee mogen niet op elkaar wachten (CLAUDE.md, "Zender-skip") —
// dus lezen we na 1,5 en na 5 s. Seintjes binnen die 5 s tellen als één, maar zetten `zenderNogEens`:
// dan volgt na de lezing op 5 s nog één lezing 1,5 s later (een tweede skip van Clay binnen 5 s gaat
// dus niet verloren). Spammen kost zo hooguit drie leesacties per 5 s per luisteraar.
// Let op: tests/draai.py haalt alleen functies uit de bron (draai.py:12-13); de twee `let`s horen
// dus ook in de harness van de suite.
let zenderSein=0, zenderNogEens=false;
function volgZender(){
  if(me.isAdmin)return;
  if(Date.now()-zenderSein<5000){zenderNogEens=true;return;}
  zenderSein=Date.now();zenderNogEens=false;
  setTimeout(kijkZender,1500);
  setTimeout(async()=>{
    await kijkZender();
    if(zenderNogEens){zenderNogEens=false;setTimeout(kijkZender,1500);}
  },5000);
}
async function kijkZender(){
  const lo=await cloud.ovrLees().catch(()=>null);
  if(lo&&lo.active&&lo.album_id){
    if(ovr&&ovr.station&&ovr.albumId===lo.album_id)return;   // speelt al; de tik corrigeert de positie
    applyStationOverride({albumId:lo.album_id,start:lo.start_sec,slotIdx:lo.slot_idx,setAt:lo.set_at,by:lo.by_name});
  }else if(lo)endStationOverride({});
}
```

- Waarom zo: het leest dezelfde rij als `readOverride()` (`:1880-1890`) met dezelfde helper `ovrLees()` (`:1893`),
  dus de bestaande kanaal-/terugvallogica blijft één plek. `applyStationOverride` en de bestaande suites
  (`station`, `laat`, `ververs`) veranderen niet.
- Test (in varve-radio, volgens zijn eigen patroon): een suite `zender-sein` (`tests/harness/zender-sein.js` met
  `let zenderSein, zenderNogEens` en een nep-`setTimeout`/`Date.now`, `tests/gevallen/zender-sein.js`, regel in
  `tests/suites.json` met `volgZender`, `kijkZender`, `applyStationOverride`, `endStationOverride`, `enterOverride`,
  `backToLive`). Gevallen: een vervalste payload doet niets zolang de rij inactief is · actieve rij → overname na
  1,5 s · inactieve rij tijdens een overname → terug naar live · beheerder → niets · tien seintjes in 1 s → drie
  leesacties · **tweede skip binnen 5 s, schrijfactie landt na de lezing op 5 s → de luisteraar volgt de tweede**
  (de valkuil van een kaal venster: `refreshOverride`, `:1915-1918`, schrijft alleen de rij en zendt niets, dus er
  komt anders geen nieuwe lezing). De hub-test (`test/volgende-koppelingen.test.js`) draait deze gevallen al op het
  codeblok hierboven, met nep-functies in plaats van het LIVE-bestand.
- Restrisico: iemand kan nog steeds seintjes sturen (alleen extra leesacties) en de chat vervalsen (`:1946-1950`).
- **Structureel (later, vraagt DDL door Clay):** Supabase Realtime Authorization — `channel('radio',
  {config:{private:true, …}})` plus RLS-policies op `realtime.messages`: lezen voor iedereen, zenden van
  `zender`/`zender-uit` alleen `is_admin()`, `chat` alleen ingelogd. Dan kan ook de chat niet meer vervalst worden.
  Te verifiëren in de Supabase-documentatie of anonieme luisteraars een private kanaal mogen lezen.

### 2.4 Beste koppelvorm voor de hub
**Manifest-app via WS `/app`, achter `?hub=`, alleen het lokale mengpaneel.** Nooit via het `zender`-kanaal of de
database: wat de hub doet is van één luisteraar (Clay), niet van de uitzending.

<!-- toets: manifest -->
```json
{
  "v": 1, "app": "varve-radio", "naam": "Varve Radio", "kleur": "#2f6bff", "truth": "app", "hb_s": 1, "lease": false,
  "scenes": [],
  "params": [
    {"id":"vol_a","naam":"Volume hoofdlaag","soort":"waarde","standaard":1,"hint":"fader","groep":"meng","slew_s":1.5},
    {"id":"vol_b","naam":"Volume tweede laag","soort":"waarde","standaard":0.7,"hint":"fader","groep":"meng","slew_s":1.5},
    {"id":"snel_a","naam":"Snelheid hoofdlaag","soort":"keuze","keuzes":["0,75×","1×","1,25×","1,5×","2×"],"standaard":0.25,"hint":"kolom","groep":"snelheid"},
    {"id":"snel_b","naam":"Snelheid tweede laag","soort":"keuze","keuzes":["0,75×","1×","1,25×","1,5×","2×"],"standaard":0.25,"hint":"kolom","groep":"snelheid"},
    {"id":"kanaal_b_vorige","naam":"Tweede laag: vorig kanaal","soort":"trigger","hint":"pad","groep":"kanaal"},
    {"id":"kanaal_b_volgende","naam":"Tweede laag: volgend kanaal","soort":"trigger","hint":"pad","groep":"kanaal"},
    {"id":"skip","naam":"Skip (persoonlijk)","soort":"trigger","hint":"pad","groep":"kanaal"},
    {"id":"paniek","naam":"Paniek: beide lagen stil","soort":"trigger","hint":"pad"}
  ]
}
```
- `vol_a`/`vol_b` → `volA`/`volB` = `round(v·100)` en `zetVolumes()` (`:1015-1016`, `:2130-2136`). `snel_*` →
  index in `SNELHEDEN`; tijdens een overname door de zender staat de hoofdlaag vast op 1× (`rateAnu`, `:1021`) — de
  app meldt dan `zet snel_a = 0.25` terug. Kanalen: 12 > 8 keuzes, dus vorige/volgende-triggers.
- **Paniek** = beide lagen in ±2 s naar volume 0, alleen in deze tab; niets naar Supabase.
- `skip` voor de beheerder zou `forceNextSlot` → `pushOverride` = de zender verzetten. Voorstel: de hub-skip is
  **altijd persoonlijk** (ook als Clay is ingelogd), anders bestuurt de hub de uitzending.

### 2.5 Regels van het repo die het beperken
- "Eén punt tegelijk": elk punt apart deployen en meten (md5 van het LIVE-bestand = `curl -s https://varve.nl/radio/`).
  Lek-herstel en hub-koppeling zijn dus **twee deploys**.
- Bron van waarheid is het LIVE-bestand, één bestand, geen build. Claude mag geen DDL draaien (alleen anon-key).
- De pagina draait op `https://varve.nl`. Een verbinding naar `ws://localhost:7700` vraagt dat `https://varve.nl` in
  `config.json` → `server.origins` staat (`src/transports/server.js:81-91`); en Chrome vraagt bij een publieke site die
  `localhost` aanspreekt mogelijk toestemming (Local Network Access) — **op de Mac te proberen**. Alternatief zonder
  die twee: het LIVE-bestand lokaal serveren (`python3 -m http.server`), dan is de origin `localhost` en mag hij altijd.

### 2.6 Werk en risico's
- Lek: **S** (1–2 uur incl. suite, één deploy, Clay meet). Risico: de vertraging van 1,5 s voor wie al luistert
  (nu direct). Kleiner dan het lek; desgewenst 0,8 s.
- Koppeling: **M** (halve dag: ±120 regels in het LIVE-bestand achter `?hub=`, suite in `tests/`). Laag nut: de radio
  is geen instrument. Risico: de pagina is live voor iedereen; een fout in de hub-code raakt alle luisteraars, ook
  zonder `?hub=` (syntaxfout). Daarom `node --check` op de script-blokken vóór de deploy (`CLAUDE.md`, "Testen").

### 2.7 Open vragen voor Clay
1. Mag het lek met de client-fix (§2.3) dicht, als eigen deploy, vóór alles?
2. Is 1,5 s vertraging bij een zender-skip acceptabel voor wie al luistert?
3. Wil je de radio überhaupt in de hub, en zo ja: alleen volume/snelheid, of ook kanaalkeuze?
4. Lokale kopie (geen origin-gedoe) of de live pagina met `https://varve.nl` in `server.origins`?

---

## 3. uurwerk (driver controleren)

### 3.1 Wat het is en hoe het draait
Browser-app (pure Web Audio, geen build, geen dependencies) op **:8765** (`python3 -m http.server`) en een Node-brug op
**:8766** (HTTP + MCP over stdio) — `uurwerk/start.sh`. De brug geeft werkwoorden door aan de tab via SSE
(`uurwerk/bridge/server.js:41-49`) en wacht tot 90 s op antwoord (`:46`). Alles is tekst: de staat is een patch
(`uurwerk/taal.js`), elke wijziging een laag met auteur.

### 3.2 Huidige hub-stand — klopt de driver?
`apps/uurwerk.json` (HTTP-driver, `truth:"hub"`, `hb_s:2`) in `sets/meditatie.json`. Nagelopen tegen het repo:

| Driver | uurwerk | Klopt |
|---|---|---|
| `macro` {naam, waarde} voor onrust/licht/dicht/samenhang | `bridge/server.js:29`, `brug.js:127` (zet de slider en vuurt `input`) | ja; licht −1..1 (`index.html:169`) = `bereik:[-1,1]` |
| `bevries` {aan} | `server.js:30`, `brug.js:128` (`aan !== false`) | ja |
| `bewaar` {bron:"varve-hub"} | `server.js:19`, `brug.js:84-89` (zonder naam = automatische naam) | ja |
| `uur` start/stop/meer/minder | `server.js:28`, `brug.js:116-126` (start zonder minuten = 60) | ja |
| gezondheid `GET /` en "tabs: 0" = niet gezond | `server.js:98` ↔ `src/drivers/http.js:182` | ja |

**Bevindingen:**
1. **`truth:"hub"` klopt niet met wat de tab zelf doet.** De tab verandert de macro's zelf: `uur.js:121-122`
   (meer/minder aanwezig = dichtheid ±0,08 én licht ±0,12), `uur.js:132-133` (aandachtswacht verlaagt onrust en
   licht; `uur.js:134` dempt bovendien het hoofdvolume rechtstreeks via `E.master.gain`, buiten `#masterVol` om), `mod.js:677`
   (nieuw uurwerk = willekeurige samenhang), `brug.js:115` (onrust 0,35), `taal.js:291-294` (een patch toepassen zet
   alle macro's). De hub weet daar niets van: na `uur_meer` staan licht (+0,12) en dicht (+0,08) in de tab hoger dan in de hub, de
   pickup wacht op de verkeerde waarde, en na een hub-herstart speelt de replay oude waarden over de stand van de tab
   heen.
2. **Elke hub-beweging wordt een laag.** `Lagen.poll` (`taal.js:319-333`, elke seconde: `taal.js:316`) legt een verschil vast,
   bewaart er 400 en zet er 200 in localStorage. Een fader die je twee minuten beweegt, duwt Clay's eigen lagen
   (en "terug") eruit. Dat raakt invariant I5 (`uurwerk/docs/BLAUWDRUK.md:36`).
3. **Geen paniek** (geen trigger `paniek` in het manifest).

### 3.3 Beste koppelvorm
**Driver houden** (nul code in uurwerk; de brug "vertaalt nooit", `uurwerk/docs/BLAUWDRUK.md:150`). Twee aanvullingen:
- **Paniek zonder hub-code:** `pas_toe` met een diff `+master 0.00` zet het hoofdvolume op 0 (`brug.js:20-40`
  `pasDiffToe` vervangt de regel `master …`; `taal.js:287` zet `#masterVol`). Met **`meet_seconden: -1`**: de brug
  rekent `Math.max(0, Math.min(15, +meet_seconden || 2.5))` (`brug.js:61`), dus `0` wordt 2,5 s wachten (`+0 || 2.5`)
  en dat loopt over `POST_TIMEOUT_MS` = 2000 (`src/drivers/http.js:24`): elke paniek zou dan
  "verb pas_toe: geen antwoord binnen 2000 ms" loggen. `-1` geeft `Math.max(0, -1)` = 0 → niet wachten. Het volume
  gaat in beide gevallen meteen naar 0 (`applyText` loopt vóór het wachten, `brug.js:58`).
- **Teruglezen (hub-code, M):** de HTTP-driver leest bij elke gezondheidscheck (2 s) ook `GET /verb/toon`
  (`brug.js:49`, geeft de patchtekst) en haalt eruit: `licht x` (`taal.js:214`, ontbreekt bij 0), `samenhang x`
  (`:215`, ontbreekt bij 0), `tuinman onrust x [bevroren]` (`:216`) en `dicht x` in de `stem`-regel (`:185`).
  Verschilt iets van wat de hub denkt, dan meldt de driver een `zet` aan de kern (zoals `#meldPreset` in
  `src/drivers/midi.js:185`). Daarna kan `truth` naar `"app"` (PROTOCOL §1 punt 4): geen replay meer over de tab
  heen. Ontwerp: `driver.lees = { verb:"toon", elke_s:2, regels: { licht: { patroon:"^licht (-?[\\d.]+)$", bereik:[-1,1], ontbreekt:0 }, … } }`.
  **Met tolerantie:** de tab schrijft macro's met twee decimalen (`taal.js:211-216`, `toFixed(2)`); zonder marge
  meldt de driver bij bijna elke check een `zet` (hub 0,4567 ↔ tab 0,46) en verspringen pickup en LEDs heen en weer.
  Dus alleen melden bij een verschil > 0,005 in eenheden van de app (licht: omgerekend naar 0..1 = 0,0025). De demping
  van `uur.js:134` is zo **niet** zichtbaar (die staat niet in de patch).
- **De lagenvloed los je niet in de hub op.** `max_hz` verlagen helpt niet: `Lagen.poll` draait op 1 Hz
  (`taal.js:316`) en legt hooguit één laag per seconde vast, of de hub nu met 10 of met 2 Hz stuurt; een fader die twee
  minuten beweegt geeft in beide gevallen ±120 lagen (alleen `max_hz` < 1 doet iets, en dat maakt de bediening traag).
  `slew_s` maakt het erger: elke sprong (snapshot, LPD8, cockpit) wordt 2–4 s uitgesmeerd en levert 2–4 lagen op in
  plaats van één. De echte remedie zit in uurwerk: opeenvolgende lagen van dezelfde auteur (`varve-hub`) binnen N s
  samenvoegen (de laatste overschrijven). Dat is een wijziging in `taal.js` (`Lagen.poll`) — open vraag 3.

### 3.4 Manifest-voorstel (huidige driver, alleen aangevuld)
Precies `apps/uurwerk.json` plus twee triggers (`master_terug`, `paniek`); geen `slew_s`, `max_hz` blijft 10 (§3.3).

<!-- toets: statisch -->
```json
{
  "v": 1, "app": "uurwerk", "naam": "Uurwerk", "kleur": "#ffb000", "truth": "hub", "hb_s": 2, "lease": false, "scenes": [],
  "params": [
    {"id":"onrust","naam":"Onrust","soort":"waarde","standaard":0,"hint":"fader","groep":"macro","rol":"macro.beweging"},
    {"id":"licht","naam":"Licht","soort":"waarde","standaard":0.5,"hint":"fader","groep":"macro","rol":"macro.helderheid","eenheid":"donker↔helder","min":-1,"max":1},
    {"id":"dicht","naam":"Dicht","soort":"waarde","standaard":0.5,"hint":"fader","groep":"macro","rol":"macro.dichtheid"},
    {"id":"samenhang","naam":"Samenhang","soort":"waarde","standaard":0,"hint":"fader","groep":"macro"},
    {"id":"bevries","naam":"Bevries tuinman","soort":"schakelaar","standaard":0,"hint":"pad","groep":"tuinman"},
    {"id":"bewaar","naam":"Dat! (bewaar moment)","soort":"trigger","hint":"pad","groep":"tuinman"},
    {"id":"uur_diep_werk","naam":"Uur: Diep werk","soort":"trigger","hint":"pad","groep":"uur"},
    {"id":"uur_lezen","naam":"Uur: Lezen","soort":"trigger","hint":"pad","groep":"uur"},
    {"id":"uur_rust","naam":"Uur: Rust","soort":"trigger","hint":"pad","groep":"uur"},
    {"id":"uur_beweging","naam":"Uur: Beweging","soort":"trigger","hint":"pad","groep":"uur"},
    {"id":"uur_stop","naam":"Uur stoppen","soort":"trigger","hint":"pad","groep":"uur"},
    {"id":"uur_meer","naam":"Meer aanwezig","soort":"trigger","hint":"pad","groep":"uur"},
    {"id":"uur_minder","naam":"Minder aanwezig","soort":"trigger","hint":"pad","groep":"uur"},
    {"id":"master_terug","naam":"Volume terug (0,8)","soort":"trigger","hint":"pad","groep":"veilig"},
    {"id":"paniek","naam":"Paniek: volume 0","soort":"trigger","hint":"pad","groep":"veilig"}
  ],
  "driver": {
    "soort": "http", "url": "http://127.0.0.1:8766", "gezond_s": 2, "max_hz": 10,
    "verbs": {
      "onrust": {"verb":"macro","args":{"naam":"onrust"},"waarde":"waarde"},
      "licht": {"verb":"macro","args":{"naam":"licht"},"waarde":"waarde","bereik":[-1,1]},
      "dicht": {"verb":"macro","args":{"naam":"dicht"},"waarde":"waarde"},
      "samenhang": {"verb":"macro","args":{"naam":"samenhang"},"waarde":"waarde"},
      "bevries": {"verb":"bevries","waarde":"aan"},
      "bewaar": {"verb":"bewaar","args":{"bron":"varve-hub"}},
      "uur_diep_werk": {"verb":"uur","args":{"actie":"start","naam":"Diep werk"}},
      "uur_lezen": {"verb":"uur","args":{"actie":"start","naam":"Lezen"}},
      "uur_rust": {"verb":"uur","args":{"actie":"start","naam":"Rust"}},
      "uur_beweging": {"verb":"uur","args":{"actie":"start","naam":"Beweging"}},
      "uur_stop": {"verb":"uur","args":{"actie":"stop"}},
      "uur_meer": {"verb":"uur","args":{"actie":"meer"}},
      "uur_minder": {"verb":"uur","args":{"actie":"minder"}},
      "master_terug": {"verb":"pas_toe","args":{"diff":"+master 0.80","meet_seconden":-1}},
      "paniek": {"verb":"pas_toe","args":{"diff":"+master 0.00","meet_seconden":-1}}
    }
  }
}
```
Wat **paniek** hier betekent: het hoofdvolume van uurwerk naar 0 (de slingers lopen door, de tuinman ook). Pas
bij het indrukken (de HTTP-driver stuurt werkwoorden alleen bij `aan`, `src/drivers/http.js:148`). Terug met
`master_terug` of door in de tab het volume te draaien. De laag krijgt auteur `varve-hub`. Liep de engine nog niet,
dan start paniek hem (stil, want master 0; `brug.js:51`).

### 3.5 Regels van uurwerk
Geen build, geen dependencies (`uurwerk/README.md:4`). I1 alles is tekst, I5 elke verandering is een laag, I6 nooit pijn
(`uurwerk/docs/BLAUWDRUK.md:32-37`). De rollen in `uurwerk/docs/ROLLEN.md` ("één verandering per beurt") gelden voor agenten; de hub
is geen agent, maar zijn lagen staan in hetzelfde logboek — en daar helpt een lagere `max_hz` niet tegen (§3.3).

### 3.6 Werk en risico's
- Paniek: **S** (alleen `apps/uurwerk.json` + een test in `test/drivers.test.js` die controleert dat het verb-bericht
  voor `paniek` en `master_terug` `meet_seconden` ≤ 0 heeft; `test/volgende-koppelingen.test.js` toetst dat nu al op
  het voorstel). Risico's: `pas_toe` roept eerst `await R().start()` aan (`brug.js:51`) — paniek **start de engine**
  als die nog niet liep — en past daarna de **hele patch** opnieuw toe (`brug.js:53-58`: `pasDiffToe` op de huidige
  tekst, dan `applyText`). `+master 0.00` verandert alleen de master-regel (`pasDiffToe` vervangt op regelkop), maar
  op de Mac nagaan dat het opnieuw toepassen geen hoorbare tik of sprong in andere bronnen geeft.
- Teruglezen: **M** (HttpDriver + parser + tests met nep-fetch: o.a. "tab 0,46 bij hub 0,4567 → geen `zet`" en
  "tab 0,60 bij hub 0,4567 → één `zet`"; `toon` gaat via de tab, dus ook hier "tabs: 0" = niets).
- Lagen samenvoegen: **S-M in uurwerk** (`Lagen.poll`), niet in de hub; alleen als Clay het wil (open vraag 3).

### 3.7 Open vragen voor Clay
1. Paniek = volume 0 goed, of liever "bevries + onrust 0" (geluid blijft, beweging stopt)?
2. Mag uurwerk `truth:"app"` worden zodra de driver terugleest (dan wint de tab na een herstart)?
3. Lagen: de hub kan de lagenvloed niet beperken (§3.3). Mag uurwerk hub-lagen samenvoegen (laatste laag van
   `varve-hub` binnen bv. 10 s overschrijven), of wil je hub-bewegingen helemaal niet als laag? Beide vragen een
   wijziging in uurwerk (`taal.js`, `Lagen.poll`).

---

## 4. av-scene-kit (driver controleren)

### 4.1 Wat het is en hoe het draait
Mac-rig: ESP32-cam → Python-bridge → OSC **:9000** → TouchDesigner 2025 (`/project1/hub`, gebouwd door
`av-scene-kit/td/td_build_hub.py`) → OSC **:9001** → Blender; Logic via IAC-bussen L2TD/TD2L; TD-MCP op **:9981**
(`av-scene-kit/CLAUDE.md:25`). UI = TD zelf. Doel: clips maken (opname, take-log).

### 4.2 Huidige hub-stand — klopt de driver?
`apps/av-scene-kit.json` (MIDI-driver "VARVE-HUB TD"), `sets/scene-kit.json`, `docs/TOUCHDESIGNER.md`.
- `node tools/genereer-manifesten.mjs --toets` → `av-scene-kit.json: actueel (14 params)`: CC 20–27 en noten 36–41
  kloppen met `av-scene-kit/config.json` (`midi.knob_cc`, `midi.pads`), de vier presets met `td_build_hub.py:167-172`.
- **Bevindingen:**
  1. **Geen paniek.** De TD-hub kent geen paniek-noot; `master_dim` (CC 27) gaat naar de opacity van `dim`
     (`td_build_hub.py:517`, `:518`). Een CC 27 = 0 vanuit de hub is **geen betrouwbare paniek**: na een preset houdt TD
     elke knop vast tot de binnenkomende waarde de presetwaarde **kruist** (`:847`). Stond de hub-waarde al onder de
     preset (bv. 0,9 bij preset 1,0), dan kruist een sprong naar 0 niet en blijft het beeld aan.
  2. **TD negeert de eerste CC per knop** na een TD-start (`:837-841`): een replay na een TD-herstart landt dus niet
     (staat al in `docs/TOUCHDESIGNER.md`, "Alleen TD herstart?").
  3. **Logic kan de hub blokkeren:** controller en L2TD worden per knop met **max** samengevoegd (`:321-331`). Stuurt
     Logic automation op CC 20–27 (track TO_TD, `av-scene-kit/logic/README.md` §3), dan kan de hub niet lager dan
     Logic. En als TO_TD het geselecteerde spoor is, stuurt Logic de CC's van "VARVE-HUB Logic" (Sediment: Shape …
     Resonance = CC 20–27!) door naar L2TD — dan bewegen Sediment-knoppen de TD-knoppen.
  4. De driver ziet niet of TD luistert (`src/drivers/index.js:147`; `sets/scene-kit.json`, opmerking): de app staat
     "actief" zolang de poort open is.

### 4.3 Beste koppelvorm
**MIDI-driver houden** (TD verandert niets behalve device 1). Voor paniek één kleine TD-tak.

### 4.4 Voorstel: paniek-pad
- `av-scene-kit/config.json` → `midi.pads.paniek = 42` (vrij: 36–41 bezet).
- `td_build_hub.py`, `onOffToOn` (`:874-889`): bij `ch1n42` knob8 terug naar "vasthouden op 0":
  `_set_const(op('preset_base'),'knob8',0)`, `pickup_mask` 0, `pickup_inv` 1, `picked['knob8']=False`. Dan is
  `ctrl.knob8 = 0` → `dim` dicht, **los van de pickup-stand**; de master komt pas terug als de fader 0 kruist (dus
  bewust: fader naar beneden, dan weer op). Wil je een fade i.p.v. een sprong: een Lag CHOP op `ctrl` voor `dim`.
- De hub weet het via `driver.presets`: noot 42 zet `master_dim` op 0 (`#meldPreset`, `src/drivers/midi.js:185`), dus
  ook de hub-pickup wacht tot de fader 0 kruist. `tools/genereer-manifesten.mjs` moet dan voor een pad `paniek` een
  preset-regel `{noot:42, waarden:{master_dim:0}}` maken (de kern herkent de trigger aan zijn id `paniek`).

Aanvulling op `apps/av-scene-kit.json` (`+` = toevoegen aan wat er staat). Dat bestand is gegenereerd: de aanvulling
hoort in `sceneKitManifest()` van `tools/genereer-manifesten.mjs`, niet met de hand.

<!-- toets: aanvulling -->
```json
{
  "app": "av-scene-kit",
  "params+": [{"id":"paniek","naam":"Paniek: master dicht","soort":"trigger","hint":"pad","groep":"veilig"}],
  "driver.map+": {"paniek": {"noot": 42}},
  "driver.presets+": [{"noot": 42, "waarden": {"master_dim": 0}}]
}
```

### 4.5 Regels van av-scene-kit
Alleen de TD-sessie schrijft in `td/**` en in `config.json` → `midi` (`av-scene-kit/CLAUDE.md`, tabel "Sessies en
eigendom"); alleen REGIE commit. Na elke TD-wijziging `python3 td/_mock_td_test.py`. `config.json` is de enige bron.
Gate G2 (clip 1 online) blokkeert fase 4–9: een paniek-pad is geen nieuwe feature van de kit, maar Clay beslist.

### 4.6 Werk en risico's
**S** (±15 regels in TD, één config-sleutel, generator + test in de hub). Risico: pad 42 moet ook in `notescope`
van beide MIDI In CHOPs (`midi_in_setup`, `:279-286`, gaat vanzelf uit `PAD_NOTES`); en de mock-test van de kit moet
de nieuwe tak kennen.

### 4.7 Open vragen voor Clay
1. Paniek in TD: master dicht (zwart), of preset "stil" (`:172`)?
2. Sprong of fade, en hoe lang?
3. Gebruik je Logic-automation op TO_TD tijdens een hub-avond? Zo niet: TO_TD-spoor dan niet selecteren.

---

## 5. sediment (driver controleren)

### 5.1 Wat het is en hoe het draait
JUCE Audio Unit (C++), alleen in Logic Pro op de Mac; geen netwerk, geen eigen UI buiten het plug-invenster.
22 parameters in `sediment/src/Params.h`; MIDI = noten, CC 1 (filter), pitch bend, sustain
(`sediment/src/PluginProcessor.cpp:73-77`: alleen `keyboardState` en `synth.renderNextBlock`, **geen** CC-tabel).
Daarnaast een generatieve Scripter-set op vier Sediment-sporen (`sediment/scripter/`).

### 5.2 Huidige hub-stand
`apps/sediment.json` (MIDI-driver "VARVE-HUB Logic", CC 20–31 en 102–111, kanaal 1), `docs/LOGIC.md`.
`node tools/genereer-manifesten.mjs --toets` → `sediment.json: actueel (22 params)`. Werkt alleen na de
Controller Assignments in Logic (Klaar-als in `STATUS.md`, golf 1, nog open). **Sediment staat in geen enkele set**
(`sets/*.json`; ONDERZOEK.md §11 noemde hem in `meditatie`). Geen paniek.

### 5.3 Beste koppelvorm
**MIDI-driver houden.** Later (los van Logic): een vaste CC→parameter-tabel in `processBlock` (ONDERZOEK.md §7, F6);
dan zijn de Controller Assignments niet meer nodig. Nu niet: Sediment is nog nooit in Logic beluisterd
(`sediment/docs/TODO.md`, "Nog niet gedaan").

### 5.4 Voorstel: paniek
`{"id":"paniek","naam":"Paniek: alle noten uit","soort":"trigger","hint":"pad"}` met `driver.map.paniek = {"cc": 123}`
(All Notes Off). De MIDI-driver kan dat al en `valideerStatisch` accepteert het, **maar `apps/sediment.json` is
gegenereerd** (`_bron`: `tools/genereer-manifesten.mjs` ← `Params.h`) en de generator verbiedt CC 123 bewust
(`VERBODEN_CC`, `tools/genereer-manifesten.mjs:110`). Een paniek die je met de hand toevoegt, verdwijnt bij de volgende
generatie en laat drie dingen falen: `node tools/genereer-manifesten.mjs --toets`, de test "actueel t.o.v. de bronnen"
(`test/drivers.test.js:715-719`) en de test "alle 22 parameters op eigen CC" (`test/drivers.test.js:358-363`: precies
22 CC's, geen in `VERBODEN_CC`). Dus:
- `sedimentManifest()` maakt de paniek-trigger zelf, buiten `SEDIMENT_CC`, als uitzondering naast `VERBODEN_CC` met
  de reden erbij: CC 123 is een kanaalmodus-bericht, hier alleen als bedoelde paniek, nooit als parameter.
- De test bij `test/drivers.test.js:358-363` telt dan alleen de **waarde**-parameters (22, geen verboden CC) en
  controleert apart dat de enige trigger `paniek` op CC 123 staat; de "actueel"-test gaat vanzelf mee.

Gedrag: JUCE's `Synthesiser` verwerkt All Notes Off; de staarten van echo en galm lopen uit. De Scripter-set speelt
daarna gewoon verder: echte stilte vraagt `output` → 0 (= −30 dB, niet stil). Bij het **loslaten** stuurt de driver
nog een CC 123 met waarde 0 (`#uit` in `src/drivers/midi.js:138-144`; All Notes Off kijkt niet naar de waarde, dus
nogmaals noten uit). En Logic routeert binnenkomende CC's alleen naar het **geselecteerde** spoor (of naar wat de
Controller Assignments aanwijzen): met de Scripter-set op vier sporen krijgt alleen dat ene spoor de paniek (open
vraag 2 en 3). **Op de Mac te proeven:** komt CC 123 via Logic bij het instrument aan?

Aanvulling op `apps/sediment.json` (`+` = toevoegen; in de generator, zie boven):

<!-- toets: aanvulling -->
```json
{ "app": "sediment", "params+": [{"id":"paniek","naam":"Paniek: alle noten uit","soort":"trigger","hint":"pad"}], "driver.map+": {"paniek": {"cc": 123}} }
```

### 5.5 Regels van sediment
"Parameter-ID's nooit hernoemen: opgeslagen projecten verwijzen ernaar" (`sediment/docs/HANDOFF.md:63`). Logic
houdt een geladen plug-in vast; bouwen alleen met Logic dicht.

### 5.6 Werk en risico's
Paniek **S-M**: geen manifest-regel maar een generator-wijziging (`sedimentManifest()` + uitzondering op
`VERBODEN_CC`) en twee tests aanpassen (`test/drivers.test.js:358-363`, `:715-719`); idem voor av-scene-kit
(`sceneKitManifest()`, §4.4). Logic-setup ±15 min (Clay). Risico's: Logic luistert standaard naar alle ingangen (staat in
`docs/LOGIC.md`, stap 2); de doorvoer naar TD via TO_TD (§4.2 punt 3) staat er nog **niet** in.

### 5.7 Open vragen voor Clay
1. Sediment in `sets/meditatie.json`?
2. Met de Scripter-set op vier sporen: welk spoor bespeelt de hub? (Controller Assignments gelden per spoor/plug-in.)
3. Paniek = noten uit genoeg, of moet de Scripter-set ook stoppen?

---

## 6. td-lab

### 6.1 Wat het is en hoe het draait
TouchDesigner **2023.12230** (macOS), gebouwd door Python-scripts over een **exec-bridge**: `/td_bridge` met een
Web Server DAT op **:9981** die Python uitvoert in TD's hoofddraad (`td-lab/bridge/td_bridge.py:137-150`: routes
`/ping` en `/exec`; `bridge/install.py:8,26`). Het CLI `td-lab/td` praat ermee. Netwerken: `scripts/world.py`
(reaction-diffusion + regisseur `brain/director.py`), `scripts/screensaver.py` (deeltjes), `scripts/genesis.py` (de
twee samen; de nieuwste). UI = TD-venster; geen MIDI, geen OSC.

Bedienbaar in `/genesis` (custom parameters, parentshortcut `Genesis`, `scripts/genesis.py:79`):
- pagina **Macro** (`:82-91`): Speed 0–1,4 · Flow 0–3 · Climb −2..2 · Wander 0–2 · Size 0–4 · Trails 0–1 · Hue 0–1 · Restless 0,2–3
- pagina **World** (`:93-110`): Auto (regisseur), Fert −1..1, Cruel −1..1, Fieldmix, Bright 0–3, Glow 0–3, Bg 0–3, Grain;
  Reseed (puls), Hud (schakelaar), en de chemie: Feed/Kill (de regisseur schrijft ze zelf, `brain/director.py:177-178`),
  Seedamt (gezet door de Reseed-puls: 1 en na vier frames weer 0, `scripts/genesis.py:383-384`), Seedthresh en Seedsoft
  (schrijft niemand; ze sturen de zaaivorm, `scripts/genesis.py:101-102`, `:135`).
- pagina **Readout** (`:113-117`): Wlife/Wact/Flash, geschreven door de regisseur (`director.py:186,223-225`).

### 6.2 Huidige hub-stand
`config.json` heeft `apps.td-lab` met `"koppeling": "osc"` (`config.json:95-100`) en `bekende_apps.td-lab` tcp 9981
(`:34`), maar **er is geen `apps/td-lab.json` en geen OSC in de hub** (§1). td-lab doet dus nergens mee.

### 6.3 Beste koppelvorm: driver in de hub, over de bestaande bridge
**Nieuwe driver-soort `td`** die `/exec` aanroept. Waarom:
- **Nul regels in td-lab.** De bridge bestaat al en wordt per verzoek herladen (`bridge/callbacks.py:15`) — dat
  laatste is ook een kostenpost, zie "Belasting" hieronder.
- Volle precisie (geen 7-bit MIDI), en geen tweede virtuele poort of MIDI In CHOP die bij een rebuild verdwijnt
  (build-scripts breken hun COMP af en bouwen opnieuw — td-lab `CLAUDE.md`, "Rules").
- De hub kan een **rebuild zien**: `op('/genesis').id` verandert bij elke `./td run scripts/genesis.py`. Nieuwe id →
  `aanmelden()` → de kern speelt alles opnieuw af (`truth:"hub"`). Geen `/genesis` → geen hartslag → "stil"/"weg".
- OSC (td-osc-query-server, ONDERZOEK.md §7) vraagt eerst een OSC-transport in de hub én een TD-component; MIDI
  vraagt een TD-script in td-lab. Beide meer werk voor minder.

**Ontwerp `src/drivers/td.js`** (naast `http.js`, zelfde levensloop):
- `driver = { soort:"td", url:"http://127.0.0.1:9981", comp:"/genesis", gezond_s:2, max_hz:10, pars:{ id: {par, bereik?} | {puls} }, paniek?: { <id>: 0..1 } }`.
  **Poort uit `config.json`** (huisregel 6), zoals `src/drivers/http.js:62-64` al doet: `apps.td-lab.poort` wint; de
  `url` in het manifest is alleen de terugval. (Bij voorkeur zet de hub-config de poort dan ook in `apps.td-lab`, naast
  `bekende_apps.td-lab.tcp`, `config.json:34`.)
- **Per tik één POST `/exec`** met alle gewijzigde parameters (`c=op('/genesis')\nc.par.Speed=0.7\n…`), laatste
  waarde wint (de coalescing van `HttpDriver.#zet`, `src/drivers/http.js:119-143`, maar per batch i.p.v. per param):
  TD's hoofddraad krijgt hooguit 10 verzoeken per seconde. Waarde = `bereik[0] + v·(bereik[1]-bereik[0])`;
  schakelaar → `True/False`; puls → `c.par.Reseed.pulse()`. **Niet half toepassen:** de batch begint met
  `c=op('/genesis')` en `if c is None: raise RuntimeError('geen comp')`, en elke toewijzing staat in een eigen
  `try: c.par.X=… except Exception: fout.append('X')` (de batch eindigt met `if fout: raise …`). Zo blijft één
  hernoemde parameter niet de rest van de batch tegenhouden, en telt de batch toch als mislukt.
- **Antwoord lezen, niet alleen de status:** `/exec` geeft **altijd HTTP 200**, ook als de Python faalde — dan staat
  er `ok:false` in de JSON (`td-lab/bridge/td_bridge.py:124` `out['ok'] = False`, `:146` `statusCode = 200`). Een
  driver die zoals `src/drivers/http.js:102` alleen naar `r.ok` kijkt, ziet een mislukte batch als geslaagd: geen
  `gemist`, geen replay. Dus: de body altijd als JSON lezen; `ok:false` of een niet-JSON-antwoord = mislukt →
  `gemist = true` → bij de volgende geslaagde gezondheidscheck opnieuw aanmelden (replay, `truth:"hub"`).
- **Gezondheid**: POST `/exec` met `(lambda c: c.id if c else None)(op('/genesis'))` (TD-time-out zoals
  `CHECK_TIMEOUT_MS`). `null`, `ok:false` of geen antwoord binnen de time-out = niet gezond; andere id dan vorige
  keer = herbouwd → opnieuw aanmelden.
- **Belasting:** `bridge/callbacks.py:14-15` herlaadt `td_bridge.py` bij **elk** verzoek (van schijf, in TD's
  hoofddraad). Bij 10 Hz plus de gezondheidscheck is dat ±10 keer per seconde. Meetpunt voor de Mac-avond: haperen de
  frames (TD Performance Monitor) bij een fader die beweegt? Zo ja: `max_hz: 5`.
- **Veiligheid**: parameternamen uit het statische manifest, gecontroleerd met `^[A-Z][A-Za-z0-9]*$` in
  `valideerStatisch` (geen tekst van buiten in de Python). Fouten nooit gooien (zoals `http.js`).
- **Paniek**: de waarden uit `driver.paniek` in één exec, en als `zet` aan de kern gemeld (zoals `#meldPreset`), zodat
  ringen en pickup kloppen.
- **Tests** (`test/drivers-td.test.js`, NepKlok + nep-fetch): batch per tik · id-wissel → replay · geen comp → geen
  hartslag · puls · paniek meldt `zet` · `stop()` ruimt alle timers op · **exec 200 met `ok:false` → `gemist` en replay
  na de volgende gezonde check** · **geen antwoord (onafgevangen callback-fout) → time-out = niet gezond** · poort uit
  `config.json` wint van de `url`.

<!-- toets: manifest -->
```json
{
  "v": 1, "app": "td-lab", "naam": "TD-lab · Genesis", "kleur": "#ff3b30", "truth": "hub", "hb_s": 2, "lease": false, "scenes": [],
  "params": [
    {"id":"speed","naam":"Snelheid wereld","soort":"waarde","standaard":0.7143,"hint":"fader","groep":"macro","rol":"macro.beweging","slew_s":2,"min":0,"max":1.4},
    {"id":"flow","naam":"Stroming","soort":"waarde","standaard":0.3333,"hint":"fader","groep":"macro","slew_s":1,"min":0,"max":3},
    {"id":"climb","naam":"Aantrekking tot leven","soort":"waarde","standaard":0.65,"hint":"fader","groep":"macro","slew_s":1,"min":-2,"max":2},
    {"id":"wander","naam":"Dwaling","soort":"waarde","standaard":0.25,"hint":"fader","groep":"macro","slew_s":1,"min":0,"max":2},
    {"id":"size","naam":"Grootte deeltjes","soort":"waarde","standaard":0.25,"hint":"fader","groep":"macro","slew_s":1,"min":0,"max":4},
    {"id":"trails","naam":"Sporen","soort":"waarde","standaard":0.75,"hint":"fader","groep":"macro","rol":"macro.ruimte","slew_s":2},
    {"id":"hue","naam":"Kleur","soort":"waarde","standaard":0.55,"hint":"fader","groep":"macro","rol":"macro.kleur","slew_s":2},
    {"id":"restless","naam":"Rusteloosheid klimaat","soort":"waarde","standaard":0.2857,"hint":"fader","groep":"macro","slew_s":2,"min":0.2,"max":3},
    {"id":"fert","naam":"Vruchtbaarheid","soort":"waarde","standaard":0.5,"hint":"knop","groep":"wereld","rol":"macro.dichtheid","slew_s":4,"min":-1,"max":1},
    {"id":"cruel","naam":"Wreedheid","soort":"waarde","standaard":0.5,"hint":"knop","groep":"wereld","slew_s":4,"min":-1,"max":1},
    {"id":"fieldmix","naam":"Veld zichtbaar","soort":"waarde","standaard":0.45,"hint":"knop","groep":"wereld","slew_s":1},
    {"id":"bright","naam":"Helderheid zwerm","soort":"waarde","standaard":0.3333,"hint":"knop","groep":"wereld","rol":"macro.helderheid","slew_s":2,"min":0,"max":3},
    {"id":"glow","naam":"Gloed fronten","soort":"waarde","standaard":0.2333,"hint":"knop","groep":"wereld","rol":"macro.intensiteit","slew_s":2,"min":0,"max":3},
    {"id":"bg","naam":"Achtergrond","soort":"waarde","standaard":0.2667,"hint":"knop","groep":"wereld","slew_s":2,"min":0,"max":3},
    {"id":"grain","naam":"Korrel van zaad","soort":"waarde","standaard":0.0513,"hint":"knop","groep":"wereld","slew_s":1,"min":0.05,"max":2},
    {"id":"auto","naam":"Regisseur aan","soort":"schakelaar","standaard":1,"hint":"pad","groep":"wereld"},
    {"id":"hud","naam":"HUD tonen","soort":"schakelaar","standaard":1,"hint":"pad","groep":"wereld"},
    {"id":"reseed","naam":"Opnieuw zaaien","soort":"trigger","hint":"pad","groep":"wereld"},
    {"id":"paniek","naam":"Paniek: zwart","soort":"trigger","hint":"pad","groep":"wereld"}
  ],
  "driver": {
    "soort": "td", "url": "http://127.0.0.1:9981", "comp": "/genesis", "gezond_s": 2, "max_hz": 10,
    "pars": {
      "speed": {"par":"Speed","bereik":[0,1.4]}, "flow": {"par":"Flow","bereik":[0,3]}, "climb": {"par":"Climb","bereik":[-2,2]},
      "wander": {"par":"Wander","bereik":[0,2]}, "size": {"par":"Size","bereik":[0,4]}, "trails": {"par":"Trails","bereik":[0,1]},
      "hue": {"par":"Hue","bereik":[0,1]}, "restless": {"par":"Restless","bereik":[0.2,3]},
      "fert": {"par":"Fert","bereik":[-1,1]}, "cruel": {"par":"Cruel","bereik":[-1,1]}, "fieldmix": {"par":"Fieldmix","bereik":[0,1]},
      "bright": {"par":"Bright","bereik":[0,3]}, "glow": {"par":"Glow","bereik":[0,3]}, "bg": {"par":"Bg","bereik":[0,3]},
      "grain": {"par":"Grain","bereik":[0.05,2]}, "auto": {"par":"Auto"}, "hud": {"par":"Hud"}, "reseed": {"puls":"Reseed"}
    },
    "paniek": {"bright": 0, "glow": 0, "bg": 0, "fieldmix": 0, "hud": 0}
  }
}
```
Standaardwaarden = de TD-standaard genormaliseerd (Speed 1,0 op 0–1,4 = 0,7143, enz.). **Paniek** = zwerm, gloed,
achtergrond en veld op 0 **en de HUD uit**: de HUD staat standaard aan en wordt over het beeld gelegd
(`scripts/genesis.py:362`, `:365`: `hudswitch` met index = Hud), dus zonder `hud: 0` bleef er tekst op zwart staan. Zwart
beeld, de chemie loopt door. Terug met een snapshot.
Feed en Kill niet: die schrijft de regisseur (`brain/director.py:177-178`), een hub-waarde wordt meteen overschreven.
Seedamt niet: dat is de Reseed-puls (`scripts/genesis.py:383-384`), die al als trigger `reseed` in het manifest
staat. Seedthresh en Seedsoft schrijft niemand; ze kunnen erbij als knoppen in de groep `wereld` (bereik 0,3–0,9 en
0,005–0,3), maar ze zijn chemie (de vorm van het zaad), geen speelparameter: open vraag 5. Readout (Wlife/Wact/Flash) niet: het protocol kent geen
alleen-lezen parameters (open vraag 3).

### 6.4 Regels van td-lab
"Source of truth is `scripts/`, not the .toe"; build-scripts zijn idempotent (afbreken en opnieuw bouwen); "Look
before you build"; Claude ziet geen beweging — Clay beoordeelt het beeld (td-lab `CLAUDE.md`, "Rules"). De driver
verandert niets aan scripts of .toe, en overleeft een rebuild (id-check).

### 6.5 Werk en risico's
**M** (±200 regels driver + validatie + tests, een uur op de Mac). Risico's:
- **Poort 9981 is dubbel geclaimd**: td-lab's bridge én de TD-MCP van av-scene-kit (`av-scene-kit/CLAUDE.md:25`,
  `av-scene-kit/prompts/01-mcp-install.md:5`). Draaien beide TD-projecten tegelijk, dan heeft één van de twee een
  andere poort nodig → `config.json` → `apps.td-lab.poort` (huisregel 6).
- **Twee TD-instanties tegelijk** (td-lab = TD 2023, av-scene-kit = TD 2025): kan dat met Clay's licentie?
- De bridge voert willekeurige Python uit. Luistert de Web Server DAT alleen op 127.0.0.1? Niet in te stellen in
  `install.py`; op de Mac controleren met `lsof -iTCP:9981 -sTCP:LISTEN`. Zo niet: iedereen op het netwerk kan code
  in TD draaien (los van de hub, wel een td-lab-risico).
- Een tikfout in `td_bridge.py`: de `reload` staat **buiten** de `try` (`bridge/callbacks.py:14-15`; de try met 500 staat
  op `:16-23`), dus een syntaxfout geeft een onafgevangen exception in de TD-callback, geen 500. Wat TD dan antwoordt
  (niets of een lege 200) is op de Mac na te gaan; de driver moet beide als "niet gezond" lezen (time-out, of geen
  geldige JSON). Een Python-fout binnen een exec (hernoemde par, `/genesis` net afgebroken tijdens een rebuild) geeft
  wél een antwoord: 200 met `ok:false` (zie het ontwerp).
- **Het contract zegt nog iets anders:** `PROTOCOL.md:19` belooft "OSC-apps: hub luistert op 7701", en `config.json:98`
  zegt voor td-lab `"koppeling": "osc"`. Bij deze stap dus ook `PROTOCOL.md` §2 bijwerken (de OSC-rij als "niet
  gebouwd" markeren of schrappen, driver-soort `td` toevoegen) en `config.json` → `apps.td-lab.koppeling` naar `td`.

### 6.6 Open vragen voor Clay
1. Welke COMP bespeel je: `/genesis` (aangenomen), of ook `/world` / `/screensaver`?
2. Mag de hub via de exec-bridge (volledige Python-toegang tot TD) praten?
3. Readout (leven/activiteit) in de cockpit tonen? Vraagt een protocoluitbreiding (alleen-lezen parameter).
4. td-lab en av-scene-kit tegelijk op één avond?
5. Seedthresh/Seedsoft (vorm van het zaad) ook op knoppen, of blijft de chemie buiten de hub?

---

## 7. anbernic-cam (Varve Eye)

### 7.1 Wat het is en hoe het draait
Een ESP32-CAM (OV2640) aan een Anbernic RG35XX SP onder Knulli; de handheld draait **Varve Eye Art**
(`varve-eye/knulli/varve-eye/VarveEyeArt.py`, 3225 regels, Python + pygame-ce): 16 effecten, een keten van twee,
een beweger, decor, sampler, werkplekken, opnemen. Camera over serieel (CH340, eigen kernelmodules,
`varve-eye/knulli/modules/README.md`); geen netwerk in de app. Ook op de Mac: `./speel-op-mac.sh` (camera in de
Mac-USB, toetsen in plaats van knoppen, `TOETSEN-MAC.md`).
- Invoer: één register van acties — `STANDAARD_INDELING` (`VarveEyeArt.py:131-169`), `KNOP_ACTIES` (`:2697-2752`),
  `AS_ACTIES` (`:2754-2780`), gelezen in de lus `while draaien` (`:2938`). `gereedschap/acties.py` haalt ze met `ast`
  uit de bron: **57 functies, 40 van de 40 plekken bezet, 0 vrij**.

### 7.2 Huidige hub-stand
Niets. `IDEEEN.md:5` ("als extra bron … via usb0 10.42.0.x"), ONDERZOEK.md §7 en §8 F6. Niet in `config.json`.
Netwerk: `varve-eye/knulli/Varve Eye USB.sh:47-53` probeert usb0 met 10.42.0.2 — er staat **geen log in het repo
dat het lukte**. Wifi werkt wel op `WiFi-XY2`; SSH nooit (`anbernic-cam/docs/TODO.md:35`).

### 7.3 Beste koppelvorm: eerst **app** op de Mac, later **bron**
**Fase A — manifest-app via WS `/app` (op de Mac).** Varve Eye Art draait al op de Mac met de camera in de Mac:
`ws://127.0.0.1:7700/app`, geen token, geen usb0-vraag. Waarde: met de APC effecten en werkplekken bespelen terwijl je
filmt (scene-kit-avond). De WS-client bestaat al in stdlib-Python: `flux-screensaver` op tak
`claude/varve-hub-koppeling`, `flux-screensaver:817-1085` (`hub_wachttijd`, `ws_frame`, `ws_ontleed`, `class Hub`) —
overnemen als `varve-eye/knulli/varve-eye/hub.py`, achter `--hub ws://…` (standaard uit). Geen nieuwe dependencies.
De lus leest hub-berichten uit een wachtrij (draad zoals `Bron`, `:1755-1850`), zodat de 60-per-seconde-lus nooit
op het netwerk wacht.

<!-- toets: manifest -->
```json
{
  "v": 1, "app": "varve-eye", "naam": "Varve Eye", "kleur": "#00e5ff", "truth": "app", "hb_s": 1, "lease": false,
  "scenes": ["werkplek 1", "werkplek 2", "werkplek 3", "werkplek 4", "werkplek 5"],
  "params": [
    {"id":"knop1","naam":"Effect: knop 1","soort":"waarde","standaard":0.5,"hint":"fader","groep":"effect"},
    {"id":"knop2","naam":"Effect: knop 2","soort":"waarde","standaard":0.5,"hint":"fader","groep":"effect"},
    {"id":"keten-knop","naam":"Keten: knop","soort":"waarde","standaard":0.5,"hint":"fader","groep":"keten"},
    {"id":"beweger-diepte","naam":"Beweger: diepte","soort":"waarde","standaard":0,"hint":"knop","groep":"beweger","rol":"macro.beweging","slew_s":1},
    {"id":"belichting","naam":"Belichting","soort":"waarde","standaard":0,"hint":"knop","groep":"camera"},
    {"id":"versterking","naam":"Versterking","soort":"waarde","standaard":0,"hint":"knop","groep":"camera"},
    {"id":"effect-vorige","naam":"Vorig effect","soort":"trigger","hint":"pad","groep":"effect"},
    {"id":"effect-volgende","naam":"Volgend effect","soort":"trigger","hint":"pad","groep":"effect"},
    {"id":"werkplek-vorige","naam":"Vorige werkplek","soort":"trigger","hint":"pad","groep":"werkplek"},
    {"id":"werkplek-volgende","naam":"Volgende werkplek","soort":"trigger","hint":"pad","groep":"werkplek"},
    {"id":"flits","naam":"Flits","soort":"trigger","hint":"pad","groep":"opname"},
    {"id":"opslaan","naam":"Beeld opslaan","soort":"trigger","hint":"pad","groep":"opname"},
    {"id":"bewaar-30s","naam":"Laatste 30 s bewaren","soort":"trigger","hint":"pad","groep":"opname"},
    {"id":"opnemen","naam":"Opname aan/uit","soort":"trigger","hint":"pad","groep":"opname"},
    {"id":"decor","naam":"Decor","soort":"schakelaar","standaard":0,"hint":"pad","groep":"beeld"},
    {"id":"sample-aan","naam":"Sample","soort":"schakelaar","standaard":0,"hint":"pad","groep":"beeld"},
    {"id":"beweger-aanuit","naam":"Beweger","soort":"schakelaar","standaard":0,"hint":"pad","groep":"beweger"},
    {"id":"paniek","naam":"Paniek: zwart","soort":"trigger","hint":"pad"}
  ]
}
```
- Trigger-id's = de actienamen uit `KNOP_ACTIES`: `trig flits` roept dezelfde functie aan als de knop (één register,
  zoals `gereedschap/LEESMIJ.md` het wil). `acties.py` kan dus de **triggers** genereren — niet de rest:
  - `knop1`, `knop2` en `keten-knop` zijn geen acties: het register heeft alleen relatieve stappen (`knop-omhoog`/
    `knop-omlaag`, `VarveEyeArt.py:2750-2751`, en de as-functies `effect-parameter`/`keten-parameter` in `AS_ACTIES`, `:2756`, `:2758`).
    De waarde-parameters (ook `belichting`, `versterking`, `beweger-diepte`) zijn dus **nieuwe absolute ingangen**.
  - `decor`, `sample-aan` en `beweger-aanuit` zijn in `KNOP_ACTIES` **wissel**functies (`_decor_aanuit`,
    `_sample_aanuit`, `_beweger_aanuit`, `:2731`, `:2733`, `:2717`). Een absolute `zet decor=1` moet eerst de huidige stand
    vergelijken en alleen wisselen als die anders is, anders schakelt `zet decor=1` bij decor aan het decor juist uit.
    Die staatcontrole bestaat nu niet.
- Waarden zijn **absoluut**: `knop1` = `min + v·(max − min)` van de `Parameter` van het gekozen effect
  (`VarveEyeArt.py:278-311`, `min`/`max`/`stap`); belichting/versterking = index in hun ladder (`:49-50`, 10 standen,
  0 = automaat). Wisselt het effect, dan meldt de app `staat` met de nieuwe stand (`truth:"app"`).
- Scène i → werkplek i (nu alleen relatief: `_werkplek(r)`, `:2604-2607`; een absolute sprong is nieuw).
- **Paniek** = uitvoer in ±1 s naar zwart (nieuw: een zwarte laag over het eindbeeld), opname loopt door; zwart blijft
  tot de volgende druk op de handheld of een `zet`/`scene` van de hub.

**Fase B — bron (gamepad → hub) via `/cockpit`, zonder hub-code.** De cockpit-berichten (PROTOCOL §8) doen al wat
een bron nodig heeft; de handheld krijgt `beeld` (apps, focus, waarden) en kan dus relatief stappen:

| Handheld | Bericht naar `ws://<mac>:7700/cockpit?token=…` |
|---|---|
| D-pad links/rechts | `{t:"focus", app}` — vorige/volgende app uit `beeld.apps` |
| L1 / R1 + D-pad links/rechts | vorige/volgende parameter van de focus-app (alleen op de handheld) |
| D-pad op/neer | `{t:"zet", app, id, v: huidige ± 0,05}` (huidige uit `beeld.apps[].waarden`) |
| A | trigger: `zet v:1`, bij loslaten `v:0` (PROTOCOL §10, Cockpit) |
| X / Y / B | `{t:"snapshot", nr:1/2/3, actie:"laad"}` |
| paniek (akkoord, 1 s) | `{t:"virtueel", dev:"lpd8", bytes:[0x99,36,127]}` … `[0x89,36,0]` (virtuele LPD8 = mk2-fabrieksstand, noot 36 kanaal 10, PROTOCOL §10) |

- Omdat alle 40 plekken bezet zijn, wordt de bron een **eigen modus** (een eigen Ports-ingang "Varve Hub"), niet een
  laag in Varve Eye Art.
- Verbinding: **wifi** (werkt) met `npm start -- --lan` en het token (`docs/NETWERK.md`, PROTOCOL §13). usb0 pas als
  Clay bevestigt dat het werkt — en let op: zit de ESP32-CAM in dezelfde USB-C-poort (host, CH340), dan kan die poort
  niet tegelijk netwerkkaart zijn (gadget, `g_ether`).
- Camera → hub (energie, beweging als macro) kan pas met een kleine hub-uitbreiding (een bron-ingang voor
  continue waarden); de virtuele LPD8-knoppen werken met pickup en zijn daarvoor ongeschikt.

### 7.4 Regels van anbernic-cam
Eén register voor functies; nieuwe functie = één regel in `KNOP_ACTIES`/`AS_ACTIES` (`gereedschap/LEESMIJ.md`).
pygame-ce is de enige dependency (`speel-op-mac.sh`). Indeling "op de vingers bouwen, niet op redenering"
(`anbernic-cam/docs/TODO.md`, gebruikslog). Geen CLAUDE.md. De kernel van de SP is 4.9.170 zonder bron; modules zelf gebouwd.

### 7.5 Werk en risico's
- Fase A: **M** (±250 regels `hub.py` + koppeling in de lus; tests met `tools/nep-hub.mjs --toets` zoals flux:
  `flux-screensaver/tests/hub-toets.mjs`). Risico: de lus moet op 60/s blijven (`anbernic-cam/docs/TODO.md` §2) — alles via een
  draad en een wachtrij.
- Fase B: **M** (eigen modus, ±200 regels). Risico's: `beeld` gaat tot 10×/s volledig over de lijn (alle apps en
  waarden) — op wifi prima, op de H700 even meten; het token moet op de kaart (niet in git).

### 7.6 Open vragen voor Clay
1. Eerst als app op de Mac (fase A) — of wil je juist de handheld als afstandsbediening (fase B)?
2. Heeft jouw SP één of twee bruikbare USB-C-poorten? Is usb0 ooit gelukt (`varve-eye-usb.log`)?
3. Welke vijf werkplekken horen op de scène-knoppen?
4. Paniek: zwart, of terug naar het kale camerabeeld?

---

## 8. musicgen-video-glitch

### 8.1 Wat het is en hoe het draait
Offline Python-pijplijn (MusicGen small via audiocraft, Apple Silicon/MPS): video analyseren (helderheid,
beweging, `musicgen-video-glitch/src/video_analyzer.py:11-76`) → prompts → MusicGen per segment (≤ 30 s) → aan elkaar → ffmpeg
(`musicgen-video-glitch/src/main.py:16-85`). CLI: `python src/main.py --video … [--output …] [--model …]`. Geen poorten, geen UI, geen
CLAUDE.md. Generatie duurt per segment seconden tot minuten.

### 8.2 Huidige hub-stand
Niets. `IDEEEN.md:7` ("gebarenlog als conditionering"), ONDERZOEK.md §3 punt 10 (bugs) en §7 ("buiten scope").

### 8.3 Beste koppelvorm: geen live koppeling — naverwerking van de avondmap
Een driver of manifest heeft geen zin: niets is live te bespelen. Wel bruikbaar: de **avondmap** van de hub
(`docs/OPNAME.md`, `gebaren.jsonl`) als bron voor de prompts in plaats van (of naast) de video-analyse. Ontwerp, in
musicgen-video-glitch:
- `musicgen-video-glitch/src/hub_log.py`: leest `gebaren.jsonl` — de `beginstand` (regel 2) en elke `[ms,"naar",app,{t:"zet",id,v}]` — en
  houdt per app de waarden bij. Per venster van 5 s: gemiddelde van de parameters met rol `macro.intensiteit`,
  `macro.beweging`, `macro.helderheid` (rol uit het manifest; de kop heeft alleen een hash, dus een kleine
  rol-tabel naast het script).
- Zelfde vorm als `VideoAnalyzer.get_prompts_from_video` (`[{timestamp, duration, prompt, metrics}]`) en dezelfde
  drempels (`_map_metrics_to_prompt`, `musicgen-video-glitch/src/video_analyzer.py:78-95`), zodat `main.py` alleen `--hub-log <map>`
  erbij krijgt.
- Geen hub-trigger die een batchjob start: de hub start geen zware processen (de starter in `src/sets/` start apps,
  geen taken), en een job van minuten past niet in een avond spelen.

### 8.4 Regels / beperkingen
Geen CLAUDE.md. Bekende bugs eerst (ONDERZOEK.md §3 punt 10): de tussen-wav staat altijd in `output/`
(`main.py:67`: `output/generated_soundtrack.wav`), ook als `--output` (het pad van de eindvideo, `main.py:90`, gebruikt
op `:82`/`:85`) elders heen wijst; `train_lora.py` is geen LoRA en draait niet;
`requirements.txt` is ongepind (audiocraft is zwaar op Apple Silicon).

### 8.5 Werk en risico's
**S-M** (±100 regels + test met een kleine `gebaren.jsonl`). Risico: het hele repo draait waarschijnlijk niet zonder
eerst de omgeving te repareren; de muzikale waarde van "macro's → prompt" is onbewezen.

### 8.6 Open vragen voor Clay
1. Wil je dit nog, of is het project geparkeerd (`project.json`: laatst gewerkt 4 jan 2026)?
2. Prompts uit de gebaren, uit de video, of gemengd?
3. Eerst de bugs repareren (eigen PR in dat repo)?

---

## 9. Voorgestelde volgorde

| # | Wat | Waarom eerst | Wie | Waar |
|---|---|---|---|---|
| 1 | **varve-radio: lek dichten** (§2.3) | live voor iedereen, los van de hub, kleinste herstel, geen DDL | Claude bouwt + suite, Clay deployt en meet | varve-radio |
| 2 | **Paniek voor de driver-apps**: uurwerk (alleen manifest, §3.4), sediment (CC 123, §5.4), av-scene-kit (pad 42, §4.4) | LPD8-P1 doet nu niets voor TD/Sediment/uurwerk; veiligheid gaat voor nieuwe apps | hub: `apps/uurwerk.json`; **generator** (`sedimentManifest()` met CC 123 als uitzondering op `VERBODEN_CC`, `sceneKitManifest()` met pad 42) + de tests `test/drivers.test.js:358-363`/`:715-719`; TD-tak in av-scene-kit | hub + av-scene-kit |
| 3 | **uurwerk teruglezen** (§3.3), met tolerantie; lagen samenvoegen alleen als Clay het wil | de hub en de tab lopen nu uit elkaar; de lagenvloed raakt Clay's eigen geschiedenis (en vraagt uurwerk-code) | hub; uurwerk voor de lagen | `src/drivers/http.js`; `uurwerk/taal.js` |
| 4 | **td-lab driver** (§6.3) + `PROTOCOL.md` §2 en `config.json` → `apps.td-lab` bijwerken | nul code in td-lab, een heel nieuw instrument erbij; wel eerst de 9981-vraag | hub | `src/drivers/td.js`, `PROTOCOL.md`, `config.json` |
| 5 | **Varve Eye als app** op de Mac (§7.3 fase A) | stdlib-client bestaat al (flux); geen netwerkvragen | Claude in anbernic-cam, Clay proeft | anbernic-cam |
| 6 | Varve Eye als **bron** (fase B) | pas na wifi/usb0-proef en een gebruikslog | anbernic-cam | — |
| 7 | varve-radio als app (§2.4) | laag nut; pas als het lek dicht is en Clay het wil | varve-radio | — |
| 8 | musicgen: avondmap → prompts (§8.3) | niet live; eerst de bugs; alleen als Clay het project oppakt | musicgen-video-glitch | — |

Sediment's Logic-setup en de TD-device-mapper zijn handwerk voor de volgende hardware-avond (STATUS.md, golf 1);
die horen bij elke stap hierboven waar TD of Logic in zit.
