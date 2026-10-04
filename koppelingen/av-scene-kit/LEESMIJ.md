# av-scene-kit: paniek-pad voor de hub (patch)

In av-scene-kit commit alleen de **REGIE**-sessie (`av-scene-kit/CLAUDE.md`, tabel "Sessies en eigendom"). Daarom staat de TD-kant van de paniek hier als patch. Hij is gemaakt in een tijdelijke worktree van av-scene-kit, op main **0c3a35d** ("Eerste versie (back-up bij opruiming 2026-10-02)"). Er is niets in av-scene-kit zelf veranderd.

## Wat het doet
Tot nu toe deed LPD8-P1 (1 s vasthouden, de paniek van de hub) niets in TouchDesigner: de TD-hub had geen paniek-noot. Een CC 27 = 0 vanuit de hub is geen betrouwbare paniek. Na een preset houdt TD elke knop vast tot de binnenkomende waarde de presetwaarde **kruist**. Staat de hub-waarde al onder de preset, dan kruist een sprong naar 0 niet (docs/VOLGENDE-KOPPELINGEN.md §4.2 en §4.4).

**0001: TD: paniek-pad 42 zet de master dicht.** Drie bestanden, allemaal van de TD-sessie:

| Bestand | Wijziging |
|---|---|
| `config.json` | `midi.pads.paniek = 42` (36–41 zijn al bezet). Alleen het `midi`-deel. Dit is de enige plek die de paniek aanzet. |
| `td/td_build_hub.py` | De `pads`-DAT krijgt `paniek()`, en in `onOffToOn` een tak voor `ch1n42`. Die zet knob8 (master-dim, de opacity van `dim`) op 0, los van de pickup-stand: `preset_base.knob8 = 0`, `pickup_mask` 0, `pickup_inv` 1, `picked['knob8'] = False`, en `paniek_open = True` in de hub-storage. Daarmee is `ctrl.knob8` 0 en het beeld zwart. De andere knoppen en de preset blijven staan. In `knob_moved` neemt de eerste nieuwe knob8-waarde na een paniek het meteen over (geen kruising nodig); `apply_preset` wist `paniek_open`. Noot 42 komt vanzelf in de `notescope` van beide MIDI In CHOPs (die volgt `PAD_NOTES`). `_DEFAULTS` verandert **niet**: zonder `midi.pads.paniek` in `config.json` doet noot 42 niets. `MASTER = 'knob8'` is bewust vast, net als `K(8, 1)` voor `dim` eerder in hetzelfde script. |
| `td/_mock_td_test.py` | `notescope` is nu 36–42. Nieuwe controles: master op 0, andere knoppen en preset blijven, een andere knop heft de paniek niet op, de eerste nieuwe knob8-waarde neemt meteen over (ook als knob8 nog nooit binnenkwam), een preset zet de master terug en wist de paniek. In build 3 (ingebouwde defaults, geen `config.json`) staat `paniek` niet in `PAD_NOTES` en doet noot 42 niets. |

**De master komt terug** met een preset-pad, of met de eerste nieuwe master-waarde die de hub stuurt: een LPD8-tik op K2 (`macro.helderheid`), een zet in de cockpit, een snapshot, of de APC-fader van `master_dim` (die wacht in de hub eerst tot hij door 0 gaat). Na een paniek gaat er dus niets vanzelf open, maar alles wat de hub daarna bewust stuurt, volgt TD. Zo tonen ringen, cockpit en snapshots dezelfde master als het beeld. Stuurt de hub precies de bytes die TD vóór de paniek al had (bijvoorbeeld een snapshot terug), dan stuurt de MIDI-driver eerst een stapje ernaast, omdat een MIDI In CHOP alleen veranderingen ziet.

