# Varve Hub — implementatieplan: samen bouwen

*3 okt 2026 · vervolg op [ONDERZOEK.md](ONDERZOEK.md). Dit plan gaat over **hoe** we het bouwen: wie wat doet, hoe de terugkoppeling werkt, in welke volgorde, en wanneer iets af is.*

---

## 1. Het principe: Claude bouwt, Clay speelt en meet

We zitten op twee plekken die elkaar aanvullen. Het plan is zo opgezet dat Claude zo veel mogelijk zonder hardware kan doen, en dat elk uur dat jij met de controllers speelt automatisch bruikbare testdata oplevert.

| | **Claude** (cloud-sessie) | **Clay** (Mac + hardware) |
|---|---|---|
| Kan | alle code · unit- en e2e-tests met nep-poorten · virtuele APC40/LPD8 · headless Chromium (Playwright) voor UI en browser-adapters · PR's in elk repo · testprotocollen schrijven · logs en opnames analyseren | echte APC40 + LPD8 · Chrome met MIDI · TouchDesigner · Blender · Logic · Omarchy-pc · gevoel beoordelen (latency, LED-leesbaarheid, speelbaarheid) |
| Kan niet | echte MIDI (de cloud heeft geen `/dev/snd`, net getest: RtMidi faalt) · TD/Logic/Blender · macOS-specifiek (launchd, CoreMIDI) | — |
| Beslist | technische details binnen de afspraken | alles wat smaak, workflow of prioriteit is · mergen |

**Gevolg voor de architectuur:** de MIDI-laag zit achter een `Port`-interface. Claude test tegen een in-memory nep-poort; `@julusian/midi` wordt pas geladen als er echte hardware is, en de hub start ook zonder (dan alleen virtuele apparaten).

---

## 2. De terugkoppellus — het belangrijkste onderdeel

Samenwerken gaat alleen goed als jouw hardware-avonden weinig moeite kosten en Claude precies kan zien wat er gebeurde. Daarom bouwt F0 eerst de **meetinstrumenten**, nog vóór de functies.

```
 Claude: code + test + protocol ──PR──▶ Clay: merge, git pull op de Mac
        ▲                                         │
        │                                varve-hub proef <naam>
        │                                (begeleide test, neemt alles op)
        │                                         │
        └── proef/*.jsonl wordt golden test ◀──git push── proef/2026-10-05-f0.jsonl
```

**Gereedschap (onderdeel van F0):**

- **`varve-hub doctor`** — één scherm met: gevonden apparaten (APC40 ja/nee, LPD8 mk1/mk2 + inhoud programma 1), vrije poorten (7700, 7701), virtuele MIDI-poorten, welke apps bereikbaar zijn (8766, 8777, 9980, …), Node-versie. Uitvoer plak je in de chat of komt in `proef/`.
- **`varve-hub proef <naam>`** — een begeleide hardwaretest in de terminal: *"druk Shift … beweeg fader 3 helemaal op … welke kleur zie je op pad 1-1? [enter = klopt, n = klopt niet + notitie]"*. Alles wordt opgenomen: ruwe MIDI in/uit met tijdstempels, jouw antwoorden, versies. Resultaat: `proef/<datum>-<naam>.jsonl` + een korte samenvatting.
- **`varve-hub opname`** — een gewone speelsessie opnemen (ruwe MIDI + wat de hub ervan maakte).

**Wat Claude ermee doet:**
- Elke `proef`-run wordt een **golden test**: dezelfde ruwe invoer moet in CI dezelfde uitvoer geven. Zo wordt elke hardware-avond permanent bewaakt.
- Afwijkingen ("n = klopt niet") worden issues of direct een fix in de volgende PR.
- Speelsessies worden replay-fixtures (latency, pickup-gedrag, LED-verkeer).

**Afspraak voor meldingen** (chat of GitHub-issue): *wat deed ik · wat verwachtte ik · wat gebeurde er · welk proef/opname-bestand*. Meer hoeft niet.

---

## 3. Beslissingen — voorstel (zeg het als je anders wilt)

