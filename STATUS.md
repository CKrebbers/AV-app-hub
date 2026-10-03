# Status

## F0 — Fundament + meetinstrumenten

**Gebouwd (Claude, 3 okt):**
- [x] APC40 mkII-profiel: 148 controls, volledig palet (128 kleuren uit protocol v1.2), LED-berichten (rgb + animaties, aan, clipstop, A|B, ringen)
- [x] LPD8-profiel: mk1/mk2 herkennen, programma's opvragen en ontleden, profielen (geleerd / programma / fabriek)
- [x] Poortlaag: interface, nep-systeem, RtMidi lazy (start ook zonder MIDI)
- [x] Wachtrij 16 berichten / 4 ms, LED-beeld met alleen-verschillen, hotplug elke 2 s met automatische init + repaint
- [x] Logboek (JSONL) + golden tests op elk opgenomen bestand
- [x] `doctor`, `proef f0-hardware`, `testpatroon`, `opname`
- [x] Volledige F0-proef doorloopbaar door een gesimuleerde gebruiker (CI)

**Op hardware (Clay — hardware-avond 1):** `node src/cli.js proef`, daarna pushen.

Klaar als:
- [ ] elke APC-control staat in de proeflog met de juiste control-id
- [ ] een volledige repaint is zichtbaar in < 50 ms (gesimuleerd: 125 berichten ≈ 30 ms)
- [ ] uittrekken/terugsteken → vanzelf init + repaint
- [ ] LPD8-model en programma 1 bekend, profiel geleerd
- [ ] de 5 open hardwarevragen beantwoord:
  - [ ] V1 nemen ringknoppen een hub-waarde over?
  - [ ] V2 volgen animaties de MIDI-clock?
  - [ ] V3 negeert de APC LEDs terwijl je een pad vasthoudt?
  - [ ] V4 geeft het intro-antwoord de faderstanden?
  - [ ] V5 welke LPD8, wat zit in de programma's, werken pad-LEDs?
- [x] CI groen

## Volgende: F2 — kern, manifesten, virtueel oppervlak
Kan zonder hardware; begint zodra F0 gebouwd is.
