# Varve Hub — onderzoek: alles bespelen met APC40 mkII + LPD8

*3 okt 2026 · gebaseerd op 7 parallelle onderzoeken: 4 I/O-surveys over alle 13 repo's, een MIDI-census, hardware-onderzoek (officieel Akai APC40 Mk2 Communications Protocol v1.2) en een architectuurstudie. Bestandsverwijzingen zijn `repo/pad:regel`.*

---

## 1. Advies in het kort

**Bouw één kleine Node-daemon, `varve-hub`, die als énige de APC40 en de LPD8 opent.** Alle apps praten met de hub, nooit meer zelf met de controllers. De hub zet de APC in mode `0x42` (host stuurt álle LEDs, ook de ringen), houdt per app de waarden en een LED-kopie bij, en praat met elke app in diens eigen taal: WebSocket (browser-apps), OSC (TouchDesigner, Blender, Python), virtuele MIDI-poorten (Logic/Sediment, de bestaande TD-hub) en HTTP (uurwerk).

Twee soorten koppeling:

| | **Lease** | **Manifest** |
|---|---|---|
| Voor | Varve DJ (youtube-mixer), av-kern | alle andere projecten |
| Hoe | hub stuurt **ruwe APC-bytes** naar de app met focus, app stuurt LED-bytes terug | app meldt zijn parameters aan; hub mapt knoppen → (app, parameter) |
| Waarom | die twee hebben al een complete, geteste APC40-stack (374 regels mapping, mapjes, soft-takeover, LEDs) — niets herschrijven | de rest heeft geen MIDI; een manifest maakt ze in één keer bespeelbaar |

- **APC40 = de app met focus.** **Bank** (note 103) vasthouden = hub-laag: bovenste padrij toont je apps in hun kleur, Track Select 1–8 wisselt focus, Scene 1–5 roept een snapshot van álle apps op. Bank is in Varve DJ én av-kern ongebruikt, dus je verliest niets.
- **LPD8 = altijd-aan globale laag**, onafhankelijk van focus: 8 macro's (intensiteit, helderheid, ruimte, beweging, kleur, dichtheid, ademperiode, klank↔beeld) naar elke app die ze ondersteunt, plus panic, tap, adem-sync, opnemen en 4 snapshots.

**Waarom niet iets bestaands?** Chataigne dekt ~60% (OSC/MIDI-routing naar TD/Blender/Logic), maar niet de lease voor Varve DJ en av-kern (je grootste investering), niet de LED-semantiek per app, en het is niet testbaar met vitest/git. Wél hergebruiken: **OSCQuery** als manifest-formaat (TD kan zijn custom parameters gratis publiceren via `td-osc-query-server`) en eventueel **Open Stage Control** later als extra touch-UI.

**Waarom niet de browser of TouchDesigner als hub?** Browser: Chrome's MIDI-service crashte 5× op 22–23 sep met meerdere tabs op de APC, en BroadcastChannel werkt alleen binnen één origin (:8777, :5173, :8080, :8765 zijn allemaal anders). TD: is soms dicht, wordt vaak herbouwd, niet testbaar, en heeft al een eigen rol in av-scene-kit.

---

## 2. Wat er nu is

| Project | Wat | Platform | Ingang nu | MIDI nu |
|---|---|---|---|---|
| **youtube-mixer** (Varve DJ) | DJ/AV-mixer, 8 tracks | Node :8777 + Chrome | HTTP-API (alleen localhost/same-origin), BroadcastChannel `varve-status`, action-bus `invoke(id, 0..1)` | **APC40, mode 0x42**, Web MIDI, 374 mappingregels, LEDs |
| **av-kern** | AV-meditatie-instrument | Vite :5173 + Chrome | geen | **APC40, mode 0x41**, Web MIDI, blueprints, deterministische bus + replay |
| **formula-lab** | formule → shader-lab | Vite :5173 (!) | BroadcastChannel `formula-lab-sync`; WS-relay :9900 gepland | geen (gepland: `input {device,control,value}`) |
| **td-lab** | TD reaction-diffusion/deeltjes | TouchDesigner 2023 | HTTP exec-bridge :9981 | geen |
| **av-scene-kit** | ESP32 → TD-hub → Blender → clips | Mac: Python, TD 2025, Blender, Logic | OSC :9000 (TD), :9001 (Blender), IAC L2TD/TD2L | TD MIDI In: CC 20–27, notes 36–41, ch1 |
| **uurwerk** | generatief slingeruurwerk | browser + Node :8765/:8766 | HTTP verbs `POST /verb` + MCP | geen |
| **waterschaal** | klankschaal/handpan + TD-water | browser :8080 + TD | WS-**client** naar `ws://localhost:9980` | geen (APC40 staat op de roadmap) |
| **sediment** | AU-padsynth + Logic Scripter-set | Logic Pro (macOS) | geen netwerk; 22 parameters via host-automation | noten, CC1, pitchbend |
| **medisynth** | altijd-rustig instrument | Vite :5173 | **niets** | geen (FOUNDATION: later "alleen trage macro's") |
| **flux-screensaver** | terminal-screensaver | Omarchy/Linux | alleen CLI-args/`flux-args` | geen |
| **anbernic-cam** (Varve Eye) | ESP32-cam op handheld | Knulli/pygame, ook Mac | serieel VEYE-protocol, gamepad | geen |
| **varve-radio** | 24u deterministische radio | single HTML + Supabase | Supabase realtime-kanaal `radio` | geen |
| **musicgen-video-glitch** | video → MusicGen-soundtrack | Python offline | CLI | geen |

