# Maschine MK2 — de virtuele MIDI-indeling

De Native Instruments Maschine MK2 doet mee als **speelapparaat** (PROTOCOL §17): de hub opent hem zelf via USB-HID en
maakt van zijn rapporten MIDI. Een lease-app die `"maschine-mk2"` in `manifest.speelt` heeft, ziet de Maschine dus als
een gewone MIDI-controller (Varve DJ: een nep-poort "Maschine MK2 (hub)", zie `koppelingen/varve-dj/LEESMIJ.md`).

**Waarom niet de MIDI-modus van de Maschine zelf?** NI ondersteunt de MK2 niet meer (sinds november 2024), en de
MIDI-modus (SHIFT + CONTROL) werkt alleen als NIHardwareAgent draait. Die agent wil het toestel voor zichzelf. De hub
leest het daarom rechtstreeks (`src/ports/hid.js`, node-hid) en heeft geen NI-software nodig.

Code: `src/devices/maschine-mk2.js` (puur: rapporten lezen en maken), `MaschineSessie` in `src/apparaten.js` (openen,
hotplug, uitdunnen, lampjes en schermen), `src/core/spelers.js` (wie speelt). Instellingen: `config.json` →
`apparaten.maschine-mk2`.

## Wat de app krijgt (`{t:"midi", dev:"maschine-mk2", bytes}`)