| # | Vraag | Voorstel | Waarom |
|---|---|---|---|
| B1 | LPD8 mk1 of mk2? | **Beide ondersteunen**; `doctor` detecteert het model (SysEx-ID `0x75`/`0x4C`). Geen pad-LEDs in het ontwerp. | Kost weinig, en we weten het zeker na F0. |
| B2 | Waar komt de code? | **Eigen privé-repo `CKrebbers/AV-app-hub`** (gedaan 3 okt). De code heet intern nog `varve-hub` (CLI, package). | `3dbuildgame` past niet; de hub verdient een eigen CLAUDE.md, CI en issues. |
| B3 | Hubtoets | **Bank (103)**, instelbaar in `config.json`. Master (80) als reserve. | Ongebruikt in Varve DJ en av-kern; heeft geen LED-functie die we missen. |
| B4 | Eerste set | **`dj`-light eerst** (Varve DJ + formula-lab + av-scene-kit/TD), **`meditatie` na 25 okt** | av-kern heeft voorrang tot de publicatie van 25 okt; daar raken we niets aan (zie §6). |
| B5 | Taal/stack | **Node 22, ESM, gewoon JS + JSDoc (`// @ts-check`), vitest, geen build.** Afhankelijkheden: `ws`, `@julusian/midi` (optioneel). | Zelfde stijl als Varve DJ en formula-lab; draait direct met `node`. |
| B6 | Varve Radio-lek | **Apart repareren**, los van de hub, wanneer jij wilt | Niet blokkerend voor de hub, wel een echt risico. |

---

## 4. Huisregels (komen in `varve-hub/CLAUDE.md`)

1. **De hub is de enige die een controller opent.** Geen app roept met hub-vlag `requestMIDIAccess` aan. Mode-SysEx van apps wordt ingeslikt.
2. **`core/` heeft geen I/O en geen klok** — tijd wordt geïnjecteerd (av-kern-regel). Alles in `core/` is met vitest te testen zonder poorten.
3. **Op de draad altijd 0..1** (triggers boolean); de app schaalt zelf (Varve-regel 2).
4. **Elke app-adapter zit achter een vlag** (`?hub=ws://localhost:7700` of `--hub`), standaard uit. Zonder hub werkt elke app precies als nu.
5. **We respecteren de regels van elk repo:** av-kern-kern (`midi.ts`, `bus.ts`) blijft bevroren · Varve DJ geen build en geen dependencies · formula-lab geen backend/framework/TS · waterschaal blijft één HTML-bestand · NEXUS (WS 8080) niet aanraken.
6. **`config.json` is de enige bron** voor poorten, kleuren, sets en de hubtoets — nooit hardcoden (av-scene-kit-regel).
7. **Elke fase eindigt speelbaar** en heeft "Klaar als"-criteria die jij op hardware afvinkt in `STATUS.md`.
8. **Klein houden.** Geen feature zonder een avond waarop je hem gebruikt (medisynth-regel). Nieuwe ideeën gaan naar `IDEEEN.md`, niet in de lopende fase.
9. Nederlands in code, docs en commits.

---

## 5. Repo-indeling `varve-hub`

```
varve-hub/
├── CLAUDE.md · README.md · PLAN.md · ONDERZOEK.md · STATUS.md · IDEEEN.md
├── config.json              poorten, hubtoets, kleuren, sets, LPD8-indeling
├── src/
│   ├── core/                puur: staat, laagstapel, mapping, pickup, LED-model, manifest, snapshots, log
│   ├── devices/             apc40mk2.js (control-map + palet, één bron), lpd8.js (mk1/mk2), virtueel
│   ├── ports/               Port-interface · rtmidi.js (lazy) · nep.js (tests)
│   ├── transports/          ws.js · osc.js · http-driver.js · midi-virtueel.js
│   ├── apps/                statische manifesten: av-scene-kit, uurwerk, sediment
│   ├── hub.js               bedrading + start
│   └── cli.js               start · doctor · proef · opname · replay
├── ui/                      hub-pagina op :7700 — virtuele APC40 + LPD8, apps, ghost-faders
├── maps/                    per-app overrides
├── sets/                    meditatie.json · dj.json · scene-kit.json
├── tools/nep-app.mjs        nep-app die een manifest aanmeldt (tests + demo)
├── proef/                   jouw hardware-runs (golden tests)
└── test/                    unit · e2e (ws/osc/http) · golden · ui (Playwright)
```

**CI (GitHub Actions):** `npm test` (unit + e2e + golden) en Playwright op de virtuele APC bij elke push. Hardwaretests (`npm run test:hw`) alleen op de Mac.

---

## 6. Planning

Vandaag is za 3 okt. **Tot 25 okt is av-kern-publicatie de prioriteit.** Daarom: Claude bouwt in die weken alles wat geen hardware nodig heeft; jij hoeft maar **twee korte hardware-avonden** te geven, en we raken av-kern niet aan (behalve een losse PR voor de ◄/►-bug, die jij zelf inplant).

### Fase 0 — Fundament + meetinstrumenten · wk 41 (5–11 okt)