**Gedeelde muzikale basis die de hub kan uitsturen:** grondtoon **D** (waterschaal D3, medisynth D2, sediment D lydisch, uurwerk dorisch D3) en een **ademklok van 6/min** (medisynth `BREATH_HZ 0.1` = waterschaal `tempo 6`).

---

## 3. Problemen en gaten die we moeten oplossen

### Blokkerend
1. **Twee apps vechten om dezelfde APC40.** Varve DJ en av-kern openen hem allebei via Web MIDI, elk met een eigen Web Lock (`varve-mixer` / `av-kern-apc`). Locks zijn per origin en beschermen dus niet tegen elkaar (`av-kern/src/kern/tabblad.ts:11-12`). Ze zetten ook verschillende modes (`0x42` vs `0x41`). → Hub wordt enige eigenaar; apps krijgen een WS-poort in plaats van Web MIDI.
2. **Varve DJ luistert naar maar één MIDI-ingang** (`youtube-mixer/src/control/midi.js:325-327`) — APC + LPD8 tegelijk kan niet. → Lost zich op via de hub.
3. **LPD8 komt in geen enkel project voor.** Alles rond de LPD8 is nieuw.
4. **Welke LPD8 heb je — mk1 of mk2?** Dat bepaalt de standaardnoten/CC's, of pad-LEDs aanstuurbaar zijn (mk1: ja, beperkt; mk2: niet betrouwbaar) en het SysEx-protocol (model-ID `0x75` vs `0x4C`). De hub kan dit zelf uitlezen met Device Inquiry.

### Bugs/inconsistenties gevonden
5. **av-kern heeft ◄/► omgedraaid.** `av-kern/src/kern/apc40.ts:41-42` zegt left=96, right=97; het officiële Akai-protocol v1.2 en Varve DJ zeggen **right = 0x60 (96), left = 0x61 (97)**. In de ademmachine zijn `ai-acc`/`ai-rej` daardoor verwisseld.
6. **Grid-oorsprong verschilt:** Varve DJ noemt de pad linksboven "1/1" (note 0x20), av-kern noemt linksonder "pad1-1" (note 0x00). De hub gebruikt één naamgeving (av-kern-ids, met de oorsprong expliciet gedocumenteerd).
7. **av-scene-kit verwacht CC 24–27 voor knob 5–8, maar die CC's stuurt de APC nooit** — het zijn ring-type-*uitgangen*. De APC kan av-scene-kit nu dus niet direct bespelen. → Hub stuurt via een virtuele poort precies CC 20–27/notes 36–41.
8. **Poortconflicten:** av-kern en formula-lab willen allebei :5173 (Vite schuift er één op → andere origin → andere localStorage). td-lab's bridge en de geplande touchdesigner-mcp willen allebei :9981. Waterschaal's 9980 kan maar één server hebben.
9. **Varve Radio, beveiliging:** de pagina past een `zender`-broadcast toe zonder te controleren wie hem stuurt (`varve-radio-v2.LIVE.html` ±L1179-1198, L1824). Iedereen met de publieke anon key kan de radio voor alle luisteraars overnemen. Los van de hub: dit moet dicht (private channel of afzendercheck). En: gebruik dit kanaal **nooit** als besturingspad.
10. **musicgen-video-glitch:** `train_lora.py` is geen LoRA (volledige fine-tune) en draait vrijwel zeker niet (`compute_predictions(...).loss` bestaat niet in audiocraft; `torch.cuda.amp.autocast` op MPS). `main.py` negeert `--output` voor de wav. Niet hub-gerelateerd, wel goed om te weten.

