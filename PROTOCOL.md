# Protocol — hoe apps, hub en cockpit met elkaar praten

*Versie 1 · het contract voor alle bouwers. Code: `src/protocol/` (types, validatie). Conformiteit: `tools/nep-hub.mjs --toets`.*

## 1. Grondregels

1. **De hub is de enige die controllers opent.** Apps krijgen waarden, geen MIDI (behalve in lease-modus, §5).
2. **Waarden op de draad zijn altijd 0..1.** De app schaalt zelf naar Hz, dB, enz. Triggers zijn boolean.
3. **Elke app werkt ook zonder hub.** De koppeling zit achter een vlag (`?hub=ws://localhost:7700/app`).
4. **De app is de bron van waarheid** voor zijn eigen waarden (`truth: "app"`), tenzij hij dat niet kan melden (`truth: "hub"`: de hub onthoudt en speelt opnieuw af bij herverbinden).
5. Onbekende berichttypes en onbekende velden worden **genegeerd**, nooit een crash.

## 2. Transport

| Wie | Hoe | Adres |
|---|---|---|
| browser- en Node-apps | WebSocket, JSON, één bericht per frame | `ws://<hub>:7700/app` (van buiten de hub-machine met `--lan`: `?token=…` of `token` in `hallo`, §13) |
| cockpit | WebSocket, JSON | `ws://<hub>:7700/cockpit` (van buiten met `--lan`: `?token=…` of cookie `varve_hub_token`, anders 401 bij de upgrade) |
| passieve apps (Scene Kit-TD en Logic via MIDI, uurwerk via HTTP) | **driver** in de hub + statisch manifest in `apps/<app>.json` | MIDI: virtuele poort (`config.json` → `apps.<app>.midipoort`); HTTP: `config.json` → `apps.<app>.poort` |
| td-lab (TouchDesigner) | **driver** `td` in de hub (`src/drivers/td.js`) over de bestaande exec-bridge van td-lab: `POST /exec` met Python-tekst, antwoord altijd HTTP 200 met JSON `{ok, stdout, result, error}` (`ok:false` = de Python faalde). Statisch manifest `apps/td-lab.json`. Staat standaard uit: `config.json` → `apps.td-lab.autostart: true` (docs/TDLAB.md) | `http://127.0.0.1:<poort>/exec`, poort = `config.json` → `apps.td-lab.poort`, anders `bekende_apps.td-lab.tcp` (9981) |
| OSC | **bestaat niet.** De hub heeft geen OSC-transport en geen luisteraar; `poorten.osc` (7701) gebruikt alleen `varve-hub doctor` om te kijken of de poort vrij is. Een OSC-koppeling vraagt eerst een nieuw transport. | — |

Driver-soorten (`driver.soort` in `apps/<app>.json`, `src/drivers/index.js`): `midi`, `http`, `td`. Een driver meldt zich bij de kern als een gewone app (`hallo` + `manifest`, hartslag zolang de app gezond is, `truth:"hub"`).

## 3. Berichten app ↔ hub (`/app`)

Elk bericht is een object met `t` (type). Volgorde bij verbinden: hub stuurt `welkom` → app stuurt `hallo`, `manifest`, `staat`.

| Richting | Bericht | Betekenis |
|---|---|---|
| hub → app | `{t:"welkom", hub:"varve-hub", v:1}` | eerste bericht na verbinden |
| app → hub | `{t:"hallo", app, inst, v:1, token?}` | `app` = vaste id (`[a-z0-9-]+`), `inst` = willekeurig per start (zo ziet de hub een herstart) |
| app → hub | `{t:"manifest", manifest}` | zie §4 |
| app → hub | `{t:"staat", waarden:{id:v}}` | huidige waarden (0..1) van alle niet-trigger-parameters; ook later, gedeeltelijk mag |
| app → hub | `{t:"zet", id, v}` | de app veranderde zelf een waarde (muis, automatie) — hub werkt LEDs en pickup bij |
| app → hub | `{t:"hb"}` | hartslag, minstens elke `hb_s` seconden |
| app → hub | `{t:"led", dev?, bytes:[[…],…]}` | alleen lease: LED-berichten. Zonder `dev` (of `"apc40"`) voor de APC; `dev:"maschine-mk2"` voor de Maschine (§17); `"xboard49"` wordt bewaard maar nergens getoond (het keyboard ontvangt niets); een onbekend apparaat: genegeerd |
| app → hub | `{t:"scherm", dev:"maschine-mk2", nr, data}` | alleen lease, met `maschine-mk2` in `speelt`: scherm `nr` (0 = links, 1 = rechts), `data` = base64 van precies 2048 bytes (§17) |
| hub → app | `{t:"zet", id, v, bron?}` | zet parameter `id` op `v` (0..1). `bron`: `"apc40"`, `"lpd8"`, `"snapshot"`, `"replay"`, `"cockpit"` |
| hub → app | `{t:"trig", id, aan}` | trigger in (`aan:true`) en uit (`aan:false`) |
| hub → app | `{t:"scene", i}` | scène `i` (0-based) uit `manifest.scenes` |
| hub → app | `{t:"focus", aan}` | de app kreeg of verloor de APC-focus |
| hub → app | `{t:"globaal", waarden}` | globale macro's en klokken (§6), alleen gewijzigde sleutels |
| hub → app | `{t:"midi", dev, bytes}` | alleen lease: ruw MIDI-bericht van de APC (`dev:"apc40"`, §5), of van een speelapparaat (`"xboard49"`, `"maschine-mk2"`, §17) |
| hub → app | `{t:"fout", reden}` | bv. ongeldig manifest; de verbinding blijft open, behalve bij close-code 4001 (§11) en 4003 (§13) |

**Hartslag:** na 3 s zonder bericht is een app `stil` (LED knippert), na 10 s `weg` (LED uit, waarden blijven bewaard). Elk bericht telt als hartslag.

**Herverbinden:** apps proberen opnieuw met 0,5 → 1 → 2 → 5 s (max) wachttijd. Zelfde `inst` = netwerkhapering; nieuwe `inst` = herstart (pickup gaat opnieuw "wachten").

## 4. Manifest