De hub-kant zit al in de hub (golf 6). Zodra `midi.pads.paniek` in de kit staat, maakt de generator een trigger `paniek` op noot 42 in `apps/av-scene-kit.json`. Daarbij komt een `driver.presets`-regel `{noot: 42, waarden: {master_dim: 0}}`: de hub weet dan dat de master dicht is (de APC-pickup wacht op 0; K2 houdt volgens PROTOCOL §14 zijn doel van vóór de paniek). De hub stuurt de noot bij P1 (1 s vasthouden) en bij Stop All als Scene Kit focus heeft. Bij loslaten stuurt hij een note-off, waar TD niets mee doet. Zonder de sleutel in de kit stuurt de hub noot 42 niet. Dat is ook bewust: anders zou de hub denken dat de master dicht is terwijl TD niets deed.

## Getest
- `python3 td/_mock_td_test.py` in de worktree met de patch: **0 fouten** (alle bestaande controles plus de nieuwe paniek-controles).
- `make test` in dezelfde worktree: **34 groen**.
- `git apply --check` past op av-scene-kit main 0c3a35d.
- In de hub, `test/paniek-drivers.test.js`. Deze test leest `midi.pads` uit deze patch. Hij toetst met de echte kern en de echte MIDI-driver dat P1 vasthouden noot 42 naar "VARVE-HUB TD" stuurt (en eerder dan 1 s niets), dat de hub `master_dim` 0 kent, en dat loslaten alleen een note-off geeft zonder dat er iets blijft hangen. Staat av-scene-kit op deze computer, dan kloont dezelfde test hem naar een tijdelijke map, past de patch toe, draait de mocktest en de generator, en speelt met `test/td-master.py` alles wat de hub naar TD stuurt af op de **echte TD-code** (in de mock-omgeving). Zo toetst hij dat hub en TD na een paniek dezelfde master hebben: na K2, de cockpit, een snapshot, de APC-fader (1,0 → 0 → 0,5 in sprongen) en een preset.
- **Nog niet** op de echte TD.

## Toepassen (REGIE)
```bash
cd ~/src/av-scene-kit                 # op main
git apply --check /pad/naar/AV-app-hub/koppelingen/av-scene-kit/0001-*.patch   # geen uitvoer = past
git am -3 /pad/naar/AV-app-hub/koppelingen/av-scene-kit/0001-*.patch
python3 td/_mock_td_test.py           # moet eindigen met "0 fouten"
make test                             # config.json veranderde: pytest-suite, 34 groen
git status                            # de tests maken __pycache__/ en .venv/ aan: niet committen
```
Loopt `git am -3` vast op een conflict (de TD-sessie heeft `td_build_hub.py` intussen veranderd)? Doe dan `git am --abort` en vraag de TD-sessie de tak van hierboven met de hand toe te voegen. Het zijn ±35 regels. Of vraag Claude in de hub de patch opnieuw te maken.

Regel voor `STATUS.md` (REGIE):
```
- <datum> · TD: paniek-pad 42 (patch uit AV-app-hub koppelingen/av-scene-kit): varve-hub LPD8-P1 zet de master dicht (knob8 op 0 tot een preset of de eerste nieuwe master-waarde). Mocktest en make test groen. Niet getest op de echte TD.
```
Optioneel (REGIE): in `BLUEPRINT.md` onder de pads een regel `| Pad 7 | note 42 | paniek (varve-hub): master dicht |`.

## Daarna in de hub
```bash
node tools/genereer-manifesten.mjs --scene-kit ~/src/av-scene-kit --sediment <pad naar sediment>
node tools/genereer-manifesten.mjs --scene-kit ~/src/av-scene-kit --sediment <pad naar sediment> --toets
npx vitest run test/drivers.test.js test/paniek-drivers.test.js
```
Zonder `--scene-kit` en `--sediment` zoekt de generator in `/home/user/av-scene-kit` en `/home/user/sediment`. Staat een map er niet, dan zegt hij welke vlag je moet geven. Nu krijgt `apps/av-scene-kit.json` de paniek (15 params). Commit `apps/av-scene-kit.json` in de hub.