### Ontbrekende ingangen (per project een kleine adapter, zie §7)
medisynth, flux-screensaver en anbernic-cam hebben geen enkele externe ingang; formula-lab en waterschaal alleen voor hun eigen partner; sediment alleen via Logic.

---

## 4. Architectuur

```
                ┌──────────── Mac ─────────────────────────────────────────────┐
 APC40 mkII ─USB─┤                                                              │
 LPD8 ──────USB─┤  varve-hub (Node, launchd)                                    │
                │   ├─ apparaten: APC (mode 0x42), LPD8, virtuele APC/LPD8      │
                │   ├─ laagstapel: LPD8-globaal → Bank-hublaag → focus-app      │
                │   ├─ staat: apps{manifest, waarden, LED-kopie}, globals       │
                │   ├─ LED-wachtrij (16 msg/4 ms, diff, echo-filter 60 ms)      │
                │   └─ log (JSONL, replaybaar)                                  │
                │      │                                                        │
                │      ├─ WS :7700 ──▶ Varve DJ (lease) · av-kern (lease)        │
                │      │              formula-lab · medisynth · waterschaal     │
                │      ├─ HTTP ─────▶ uurwerk :8766/verb                         │
                │      ├─ MIDI-poort "VARVE-HUB TD" ───▶ TD /project1/hub        │
                │      ├─ MIDI-poort "VARVE-HUB Logic" ─▶ Logic → Sediment       │
                │      ├─ OSC :7701 in / uit ─▶ td-lab (OSCQuery) · Blender      │
                │      └─ UI http://localhost:7700 (virtuele APC40 + LPD8)       │
                └───────────────────────────────┬──────────────────────────────┘
                                                │ LAN (mDNS _varvehub._tcp, token)
                    Omarchy-pc: flux-screensaver ┘   (later: Anbernic via usb0 10.42.0.x)
```

**Poorten:** hub op **7700** (HTTP + WS + OSCQuery) en **7701/udp** (OSC). Vrij van alles wat al in gebruik is (5173, 8080, 8765/8766, 8777, 9000/9001, 9876, 9980, 9981, 9900 gepland). Verplaats formula-lab naar **5174** met `strictPort`.

**Laagstapel per binnenkomend bericht:**
1. LPD8 → globale laag (altijd).
2. Bank ingedrukt → hublaag (focus, snapshots).
3. Anders → app met focus: lease (ruwe bytes) of manifest-pagina.
4. Anders → gelogd als "niet-gemapt" (zoals `av-kern/scripts/niet-gemapt.ts`).

**Lease-details**
- De hub slikt mode-SysEx van apps in (`F0 47 7F 29 60 …`); alleen de hub zet de mode.
- Elke app heeft een eigen LED-kopie; die gaat alleen naar de hardware als de app focus heeft. Bij wisselen: volledige repaint uit de kopie.
- av-kern gaat uit van `0x41`, waarin de APC zelf zijn ringen tekent. In `0x42` moet de host dat doen → de hub **emuleert de ringen** voor apps met `rings:"auto"` (knob-CC terugschrijven naar de ring). Zo blijft de bevroren kern (`midi.ts`, `bus.ts`) onaangeroerd.

**Protocol (minimaal)** — waarden op de draad altijd **0..1**, triggers boolean (Varve-regel 2); de app schaalt zelf.

Manifest (subset van OSCQuery-attributen):
```json
{"v":1,"app":"formula-lab","name":"Formula Lab","color":21,"truth":"app","hb_s":1,
 "params":[
  {"id":"in1","name":"In 1","type":"f","default":0,"hint":"fader","group":"handen"},
  {"id":"take","name":"Take","type":"trigger","hint":"pad"},
  {"id":"palet","name":"Palet","type":"enum","values":["a","b","c"],"hint":"kolom"},
  {"id":"ruimte","name":"Ruimte","type":"f","slew_s":4,"role":"macro.ruimte"}],
 "scenes":["A","B","C"],"lease":false}
```