| Wat | MIDI | Toelichting |
|---|---|---|
| **16 pads** | noot **36–51**, kanaal **0** (status `0x90`/`0x80`) | pad 1 = linksonder = 36, pad 16 = rechtsboven = 51 (zoals opgedrukt, en zoals NI's eigen MIDI-modus) |
| velocity | 1..127 | uit de **drukstijging** van het laatste frame onder de drempel tot het moment dat de slag telt: `127 · stijging / pads.stijging_vol` |
| aftertouch | polyfone aftertouch `0xA0`, noot van de pad, druk 0..127 | alleen bij verandering, hooguit `pads.aftertouch_hz` (30) keer per seconde per pad |
| loslaten | noot uit (`0x80`, velocity 0) | onder `pads.los` (hysterese: tussen `los` en `drempel` blijft hij aan) |
| **48 knoppen** | noot = bitnummer **0–47**, kanaal **1** (`0x91` 127 / `0x81` 0) | tabel hieronder |
| **8 draaiknoppen** (onder de schermen) | **CC 16–23**, kanaal 0, **relatief** (tweecomplement: 1..63 = rechtsom, 127..65 = linksom) | pas na `encoder_drempel` (12) tellen in één richting, dan alles wat er opgespaard is (een rustende knop trilt een paar tellen heen en weer: dat valt weg). Eén omwenteling ≈ 1000 tellen (de knoppen tellen 0..999 en lopen dan rond); de app schaalt zelf |
| **masterwiel** draaien | **CC 24**, kanaal 0, relatief, ±1 per klik | een 4-bit teller die rondloopt |
| masterwiel indrukken | noot 23 op kanaal 1 (`wiel`) | heeft geen lampje |

Een pad telt pas als slag als hij **twee frames achter elkaar** (`pads.bevestig`) op of boven `pads.drempel` (200 van
4095) staat: één los frame is een hapering, geen slag. De pads sturen ±750 rapporten per seconde, ook in rust; wat
de app krijgt is daarmee al uitgedund (een noot aan, aftertouch hooguit 30×/s, een noot uit).

### De knoppen (noot op kanaal 1)

| Noot | Knop | Noot | Knop | Noot | Knop | Noot | Knop |
|---|---|---|---|---|---|---|---|
| 0–7 | F1–F8 (boven de schermen) | 16 | VOLUME | 24–31 | groep A–H | 40 | SCENE |
| 8 | CONTROL | 17 | SWING | 32 | RESTART | 41 | PATTERN |
| 9 | STEP | 18 | TEMPO | 33 | ◄ (transport) | 42 | PAD MODE |
| 10 | BROWSE | 19 | ◄ (bij het masterwiel) | 34 | ► (transport) | 43 | NAVIGATE |
| 11 | SAMPLING | 20 | ► (bij het masterwiel) | 35 | GRID | 44 | DUPLICATE |
| 12 | ◄ (links boven) | 21 | ENTER | 36 | PLAY | 45 | SELECT |
| 13 | ► (links boven) | 22 | NOTE REPEAT | 37 | REC | 46 | SOLO |
| 14 | ALL | 23 | masterwiel indrukken | 38 | ERASE | 47 | MUTE |
| 15 | AUTO | | | 39 | SHIFT | | |

De namen in de hub (logboek, cockpit, proef): `f1`…`f8`, `control`, `step`, `browse`, `sampling`, `browseL`, `browseR`,
`all`, `auto`, `volume`, `swing`, `tempo`, `navL`, `navR`, `enter`, `noteRepeat`, `wiel`, `groepA`…`groepH`, `restart`,
`stapL`, `stapR`, `grid`, `play`, `rec`, `erase`, `shift`, `scene`, `pattern`, `padMode`, `navigate`, `duplicate`,
`select`, `solo`, `mute`; de pads `pad1`…`pad16`, de draaiknoppen `enc1`…`enc8`, het wiel `masterwiel`.

## Wat de app terugstuurt

**Lampjes:** `{t:"led", dev:"maschine-mk2", bytes:[[0x90, noot, velocity], …]}` — een noot aan op hetzelfde nummer als
de knop of pad; noot uit (of velocity 0) = uit.

| Wat | Velocity betekent |
|---|---|
| pads (kanaal 0, noot 36–51) | **APC-paletindex** 0..127: dezelfde 128 kleuren als de APC40 (`PALET` in `src/devices/apc40mk2.js`), zodat een pad op beide controllers dezelfde kleur heeft |
| groepknoppen A–H (kanaal 1, noot 24–31) | ook paletindex; beide lampjes (zones) van de knop krijgen dezelfde kleur |
| andere knoppen (kanaal 1) | helderheid 0..127 (alleen wit/eenkleurig) |

De hub zet dat om naar de HID-rapporten `0x80` (pads, R,G,B), `0x81` (groepen 2 × R,G,B + de 8 transportlampjes) en
`0x82` (31 knoplampjes), en stuurt alleen wat veranderde. `led_max` in `config.json` is de helderste waarde op de draad
(255; de proef meet of 127 al het felste is).

**Schermen:** `{t:"scherm", dev:"maschine-mk2", nr, data}` — `nr` 0 = links, 1 = rechts; `data` = base64 van precies
**2048 bytes**: 256 × 64 pixels, 1 bit per pixel, rij voor rij van boven, 32 bytes per rij, het hoogste bit van een byte
is de meest linkse pixel, 1 = aan. De hub stuurt het in 8 stukken van 9 + 256 bytes (`0xE0`/`0xE1`) en alleen de stukken
die veranderden. De panelen houden hun beeld vast: bij stoppen maakt de hub ze leeg.

De hub bewaart per app de laatste lampjes en schermen en toont ze zolang die app speelt; wisselt wie speelt, dan eerst
alles uit en dan wat de nieuwe app het laatst stuurde.

## Instellingen (`config.json` → `apparaten.maschine-mk2`)

| Sleutel | Standaard | Wat |
|---|---|---|
| `vid`, `pid` | `"17cc"`, `"1140"` | USB-id (hex). Zonder: geen Maschine |
| `niet_exclusief` | `false` | `true` = openen naast een ander programma (macOS vraagt dan om Invoermonitoring) |
| `stil_ms` | 2000 | zo lang na openen mag er geen enkel rapport komen voor de hub "geen invoer" zegt |
| `pads.drempel` / `pads.los` | 200 / 100 | slag vanaf, loslaten onder (0..4095) |
| `pads.bevestig` | 2 | frames op of boven de drempel voor een slag |
| `pads.stijging_vol` | 1500 | drukstijging die velocity 127 geeft |
| `pads.max` | 4095 | volle druk (aftertouch 127) |
| `pads.aftertouch_hz` | 30 | hooguit zo vaak aftertouch per pad per seconde |
| `encoder_drempel` | 12 | tellen in één richting voor een draaiknop iets stuurt |
| `led_max` | 255 | helderste waarde op de draad |
| `per_burst` | 4 | hooguit zoveel HID-rapporten (lampjes, schermstukken) per `led.burst_ms` (4 ms): schrijven gaat synchroon, een schermstuk is 265 bytes |

## Als het niet werkt

| Wat je ziet | Waarom | Wat te doen |
|---|---|---|
| hubvenster: `Maschine: bezet (cannot open device …)`; cockpit: status `bezet` (pas na twee mislukte rondes: één keer kan een kabel zijn die net losgaat) | een ander programma heeft hem (exclusief) open: Maschine 2, Controller Editor, NIHardwareAgent of NIHostIntegrationAgent | sluit Maschine 2 en Controller Editor; blijft hij bezet, stop de NI-agents in Activiteitenweergave. De hub probeert het elke paar seconden zelf opnieuw. `node src/cli.js doctor` zegt welke NI-programma's draaien |
| hubvenster: `Maschine: open, maar er komt niets binnen`; status `geen-invoer` | macOS laat de invoer niet door (privacy: Invoermonitoring) | Systeeminstellingen → Privacy en beveiliging → Invoermonitoring → zet Terminal (of iTerm) aan, en start de hub opnieuw |
| `Geen HID (node-hid niet geïnstalleerd …)` | node-hid ontbreekt | `npm install` (node-hid is optioneel, net als de MIDI-module) |
| pads reageren te snel/te traag, of geven een slag in rust | drempels passen niet bij dit toestel | `pads.drempel`, `pads.los`, `pads.stijging_vol` in `config.json`; de rustopname van de proef laat de ruisvloer zien |
| de verkeerde pad licht op of reageert | de oriëntatie klopt niet | stap "welke pad is welke?" van de proef; noteer het, Claude past `padVanPlek` aan |

## Wat alleen het echte toestel kan zeggen (proef `speelapparaten`)

Dit is gebouwd op de bronnen hieronder (maschine-code is in juli 2026 op hardware getest), maar op Clay's toestel
nog niet gemeten:

- **Openen:** lukt het met de NI-agents aan (of is hij dan "bezet")? Vraagt macOS om Invoermonitoring, en ook bij
  exclusief openen?
- **Rust:** komt er echt ±750 rapporten per seconde, 65 bytes, en blijft de ruis ver onder de loslaatdrempel (100)?
- **Oriëntatie:** is plek 0 in het rapport echt pad 13 (linksboven), en rechtsonder pad 4?
- **Drempels en velocity:** voelen 200/100 en twee frames bevestiging goed; geeft zacht en hard een bruikbaar bereik;
  is de volle druk ±4095?
- **Draaiknoppen:** hoeveel tellen per omwenteling, en is 12 een goede drempel (niet dood bij langzaam draaien)?
- **Lampjes:** is 255 of al 127 het felste (`led_max`); hebben de groepknoppen echt twee zones; klopt de oriëntatie?
- **Schermen:** links/rechts, rij voor rij, hoogste bit links.
- **Schrijfsnelheid:** node-hid schrijft synchroon (de hub wacht tot het rapport weg is). De proef meet hoe lang twee
  volle schermen duren; is dat veel meer dan ±20 ms, dan moet het schrijven naar `HIDAsync` (een eigen werkrij van
  node-hid), zodat een schermupdate de pads niet vertraagt.

## Bronnen

- jayintheday/maschine-code, `PROTOCOL.md` (MIT, TypeScript + node-hid op macOS, op hardware getest juli 2026):
  https://github.com/jayintheday/maschine-code
- shaduzlabs/cabl, `src/devices/ni/MaschineMK2.cpp` (MIT): https://github.com/shaduzlabs/cabl
- Ardour, `libs/surfaces/maschine2/m2_dev_mk2.*`: https://github.com/Ardour/ardour
- node-hid 3.4 (`nonExclusive` op macOS, prebuilds): https://github.com/node-hid/node-hid
