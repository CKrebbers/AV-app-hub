# TouchDesigner koppelen aan varve-hub (av-scene-kit)

De TD-hub van av-scene-kit (`/project1/hub`, gebouwd door `td/td_build_hub.py`) luistert naar MIDI-**device 1**
op kanaal 1: CC 20–27 voor de acht knoppen en noten 36–41 voor de pads. De echte APC40 kan dat niet voeden —
CC 24–27 zijn op de APC ring-*uitgangen* en komen nooit binnen (ONDERZOEK.md §3 punt 7). Daarom opent de hub een
**virtuele MIDI-poort "VARVE-HUB TD"** en speelt daarop precies wat TD verwacht. In TD verandert er niets
behalve welk apparaat device 1 is.

Manifest en mapping: `apps/av-scene-kit.json` (gegenereerd uit `av-scene-kit/config.json` met
`node tools/genereer-manifesten.mjs`). Driver: `src/drivers/midi.js`.

## Eenmalig instellen (±5 minuten)

1. **Start eerst de hub** (`varve-hub`). De poort "VARVE-HUB TD" bestaat alleen zolang de hub draait.
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

**Na een herstart van de hub** verdwijnt de virtuele poort even. Staat de regel in de Device Mapper daarna op
"not found", kies dan de In Device opnieuw. (TD pakt hem meestal vanzelf weer op.)

## Wat de hub stuurt

Alle waarden 0..1 uit de hub worden `round(v·127)`. De hub stuurt een waarde alleen als hij verandert.

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

- **Pads** zijn triggers: indrukken = note-on 127, loslaten = note-off. TD reageert op de note-on
  (`onOffToOn` in de `pads`-DAT). Opname en take-log **togglen** in TD zelf; de hub weet dus niet of de opname
  loopt — kijk naar de TD-statusregel.
- **Scènes** (Scene 1–4 op de APC, of in de cockpit) spelen dezelfde preset-noten als korte aanslag
  (note-off na 100 ms, zodat TD de noot zeker in een frame ziet).
- **Presets en pickup:** na een preset houdt TD elke knop vast tot de binnenkomende waarde de presetwaarde
  kruist (`knob_moved` in de `pads`-DAT, `PICK_EPS 0.02`). Draait een APC-fader dus "niets", beweeg hem dan
  over de presetwaarde heen. De hub doet zijn eigen pickup daarnaast, voor de fysieke fader.
- **Hub onthoudt** (`truth:"hub"`): TD kan zijn waarden niet terugmelden. Na een herstart van de hub speelt hij
  de laatst bekende waarden opnieuw af. Herstart je alleen TD, beweeg dan even de faders, of laad een snapshot.

## Problemen

| Symptoom | Oorzaak / oplossing |
|---|---|
| Geen `ch1c2x`-kanalen in `midi_in` | Device Mapper: ID 1 staat niet op "VARVE-HUB TD", of de hub draait niet. |
| Alleen CC 20–23 bewegen | Je gebruikt nog de echte APC als device 1 in plaats van de hub-poort. |
| Waarden springen | Twee apparaten op ID 1. Er mag er maar één zijn. |
| Pad doet twee keer iets | De oude controller staat er nog naast; haal hem uit de Device Mapper. |
