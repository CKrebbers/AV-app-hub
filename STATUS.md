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

## Golf 0 — contract ✓
`PROTOCOL.md` + `src/protocol/` (types, manifest- en berichtvalidatie), conformiteitstoets `tools/nep-hub.mjs`, voorbeeld-app `tools/nep-app.mjs`.

## Golf 1 — F2: kern, server, cockpit, drivers ✓ (gebouwd en getest zonder hardware)
Gebouwd door 5 bouwers + 10 reviewers + 5 verwerkers, samengevoegd en bedraad door Claude.
- [x] Kern: focus via Bank + Track Select, automatische indeling, fader-pickup, ringen, keuze/schakelaar/trigger, lease voor Varve DJ en av-kern (LED-kaart per app, mode-SysEx ingeslikt, ring-emulatie), LPD8-macro's met rollen en slew, paniek/tap/adem/opname/snapshots, hartslag, truth hub
- [x] Server: HTTP + WebSocket `/app` en `/cockpit`, Origin- en Host-beveiliging, ingedrukte virtuele toetsen worden losgelaten als de cockpit wegvalt
- [x] Cockpit op http://localhost:7700: virtuele APC40 + LPD8, apps, focus-parameters, snapshots, globaal, live invoer (`docs/cockpit.png`)
- [x] Drivers zonder code in de apps: av-scene-kit (TD via virtuele MIDI-poort "VARVE-HUB TD"), Sediment (Logic via "VARVE-HUB Logic"), uurwerk (HTTP); handleidingen `docs/TOUCHDESIGNER.md`, `docs/LOGIC.md`
- [x] 51 spelerscenario's (zwarte doos) + end-to-end tests van de hele hub — 347 tests
- [x] `varve-hub start` (`npm start`)

Klaar als (op jouw Mac):
- [ ] `npm start` → cockpit opent, APC en LPD8 staan op "verbonden"
- [ ] `node tools/nep-app.mjs --app formula-lab` en `--app waterschaal` in twee terminals → beide verschijnen; Bank + Track Select wisselt; fader 1 pakt op zonder sprong
- [ ] LPD8-knop 2 verandert "Helderheid" in beide nep-apps
- [ ] TD: device 1 = "VARVE-HUB TD" → APC-knoppen bewegen de TD-hub (zie `docs/TOUCHDESIGNER.md`)

## Golf 2 — breken ✓
6 zoekers (MIDI-chaos, netwerkchaos, levensduur, lease-chaos, protocol-feiten, volledigheid) → 23 bevindingen door een scepticus bevestigd (6 belangrijk, 17 klein, 0 blokkerend) → per gebied opgelost, elk met een test die de fout eerst liet zien. Belangrijkste: slots komen vrij, twee tabs van dezelfde app verdringen elkaar niet meer, LPD8-pickup volgt snapshots en app-wijzigingen, lease-LEDs strikt gefilterd en begrensd, Sediment-waarden op log-schaal in de cockpit, nette foutmelding als poort 7700 bezet is. Beslissingen: `PROTOCOL.md` §11.

## Volgende
- Golf 3: koppelingen in de apps zelf (Varve DJ, formula-lab, waterschaal, medisynth, flux; av-kern na 25 okt)
