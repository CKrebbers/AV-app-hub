# Logic Pro koppelen aan varve-hub (Sediment)

Sediment is een AU-padsynth zonder netwerk: hij luistert alleen naar Logic. De hub opent daarom een
**virtuele MIDI-poort "VARVE-HUB Logic"** en stuurt per parameter een eigen CC. In Logic koppel je elke CC
één keer aan de Sediment-parameter met **Controller Assignments**. Daarna kun je Sediment met de APC40
(focus op Sediment) en de LPD8 (macro's) bespelen. Er gaat niets terug naar de hub: geen LED-terugkoppeling.

Manifest en mapping: `apps/sediment.json` (gegenereerd uit `sediment/src/Params.h` met
`node tools/genereer-manifesten.mjs`). Driver: `src/drivers/midi.js`.

## Welke CC's

Alleen CC's die de MIDI-specificatie "ongedefinieerd" noemt: **20–31** en **102–111**. Zo blijven
**CC 1** (modwiel = filter in Sediment), **7** (volume), **10** (pan), **64** (sustain) en de LSB's 32–63
van je keyboard vrij. Alles op **kanaal 1**.

| CC | Sediment-parameter (naam in Logic) | Groep | Bereik | APC | LPD8-rol |
|---|---|---|---|---|---|
| 20 | Shape | Bron | 0 – 100 % | knop | |
| 21 | Detune | Bron | 0 – 50 ct | knop | |
| 22 | Width | Bron | 0 – 100 % | knop | |
| 23 | Sub | Bron | 0 – 100 % | knop | |
| 24 | Air | Bron | 0 – 100 % | fader | |
| 25 | Drift | Bron | 0 – 100 % | knop | |
| 26 | Cutoff | Filter | 30 Hz – 18 kHz (midden 1 kHz) | fader | `macro.helderheid` (K2) |
| 27 | Resonance | Filter | 0 – 100 % | knop | |
| 28 | Motion | Filter | 0 – 100 % | fader | `macro.beweging` (K4) |
| 29 | Motion Rate | Filter | 0,01 – 4 Hz (midden 0,2 Hz) | knop | |
| 30 | Attack | Envelope | 5 ms – 20 s (midden 1,5 s) | knop | |
| 31 | Decay | Envelope | 20 ms – 20 s (midden 2 s) | knop | |
| 102 | Sustain | Envelope | 0 – 100 % | knop | |
| 103 | Release | Envelope | 20 ms – 30 s (midden 3 s) | knop | |
| 104 | Echo Time | Echo | 20 ms – 2 s (midden 400 ms) | knop | |
| 105 | Echo Feedback | Echo | 0 – 95 % | knop | |
| 106 | Echo Mix | Echo | 0 – 100 % | fader | |
| 107 | Space Decay | Ruimte | 0,5 – 40 s (midden 6 s) | knop | |
| 108 | Space Mix | Ruimte | 0 – 100 % | fader | `macro.ruimte` (K3) |
| 109 | Shimmer | Ruimte | 0 – 100 % | fader | |
| 110 | Tone | Ruimte | 0 – 100 % | fader | |
| 111 | Output | Uit | −30 – +6 dB | fader | |
| 123 | *(geen: All Notes Off)* | paniek | — | Stop All | P1 (1 s) |

**Paniek** (LPD8-P1 1 s vasthouden, of Stop All met Sediment in focus) stuurt **CC 123 = All Notes Off** op
kanaal 1, en bij loslaten nog eens (waarde 0; All Notes Off kijkt niet naar de waarde). Daar hoort **geen**
Controller Assignment bij: Logic geeft hem door aan het instrument van het spoor dat de MIDI krijgt (het
geselecteerde spoor), en Sediment zet dan alle noten uit; galm en echo lopen uit. De Scripter-set speelt
daarna gewoon verder, en de master gaat niet omlaag (Output 0 = −30 dB, niet stil). Nog niet op de Mac
geprobeerd: draai bij het eerste gebruik een akkoord met lange release en houd P1 vast; hoor je niets
veranderen, dan filtert Logic CC 123 (zie de problementabel). CC 123 is bewust de enige verboden CC die de hub
stuurt (`PANIEK_CC` in `tools/genereer-manifesten.mjs`).

"Midden" = de waarde die op CC 64 valt: Sediment gebruikt een logaritmische schaal (`setSkewForCentre`), en
Logic zet CC 0–127 lineair op die genormaliseerde 0..1. De hub rekent ook in die genormaliseerde 0..1, dus
de standaardwaarden in het manifest kloppen met wat Logic toont.

## Eenmalig instellen (±15 minuten)

1. **Start eerst de hub** (`npm start` in de map van de hub, oftewel `node src/cli.js start`). De poort "VARVE-HUB Logic" bestaat alleen zolang de hub draait.
   Controle: *Audio MIDI-configuratie → MIDI-studio* toont "VARVE-HUB Logic".
2. **Logic → Instellingen → MIDI → Invoer** (*Settings → MIDI → Inputs*): vink **VARVE-HUB Logic** aan.
   (Staat hij er niet, start Logic dan opnieuw nadat de hub draait.)
   **Vink in dezelfde lijst VARVE-HUB TD uit.** Logic luistert standaard naar álle MIDI-ingangen. De TD-poort
   stuurt noten 36–41 (presets, opname, take-log) en CC 20–27 op kanaal 1: precies de CC's van Shape … Resonance.
   Staat hij aan, dan speelt Sediment een lage noot bij elke TD-preset, en bewegen zijn parameters mee met de
   TD-knoppen.
3. Maak (of open) een **softwarematig-instrumentspoor met Sediment** en selecteer het. Open het
   plug-invenster van Sediment.
4. Open de cockpit (`http://localhost:7700`) en kies Sediment. Dat is de makkelijkste route om te leren: daar
   zet je elke parameter direct, zonder pickup. (Op de APC kan het ook: Bank ingedrukt houden + de Track
   Select-knop van het Sediment-slot. Maar een APC-fader met pickup stuurt pas een CC als hij de huidige waarde
   kruist, dus dan "leert Logic niets" tot je de fader ver genoeg beweegt.)
5. Koppel elke parameter met **Leer-modus**:
   1. **Logic Pro → Bedieningsoppervlakken → Leer toewijzing voor …** (*Control Surfaces → Learn Assignment*,
      sneltoets **⌘L**). Het venster *Controller Assignments* opent in Leer-modus.
   2. Klik in het Sediment-venster op de parameter (bijv. **Cutoff**) of beweeg hem een klein beetje.
   3. Beweeg in de cockpit (of op de APC) diezelfde parameter een flink stuk heen en weer. Logic leert
      CC 26 → Cutoff.
   4. Volgende parameter: stap 2–3 herhalen, Leer-modus blijft aan. Werk de tabel hierboven van boven naar
      beneden af; welke CC bij welke parameter hoort, staat alleen in die tabel (de cockpit kent de CC-nummers niet).
   5. Klaar: zet Leer-modus uit (⌘L of de knop in het venster).
6. **Controleer in de expertweergave** van *Controller Assignments* (*Expert View*):
   - **Input**: `VARVE-HUB Logic`, **nooit `All`**. Met *All* reageert de toewijzing ook op CC 20–27 van de
     TD-poort en van je keyboard. **Channel** 1, **Type** Control Change, **Number** = de CC uit de tabel.
   - **Value**: Min 0, Max 127, Format *unsigned*, **Mode** *Scaled* (niet *Relative* of *Toggle*).
   - **Class** *Mixer*, **Channel Strip** het Sediment-spoor (of *Selected Track* als Sediment altijd
     geselecteerd is), **Parameter** de Sediment-parameter.
   - Kies de zone/modus "VARVE-HUB" zodat het herkenbaar blijft.
7. **Bewaar het project.** Controller Assignments staan in de Logic-voorkeuren, dus ze gelden ook in andere
   projecten — zolang daar een spoor met Sediment op dezelfde plek staat.

## Testen

- Draai op de APC (Sediment-focus) de fader van **Cutoff**: de Cutoff-knop in Sediment draait mee.
- Draai op de LPD8 **K3** (`macro.ruimte`): Space Mix volgt (met pickup: eerst de huidige waarde kruisen).
- Speel noten op je keyboard: CC 1 (modwiel) opent nog steeds het filter — de hub raakt CC 1 niet aan.

## Problemen

| Symptoom | Oorzaak / oplossing |
|---|---|
| "VARVE-HUB Logic" staat niet in de invoerlijst | Hub draait niet, of Logic startte vóór de hub. Hub starten, Logic herstarten. |
| Parameter springt terug | Er staat automatie op het spoor in *Read*; zet het spoor op *Off* of *Latch*. |
| Leer-modus pakt CC 1 | Je bewoog het modwiel tijdens het leren. Toewijzing verwijderen en opnieuw. |
| Sediment speelt vanzelf lage noten (C1–F1) als ik in TD een preset kies | VARVE-HUB TD staat aan als Logic-invoer. Stap 2: uitvinken. |
| Shape … Resonance bewegen mee met de TD-knoppen | De toewijzing heeft Input *All*, of VARVE-HUB TD staat aan als invoer. Stap 2 en 6. |
| Leer-modus pakt niets als ik een APC-fader beweeg | Pickup: de hub stuurt pas als de fader de huidige waarde kruist. Leer via de cockpit, of beweeg de fader over zijn hele bereik. |
| Sediment-knoppen (Shape … Resonance) bewegen de TD-knoppen | Het spoor TO_TD (External Instrument naar L2TD, uit av-scene-kit) is geselecteerd: dan stuurt Logic de CC's 20–27 van VARVE-HUB Logic door naar TD, en daar telt per knop de hoogste waarde (av-scene-kit `td/td_build_hub.py`). Selecteer het Sediment-spoor, of zet TO_TD op een andere invoer. Zie `docs/VOLGENDE-KOPPELINGEN.md` §4. |
| P1 vasthouden doet niets in Sediment | CC 123 komt alleen bij het geselecteerde spoor aan (of Logic filtert hem). Selecteer het Sediment-spoor en probeer opnieuw; met de Scripter-set op vier sporen krijgt alleen het geselecteerde spoor de paniek. |
| Werkt alleen als het spoor geselecteerd is | In de expertweergave staat *Selected Track*; kies het Sediment-spoor. |
| Hub herstart, Logic reageert niet meer | De virtuele poort was even weg. Meestal pakt Logic hem vanzelf weer op; anders stap 2 opnieuw. Na een herstart stuurt de hub de waarden die hij onthield (`~/.varve-hub/staat.json`) weer naar Sediment. Zonder geheugen (eerste keer, bestand weg, `--zonder-geheugen`) stuurt hij niets: dan houdt Sediment zijn eigen stand, maar gaat de hub (cockpit, ringen, pickup) uit van de standaardwaarden uit het manifest. Laad een snapshot, of beweeg de fader over de standaardwaarde heen: dan staan ze weer gelijk. |

*Later (ONDERZOEK.md §7):* een vaste CC→parameter-tabel in de Sediment-processor zelf maakt deze Logic-stap
overbodig. De CC-nummers hierboven zijn dan de tabel.