```json
{
  "v": 1,
  "app": "formula-lab",
  "naam": "Formula Lab",
  "kleur": "#3fbf5f",
  "truth": "app",
  "hb_s": 1,
  "lease": false,
  "scenes": ["A", "B", "C"],
  "params": [
    { "id": "in1", "naam": "In 1", "soort": "waarde", "standaard": 0, "hint": "fader", "groep": "handen" },
    { "id": "take", "naam": "Take", "soort": "trigger", "hint": "pad" },
    { "id": "palet", "naam": "Palet", "soort": "keuze", "keuzes": ["warm", "koel", "mono"], "hint": "kolom" },
    { "id": "ruimte", "naam": "Ruimte", "soort": "waarde", "standaard": 0.4, "rol": "macro.ruimte", "slew_s": 4 }
  ]
}
```

| Veld | Verplicht | Betekenis |
|---|---|---|
| `v` | ja | altijd 1 |
| `app` | ja | id, `[a-z0-9-]{1,32}` |
| `naam` | ja | voor de cockpit |
| `kleur` | nee | hex; de hub kiest de dichtstbijzijnde APC-paletkleur. Standaard uit `config.json` → `apps.<app>.kleur` |
| `truth` | nee | `"app"` (standaard) of `"hub"` |
| `hb_s` | nee | hartslag-interval, standaard 1 |
| `lease` | nee | `true` = deze app krijgt ruwe APC-MIDI (§5) |
| `rings` | nee | alleen lease: `"host"` (app tekent ringen, standaard) of `"auto"` (hub tekent ringen mee met de knop — voor apps gebouwd op APC-modus 0x41, zoals av-kern) |
| `speelt` | nee | alleen lease: de speelapparaten die deze app bespeelt, bv. `["xboard49", "maschine-mk2"]` (§17). Max 8 namen; een naam die de hub niet kent valt weg |
| `scenes` | nee | namen; komen op de scene-knoppen |
| `params` | ja (mag leeg bij lease) | max 128 |

Parameter:

| Veld | Verplicht | Betekenis |
|---|---|---|
| `id` | ja | `[a-z0-9_.-]{1,48}`, uniek in de app |
| `naam` | ja | kort, voor cockpit en APC-kaart |
| `soort` | ja | `"waarde"` (0..1) · `"schakelaar"` (0 of 1) · `"trigger"` (moment) · `"keuze"` (index in `keuzes`, op de draad `index/(n-1)`) |
| `standaard` | nee | 0..1, standaard 0 |
| `keuzes` | bij `keuze` | 2..8 namen |
| `hint` | nee | `"fader"` · `"knop"` · `"pad"` · `"kolom"` — voorkeur voor automatische indeling |
| `groep` | nee | groepen worden pagina's op de device-knoppen en kolommen op het grid |
| `rol` | nee | koppelt aan een globale macro (§6), bv. `"macro.ruimte"` |
| `slew_s` | nee | de hub verloopt waarden over zoveel seconden (voor trage apps als medisynth): elke `zet` van de hub zelf (cockpit, snapshot, replay, LPD8-macro), niet een directe APC-beweging; alleen bij `soort:"waarde"` (§12) |
| `takeover` | nee | `"pickup"` (standaard voor faders), `"direct"`, `"schaal"` |
| `eenheid`, `min`, `max`, `centre` | nee | alleen voor weergave in de cockpit; `centre` = de waarde die op 0,5 ligt (log-schaal zoals JUCE `setSkewForCentre`), zonder `centre` lineair |

## 5. Lease-modus (Varve DJ, av-kern)

Een app met `lease:true` krijgt, zolang hij focus heeft, alle APC-invoer als `{t:"midi", dev:"apc40", bytes}` — behalve de **hubtoets** (`config.json` → `hubtoets`, standaard Bank = note 103) en alles wat binnenkomt terwijl die is ingedrukt. Wat de app aan LEDs wil, stuurt hij als `{t:"led", bytes}`; de hub bewaart dat per app en tekent het als de app focus heeft (volledige repaint bij wisselen). **Mode-SysEx (`F0 47 7F 29 60 …`) van apps wordt ingeslikt**: alleen de hub zet de modus (0x42). LPD8-invoer gaat nooit naar een lease-app als MIDI; die krijgt `globaal` zoals iedereen.

## 6. Globale laag (LPD8) en rollen

De LPD8 werkt altijd, los van focus. Knoppen 1–8 zetten globale macro's; elke app die een parameter met die `rol` heeft, krijgt een `zet` voor die parameter (met zijn eigen `slew_s`). Daarnaast krijgt elke app `globaal` met alle macro's en klokken, voor wie het zelf wil gebruiken.

| LPD8 | Rol / sleutel | |
|---|---|---|
| K1 | `macro.intensiteit` | |
| K2 | `macro.helderheid` | |
| K3 | `macro.ruimte` | |
| K4 | `macro.beweging` | |
| K5 | `macro.kleur` | |
| K6 | `macro.dichtheid` | |
| K7 | `klok.adem_periode` | 0..1 → 4..16 s per ademhaling (standaard 10 s = 6/min) |
| K8 | `macro.balans` | klank ↔ beeld |
| P1 | paniek (1 s vasthouden) | hub stuurt `trig paniek` naar iedereen die een trigger `paniek` heeft, en `globaal {paniek:1}` |
| P2 | tap tempo | `globaal {bpm}` |
| P3 | adem opnieuw (fase 0) | `globaal {adem_fase}` |
| P4 | gebaren opnemen aan/uit | hub-log |
| P5–P8 | snapshot 1–4 (lang = opslaan) | `zet` naar alle apps |

`globaal` bevat ook: `adem` (fase 0..1, ±10 Hz), `grondtoon` (`"D"`), `bpm`.

## 7. APC-indeling voor manifest-apps

- Faders 1–8: parameters met `hint:"fader"`, daarna overige `waarde`s in manifestvolgorde.
- Device-knoppen 1–8: `hint:"knop"`; meer dan 8 → pagina's per `groep`, Device ◄/► bladert.
- Track-knoppen 1–8: volgende 8 waarden.
- Grid: `keuze` → één kolom per keuze (rij = optie); `trigger`/`schakelaar` → pads per `groep`.
- Scene 1–5: `scenes`. Stop All: trigger `paniek` van die app als die bestaat.
- Overschrijven per app: `maps/<app>.json`, sleutel = control-id (`fader3`, `dk5`, `pad2-4`) → `{ id, takeover? }`.

**Hubtoets (Bank) ingedrukt:** bovenste padrij = app-slots 1–8 (kleur per app; pulseren = focus, vol = actief, gedimd = verbonden, knipperen = `stil`, uit = leeg/`weg`), Track Select 1–8 = focus, Scene 1–5 = hub-snapshot.

