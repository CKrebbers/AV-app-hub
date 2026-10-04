# av-scene-kit: paniek-pad voor de hub (patch)

In av-scene-kit commit alleen de **REGIE**-sessie (`av-scene-kit/CLAUDE.md`, tabel "Sessies en eigendom"). Daarom staat de TD-kant van de paniek hier als patch. Hij is gemaakt in een tijdelijke kopie van av-scene-kit, op main **0c3a35d** ("Eerste versie (back-up bij opruiming 2026-10-02)"). Er is niets in av-scene-kit zelf veranderd.

## Wat het doet
Tot nu toe deed LPD8-P1 (1 s vasthouden, de paniek van de hub) niets in TouchDesigner: de TD-hub had geen paniek-noot. Een CC 27 = 0 vanuit de hub is geen betrouwbare paniek. Na een preset houdt TD elke knop vast tot de binnenkomende waarde de presetwaarde **kruist**. Staat de hub-waarde al onder de preset, dan kruist een sprong naar 0 niet (docs/VOLGENDE-KOPPELINGEN.md §4.2 en §4.4).

**0001: TD: paniek-pad 42 zet de master dicht.** Drie bestanden, allemaal van de TD-sessie:

| Bestand | Wijziging |
|---|---|
| `config.json` | `midi.pads.paniek = 42` (36–41 zijn al bezet). Alleen het `midi`-deel. |
| `td/td_build_hub.py` | `_DEFAULTS` krijgt dezelfde sleutel. De `pads`-DAT krijgt `paniek()`, en in `onOffToOn` een tak voor `ch1n42`. Die zet knob8 (master-dim, de opacity van `dim`) op 0, los van de pickup-stand: `preset_base.knob8 = 0`, `pickup_mask` 0, `pickup_inv` 1 en `picked['knob8'] = False`. Daarmee is `ctrl.knob8` 0 en het beeld zwart. De andere knoppen en de preset blijven staan. Noot 42 komt vanzelf in de `notescope` van beide MIDI In CHOPs (die volgt `PAD_NOTES`). Staat er geen `paniek` in de config, dan doet noot 42 niets. |
| `td/_mock_td_test.py` | `notescope` is nu 36–42. Nieuwe controles voor de paniek-tak: master vast op 0, andere knoppen en preset blijven, nog niet terug bij 0,5, wel terug als de fader 0 kruist, een preset zet de master terug op de presetwaarde, en zonder `midi.pads.paniek` gebeurt er niets (ook geen fout). |

**De master komt terug** met een preset-pad, of door de master-fader naar 0 en weer omhoog te draaien. Dat is bewust: na een paniek gaat er niets vanzelf weer open. Een LPD8-tik op K2 (`macro.helderheid`) brengt hem **niet** terug, want TD wacht op 0.

De hub-kant zit al in de hub (golf 6). Na `node tools/genereer-manifesten.mjs` maakt de generator, zodra `midi.pads.paniek` in de kit staat, een trigger `paniek` op noot 42 in `apps/av-scene-kit.json`. Daarbij komt een `driver.presets`-regel `{noot: 42, waarden: {master_dim: 0}}`: de hub weet dan dat de master dicht is, en zijn pickup wacht ook op 0. De hub stuurt de noot bij P1 (1 s vasthouden) en bij Stop All als Scene Kit focus heeft. Bij loslaten stuurt hij een note-off, waar TD niets mee doet. Zonder de sleutel in de kit stuurt de hub noot 42 niet. Dat is ook bewust: anders zou de hub denken dat de master dicht is terwijl TD niets deed.

