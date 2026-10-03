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
| browser- en Node-apps | WebSocket, JSON, één bericht per frame | `ws://<hub>:7700/app` |
| cockpit | WebSocket, JSON | `ws://<hub>:7700/cockpit` |
| OSC-apps (TD, Python) | OSC/UDP | hub luistert op 7701; app noemt zijn eigen poort in `hallo` |
| passieve apps (TD via MIDI, uurwerk via HTTP, Logic) | **driver** in de hub + statisch manifest in `apps/<app>.json` | — |

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
| app → hub | `{t:"led", bytes:[[…],…]}` | alleen lease: LED-berichten voor de APC |
| hub → app | `{t:"zet", id, v, bron?}` | zet parameter `id` op `v` (0..1). `bron`: `"apc40"`, `"lpd8"`, `"snapshot"`, `"replay"`, `"cockpit"` |
| hub → app | `{t:"trig", id, aan}` | trigger in (`aan:true`) en uit (`aan:false`) |
| hub → app | `{t:"scene", i}` | scène `i` (0-based) uit `manifest.scenes` |
| hub → app | `{t:"focus", aan}` | de app kreeg of verloor de APC-focus |
| hub → app | `{t:"globaal", waarden}` | globale macro's en klokken (§6), alleen gewijzigde sleutels |
| hub → app | `{t:"midi", dev, bytes}` | alleen lease: ruw MIDI-bericht van de APC (`dev:"apc40"`) |
| hub → app | `{t:"fout", reden}` | bv. ongeldig manifest; de verbinding blijft open |

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
| `slew_s` | nee | de hub verloopt waarden over zoveel seconden (voor trage apps als medisynth) |
| `takeover` | nee | `"pickup"` (standaard voor faders), `"direct"`, `"schaal"` |
| `eenheid`, `min`, `max` | nee | alleen voor weergave in de cockpit |

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
| hub → cockpit | `{t:"beeld", apps:[{app,naam,kleur,status,focus,params,waarden}], focus, globaal, apparaten:{apc40,lpd8}}` — volledig, bij verbinden en max 10×/s bij wijziging |
| hub → cockpit | `{t:"leds", dev:"apc40", staat:{<control-id>: LedStaat}}` — alleen gewijzigde |
| hub → cockpit | `{t:"invoer", g}` — elke controller-gebeurtenis (voor de live-weergave) |
| cockpit → hub | `{t:"virtueel", dev:"apc40"\|"lpd8", bytes}` — de virtuele controller drukt iets in, precies alsof het van USB kwam |
| cockpit → hub | `{t:"focus", app}` · `{t:"zet", app, id, v}` · `{t:"snapshot", nr, actie:"laad"\|"bewaar"}` |

`LedStaat` is die van `src/devices/apc40mk2.js` (`{kleur, anim}`, `{aan}`, `{knipper}`, `{stand}`, `{waarde}`).

## 9. Kern-API (binnen de hub)

Zodat transports, drivers en kern los van elkaar gebouwd kunnen worden. Types in `src/protocol/types.js`.

- Een **Verbinding** is alles waarlangs de hub met één app praat: `{ app, stuur(bericht) }`. De WS-server maakt er één per socket; een driver (MIDI, HTTP, OSC) is er zelf één.
- `kern.verbind(verbinding)` → de kern weet van de app; daarna `kern.ontvang(app, bericht)` voor elk bericht van de app (`hallo`, `manifest`, `staat`, `zet`, `hb`, `led`); `kern.verbreek(app)` bij sluiten.
- `kern.invoer(gebeurtenis)` voor elke gebeurtenis van `ApcSessie`/`Lpd8Sessie` (en virtuele controllers).
- De kern schrijft LEDs via een **Oppervlak** `{ zet(id, LedStaat), teken() }` (`ApcSessie` voldoet) en stuurt naar apps via `verbinding.stuur()`.
- `kern.beeld()` → wat de cockpit nodig heeft (§8). Kern meldt wijzigingen via `kern.bij('beeld'|'leds'|'invoer', fn)`.