## 8. Cockpit (`/cockpit`)

De cockpit is een browserpagina die de hub toont en bedient. Hij is geen app (geen manifest).

| Richting | Bericht |
|---|---|
| hub → cockpit | `{t:"beeld", apps:[{app,naam,kleur,status,focus,params,waarden}], focus, globaal, apparaten:{apc40,lpd8}, opname, opnameInfo:{map,melding,fout,sinds}, slews:[{app,id,doel,eindMs}], nu}` — volledig, bij verbinden en max 10×/s bij wijziging. `opname` = LPD8-pad 4 neemt op; `opnameInfo` = map van de lopende avond (of `null`), laatste melding van de opname (blijft staan tot er een nieuwe komt; `fout:true` = schijf vol, map niet schrijfbaar, geen avondmap; een fout van de avond verdwijnt niet achter `opname klaar`, die wordt dan samengevoegd en blijft `fout:true`, net als bij verloren regels) en `sinds` (begin; `null` als er niets loopt, ook als pad 4 aan staat zonder avondmap); `slews` = parameters die nu over `slew_s` glijden (§12), `doel` 0..1; `eindMs` en `sinds` staan op de klok van de hub, `nu` is die klok op het moment van het beeld |
| hub → cockpit | `{t:"leds", dev:"apc40", staat:{<control-id>: LedStaat}}` — alleen gewijzigde |
| hub → cockpit | `{t:"invoer", g}` — elke controller-gebeurtenis (voor de live-weergave) |
| cockpit → hub | `{t:"virtueel", dev:"apc40"\|"lpd8", bytes}` — de virtuele controller drukt iets in, precies alsof het van USB kwam |
| cockpit → hub | `{t:"focus", app}` · `{t:"zet", app, id, v}` · `{t:"snapshot", nr, actie:"laad"\|"bewaar"}` |

`LedStaat` is die van `src/devices/apc40mk2.js` (`{kleur, anim}`, `{aan}`, `{knipper}`, `{stand}`, `{waarde}`).

## 9. Kern-API (binnen de hub)

Zodat transports, drivers en kern los van elkaar gebouwd kunnen worden. Types in `src/protocol/types.js`.

- Een **Verbinding** is alles waarlangs de hub met één app praat: `{ app, stuur(bericht), sluit?() }`. De WS-server maakt er één per socket; een driver (MIDI, HTTP, TD) is er zelf één.
- `kern.verbind(v)` → nieuwe verbinding (app nog onbekend); `kern.ontvang(v, bericht)` voor elk gecontroleerd bericht (`hallo`, `manifest`, `staat`, `zet`, `hb`, `led`) — bij `hallo` zet de kern `v.app`; `kern.verbreek(v)` bij sluiten.
- `kern.invoer(g, bytes)` voor elke gebeurtenis van `ApcSessie`/`Lpd8Sessie` en van de virtuele controllers (ruwe bytes zijn nodig voor lease).
- `kern.cockpit(b)`, `kern.focus(app)`, `kern.bewaar(nr)`, `kern.laad(nr)`, `kern.herteken()` (na opnieuw aansluiten), `kern.apparaatWeg(dev)`, `kern.zetApparaat(dev, info)`, `kern.zetOpnameInfo({map, melding, fout, sinds})` (alleen de meegegeven velden veranderen; `beeld.opnameInfo`, §8), `kern.beeld()`, `kern.stop()`.
- `kern.exporteer()` / `kern.importeer(data)`: het geheugen over een herstart heen (§12), puur; `src/opslag.js` schrijft en leest het.
- De kern schrijft LEDs via een **Oppervlak** `{ zet(id, LedStaat), teken(), stuur(bytes), vergeet() }` (`ApcSessie` voldoet) en stuurt naar apps via `verbinding.stuur()`.
- Events via `kern.bij(naam, fn)`: `beeld`, `leds`, `invoer`, `opname`, `naarApp`, `geheugen` (snapshots of truth:"hub"-waarden veranderden).
- `ApcSessie`/`Lpd8Sessie` (`src/apparaten.js`) melden `verbonden`, `weg`, `gebeurtenis` en `fout` (e, soort: `'sturen'` | `'openen'`, één keer per storing; §16).
- Bedrading van alles samen: `src/hub.js` (`startHub`), gestart met `varve-hub start`.

## 10. Beslissingen (golf 1)

Vragen die de bouwers opwierpen, en hoe ze beslist zijn. Dit is net zo bindend als de rest.

**Verbinden**
- `welkom` stuurt de hub; de server garandeert er precies één per verbinding.
- Een tweede `hallo` op dezelfde verbinding met dezelfde `app` en een nieuwe `inst` = herstart (drivers gebruiken dit na een storing): pickup opnieuw "wachten", bij `truth:"hub"` opnieuw afspelen.
- `truth:"hub"`: bij `hallo` speelt de hub alle bekende waarden opnieuw af (`bron:"replay"`) en negeert hij het eerstvolgende `staat` van die app, zodat standaardwaarden de bewaarde niet overschrijven. Sinds golf 4 ook over een herstart van de hub heen (geheugen op schijf, §12).
- Hartslag: `config.hartslag.stil_s`/`weg_s` gelden voor `hb_s = 1`; een app met `hb_s = 2` krijgt twee keer zo lang.

**Globaal (§6)**
- Sleutels in `globaal` zijn de rolnamen (`macro.ruimte`, …), plus `adem` (fase 0..1), `klok.adem_periode` (0..1 → `4 + 12·v` seconden), `bpm`, `grondtoon`, `paniek` (1 tijdens paniek, 0 na loslaten van P1).
- P3 zet `adem` terug op 0 (geen aparte `adem_fase`).
- LPD8-knoppen werken met pickup tegen de huidige waarde (eerste app met die rol, anders 0,5): er springt nooit iets, ook niet bij de eerste aanraking (uitzondering na een paniek: §14).
- P5–P8 en Bank+Scene: kort of lang wordt beslist bij loslaten (> 600 ms = bewaren). Snapshots bewaren app-waarden, geen globale macro's.