## Getest
- `python3 td/_mock_td_test.py` in de kopie met de patch: **0 fouten** (alle bestaande controles plus de nieuwe paniek-controles).
- `git apply --check` past op av-scene-kit main 0c3a35d.
- In de hub, `test/paniek-drivers.test.js`. Deze test leest `midi.pads` uit deze patch. Hij toetst met de echte kern en de echte MIDI-driver dat P1 vasthouden noot 42 naar "VARVE-HUB TD" stuurt (en eerder dan 1 s niets), dat de hub `master_dim` 0 kent, en dat loslaten alleen een note-off geeft zonder dat er iets blijft hangen. Staat av-scene-kit op deze computer, dan kloont dezelfde test hem naar een tijdelijke map, past de patch toe, draait de mocktest en de generator, en controleert noot 42 met preset `master_dim` 0.
- **Nog niet** op de echte TD.

## Toepassen (REGIE)
```bash
cd ~/src/av-scene-kit                 # op main
git apply --check /pad/naar/AV-app-hub/koppelingen/av-scene-kit/0001-*.patch   # geen uitvoer = past
git am -3 /pad/naar/AV-app-hub/koppelingen/av-scene-kit/0001-*.patch
python3 td/_mock_td_test.py           # moet eindigen met "0 fouten"
git status                            # de mocktest maakt common/__pycache__/ aan: niet committen
```
Loopt `git am -3` vast op een conflict (de TD-sessie heeft `td_build_hub.py` intussen veranderd)? Doe dan `git am --abort` en vraag de TD-sessie de tak van hierboven met de hand toe te voegen. Het zijn ±15 regels. Of vraag Claude in de hub de patch opnieuw te maken.

Regel voor `STATUS.md` (REGIE):
```
- <datum> · TD: paniek-pad 42 (patch uit AV-app-hub koppelingen/av-scene-kit): varve-hub LPD8-P1 zet de master dicht (knob8 vast op 0 tot de fader 0 kruist of een preset). Mocktest groen. Niet getest op de echte TD.
```
Optioneel (REGIE): in `BLUEPRINT.md` onder de pads een regel `| Pad 7 | note 42 | paniek (varve-hub): master dicht |`.

Daarna **in de hub**: `node tools/genereer-manifesten.mjs`. Nu krijgt `apps/av-scene-kit.json` de paniek (15 params). Controleer met `node tools/genereer-manifesten.mjs --toets` en `npx vitest run test/drivers.test.js`. Commit `apps/av-scene-kit.json` in de hub.

## Testen op de echte TD (±5 minuten, Clay)
1. Pas de patch toe en bouw de TD-hub opnieuw (`td_build_hub.py` in de Textport, zoals altijd). De statusregel mag geen `CONFIG`-melding geven.
2. Kijk in `/project1/hub/midi_in`: `notescope` is `36 37 38 39 40 41 42`.
3. Start de hub (`npm start`), met device 1 op "VARVE-HUB TD" (docs/TOUCHDESIGNER.md). Draai daarna in de hub `node tools/genereer-manifesten.mjs` en herstart de hub.
4. Kies preset 1 (pad 36). Draai de master (fader van `master_dim`) tot het beeld meegaat.
5. Houd **LPD8-P1** 1 s vast. Verwacht: het beeld gaat in één keer naar zwart. De statusregel zegt "PANIEK: master dicht", en `ch1n42` knippert in `midi_in`.
6. Laat P1 los: er verandert niets, het beeld blijft zwart.
7. Draai de master-fader omhoog: nog steeds zwart. Draai hem naar 0 en weer omhoog: het beeld komt terug.
8. Nog eens P1, en dan een preset-pad: het beeld komt terug op de presetwaarde.
9. Met Scene Kit in focus op de APC: **Stop All** doet hetzelfde als stap 5.

Wil je liever een fade dan een sprong: zet een Lag CHOP op `ctrl` voor `dim`. Dat zit niet in deze patch (open vraag 2).

## Open vragen voor jou (uit docs/VOLGENDE-KOPPELINGEN.md §4.7)
1. Paniek in TD = master dicht (zwart), zoals nu? Of liever preset "stil"?
2. Sprong (nu) of fade, en hoe lang?
3. Gate G2 (clip 1 online) blokkeert nieuwe features in de kit. Dit is een veiligheidsknop, geen feature van de kit, maar het is jouw beslissing of hij er nu in mag.