| Richting | WS-berichten (`{t:…}`) |
|---|---|
| app → hub | `hello{app,token}` · `manifest{…}` · `state{values}` · `hb{}` · `led{bytes}` (lease) |
| hub → app | `set{id,v}` · `trig{id,on}` · `scene{i}` · `focus{on}` · `globals{adem,grondtoon,bpm…}` · `midi{dev,bytes}` (lease) |

- Heartbeat elke 1 s; na 3 s stil = "stale" (LED knippert), na 10 s = offline (LED uit).
- OSC-variant: `/hub/hello s:app s:manifestURL i:replyPort`, hub stuurt `/varve/<app>/<id> f`.
- **Passieve apps** (TD via MIDI, uurwerk via HTTP, Logic) kunnen zich niet aanmelden → de hub levert een **statisch manifest** mee in `hub/apps/<app>.json` met een driver (`midi` / `http` / `osc`).
- **Herstart:** app meldt zich opnieuw → hub synchroniseert LEDs/pickup ("app-truth"). Apps die geen staat kunnen melden (uurwerk, TD-MIDI) krijgen de laatste hub-waarden terug ("hub-truth", met debounce op schijf bewaard).

---

## 5. Bedienconcept

### APC40 mkII — "de app met focus"

| Control | Zonder Bank | Met **Bank** ingedrukt (hublaag) |
|---|---|---|
| Clip-grid 8×5 | van de focus-app | bovenste rij = app-slots 1–8 in app-kleur |
| Track Select 1–8 | focus-app | **focus naar app 1–8** |
| Scene 1–5 | focus-app | **hub-snapshot 1–5** (alle apps tegelijk) |
| Stop All Clips | focus-app (manifest-apps: panic van die app) | — |
| al het andere | focus-app | — |

**LED-taal (overal hetzelfde):**

| LED | Betekenis |
|---|---|
| uit | offline / leeg slot |
| app-kleur, gedimd | verbonden, idle |
| app-kleur, vol | actief |
| **pulseren** (MIDI-kanaal 6–10) | heeft focus / speelt |
| **knipperen** (kanaal 11–15) | heartbeat weg, wacht op pickup, of fout |
| rood | alleen voor opnemen |
| wit | alleen voor hub-overlays |

App-kleuren: Varve DJ oranje · av-kern diepblauw · av-scene-kit/TD magenta · formula-lab groen · waterschaal cyaan · uurwerk amber · medisynth violet · sediment/Logic wit. Dezelfde kleuren in de hub-UI.

**Automatische indeling voor manifest-apps:** `hint:fader` → faders 1–8; knoppen → device knobs (Device ◄/► bladert door groepen), daarna track knobs; triggers/enums → grid (één kolom per enum); `scenes` → scene-knoppen. Overschrijven per app in `hub/maps/<app>.json`, gesleuteld op av-kern-control-ids (`fader3`, `dk5`, `pad2-4`).

**Soft-takeover**
- **16 ringknoppen (device + track):** dit zijn eindeloze encoders met een interne waarde die de host mag overschrijven (protocol v1.2 "Controller Value Update"). Bij focuswissel schrijft de hub de doelwaarden naar CC 16–23/48–55 → ring én knop springen mee, **geen pickup nodig**. *(Op hardware bevestigen — zie §10.)*
- **9 faders + crossfader + 8 LPD8-knoppen:** gewone potmeters, niet gemotoriseerd → **pickup bij kruisen** (overnemen uit `youtube-mixer/src/control/mapping.js`). Zolang een fader niet gevangen is knippert de Clip Stop-LED van die strip; de hub-UI toont een "spook" op de doelwaarde.
- Tempo (CC13) en Cue (CC47) zijn relatief, two's complement.

### LPD8 — "altijd aan"

| | Functie | gaat naar |
|---|---|---|
| K1 | intensiteit / master | elke app met `role:"macro.intensiteit"` |
| K2 | helderheid | `macro.helderheid` |
| K3 | ruimte / galm | `macro.ruimte` |
| K4 | beweging / snelheid | `macro.beweging` |
| K5 | kleur / tint | `macro.kleur` |
| K6 | dichtheid | `macro.dichtheid` |
| K7 | ademperiode (rond 6/min) | `clock.adem` → globals |
| K8 | klank ↔ beeld | `macro.balans` |
| P1 | **panic**: alles in 30 s naar zwart/stilte (1 s vasthouden) | alle apps |
| P2 | tap tempo | globals |
| P3 | adem re-sync (fase = 0 nu) | globals |
| P4 | gebaren opnemen aan/uit | hub-log |
| P5–P8 | hub-snapshot 1–4 (lang drukken = opslaan) | alle apps |