**APC (§7)**
- Slots in de Bank-laag: focus = pulseren, `actief` = vol, `nieuw` (hallo, nog geen manifest) = gedimd, `stil` = knipperen, `weg`/leeg = uit. Bank + Shift + Scene = snapshot bewaren; bewaarde scènes branden wit.
- Faders: de fysieke stand is bij de start onbekend → de clip-stop-LED van die strip knippert tot de fader de doelwaarde kruist.
- `config.ringen_nemen_waarde_over` (standaard `true`, te bevestigen door proef V1): bij focus krijgt elke ringknop de waarde van de app. Bij `false` krijgen ringknoppen pickup en toont de ring alleen een bekende fysieke stand.
- Kaarten per app: `maps/<app>.json` (`{ "<control-id>": { "id": "<param>", "takeover"?: … } }`), door de hub ingelezen als `config.kaarten`.
- Een keuze met meer dan 5 opties: pad stapt door de opties.

**Cockpit (§8)**
- `beeld` bevat ook: per app `slot`, `lease`, `pagina`, `paginas`; verder `snapshots`, `opname`, `opnameInfo`, `slews` en `nu` (§8), `pickup` (`{ <control-id>: { id, doel, gevangen, fysiek } }` voor spookfaders) en `apparaten` (`{ apc40: { verbonden, naam }, lpd8: { verbonden, naam, model } }`, plus de speelapparaten en `spelers`, §17).
- Bij verbinden krijgt een cockpit `beeld` én een volledig `leds`. Ongeldige cockpitberichten → `{ t:"fout", reden }`.
- Een cockpit-`zet` op een trigger: `v:1` = `trig aan:true`, `v:0` = `trig aan:false`.
- Valt een cockpit weg (sluiten, fout of geen pong) terwijl hij virtueel iets ingedrukt houdt, dan laat de hub die toetsen los; zo ook elke trigger die hij met `zet` (`v > 0`) indrukte en niet losliet (golf 8): `zet v:0` → `trig aan:false`. Niet zolang iemand anders hem nog vasthoudt: een andere cockpit (die laat hem los, of de hub als ook die wegvalt) of de hardware (LPD8 P1 op `paniek`, Stop All op de paniek-trigger van die app, een APC-pad; de kern laat hem los bij het loslaten daarvan). Een nette `v:0` van een cockpit laat hem wel direct los, ook als een ander hem nog vasthoudt (de kern telt de bronnen van een cockpit-trigger niet: een bekende grens, docs/DUURTEST.md golf 8 punt 1); daarna houdt niemand hem meer vast en volgt bij wegvallen geen tweede `aan:false`. Is de id na een nieuw manifest geen trigger meer (een waarde, of weg) of is de app vergeten, dan stuurt de hub niets (een `zet` zou een waarde op 0 zetten); is de app op dat moment weg, dan valt het loslaten weg, zoals bij de APC (kwam hij al terug, dan hoort hij het).
- De virtuele LPD8 stuurt altijd de mk2-fabrieksstand (noot 36–43 kanaal 10, CC 70–77); de hub leest die los van het profiel van de echte LPD8.

## 11. Beslissingen (golf 2 — uit het breken)

- **Twee instanties van dezelfde app** (bv. twee tabs): de nieuwste wint. De oude krijgt `{t:"fout", reden:"vervangen: …"}` en close-code **4001**, en wordt geweigerd zolang de nieuwe verbonden is. Een app die 4001 krijgt, wacht 30 s voor hij opnieuw probeert (anders verdringen ze elkaar eindeloos).
- **Driver en echte app met dezelfde id** (bv. uurwerk via HTTP én een uurwerk-tab met `?hub=`): de WebSocket-verbinding wint; valt die weg, dan neemt de driver het weer over (als herstart, met replay).
- **Slots worden hergebruikt.** Een app die terugkomt krijgt zijn eigen slot. Zijn alle 8 bezet, dan krijgt een nieuwe app het slot van een weggevallen app (liefst niet die met focus). Volgorde (golf 7): zijn eigen slot, dan een leeg slot (gat), dan een nieuw slot achteraan, dan dat van een weggevallen app. Na een herstart midden in de set (§12, loopbestand) blijven de slots van apps die nog niet terug zijn gereserveerd tot alle 8 vol zijn, en pakt de focus-app van toen de focus terug als hij binnen 60 s terugkomt, tenzij Clay of de set intussen een focus koos.
- **Lease-LEDs:** alleen geldige berichten (precies één note-on, note-off of CC van 3 bytes) gaan naar de APC — ook verstopte mode-SysEx valt weg, al bij de validatie (`isLedBericht`). Bij een stortvloed lopen lease-LEDs hooguit ±40 ms voor op de APC; de rest wordt per LED samengevoegd (nieuwste wint).
- **LPD8-pickup volgt de buitenwereld:** verandert de waarde van een macro door een snapshot, de app of de cockpit, dan "wacht" de LPD8-knop weer tot hij die waarde kruist (uitzondering: wat een app zelf doet tijdens of vlak na een paniek, §14).
- **Triggers blijven nooit hangen:** het loslaten gaat altijd naar de trigger waar het indrukken heen ging, ook na een nieuw manifest, een paginawissel of een focuswissel. **Dezelfde toets van twee bronnen** (golf 8: de APC én virtueel in de cockpit, of twee cockpits): de hub kent geen bronnen, een APC-toets is in of uit. Een druk op een toets die al in is en naar dezelfde bestemming gaat (dezelfde app met focus, of de Bank-laag), doet niets: geen tweede `trig aan:true`, geen tweede zet of keuze, geen gat in een Stop All-paniek. Wisselde de bestemming ertussen (focuswissel, Bank in of uit), dan krijgt de eerste eerst zijn los (`trig aan:false`, Stop All gaat in de naloop, een lease-app een note-off) en geldt de druk daarna voor de nieuwe. De eerste los laat de toets los; een los op een toets die al los is, gaat nergens heen (ook niet naar de app met focus). Bank en Shift net zo: de eerste los laat ze los. Komt een los nooit aan (een verloren note-off, of de APC was met RtMidi korter los dan één tik van de poortlijst zodat er geen `apparaatWeg` komt, §16), dan ziet de hub de toets nog als in: de eerstvolgende druk bij dezelfde bestemming telt niet, de los daarna laat hem los. Er blijft niets hangen; het kost Clay hooguit één tik. LPD8: een P1-druk terwijl de paniek loopt of al aftelt, start geen tweede (de eerste los beëindigt hem); P2–P4 tellen elke druk (een LPD8 in PC-modus stuurt geen los), P5–P8 kort of lang vanaf de laatste druk (bij twijfel laden, nooit per ongeluk een snapshot overschrijven). P1 en P5–P8 werken op de los en vragen dus een LPD8 in note- of CC-modus (de standaardprofielen gebruiken noten): in PC-modus begint P1 na een seconde (`PANIEK_MS`) een paniek die pas eindigt als de LPD8 wegvalt, en doen P5–P8 niets. Faders en knoppen hebben geen druk of los en merken hier niets van.
- **Stoppen:** een gestopte kern negeert alles en start geen timers meer; `hub.stop()` sluit eerst de server, schrijft dan het geheugen weg (§12), stopt de kern en sluit de apparaten.
- **Zonder virtuele MIDI-poorten** (geen RtMidi) starten de MIDI-drivers niet en melden ze dat; TD en Sediment staan dan niet als "actief" in de cockpit.