| Taak | Wie |
|---|---|
| Repo `varve-hub` aanmaken (leeg, privé) | Clay (2 min) |
| Skelet, CLAUDE.md, config, CI | Claude |
| `devices/apc40mk2.js` (control-map + volledig 128-kleurenpalet uit protocol v1.2) en `lpd8.js` | Claude |
| `Port`-interface, nep-poort, lazy rtmidi | Claude |
| LED-wachtrij (16/4 ms) + diff + echo-filter, mode 0x42 init, hotplug-poll | Claude |
| `doctor`, `proef`, `opname` | Claude |
| Proefprotocol `f0-hardware` (elke control, palet, replug, de 5 open vragen uit ONDERZOEK §10) | Claude |
| **Hardware-avond 1** (±45 min): `git pull && npm i && npx varve-hub proef f0-hardware`, push het bestand | Clay |
| Golden tests uit jouw run, hardwarevragen beantwoord in ONDERZOEK §10 | Claude |

**Klaar als:** elke APC-control staat in de proeflog met de juiste control-id · een volledige repaint is zichtbaar in < 50 ms · uittrekken/terugsteken → vanzelf init + repaint · LPD8-model en programma 1 bekend · de 5 open hardwarevragen zijn beantwoord · CI groen.

### Fase 2 — Kern, manifesten, virtueel oppervlak · wk 42 (12–18 okt)
*(F2 vóór F1: kan volledig zonder hardware.)*

| Taak | Wie |
|---|---|
| `core/`: staat per app, laagstapel (LPD8 → Bank → focus), automatische indeling uit manifest, pickup, ring-sync, globals (adem, grondtoon D, bpm), snapshots, heartbeat | Claude |
| WS-transport + protocol (`hello/manifest/state/set/trig/focus/globals/hb`) | Claude |
| Hub-UI op :7700: virtuele APC40 (gebaseerd op `av-kern/src/ui/virtual.ts`) + virtuele LPD8, app-lijst, ghost-faders | Claude |
| `tools/nep-app.mjs`, Playwright-tests op de virtuele APC | Claude |
| Even kijken naar de UI (link naar artefact of lokaal `npm start`) en zeggen wat je ervan vindt | Clay (15 min) |

**Klaar als:** een nep-app meldt zich aan en zijn parameters staan vanzelf op de (virtuele) APC in de juiste kleur · LPD8-K1 beweegt master in 3 nep-apps tegelijk · pickup en focuswissel unit-getest · nep-app herstarten behoudt waarden en LEDs.

### Fase 3a — Eerste echte apps zonder codewijziging · wk 43 (19–25 okt)

| Taak | Wie |
|---|---|
| Virtuele MIDI-poort "VARVE-HUB TD" + statisch manifest uit `av-scene-kit/config.json` | Claude |
| HTTP-driver voor uurwerk (`macro`, `uur`, `bewaar`, `bevries`) + statisch manifest | Claude |
| Proefprotocol `f3a-td-uurwerk` | Claude |
| **Hardware-avond 2** (±45 min): TD MIDI Device Mapper device 1 → "VARVE-HUB TD"; uurwerk starten; `proef f3a-td-uurwerk` | Clay |

