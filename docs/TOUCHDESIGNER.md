# TouchDesigner koppelen aan varve-hub (av-scene-kit)

De TD-hub van av-scene-kit (`/project1/hub`, gebouwd door `td/td_build_hub.py`) luistert naar MIDI-**device 1**
op kanaal 1: CC 20–27 voor de acht knoppen en noten 36–41 voor de pads (42 = paniek, met de TD-patch). De echte APC40 kan dat niet voeden —
CC 24–27 zijn op de APC ring-*uitgangen* en komen nooit binnen (ONDERZOEK.md §3 punt 7). Daarom opent de hub een
**virtuele MIDI-poort "VARVE-HUB TD"** en speelt daarop precies wat TD verwacht. In TD verandert er niets
behalve welk apparaat device 1 is.

Manifest en mapping: `apps/av-scene-kit.json` (gegenereerd uit `av-scene-kit/config.json` met
`node tools/genereer-manifesten.mjs`). Driver: `src/drivers/midi.js`.

## Eenmalig instellen (±5 minuten)

1. **Start eerst de hub** (`npm start` in de map van de hub, oftewel `node src/cli.js start`). De poort "VARVE-HUB TD" bestaat alleen zolang de hub draait.
   Controle op de Mac: *Audio MIDI-configuratie → MIDI-studio* toont een apparaat "VARVE-HUB TD".
2. Open het TD-project met `/project1/hub`.
3. *Dialogs → MIDI Device Mapper*.
4. Staat er al een regel met **ID 1** (bijvoorbeeld de oude controller), zet die op een ander ID of verwijder hem.
5. *Create New Mapping* (of pas de bestaande regel aan):
   - **In Device**: `VARVE-HUB TD`
   - **Out Device**: leeg laten (de hub luistert niet terug)
   - **ID**: `1` — dat is `midi.devices.controller` in `av-scene-kit/config.json`
   - **Channel**: 1 (de hub stuurt alles op kanaal 1 = statusbyte `B0`/`90`/`80`)
6. Sluit de mapper. Draai op de APC een fader van de Scene Kit (geef hem focus met Bank + Track Select) en kijk
   in `/project1/hub/midi_in` of `ch1c20` … `ch1c27` bewegen.

De L2TD-poort (device 3, Logic → TD) en TD2L (device 2) blijven zoals ze waren.

**Na een herstart van de hub** verdwijnt de virtuele poort even; daarna stuurt de hub de waarden die hij onthield (zie hieronder). Staat de regel in de Device Mapper daarna op
"not found", kies dan de In Device opnieuw. (TD pakt hem meestal vanzelf weer op.)

## Wat de hub stuurt

Alle waarden 0..1 uit de hub worden `round(v·127)`. Een beweging van de APC, LPD8 of cockpit stuurt de hub
alleen als de CC-waarde verandert; een snapshot of een herhaling (replay) stuurt hij altijd.

| MIDI (kanaal 1) | TD-kanaal | Hub-param | Wat | Rol (LPD8) | APC-hint |
|---|---|---|---|---|---|
| CC 20 | `ch1c20` → knob1 | `feedback` | feedback (TD) | — | fader |
| CC 21 | `ch1c21` → knob2 | `mix` | mix: 0 = Blender, 1 = cam | — | fader |
| CC 22 | `ch1c22` → knob3 | `glitch` | glitch (TD) | — | fader |
| CC 23 | `ch1c23` → knob4 | `emission` | emissie (Blender) | `macro.intensiteit` (K1) | knop |
| CC 24 | `ch1c24` → knob5 | `height` | hoogte (Blender) | — | knop |
| CC 25 | `ch1c25` → knob6 | `orbit` | orbit (Blender) | `macro.beweging` (K4) | knop |
| CC 26 | `ch1c26` → knob7 | `hue` | kleur (Blender) | `macro.kleur` (K5) | knop |
| CC 27 | `ch1c27` → knob8 | `master_dim` | master (opacity van `dim`) | `macro.helderheid` (K2) | fader |
| noot 36 | `ch1n36` | `preset1` / scène 1 | preset 1 · spiegel | | pad |
| noot 37 | `ch1n37` | `preset2` / scène 2 | preset 2 · datamosh | | pad |
| noot 38 | `ch1n38` | `preset3` / scène 3 | preset 3 · pixelregen | | pad |
| noot 39 | `ch1n39` | `preset4` / scène 4 | preset 4 · stil | | pad |
| noot 40 | `ch1n40` | `record` | opname aan/uit (toggle) | | pad |
| noot 41 | `ch1n41` | `takelog` | take-log aan/uit (toggle) | | pad |
| noot 42 | `ch1n42` | `paniek` | master dicht (alleen met de TD-patch, zie hieronder) | P1 (1 s) | Stop All |