## 12. Beslissingen (golf 4 — geheugen en slew)

**Geheugen op schijf**
- De hub onthoudt over een herstart heen: de snapshots (1-5 via Bank+Scene, 1-4 via de LPD8) en de laatste waarden van apps met `truth:"hub"`, plus per zo'n app zijn laatste `inst`. Waarden van `truth:"app"`-apps niet (die app weet het zelf); komt een bewaarde app terug als `truth:"app"`, dan verdwijnen zijn waarden uit het geheugen.
- Bestand: `config.json` → `geheugen.pad` (standaard `~/.varve-hub/staat.json`); `$VARVE_HUB_STAAT` gaat voor; `varve-hub start --zonder-geheugen` zet het uit. Inhoud: `{ "v": 1, "snapshots": { "<nr>": { "<app>": { "<param>": 0..1 } } }, "waarden": { "<app>": { … } }, "inst": { "<app>": "<inst>" } }`.
- Schrijven: hooguit eens per `geheugen.schrijf_ms` (minimum en standaard 1000 ms), alleen bij een echte wijziging, atomisch (tijdelijk bestand + fsync + rename), en bij stoppen meteen. Van een lopende slew wordt het doel bewaard, niet de tussenwaarde.
- Lezen bij de start. Ontbreekt het bestand: leeg beginnen, met een melding. Kapot, onleesbaar of een onbekende versie: leeg beginnen, en het oude bestand gaat naar `<pad>.kapot`; lukt dat niet, dan schrijft de hub deze sessie niets (het oude geheugen blijft). Ongeldige onderdelen vallen weg; dan blijft het origineel als kopie in `<pad>.kapot`.
- Slots en focus staan **niet** in het geheugen: na een nette stop is een nieuwe start een nieuwe avond (de BANK-rij begint bij slot 1). Alleen na een herstart midden in de set komen ze terug, uit het loopbestand.
- **Loopbestand** (golf 7): `<geheugen>.loopt` staat er zolang de hub draait en gaat weg bij netjes stoppen (Ctrl-C, SIGTERM, venster dicht). Staat het er bij de start nog, dan viel de vorige hub om (kill -9, een fout in de hub, stroom weg). Inhoud: `{ "v": 1, "pid", "begon", "set", "apps": { "<app>": <pid> }, "sinds": { "<app>": "<iso>" }, "opname": bool, "slots": [<app>|null], "focus": <app>|null }`. De volgende start neemt dan de nog levende processen van de set over (alleen als hun begintijd klopt met `sinds`), zet slots en focus terug, laat de opname doorlopen in een nieuwe avond en herstelt de afgebroken avond (alleen avonden die begonnen nadat die hub startte). Is het loopbestand van vóór de laatste opstart van de computer, dan is het een gewone start (alleen de afgebroken avond wordt hersteld). Draait er nog een hub met hetzelfde geheugen, dan laat een tweede hub het loopbestand ongemoeid. Met `--zonder-geheugen` is er geen loopbestand.
- **Uitvoer van de apps** van een set: `<map van het geheugen>/uitvoer/<app>.log` (de vorige start: `<app>.vorige.log`), niet via een pipe, zodat de apps een crash van de hub overleven.
- Replay na een hub-herstart: zodra het manifest van een `truth:"hub"`-app binnenkomt, krijgt hij de bewaarde waarden (`bron:"replay"`) en wordt zijn eerstvolgende `staat` genegeerd. Meldt hij zich met **dezelfde `inst`** als vorige sessie (hij draaide gewoon door), dan gaan ze direct, zonder slew: hij heeft ze nog, en zo is er geen dip. Met een **nieuwe `inst`** (de app herstartte ook, of een driver: die krijgt per hub-start een nieuwe inst) staat de app op zijn standaardwaarde en verlopen ze van daaruit met `slew_s`.

**slew_s**
- `slew_s` geldt voor elke `zet` van de hub zelf: cockpit, snapshot laden, replay na een herstart, LPD8-macro. Niet voor een directe APC-fader of -knop: die is al continu en moet direct voelen; zo'n beweging breekt een lopende slew af.
- Alleen voor `soort:"waarde"`; een keuze of schakelaar springt.
- Elke nieuwe `zet` start een nieuwe slew vanaf de huidige (tussen)waarde, met de volle `slew_s`. Een cockpit-schuif die je sleept loopt dus achter; laat je hem los, dan blijft de schuif op het doel staan en toont de cockpit de tussenwaarde als aparte balk met "→ doel" tot de slew klaar is (`beeld.slews`, §8). Dat is bewust: de app krijgt nooit een sprong.

**Apps per monitor**
- Een app met `per_monitor: true` in `config.json` (flux) meldt zich per monitor aan als `<app>-<monitor>` (`flux-dp-1`). De hub geeft die de kleur van de basis-app en de naam `"<naam> (<monitor>)"`; staat de monitor niet in de naam uit het manifest, dan zet de hub hem erachter.

## 13. Beslissingen (golf 4 — op het netwerk, docs/NETWERK.md)

- **Token met `--lan`.** Luistert de hub op het netwerk, dan moet elke verbinding van buiten de eigen machine (niet `127.0.0.1`/`::1`) het token tonen. Lokaal blijft alles zonder token werken.
  - `/app`: `?token=…` in de URL, of `token` in `hallo` (`{t:"hallo", app, inst, v:1, token}`). Het token gaat nooit naar de kern of een logboek.
  - `/cockpit` en HTTP: `?token=…` in de URL of het cookie `varve_hub_token` (dat de hub zet na een `?token=`). Zonder geldig token: HTTP **401**, ook bij de upgrade van `/cockpit`.