**Klaar als:** APC-fader beweegt feedback/mix in de TD-hub en Blender-zuilen reageren (via TD) · een LPD8-knop verandert `onrust` in uurwerk · uurwerk-latency gemeten (< 150 ms acceptabel voor macro's) · e2e-tests groen.

> **25 okt: av-kern-publicatie.** Geen hub-werk dat jouw tijd vraagt in die week.

### Fase 1 — Lease: Varve DJ en av-kern samen · wk 44–45 (26 okt–8 nov)

| Taak | Wie |
|---|---|
| PR youtube-mixer: `src/control/hub.js` (zelfde interface als `MidiHub`) achter `?hub=`; LPD8-globals → `actions.invoke` | Claude |
| PR av-kern: `src/ui/hub.ts` (buiten de kern) + ◄/►-fix in `apc40.ts` (als die nog niet gemerged is) | Claude |
| Hub: lease-modus, LED-kopie per app, ring-emulatie voor av-kern, mode-SysEx inslikken | Claude |
| Spy-test: 0× `requestMIDIAccess` met `?hub` (Playwright) | Claude |
| PR's reviewen en mergen | Clay |
| **Hardware-avond 3** (±1 u): beide apps open, 30 min wisselen, `proef f1-lease` | Clay |

**Klaar als:** beide apps tegelijk open · Bank + Track Select wisselt zonder tab te sluiten · LED-beeld na wissel byte-gelijk aan de laatste staat van die app · 0× `requestMIDIAccess` · 30 min zonder Chrome-MIDI-crash · av-kern-regel 8 ("Varve dicht voor AV-kern") kan weg.

### Fase 3b — Browser-adapters · wk 46 (9–15 nov)
formula-lab (WS-transport op de `SyncChannel`-interface, `in1..in8`, cue/take, poort → 5174) · waterschaal (`?hub=` tweede verbinding, test tegen `nep-td.mjs`) · medisynth (2–4 trage macro's, adem volgen). Elk een PR in het eigen repo.
**Klaar als (per app):** fader/knop op de APC of LPD8 beweegt zichtbaar het verwachte · e2e groen · app werkt ongewijzigd zonder vlag.

### Fase 4 — Opnemen, replay, snapshots, sets · wk 47
`sets/*.json` + `varve-hub start <set>`, Bank + Scene snapshot-recall, LPD8-P4 gebaren-opname, replay naar zelfde eindstaat-hash.
**Klaar als:** `varve-hub start meditatie` brengt alles in de juiste begintoestand · een opname van 2 min speelt af naar dezelfde hash · Bank + Scene roept 4 apps tegelijk op.

### Fase 5 — Netwerk, Linux, altijd aan · wk 48
mDNS + token, launchd-agent (Mac), systemd-user-unit (Omarchy), flux-adapter (UDP-listener in Python stdlib).
**Klaar als:** LPD8-knop op de Mac verandert flux op de Omarchy-pc · na reboot draait de hub en zijn clients binnen 5 s terug.

### Fase 6 — Op gebruik
td-lab via OSCQuery-COMP · sediment (Logic Controller Assignments, later CC-tabel in de AU) · anbernic over usb0 · Open Stage Control als extra UI. Alleen wat je na een paar speelavonden echt mist.

---

## 7. Hoe een taak loopt (PR-ritme)

1. **Claude** werkt op een `claude/…`-branch in het betreffende repo, met tests, en opent een PR met: wat · waarom · hoe getest · wat jij op hardware moet checken (met het `proef`-commando erbij).
2. **CI** draait unit, e2e, golden en Playwright. Rood = Claude fixt het voordat jij kijkt.
3. **Clay** leest de samenvatting, merget of reageert in de PR. Bij hardware-afhankelijke PR's: eerst de bijbehorende `proef`, dan mergen.
4. **Na merge:** Claude werkt `STATUS.md` bij; open punten gaan naar de volgende PR, ideeën naar `IDEEEN.md`.

Eén PR = één ding. Adapter-PR's in andere repo's zijn klein en altijd achter een vlag.

---

## 8. Testpiramide

| Laag | Wat | Waar |
|---|---|---|
| Unit | `core/`: mapping, laagstapel, pickup, LED-diff, palet, manifest, snapshots, heartbeat — met nep-klok | CI |
| Golden | jouw `proef/`- en `opname/`-bestanden: zelfde ruwe invoer → zelfde uitvoer/hash | CI |
| E2E | hub op vrije poort + nep-apps via WS/OSC/HTTP; Python OSC-listener (patroon `av-scene-kit/tests/test_e2e_osc.py`) | CI |
| UI | Playwright op virtuele APC/LPD8; spy op `requestMIDIAccess` in app-adapters | CI |
| Hardware | `npm run test:hw` + `proef`-protocollen | Mac |
| Speelavond | echte set spelen, `opname` aan, gevoel noteren | Mac |

---

## 9. Risico's en wat we eraan doen

| Risico | Maatregel |
|---|---|
| Hub-werk gaat ten koste van av-kern-publicatie | av-kern niet aanraken vóór 25 okt (behalve de losse ◄/►-PR); max 2 korte hardware-avonden in die periode |
| Te groot systeem (bekend patroon, formula-lab CLAUDE.md §1) | elke fase speelbaar, strikte Klaar-als, `IDEEEN.md` als parkeerplaats, geen feature zonder gebruik |
| Hardware gedraagt zich anders dan het protocol | F0 beantwoordt de 5 open vragen vóór we erop bouwen |
| Browser blokkeert `ws://localhost` vanaf een https-site (Local Network Access) | lokaal draaien (localhost-origin) voor de hub; varve.nl-versies blijven zonder hub |
| Een app crasht of herstart midden in een set | heartbeat + app-/hub-truth + LED knippert; panic op LPD8-P1 |
| Latency via WS/HTTP voelbaar | meten in elke proef; uurwerk alleen macro's; drempel p95 < 5 ms (WS/OSC) en < 150 ms (HTTP) |
| Vergeten welke versie op de Mac staat | `doctor` toont git-hash van hub en adapters |

---

## 10. Volgende stappen (deze week)

1. **Clay:** beslissingen B1–B6 bevestigen of aanpassen (één regel per stuk is genoeg).
2. ~~**Clay:** leeg privé-repo aanmaken~~ → `CKrebbers/AV-app-hub` ✓
3. **Claude:** repo koppelen, F0 bouwen (skelet → apparaten → poorten → LED-wachtrij → doctor/proef), PR openen.
4. **Claude:** losse PR in av-kern voor de ◄/►-bug (klein, jij plant de merge).
5. **Clay:** hardware-avond 1 (`proef f0-hardware`), bestand pushen.