- **Pads** zijn triggers: indrukken = note-on 127, loslaten = note-off. TD reageert op de note-on
  (`onOffToOn` in de `pads`-DAT). Opname en take-log **togglen** in TD zelf; de hub weet dus niet of de opname
  loopt — kijk naar de TD-statusregel. Elke druk is een echte aanslag: kwam het loslaten van de vorige druk
  nooit aan (bijvoorbeeld omdat je intussen Bank indrukte), dan stuurt de hub eerst nog een note-off.
- **Scènes** (Scene 1–4 op de APC, of in de cockpit) spelen dezelfde preset-noten als korte aanslag
  (note-off na 100 ms, zodat TD de noot zeker in een frame ziet).
- **Presets en pickup:** een preset zet in TD alle acht knoppen op de presetwaarden, en TD houdt elke knop vast
  tot de binnenkomende waarde de presetwaarde kruist (`knob_moved` in de `pads`-DAT, `PICK_EPS 0.02`). De hub
  kent die presetwaarden (`driver.presets` in `apps/av-scene-kit.json`, uit `PRESETS` in `td_build_hub.py`)
  en neemt ze bij elke preset-noot over. Ringen en cockpit tonen dus de presetstand, en de pickup van de hub
  wacht net als TD tot de fader de presetwaarde kruist.
- **Paniek** (LPD8-P1 1 s vasthouden, of Stop All met Scene Kit in focus): de hub stuurt noot 42 en TD zet de
  master (knob8, opacity van `dim`) op 0 en houdt hem daar, los van waar de fader staat; de hub weet dat
  (`master_dim` → 0, net als bij een preset). **Terug:** een preset-pad, of de master-fader naar 0 en weer op; een
  LPD8-tik op K2 alleen helpt dus niet (TD wacht op 0). Werkt pas als `midi.pads.paniek = 42` in
  `av-scene-kit/config.json` staat en de tak in `td_build_hub.py` zit: de patch in `koppelingen/av-scene-kit/`
  (REGIE past hem toe), daarna `node tools/genereer-manifesten.mjs` in de hub. Zonder die sleutel stuurt de hub
  noot 42 niet.
- **Hub onthoudt** (`truth:"hub"`): TD kan zijn waarden niet terugmelden. De hub onthoudt ze daarom zelf, ook
  over een herstart van de hub heen: ze staan in `~/.varve-hub/staat.json` (samen met de snapshots). Herstart de
  hub terwijl TD blijft draaien, dan stuurt de hub zodra de driver zich aanmeldt de onthouden waarden naar TD;
  TD en hub staan dan meteen gelijk. Was het geheugen er niet (eerste keer, bestand weggegooid, of gestart met
  `--zonder-geheugen`), dan stuurt de hub niets: dan houdt TD zijn eigen stand (bijvoorbeeld preset 3) en gaat
  de hub uit van de standaardwaarden (= preset 1). Kies dan een preset of laad een snapshot: dan staan TD en hub
  weer gelijk.
- **Alleen TD herstart?** Dan staat TD weer op preset 1 en weet de hub dat niet. Kies een preset (pad of scène):
  TD en hub staan dan weer gelijk. Of beweeg de faders die je terug wilt. Een snapshot laden helpt alleen voor
  waarden die afwijken van de huidige hub-stand.

## Problemen

| Symptoom | Oorzaak / oplossing |
|---|---|
| Geen `ch1c2x`-kanalen in `midi_in` | Device Mapper: ID 1 staat niet op "VARVE-HUB TD", of de hub draait niet. |
| Alleen CC 20–23 bewegen | Je gebruikt nog de echte APC als device 1 in plaats van de hub-poort. |
| Waarden springen | Twee apparaten op ID 1. Er mag er maar één zijn. |
| Pad doet twee keer iets | De oude controller staat er nog naast; haal hem uit de Device Mapper. |
| Sediment speelt een noot als ik een preset kies | Logic luistert ook naar VARVE-HUB TD. Zie docs/LOGIC.md stap 2: uitvinken. |