- Elke app bepaalt zelf wat "intensiteit" betekent, met zijn eigen `slew_s` (medisynth bijvoorbeeld ≥ 4 s — FOUNDATION I4: geen BPM, alleen trage macro's).
- Pads momentary gebruiken; toggle-staat houdt de hub bij (LPD8-toggle loopt anders uit de pas).
- Geen pad-LEDs aannemen; status staat in de hub-UI.
- LPD8-programma: vast **programma 1 = hub-programma**. De hub leest bij aansluiten het programma uit via SysEx en waarschuwt als het afwijkt (schrijven alleen op verzoek). Programma 4 als reserve app-wisselaar als het Bank-akkoord ooit faalt.

---

## 6. Hardwarefeiten (APC40 mkII protocol v1.2 + LPD8)

**APC40 mkII, mode 0x42** — intro `F0 47 7F 29 60 00 04 42 00 00 00 F7`. Valt terug naar mode 0 bij elke stroomonderbreking/replug → opnieuw sturen + alle LEDs hertekenen.

| Control | Bericht | Kanaal |
|---|---|---|
| Clip-grid | note 0–39; linksonder = 0, bovenste rij = 32–39 | 0 |
| Rec arm / Solo / Activator / Track Select / Clip Stop / A-B | note 48 / 49 / 50 / 51 / 52 / 66 | 0–7 = track |
| Device ◄► / Bank ◄► | 58,59 / 60,61 | 0 |
| Dev on/off, Lock, Clip/Dev view, Detail | 62, 63, 64, 65 | 0 |
| Master select / Stop All | 80 / 81 | 0 |
| Scene 1–5 | 82–86 | 0 |
| Pan / Sends / User | 87 / 88 / 89 | 0 |
| Metronome / Play / Record / Session | 90 / 91 / 93 / 102 | 0 |
| ▲ ▼ ► ◄ | 94 / 95 / **96 / 97** | 0 |
| Shift / Tap / Nudge − + / **Bank** | 98 / 99 / 100, 101 / **103** | 0 |
| Faders | CC 7 | 0–7 |
| Master / Crossfader / Tempo (rel) / Cue (rel) | CC 14 / 15 / 13 / 47 | 0 |
| Device knobs / ring-type | CC 16–23 / 24–31 | 0 |
| Track knobs / ring-type | CC 48–55 / 56–63 | 0 |
| Footswitch | CC 64 | 0 |

- **RGB-pads en scene-knoppen:** note-on, velocity = paletindex 0–127. Animatie: eerst basiskleur op kanaal 0, dan tweede kleur op kanaal 1–5 (one-shot), 6–10 (pulse) of 11–15 (blink), snelheden 1/24…1/2.
- **Ringen:** type via CC 24–31/56–63 (0 uit, 1 single, 2 volume, 3 pan); waarde via de CC van de knop zelf.
- **Eenkleurige LEDs:** 0 uit, ≥1 aan; Clip Stop 2 = knipper; A/B 1 geel, 2+ oranje. Geen LED: pijlen, Shift, Tap, Nudge, Stop All.
- Een volledige repaint = ±135 berichten → alleen verschillen sturen, rate-limiten (16 per 4 ms, zoals beide apps al doen).

**LPD8**

| | mk1 | mk2 |
|---|---|---|
| Pads | 8, eenkleurig | 8, RGB, velocity + pressure |
| Knoppen | 8, vast bereik | 8, 270°, vast bereik |
| Programma's | 4 | 4 in flash + programma 0 in RAM |
| SysEx-model | `0x75` | `0x4C` |
| Fabrieks-default | *niet geverifieerd — zelf dumpen* | pads note 36–43 (kanaal 10), knoppen CC 70–77 (kanaal 1) — community, verifiëren |
| Pad-LED via host | ja, maar volgende druk overschrijft | **niet betrouwbaar** |
| Programma lezen | `F0 47 7F 75 63 00 01 <1-4> F7` | `F0 47 7F 4C 03 00 01 <0-4> F7` |

**Software-stack:** `@julusian/midi` 3.8.1 (onderhouden RtMidi-wrapper, virtuele poorten op macOS + Linux; SysEx expliciet aanzetten met `ignoreTypes(false,false,false)`). Op macOS kunnen meerdere apps dezelfde USB-poort openen en hun uitvoer wordt **gemengd** — precies waarom de LEDs nu vechten. Zet de APC40-control-surface in Logic/Ableton uit op de hub-Mac.

---

## 7. Adapters per project (kleinste ingreep)

| Project | Koppeling | Ingreep | Moeite |
|---|---|---|---|
| **av-scene-kit** (TD + Blender) | virtuele MIDI-poort "VARVE-HUB TD", kies hem als device 1 in TD's MIDI Device Mapper; hub stuurt exact CC 20–27 / notes 36–41 ch1. Statisch manifest gegenereerd uit `config.json` (`knobs`, `midi.pads`). | **nul code** | S |
| **uurwerk** | hub-HTTP-driver `POST :8766/verb {verb:"macro", args:{naam,waarde}}`, max ±10 Hz, laatste waarde wint. Statisch manifest: onrust/licht/dicht/samenhang + `uur start/stop`, `bewaar`, `bevries`. | **nul code** (latency meten) | S |
| **Varve DJ** | lease: `src/control/hub.js` met dezelfde interface als `MidiHub`, achter `?hub=ws://localhost:7700`; met de vlag wordt `requestMIDIAccess` nooit aangeroepen. LPD8-globals → `actions.invoke(id, 0..1)`. *Niet* de virtuele-poort-truc: `_autoPick` kiest `/apc40/i` vóór de through-filter (`midi.js:267-275`), maar onthouden poortnamen en de echte APC maken het volgorde-afhankelijk. | ±1 bestand + vlag | M |
| **av-kern** | lease: `src/ui/hub.ts` (buiten de bevroren kern): WS → `Driver.input(bytes,'hub')`, LED-uitvoer → WS. Hub emuleert ringen. ◄/► fixen in `apc40.ts`. | ±1 bestand + bugfix | M |
| **formula-lab** | WS-transport dat de `SyncChannel`-interface implementeert (`src/sync/local.js` is daar al op voorbereid); manifest `in1..in8` + cue/take/dice. Poort → 5174. NEXUS (WS 8080) niet aanraken. | ±1 bestand | M |
| **waterschaal** | `?hub=ws://…:7700` als tweede verbinding in `td/waterschaal-lokaal.html`; hub-`set` → dezelfde handlers als TD's `adem`/`wrijf`/`scene`/`tik`. Manifest: scene, druk, draai, adem, tik veld 1–8 (pads met velocity!), plus de `P`-parameters (tempo, morph, zweving, vulling, volume) die nu niet via WS gaan. Testen tegen `tools/nep-td.mjs`. | klein, in single-file HTML | M |
| **td-lab** | `td-osc-query-server`-COMP op `/genesis`, `/world`, `/screensaver` → manifest gratis, input via OSC. Bridge-poort 9981 verplaatsen (botst met touchdesigner-mcp). Readout `Wlife/Wact/Flash` als terugkanaal. | TD-component | M |
| **sediment** | virtuele poort "VARVE-HUB Logic" → track-input; Logic Controller Assignments → de 22 parameters. Statisch manifest gegenereerd uit `src/Params.h`. Later: vaste CC→param-tabel in de processor (onafhankelijk van Logic). Geen LED-terugkoppeling. | nul code, wel Logic-setup | S |
| **medisynth** | `src/hub.js`: 2–4 macro's (ruimte, opbrengst/weer, helderheid) met `slew_s ≥ 4`, geen triggers, geen BPM; optioneel de adem-fase van de hub volgen. | klein | S |
| **flux-screensaver** | stdlib-Python UDP/OSC-listenerthread: tempo, dichtheid, palet. Dé LAN/Linux-test. | klein | S |
| **anbernic-cam** | later, zodra usb0 (10.42.0.x) of wifi werkt: OSC-listener die dezelfde actienamen als `knoppen.json` aanroept. De handheld kan ook een **bron** voor de hub worden. | later | M |
| **varve-radio** | optioneel lokaal: volume A/B, kanaal, laag 2 via een kleine same-origin adapter. **Nooit** via de `zender`-broadcast. Eerst het lek dichten. | laag | — |
| **musicgen-video-glitch** | niet live. Hooguit een hub-pad die een batchjob start; gebarenlog later als conditionering. | buiten scope | — |

---

## 8. Bouwplan

Elke fase is klein genoeg voor een paar avonden en eindigt met iets speelbaars.

**F0 — Hub bezit de APC (1 avond).** Node + `@julusian/midi` + `ws`; mode 0x42, LED-wachtrij, invoerlog, testpatroon. LPD8 uitlezen (Device Inquiry + programma-dump).
**Klaar als:** elke APC-control verschijnt in de log met de juiste control-id · een volledige repaint is zichtbaar in < 50 ms · uittrekken en terugsteken → vanzelf init + repaint · je weet welke LPD8 je hebt en wat programma 1 stuurt · geen Chrome-tab heeft MIDI open.

**F1 — Lease voor Varve DJ en av-kern.** `hub.js` / `hub.ts`, ring-emulatie, LED-kopie per app.
**Klaar als:** beide apps tegelijk open · Bank + Track Select 1/2 wisselt zonder tab te sluiten · na elke wissel klopt het LED-beeld byte-voor-byte met de laatste staat van die app (test) · spy-test bewijst 0× `requestMIDIAccess` met `?hub` · 30 min wisselen zonder MIDI-crash. *(Dit lost het grootste probleem van nu op en schrapt av-kern-regel 8.)*

**F2 — Manifesten, LPD8-laag, virtueel oppervlak.** Manifest-validatie, automatische indeling, laagstapel, pickup, globals (adem, grondtoon D), hub-UI op :7700 met virtuele APC40 (hergebruik `av-kern/src/ui/virtual.ts` + `apc40.ts`) en virtuele LPD8.
**Klaar als:** `tools/nep-app.mjs` meldt zich aan en zijn parameters staan vanzelf op de APC in de juiste kleur · K1 beweegt master in 3 nep-apps tegelijk · pickup is unit-getest · nep-app killen en herstarten behoudt waarden en LEDs.

**F3 — Adapters, goedkoopste eerst:** av-scene-kit (virtuele poort) → uurwerk (HTTP) → formula-lab → waterschaal → td-lab.
**Klaar als (per app):** een fader op de APC beweegt zichtbaar het verwachte ding én de e2e-test is groen.

**F4 — Opnemen, replay, snapshots.**
**Klaar als:** een LPD8-P4-opname van 2 min speelt opnieuw af naar dezelfde eindstaat-hash (zelfde patroon als av-kern's `Replayer`) · Bank + Scene roept 4 apps tegelijk op.

**F5 — LAN + Linux.** mDNS, token, systemd-unit, flux-adapter.
**Klaar als:** een LPD8-knop op de Mac verandert flux op de Omarchy-pc · na een reboot draait de hub weer en zijn alle clients binnen 5 s terug zonder handwerk.

**F6 — Op gebruik:** medisynth, sediment-CC-tabel, anbernic over USB-netwerk, Open Stage Control als extra UI.

**Waar de code komt:** deze map is het startpunt. De hub verdient een eigen repo (`varve-hub`); de naam `3dbuildgame` past er niet bij. De app-adapters landen elk in hun eigen repo, achter een vlag (`?hub=`), zodat niets kapotgaat zonder hub.

---

## 9. Testen

- **Unit (vitest, Node, geen DOM, geïnjecteerde klok — av-kern-regels 6–7):** laagresolutie, pickup (cases porten uit `youtube-mixer/test/mapping.test.mjs`), LED-diff + repaint bij focuswissel, mode-SysEx inslikken, ring-emulatie, manifest-validatie, HTTP-driver-coalescing, heartbeat-statemachine, snapshots.
- **MIDI-poort als interface:** in CI een in-memory nep-poort; echte loopback-tests (tag `hw-midi`) lokaal — Mac: RtMidi virtuele poorten; Linux: `modprobe snd-virmidi`/`snd-seq-dummy`. Niet rekenen op `/dev/snd/seq` in gehoste CI.
- **Replay-formaat (JSONL):** kop `{"v":1,"t0":…,"apps":{app:manifestHash},"globals":{…}}`, regels `[ms,"in","apc40",[b0,b1,b2]]` (ruw → test mapping) en `[ms,"set",app,id,v]` (opgelost → speelt af op apps). Combineert av-kern's `{tick,bytes}` met Varve's `[t,action,waarde]`; converters voor beide. Golden files in `test/golden/`: replay → identieke staat-hash.
- **Virtuele APC40/LPD8** in de hub-UI: hardware-loos ontwikkelen en demo's.
- **Nep-apps:** `tools/nep-app.mjs` (manifest + echo), plus de bestaande `waterschaal/tools/nep-td.mjs` en `av-scene-kit/tools/fake_td.py`.
- **OSC end-to-end:** patroon van `av-scene-kit/tests/test_e2e_osc.py` (`free_udp_port`, hub met tijdelijke config, UDP-listener controleert adres, waarde, p95-latency < 5 ms).
- **Hardware-checklist** (stijl `av-kern/FASE0-TEST.md`): elke control één keer · alle paletkleuren · replug · ring-overname na focuswissel · pulse/blink-snelheid met en zonder MIDI-clock · 30 min twee-app-wisselen · LPD8 programma 1 vs 4 · Mac slaap/wakker.

---

## 10. Open hardwarevragen — eerst testen (F0)

1. **Nemen de 16 ringknoppen een host-waarde echt over** (geen pickup nodig)? Protocol zegt ja; één communitymelding twijfelt over ringen in mode 2.
2. **Volgen pulse/blink de MIDI-clock (0xF8)?** Zo ja, dan stuurt de hub clock afgeleid van bpm of ademklok.
3. **Negeert de APC LED-berichten terwijl een pad is ingedrukt?** (communitymelding) → dan LED opnieuw sturen bij note-off.
4. **Antwoord `F0 47 7F 29 61 …` op de intro:** geeft dat de faderstanden bij opstart? Dan kan pickup direct goed starten.
5. **LPD8:** mk1 of mk2, wat staat er in programma 1, en werkt (mk2) een kleur via RAM-programma 0?

---

## 11. Gebruik in je totale setup

**Machines**
- **Mac (MacBook Air):** varve-hub (launchd, start bij inloggen), APC40 + LPD8 via USB, Chrome (Varve DJ, av-kern, formula-lab, waterschaal, medisynth, uurwerk), TouchDesigner, Blender, Logic. Alle USB-controllers hier.
- **Omarchy-pc:** flux-screensaver (en eventueel Blender over NDI uit av-scene-kit); verbindt over LAN met `ws://<mac>.local:7700`.
- **Anbernic + ESP32's:** voorlopig los; later via usb0/wifi.

**Sets (profielen)** — een set bepaalt welke apps op slot 1–8 staan en met welke snapshot je begint, zodat Bank-overzicht en kleuren per avond vast liggen:

| Set | Slot 1–8 |
|---|---|
| `meditatie` | av-kern · medisynth · waterschaal · sediment · uurwerk · td-lab |
| `dj` | Varve DJ · formula-lab · av-scene-kit/TD · td-lab |
| `scene-kit` | av-scene-kit/TD · Blender · Logic/sediment · formula-lab |

**Een avond:** `varve-hub start meditatie` → hub opent de controllers en start/opent de apps uit de set (of wacht tot ze zich melden) → bovenste rij licht op in app-kleuren → spelen met de APC per app, LPD8 voor het geheel → P4 neemt het gebaar op, Varve DJ/av-kern/TD nemen beeld/klank op zoals nu → achteraf replay of clip maken via de bestaande av-scene-kit-pipeline.

---

## 12. Beslissingen voor jou

1. **LPD8 mk1 of mk2?** (bepaalt LED-mogelijkheden en defaults)
2. **Eigen repo `varve-hub`** — akkoord, of toch in deze repo?
3. **Bank als hubtoets** — of liever Master (note 80, ook vrij in beide apps)?
4. **Eerste set** om naartoe te bouwen: `meditatie` (av-kern-publicatie 25 okt) of `dj`?
5. **Varve Radio-lek** nu apart dichten?

---

### Bronnen
- Akai APC40 Mk2 Communications Protocol v1.2 — https://cdn.inmusicbrands.com/akai/attachments/apc40II/APC40Mk2_Communications_Protocol_v1.2.pdf
- Ableton APC40_MkII remote script (gedecompileerd) — https://github.com/gluon/AbletonLive11_MIDIRemoteScripts/tree/main/APC40_MkII
- LPD8 mk2 User Guide — https://cdn.inmusicbrands.com/akai/LPD8/LPD8%20mk2%20-%20User%20Guide%20-%20v1.2.pdf
- LPD8 mk2 SysEx (reverse-engineered) — https://github.com/stephensrmmartin/lpd8mk2 · https://github.com/nimblemachines/akai-lpd8
- LPD8 mk1 protocol — https://github.com/bennigraf/lpd8-web-editor/blob/main/lpd8-protocol.md
- `@julusian/midi` — https://github.com/Julusian/node-midi
- td-osc-query-server — https://github.com/jonglissimo/td-osc-query-server
- Chrome Web MIDI permission — https://developer.chrome.com/blog/web-midi-permission-prompt