## Terugdraaien
De volgorde telt. Draai je de TD-kant terug zonder de hub opnieuw te genereren, dan stuurt de hub noot 42 nog en denkt hij dat de master dicht is, terwijl TD niets deed.
1. In av-scene-kit (REGIE): `git revert <commit van de patch>`, dan `python3 td/_mock_td_test.py` en `make test`. Alleen `midi.pads.paniek` uit `config.json` halen is ook genoeg om TD de noot te laten negeren (de defaults kennen hem niet), maar dan blijft de code staan.
2. In de hub: de generator opnieuw draaien (zelfde commando als hierboven), daarna `--toets`. `apps/av-scene-kit.json` heeft dan weer 14 params, zonder paniek. Commit het.

De andere twee driver-apps staan helemaal in de hub. **uurwerk**: haal de params en verbs `paniek` en `master_terug` uit `apps/uurwerk.json`. **Sediment**: haal in `tools/genereer-manifesten.mjs` de paniek-regels (`PANIEK_CC`) uit `sedimentManifest()` en genereer opnieuw. Pas daarna de tests in `test/paniek-drivers.test.js` en `test/drivers.test.js` aan.

## Testen op de echte TD (±5 minuten, Clay)
1. Pas de patch toe en bouw de TD-hub opnieuw (`td_build_hub.py` in de Textport, zoals altijd). De statusregel mag geen `CONFIG`-melding geven.
2. Kijk in `/project1/hub/midi_in`: `notescope` is `36 37 38 39 40 41 42`.
3. Genereer in de hub de manifesten (het commando onder "Daarna in de hub") en start dan de hub (`npm start`), met device 1 op "VARVE-HUB TD" (docs/TOUCHDESIGNER.md).
4. Kies preset 1 (pad 36). Draai de master (fader van `master_dim`) tot het beeld meegaat.
5. Houd **LPD8-P1** 1 s vast. Verwacht: het beeld gaat in één keer naar zwart. De statusregel zegt "PANIEK: master dicht", en `ch1n42` knippert in `midi_in`. De cockpit toont Master 0.
6. Laat P1 los: er verandert niets, het beeld blijft zwart.
7. Draai de APC-master-fader omhoog: nog steeds zwart (de hub wacht tot de fader door 0 gaat). Draai hem naar 0 en weer omhoog: het beeld komt terug, en de cockpit volgt.
8. Nog eens P1. Zet nu de master in de cockpit op de helft: het beeld komt terug op de helft. Doe hetzelfde met een snapshot (P5–P8) en met een tik op K2.
9. Nog eens P1, en dan een preset-pad: het beeld komt terug op de presetwaarde.
10. Met Scene Kit in focus op de APC: **Stop All** doet hetzelfde als stap 5.

Wil je liever een fade dan een sprong: zet een Lag CHOP op `ctrl` voor `dim`. Dat zit niet in deze patch (open vraag 2).

## Open vragen voor jou (uit docs/VOLGENDE-KOPPELINGEN.md §4.7)
1. Paniek in TD = master dicht (zwart), zoals nu? Of liever preset "stil"?
2. Sprong (nu) of fade, en hoe lang?
3. Gate G2 (clip 1 online) blokkeert nieuwe features in de kit. Dit is een veiligheidsknop, geen feature van de kit, maar het is jouw beslissing of hij er nu in mag.
4. Hoe streng na een paniek? Nu neemt TD de eerste nieuwe master-waarde uit de hub meteen over (K2, cockpit, snapshot, fader na 0), zodat hub en beeld gelijk blijven. Strenger kan: TD wacht tot de waarde 0 kruist (≤ 0,02). Maar dan tonen cockpit, ringen en een snapshot die je daarna bewaart een open master terwijl het beeld zwart is, want de hub weet niet dat TD een waarde negeerde. Daarom is gekozen voor overnemen. Zeg het als je het anders wilt.