- **Zonder geldig token op `/app`:** de hub stuurt `welkom` en wacht op `hallo`. Een `hallo` zonder of met een verkeerd token, elk ander bericht eerst, of geen `hallo` binnen 3 s → `{t:"fout", reden:"token nodig: …"}` en close-code **4003**. Zo'n verbinding bereikt de kern nooit (geen slot, geen LEDs). Hooguit 16 tegelijk wachtend (4 per adres); daarboven gaat een nieuwe meteen dicht. `/app` accepteert ook het cookie (voor pagina's van de hub zelf, zoals `/oefen`).
- **Een app die 4003 krijgt** herverbindt met de gewone backoff (0,5 → 5 s); opnieuw proberen helpt pas als het token klopt, dus een app mag ook bewust langzamer gaan of de gebruiker melden dat het token ontbreekt.
- **Grenzen (golf 5, beveiligingsreview):** hooguit 128 verbindingen tegelijk (daarboven HTTP 503 bij de upgrade); snapshotnummers vanuit de cockpit 1..99; `inst` in `hallo` hooguit 64 tekens.
- **Origin voor `/cockpit` (golf 5):** alleen same-origin (de pagina's van de hub zelf) of wat in `server.origins` staat; niet meer elke `localhost`-poort. `/app` mag lokaal vanaf `http(s)://localhost` en `127.0.0.1` op elke poort (browser-apps op hun eigen dev-server).
- **Elk HTTP-antwoord** heeft `X-Frame-Options: DENY`, `Content-Security-Policy: frame-ancestors 'none'` en `Referrer-Policy: no-referrer`. Meerdere `varve_hub_token`-cookies: één geldig is genoeg.
- **Zonder token luistert de hub nooit buiten loopback:** een `host` die niet `127.0.0.1`/`localhost`/`::1` is zonder token wordt geweigerd vóór het luisteren (`start` stopt met exit 4).

## 14. Beslissingen (golf 5)

Uit de generale repetitie (`docs/REPETITIE.md`). Getoetst in `test/kern-golf5.test.js` en `test/repetitie.test.js`.

**Pickup na een paniek** (vult §11 "LPD8-pickup volgt de buitenwereld" aan)
- Wat een app **zelf** verandert (`zet` of `staat` van de app) terwijl de paniek loopt, of binnen `paniek.naloop_s` seconden daarna (`config.json`, standaard 5; 0 = alleen tijdens de paniek, en dan telt bij Stop All alleen wat binnenkomt terwijl de knop ingedrukt is; geen getal ≥ 0 → melding bij de start en 5), verplaatst het pickup-doel van een **LPD8-macroknop** niet. De knop blijft gevangen; de eerste tik zet weer elke app met die rol. Voorbeeld: Waterschaal zet bij paniek zelf `volume` op 0 en meldt dat; K1 stond op 0,28 en blijft gevangen, dus de volgende tik zet Waterschaal én MediSynth weer op de knopstand.
- De hub bewaart en toont die waarde gewoon (`waarden`, cockpit, geheugen): alleen het pickup-doel van de LPD8-knop blijft staan. Had de knop nog geen pickup (nog nooit aangeraakt, ook als er geen LPD8 aan hangt), dan geldt als doel de waarde van vóór die zet, niet de paniekwaarde. Dat doel blijft staan tot de knop het oppakt of de buitenwereld het na de naloop verplaatst (cockpit, snapshot, een zet van de app), ook uren later: wie daarna K1 vanaf 0 opendraait, hoort niets tot de knop de oude stand kruist. Bewust zo: na een paniek is de stand van vóór de paniek het referentiepunt, niet de stilte.
- Dit is een uitzondering op §9 ("er springt nooit iets, ook niet bij de eerste aanraking") en §11: de eerste K1-tik na een paniek zet de app die zichzelf stil zette van 0 terug naar de knopstand. Dat is precies de bedoeling.
- **K1 werkt ook terwijl de paniek nog loopt** (P1 of Stop All nog vast): draai je K1, dan gaan de apps met die rol meteen naar de knopstand, ook de app die zichzelf net stil zette. Wie P1 vasthoudt en tegelijk aan K1 draait, doet dat met opzet.
- "De paniek loopt": LPD8-P1 is vastgehouden (vanaf het moment dat de paniek ingaat, na 1 s) tot loslaten, voor alle apps; of **Stop All** van de app met focus is ingedrukt, alleen voor die app. De naloop telt vanaf loslaten. Het loslaten van Stop All telt voor de app waar het indrukken heen ging, ook na een focuswissel, een nieuw manifest (met of zonder paniek-trigger, of een lease), een vergeten app of een APC die wegvalt: een paniek blijft nooit hangen.
- Alleen wat de app zelf doet. Een zet van de cockpit of een snapshot tijdens de paniek verplaatst het doel wél (zoals §11).
- **APC-pickups (faders, ringknoppen zonder overname) van de app met focus volgen wél de buitenwereld**, ook tijdens een paniek: zo'n control hoort bij precies één parameter van de app die je ziet, en wat de app daar zelf van maakt is de waarheid. Na `volume` 0 wacht fader 1 dus weer (de clip-stop-LED knippert) tot hij 0 kruist. Een LPD8-knop is een macro over alle apps met die rol: als één app hem tijdens een paniek loskoppelt, doet hij voor alle andere apps ook niets meer.

**Geen dubbele zets bij keuze en schakelaar**
- Een `zet` op een parameter met `soort` `keuze` of `schakelaar` gaat niet naar de app als de gekwantiseerde waarde gelijk is aan wat de hub al van de app weet. Dat geldt voor elke bron (LPD8-macro, APC-pad of -stap, cockpit, snapshot): dezelfde keuze nog eens sturen heeft nooit zin. LEDs en pickup worden wel bijgewerkt, en `globaal` (de macro zelf) gaat nog steeds bij elke tik naar iedereen.
- **Replay gaat altijd** (`bron:"replay"`, na een herstart van de app of van de hub): de app weet het dan nog niet.
- Meldde de app zelf een andere stand (`zet`/`staat`), dan gaat de oude stand daarna gewoon weer.
- **Bekende grens:** de hub vergelijkt met wat hij zelf het laatst zette of hoorde, niet met wat de app bevestigde. Kruisen een zet van de hub en een eigen zet van de app elkaar, of negeert een app een zet zonder iets terug te melden, dan kan de hub een andere stand denken dan de app heeft; dezelfde keuze nog eens kiezen doet dan niets. Lopen hub en app zo uiteen (de cockpit toont een andere optie dan de app), kies dan even een andere optie en daarna weer de gewenste, of herstart de app: dan meldt hij zijn stand opnieuw (`staat`), of speelt de hub bij `truth:"hub"` alles opnieuw af.
- Voor `soort:"waarde"` verandert er niets.

**Globale adem volgt de adem-app**
- Verandert de eerste app met een parameter met rol `klok.adem_periode` die waarde (zelf, of via cockpit/snapshot), dan gaat `globaal['klok.adem_periode']` mee, zonder sprong in de adem-fase. Zo ademen alle apps en de cockpit in de periode van de app die je hoort (bv. Waterschaal na een scène). De LPD8 (K7) zet globaal zoals altijd; een tweede app met dezelfde rol bepaalt de klok niet.

**Paniek bij de driver-apps** (golf 6, `test/paniek-drivers.test.js`): ook een driver-app heeft een trigger `paniek` in zijn statische manifest, zodat P1 en Stop All hem bereiken; wat dat betekent, beslist het manifest. **uurwerk**: `pas_toe` `+master 0.00` met `meet_seconden: -1` (alleen bij indrukken; terug met `master_terug`). `pas_toe` start de engine als die nog niet liep (daarna stil). De paniek blijft niet staan: uurwerk zet de master terug op 0,8 bij elke patchtekst zonder regel `master` (de terugdraai-stap van de tuinman tot 30 s na zijn ingreep, een uur, een moment, een set; `docs/VOLGENDE-KOPPELINGEN.md` §3.4); dat is een wens voor het uurwerk-repo. Een trigger gaat ook als de brug bij de laatste gezondheidscheck onbereikbaar leek (de kern speelt triggers bij herstel niet opnieuw af; de driver logt het). **Sediment**: CC 123 All Notes Off (bij indrukken en loslaten; de enige verboden CC die de hub stuurt, `PANIEK_CC`). Dat laat alle noten los: ze vallen weg met Sediments eigen Release (standaard 7 s, tot 30 s) plus de staarten van galm en echo; geen harde stop. **Scene Kit (TD)**: noot `midi.pads.paniek` (42, alleen als `av-scene-kit/config.json` die sleutel heeft) met `driver.presets` → `master_dim` 0. TD zet de master op 0 en neemt de eerstvolgende CC 27 meteen over (welke waarde ook, geen kruising), of een preset; zo volgt TD wat de hub daarna bewust stuurt (K2 zoals hierboven voor manifest-apps, de cockpit, een snapshot, de APC-fader, die eerst door 0 moet). Zette de app een waarde zelf (preset of paniek) en zou de hub daarna precies de bytes sturen die TD al had, dan stuurt de MIDI-driver eerst een stapje ernaast, want een MIDI In CHOP ziet alleen veranderingen.

**uurwerk leest terug (golf 6)**
- De HTTP-driver van uurwerk leest de tab regelmatig terug (`config.json` → `teruglezen`); een echt verschil komt in de kern als zet van de app (bron `app`, §11 en hierboven), nooit terug naar de tab. Wat de hub net zelf stuurde (2 s) en afrondingsverschillen tellen niet.

## 15. Beslissingen (golf 7 — duurtest, docs/DUURTEST.md)

Uit een avond van uren in een paar minuten. Ze begrenzen wat de hub onthoudt over apps die nooit afmaken wat ze begonnen:
- **Een app die nooit een geldig manifest stuurde, wordt bij verbreken vergeten**: weg uit de lijst en uit `beeld.apps` (geen status `weg`), zijn slot komt vrij voor een ander (een gat gaat vóór een nieuw slot achteraan), en had hij de focus, dan heeft niemand die (een bewaarde focus van na een herstart van de hub blijft staan). Uitzondering op §11 "Een app die terugkomt krijgt zijn eigen slot": een app zonder manifest is niets kwijt en begint opnieuw. Een app mét manifest blijft zoals altijd bekend met status `weg` en zijn waarden (§3).
- **Vóór het manifest** bewaart de hub van `zet`/`staat` alleen waarden met een geldige id (`PARAM_ID`, §4), hooguit `MAX_PARAMS` (128) ids; de rest valt stil weg.
- **Een nieuw manifest ruimt op**: waarden (en lopende slews) van ids die het niet (meer) heeft, vallen weg; bij `truth:"hub"` gaat dat mee naar het geheugen op schijf (§12). Parameters die blijven, houden hun waarde.

## 16. Beslissingen (golf 8)

- **Een kabel die even los is (docs/DUURTEST.md golf 8 punt 3).** De controller komt terug met een poort die een signaal geeft; met RtMidi alleen via de poortlijst. Drie wegen, in `src/core/aansluiting.js`:
  - **De poortlijst, elke 250 ms** (`LIJST_MS`, los van het openen elke `hotplug_ms`): staat het apparaat er niet meer in, dan sluit de hub de poort en meldt `weg`; komt het terug, dan opent hij het bij de eerstvolgende tik (niet pas bij de ronde) en initialiseert het (APC: modus, ringtypes, alle LEDs; LPD8: identiteitsvraag). Dit is het enige dat met RtMidi werkt: daar gooit sturen niet en meldt de poort niets (`src/ports/rtmidi.js`). Een kabel die korter los is dan één tik, blijft daar onzichtbaar (de APC blijft dan donker in modus 0x40); of en hoe lang het apparaat bij kort uittrekken uit de lijst verdwijnt, meten we op de hardware-avond (docs/HARDWARE-AVOND.md).
  - **De poort zegt dat hij niet meer leeft** (`levend()` false, de nep-poort na een replug) **of sturen gooit**: de eerste keer (en bij een poort die niet meer leeft elke keer, met de pauzes hieronder) sluit de hub de poort meteen, meldt `weg`, opent hem opnieuw en initialiseert het apparaat, ook als de kabel al terug is vóór de volgende ronde.
  - **Blijft sturen daarna mislukken**, dan blijft de poort open (de ingang werkt misschien nog: knoppen en pads blijven aankomen, geen `weg`, de LPD8-waarden en een lopende paniek blijven staan) en initialiseert de hub het apparaat alleen opnieuw, met pauzes van 0,25 s die steeds verdubbelen tot 30 s (`HERSTEL`). Lukte sturen weer 10 s, of was het apparaat echt uit de lijst, dan begint het weer bij meteen opnieuw openen.
- **Eén logregel per storing, niet per bericht of per poging**, via de log van `src/hub.js`: `APC: sturen mislukt — kabel los? de hub probeert opnieuw` (voorbij zodra er weer iets verstuurd is) en `APC: openen mislukt (<reden>) — de hub probeert opnieuw` (voorbij zodra de poort weer open is); voor de LPD8 met `LPD8:`. De twee soorten staan los van elkaar: de ene onderdrukt de andere niet. Een hikje in de poortlijst terwijl de poort open is, is geen storing en geeft geen regel.
- **Sessie-API (§9):** `ApcSessie`/`Lpd8Sessie` melden `fout` als `(e, soort)` met `soort` `'sturen'` of `'openen'`; in het logboek een `melding` met `wat:"fout"`, `soort` en `fout` (de tekst van de fout).

## 17. Speelapparaten: Xboard49 en Maschine MK2 (golf 9)

Twee controllers om op te spelen, naast de APC40 en de LPD8. De hub opent ze (huisregel 1) en geeft ze door aan één
lease-app tegelijk; ze staan buiten de laagstapel van de APC (§7) en de globale laag (§6).

| Apparaat | Hoe de hub hem opent | Wat de app krijgt (`{t:"midi", dev, bytes}`) | Terug |
|---|---|---|---|
| **E-MU Xboard49** (`xboard49`) | MIDI, alleen de ingang (class-compliant; het keyboard ontvangt niets). Poortnaam: `config.json` → `apparaten.xboard49.naam` | de ruwe bytes, ongewijzigd: noten, kanaal-aftertouch, pitchbend, CC1, CC64, bank select + programmawissel, CC120/123 (paniek), de 16 knoppen (CC of NRPN), en de schuif als SysEx Master Volume `F0 7F 7F 04 01 ll mm F7` | niets |
| **Maschine MK2** (`maschine-mk2`) | USB-HID (`src/ports/hid.js`, node-hid, optioneel), VID:PID uit `config.json` → `apparaten.maschine-mk2` | **virtuele MIDI** (docs/MASCHINE.md): pads noot 36–51 kanaal 0 met velocity, polyfone aftertouch (hooguit ±30×/s per pad, alleen bij verandering); knoppen noot = bitnummer (0–47) op kanaal 1; 8 draaiknoppen CC 16–23 relatief; masterwiel CC 24 relatief (tweecomplement) | `{t:"led", dev:"maschine-mk2"}`: noot aan op hetzelfde nummer, pads en groepknoppen velocity = APC-paletindex, andere knoppen velocity = helderheid; `{t:"scherm"}` |

**Wie speelt** (per apparaat apart): de app met APC-focus als die het apparaat in `speelt` heeft; anders de laatst
gefocuste app die het heeft; anders de eerste in slotvolgorde die het heeft. Alleen verbonden lease-apps tellen (niet
`weg`). Niemand: de invoer gaat nergens heen. De hubtoets (Bank) doet hier niets: het keyboard speelt door terwijl je
focus wisselt. `beeld.spelers` (§8) zegt per apparaat wie er speelt.

**Niets blijft hangen** (zoals §11): een loslaten (noot uit, of noot aan met velocity 0; pedaal CC64 < 64) gaat altijd
naar de app die het indrukken kreeg, ook na een focuswissel. Een loslaten van iets dat niemand vasthield, gaat nergens
heen. Wordt dezelfde toets nog eens ingedrukt terwijl hij bij een andere app in staat, dan krijgt die eerst een
loslaten. Polyfone aftertouch volgt de noot (naar wie hem indrukte; van een noot die niet in is: weg). Valt het apparaat
weg (uittrekken), dan krijgt elke app het loslaten van wat hij nog vasthield. Paniek van de Xboard (CC120/123) gaat naar
wie nu speelt én naar elke app die op dat kanaal nog iets vasthoudt. Al het andere (CC, pitchbend, kanaal-aftertouch,
SysEx, programmawissel) gaat naar wie nu speelt.

**Lampjes en schermen van de Maschine.** De hub bewaart per app wat hij stuurde (laatste per adres, en per scherm) en
toont het zolang die app speelt. Wisselt wie speelt, dan eerst alles uit en daarna wat de nieuwe app het laatst stuurde
(volledige repaint). Een app die het apparaat niet in `speelt` heeft, kan er niets op zetten. Scherm: 256×64 pixels,
1 bit, rij voor rij van boven, 32 bytes per rij, het hoogste bit is de meest linkse pixel, 1 = aan (`data` base64,
precies 2048 bytes; anders `{t:"fout"}`). Bij stoppen gaan lampjes en schermen uit (de panelen houden anders hun beeld).

**Status voor de cockpit** (`beeld.apparaten.xboard49` en `beeld.apparaten["maschine-mk2"]`, alleen als `config.json`
ze noemt): `{verbonden, naam}`, voor de Maschine ook `status` (`"geen-hid"` node-hid ontbreekt · `"zoekt"` niet
aangesloten · `"bezet"` openen mislukt, een NI-programma heeft hem · `"verbonden"` · `"geen-invoer"` open, maar binnen
`stil_ms` geen enkel rapport: macOS-Invoermonitoring) en `hint` (wat te doen). In het hubvenster één regel per storing
(§16): `Maschine: bezet (…) — sluit Maschine 2 en Controller Editor; …` of `Maschine: open, maar er komt niets binnen — …`.
De hub probeert het bij elke hotplug-ronde opnieuw.

**Kern-API (§9):** `new Kern({ …, speelOppervlakken: { "maschine-mk2": { led(m), scherm(nr, data), leeg() } } })`;
`kern.invoer(g, bytes)` ook voor `XboardSessie`/`MaschineSessie` (`src/apparaten.js`); `kern.apparaatWeg("xboard49" |
"maschine-mk2")` laat los wat er vastgehouden werd. De routering zelf staat in `src/core/spelers.js` (puur).

**Opname en logboek:** de avondmap (`docs/OPNAME.md`) neemt `xboard49` en `maschine-mk2` op (bij de Maschine de virtuele
MIDI, al uitgedund); `herhaal` speelt ze niet af (ze gaan alleen naar lease-apps, die niet in de eindstand staan).
In een proeflogboek: elk knoppenrapport van de Maschine ruw (`maschine-mk2`), padrapporten alleen als ze iets deden of
tijdens de rustopname, en de virtuele MIDI als `maschine-mk2-midi` (golden test, `test/herspeel.js`).
