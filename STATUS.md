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

**Op hardware (Clay — hardware-avond 1):** volg `docs/HARDWARE-AVOND.md` (`node src/cli.js proef`, daarna pushen).

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

## Golf 3 — koppelingen in de apps ✓ (wacht op Clay's OK per repo)
Elke app spreekt het protocol achter `?hub=ws://localhost:7700/app`; zonder vlag verandert er niets.
- formula-lab (poort 5174), waterschaal (`td/waterschaal-lokaal.html`), medisynth (poort 5175), flux (`flux-<monitor>`): tak `claude/varve-hub-koppeling` in elk repo, met een PR.
- Varve DJ: patch in `koppelingen/varve-dj/` (youtube-mixer: "nooit committen"), lease-modus.

## Golf 4 — een avond spelen ✓ (gebouwd en getest zonder hardware)
6 onderdelen, elk bouwer + 2 reviewers + verwerker; samengevoegd en opnieuw getest (648 tests, plus de echte repetitie).
- [x] **Sets en starter** — `npm start -- <set>` (`docs/SETS.md`)
- [x] **Avondmap** — LPD8-pad 4 neemt de avond op, `npm run herhaal` speelt hem terug en vergelijkt (`docs/OPNAME.md`)
- [x] **Geheugen** — snapshots en `truth:"hub"`-waarden over een herstart (`~/.varve-hub/staat.json`); slew_s voor alles behalve de APC (PROTOCOL §12)
- [x] **Altijd aan + netwerk (F5)** — `--lan` met token en mDNS, `installeer` (launchd/systemd), `token` (`docs/NETWERK.md`, PROTOCOL §13)
- [x] **Generale repetitie** — `npm run repetitie`: de hub met de échte koppelingen in headless Chromium, één avond lang (`docs/REPETITIE.md`); in CI met nep-apps
- [x] **av-kern** — lease-koppeling als patch in `koppelingen/av-kern/`, toepassen na 25 okt (incl. ◄/►-fix: right = 96, left = 97)

Klaar als (op jouw Mac):
- [ ] `npm start -- meditatie` start de apps, Chrome-tabs gaan open, beginstand en focus staan; Ctrl-C of het venster sluiten laat geen processen achter
- [ ] LPD8-pad 4 aan/uit → map in `~/Movies/varve-avonden/`; `npm run herhaal -- <map>` meldt "eindstaat klopt"
- [ ] hub herstarten → snapshots zijn er nog
- [ ] `npm start -- --lan` → cockpit op de tablet via het adres uit `node src/cli.js token`
- [ ] `dns-sd -R` en CoreMIDI werken ook onder launchd (`node src/cli.js installeer`)

Gevonden door de repetitie — opgelost in golf 5 (PROTOCOL §14):
- ~~Na een paniek doet LPD8-K1 niets meer~~ → wat een app zelf verandert tijdens of vlak na een paniek (`paniek.naloop_s`, standaard 5) verplaatst de LPD8-pickup niet meer.
- ~~Een LPD8-macro op een keuze stuurt bij elke tik een `zet`~~ → een gelijke keuze/schakelaar gaat niet nog eens (179 → 0).
- Waterschaal `tempo`: app-kant op de PR-tak (tempo continu, CKrebbers/waterschaal#1), hub-kant in golf 5 (de globale adem volgt de adem-app). Helemaal dicht zodra die PR gemerged is.

## Oefenruimte ✓
http://localhost:7700/oefen (ook via "oefenen" in de cockpit): 14 lessen (les 14, glijden zien, kwam erbij in golf 7) met twee oefen-apps, Zon en Zee, die het gewone app-protocol spreken. Elke les controleert wat er echt in de hub gebeurt. De juiste knop licht op de virtuele APC/LPD8 op, en een gesimuleerde leerling haalt in CI alle lessen tegen de echte hub (`test/oefen.test.js`, `test/oefen-ui.test.js`).

Klaar als (op jouw Mac):
- [ ] alle 14 lessen gehaald met de echte APC40 en LPD8

## Golf 5 — klaar voor de eerste echte avond ✓ (gebouwd en getest zonder hardware)
6 onderdelen (bouwer + 2 reviewers + verwerker), plus een beveiligingsreview en een review van de oefenruimte; samengevoegd en opnieuw getest.
- [x] **Kern-fixes** — K1 na paniek, geen dubbele keuze-zets, globale adem volgt de adem-app (PROTOCOL §14)
- [x] **Cockpit** — rode REC met map en looptijd tijdens een opname, opname-meldingen (fout in rood), glijdende parameters tonen hun doel "→ 80%"
- [x] **`npm run check -- [set]`** — alles nalopen vlak vóór een optreden (`docs/CHECK.md`)
- [x] **Draaiboek hardware-avond** — `docs/HARDWARE-AVOND.md`; de F0-proef meet nu ook het hubtoets-akkoord, de loslaat-berichten van de LPD8-pads en LPD8-hotplug
- [x] **Onderzoek volgende koppelingen** — `docs/VOLGENDE-KOPPELINGEN.md` (varve-radio, uurwerk, av-scene-kit, Sediment, td-lab, anbernic-cam, musicgen-video-glitch; volgorde in §9)
- [x] **Beveiliging** — grenzen tegen overvallen zonder token, cockpit alleen same-origin, geen framen, bestandsrechten (PROTOCOL §13, `docs/NETWERK.md`)
- [x] **Oefenruimte** — review verwerkt (herladen, twee tabs, tempo/adem zichtbaar, lang drukken ruimer)
- [ ] Waterschaal: tempo continu op de PR-tak (wacht op Clay's OK om te mergen)

Klaar als (op jouw Mac):
- [ ] `npm run check -- meditatie` geeft alleen ✓ en !
- [ ] F0-proef ook: hubtoets-akkoord (Bank + Track Select, Bank + Shift + Scene) komt netjes binnen; LPD8-pads sturen een loslaat-bericht (lang drukken P5–P8, paniek P1); LPD8 eruit/erin → vanzelf terug met profiel
- [ ] cockpit toont REC tijdens een opname met P4

Open vragen voor Clay (uit golf 5):
- De paniek-naloop geldt ook voor Stop All van de app met focus — goed zo?
- ~~Paniek per app voor TD, Sediment en uurwerk~~ → gebouwd in golf 6 (zie hieronder); wat paniek per app betekent, mag je nog bijstellen.
- varve-radio: het "lek" is geen MIDI maar het overnemen van de zender via Supabase-broadcast; een klein herstel staat klaar in §2.3 (eigen deploy, jouw OK nodig).

## Golf 6 — de driver-apps en de volgende koppelingen ✓ (gebouwd en getest zonder hardware)
5 onderdelen (bouwer + 2 reviewers + verwerker); de hub-delen samengevoegd en opnieuw getest.
- [x] **Paniek voor de driver-apps** — uurwerk volume 0 (`pas_toe +master 0.00`, terug met de trigger `master_terug`), Sediment CC 123 (alle noten uit), Scene Kit noot 42 → master dicht (TD-patch in `koppelingen/av-scene-kit/`, wacht op REGIE; daarna `node tools/genereer-manifesten.mjs`)
- [x] **uurwerk leest terug** — verandert er iets in de uurwerk-tab, dan volgt de hub (cockpit, pickup); `teruglezen` in `config.json`
- [x] **td-lab als driver** — `src/drivers/td.js` over de exec-bridge van td-lab, standaard uit (`apps.td-lab.autostart`); zie `docs/TDLAB.md`
- [ ] **varve-radio: zender-lek dicht** — op de tak `claude/zender-lek` (PR in varve-radio), wacht op jouw OK, deploy en meting
- [ ] **Varve Eye als app op de Mac** — op de tak `claude/varve-hub-koppeling` (PR in anbernic-cam), wacht op jouw OK

Klaar als (op jouw Mac):
- [ ] LPD8-P1 vasthouden: uurwerk wordt stil, Sediment stopt alle noten, (na de TD-patch) de TD-master gaat dicht
- [ ] iets veranderen in de uurwerk-tab → de cockpit volgt binnen een paar seconden
- [ ] td-lab: de testtabel in `docs/TDLAB.md`

## Golf 7 — klaar voor een lange avond ✓ (gebouwd en getest zonder hardware)
4 onderdelen (bouwer + 2 reviewers + verwerker), samengevoegd en opnieuw getest.
- [x] **Spiekbrief** — één A4 liggend per set met wat elke knop doet (`npm run spiekbrief -- <set|alle>`, of `/spiekbrief` in de cockpit; `docs/SPIEKBRIEF.md`). De indeling komt van een echte kern, en een test drukt elke knop op de spiekbrief en kijkt of de kern precies dat doet
- [x] **Duurtest** — een hele avond (±3,5 uur) in een paar minuten: `npm run duurtest -- --minuten 3 --seed 7` (`docs/DUURTEST.md`). Vond en herstelde vier lekken/crashes: apps zonder manifest bleven voor altijd staan, waarden met vreemde ids groeiden, een timer bleef na stop staan, en een crash bij een losgetrokken APC met LEDs in de wachtrij. Een korte versie draait in `npm test`
- [x] **Herstart midden in de set** — valt de hub om (crash, kill -9) of stop je hem per ongeluk: apps krijgen hun eigen slot terug, de focus komt terug, apps van de set draaien door en worden overgenomen (niet dubbel gestart), de opname gaat verder in een nieuwe avond en de afgebroken avond wordt hersteld. `npm start -- <set> --blijf` start de hub na een crash vanzelf opnieuw. Wat je ziet en doet: `docs/HARDWARE-AVOND.md`, "Als de hub omvalt"
- [x] **Afwerking** — `npm run check` controleert ook het teruglezen in `apps/*.json`; de oefenruimte laat zien dat een waarde glijdt (les 14); docs kloppen weer met de code

Klaar als (op jouw Mac):
- [ ] spiekbrief van je set geprint en naast de controllers gelegd; klopt hij met wat je voelt?
- [ ] midden in een set de hub met Ctrl-C stoppen en opnieuw starten: komt alles terug zoals beschreven?

## Golf 8 — niets blijft hangen ✓ (gebouwd en getest zonder hardware)
3 onderdelen, elk in een eigen tak met review, samengevoegd; daarna de duurtest zonder omwegen en opnieuw getest.
- [x] **Tablet verliest wifi met een trigger vast** — de hub laat de trigger los (`trig aan:false`), behalve als een andere cockpit of de hardware (LPD8 P1, Stop All, een APC-pad) hem nog vasthoudt (PROTOCOL §10)
- [x] **Dezelfde toets van twee kanten** (APC én cockpit, of twee cockpits) met een focuswissel ertussen — de eerste app krijgt altijd zijn los, de paniek na Stop All loopt gewoon uit; de eerste los laat de toets los, er blijft niets hangen (PROTOCOL §11)
- [x] **Kabel even los** — de hub kijkt elke 250 ms in de poortlijst, en sluit, opent en initialiseert meteen opnieuw bij een stuurfout (daarna met oplopende pauzes); in het hubvenster één regel per storing: `APC: sturen mislukt — kabel los? de hub probeert opnieuw` (PROTOCOL §16). Met RtMidi op de Mac is een kabel die korter dan 250 ms los is onzichtbaar
- [x] **Duurtest zonder omwegen** — de cockpits drukken op dezelfde toetsen als de hand (ook Stop All), vallen abrupt weg, en de APC en de LPD8 gaan ook heel kort los; voor elk van de drie een invariant die een regressie meldt (`docs/DUURTEST.md`). Seeds 7, 11 en 3, elk 4 minuten echt (±1 uur 47 avond): goed, geen lek, geen geschonden invariant
- [x] **`npm run check`** — ✗ als pad 1 van de LPD8 in het profiel in PC-modus staat (de paniek eindigt dan nooit), ! als dat alleen voor pad 5–8 geldt (geen snapshot), met wat te doen

Klaar als (op jouw Mac):
- [ ] APC en LPD8 kort los (`docs/HARDWARE-AVOND.md`, blok 4): binnen ±2 s weer verbonden en het LED-beeld terug; blijft hij donker, noteer hoe lang de kabel los was

## Golf 9 — speelapparaten: Xboard49 en Maschine MK2 (gebouwd en getest zonder hardware)
De hub opent ook het keyboard (E-MU Xboard49) en de Maschine MK2 en geeft ze door aan de lease-app die speelt (PROTOCOL §17).
- [x] **Protocol** — manifestveld `speelt`, `{t:"midi", dev:"xboard49"|"maschine-mk2"}`, `{t:"led", dev}`, `{t:"scherm"}`; de conformiteitstoets (`node tools/nep-hub.mjs --toets`) toetst ook een app die speelt, `node tools/nep-app.mjs --speelt` is er een voorbeeld van
- [x] **Wie speelt** — de app met APC-focus als die het apparaat speelt, anders de laatst gefocuste die het speelt; een loslaten gaat altijd naar wie het indrukken kreeg (ook na een focuswissel), een apparaat dat wegvalt laat alles los (`src/core/spelers.js`)
- [x] **Xboard49** — alleen de MIDI-ingang, hotplug zoals de LPD8; profiel met de 16 knoppen (tot de proef ze leert: de gok 21–28/31–38) en de schuif (SysEx Master Volume)
- [x] **Maschine MK2 via HID** — node-hid, optioneel (zonder start de hub gewoon); virtuele MIDI-indeling in `docs/MASCHINE.md` (pads 36–51 met velocity en gedunde aftertouch, knoppen op kanaal 1, draaiknoppen en masterwiel relatief); lampjes in APC-kleuren, schermen; "bezet" en "geen invoer" met wat te doen, elke ronde opnieuw proberen
- [x] **`doctor`** — beide apparaten, de NI-programma's die draaien, of er invoer van de Maschine komt (Invoermonitoring)
- [x] **Proef `speelapparaten`** — 21 stappen, doorloopbaar door de gesimuleerde gebruiker; golden test op het logboek (`test/fixtures/synthetisch-speelapparaten.jsonl`)
- [ ] **Varve DJ** — de nep-poorten "Xboard49 (hub)" en "Maschine MK2 (hub)" in `HubMidi` en `speelt` in het manifest: nog niet gebouwd, wacht op jouw OK (`koppelingen/varve-dj/LEESMIJ.md`)

Klaar als (op jouw Mac):
- [ ] `npm install` haalt node-hid binnen; `node src/cli.js doctor` toont onder "Speelapparaten" de Xboard49 en de Maschine (17cc:1140), en "invoer komt binnen"
- [ ] `node src/cli.js proef speelapparaten` loopt door (`docs/HARDWARE-AVOND.md`, blok 8); proef-logboek en `xboard49-profiel.json` gepusht
- [ ] uit de proef bekend: poortnaam van de Xboard, CC's (of NRPN) van de 16 knoppen, aftertouch aan/uit, de schuif als SysEx
- [ ] uit de proef bekend: opent de Maschine met de NI-agents aan (of "bezet")? vraagt macOS om Invoermonitoring? ruisvloer in rust, oriëntatie (linksboven = pad 13), drempels en velocity, `led_max` (127 of 255), twee zones per groepknop, schermen
- [ ] `npm start` + `node tools/nep-app.mjs --speelt`: een pad op de Maschine licht groen op zolang je hem indrukt, het linkerscherm toont een rand en een schuine lijn; Maschine eruit en erin → binnen ±2 s terug
- [ ] (na de Varve-patch) Varve DJ speelt op het keyboard en de pads, ook als av-kern de APC-focus heeft

Keuzes om na te lopen (zeg het als je het anders wilt):
- De Maschine geeft **virtuele MIDI** (geen eigen HID-berichten naar apps): zo gebruikt Varve DJ hem met hetzelfde MIDI-pad als de APC.
- De hubtoets (Bank) doet niets met de speelapparaten: het keyboard speelt door terwijl je focus wisselt.
- De schuif van de Xboard gaat als ruwe SysEx naar de app (niet omgezet naar een CC).

## Golf 10 — de sectie in de globale laag (gebouwd en getest zonder hardware)
Een app kan iets aan `globaal` leveren; eerste groep: de sectie van het nummer (PROTOCOL §18).
- [x] **Protocol** — manifestveld `levert: ["sectie"]`, bericht app → hub `{t:"globaal", waarden}` met `sectie.energie` (0..1), `sectie.label` (tekst) en `sectie.nieuw: true`; validatie in `src/protocol/` (`test/protocol-sectie.test.js`)
- [x] **Hub** — `src/core/bijdragen.js` (puur): bron = de eerste app met `levert` die niet weg is; `sectie.nieuw` naar de apps als teller (mod 16, /16), zodat niemand een klap mist of er een verzint bij herverbinden of in de cockpit (10×/s); bron weg = bevriezen; `beeld.bronnen` (`test/kern-sectie.test.js`)
- [x] **Conformiteitstoets** — `node tools/nep-hub.mjs --toets` stuurt elke app een sectie mee en toetst een leverende app (na het manifest, alleen groepen uit `levert`, hooguit 10×/s, na herverbinden opnieuw zonder `nieuw`); `node tools/nep-app.mjs --sectie` doet het voor
- [x] **Cockpit** — "sectie: drop · 80%" onder Globaal, de bron in de tooltip, een flits bij elke nieuwe sectie
- [ ] **Varve DJ** — de sectie die je hoort op de maatgever naar de hub sturen (achter `?hub=`, `src/control/hub.js`); komt van de coördinator zodra die bron in Varve er is
- [ ] **Beeld-apps** — av-kern, waterschaal, formula-lab reageren op `sectie.*` in `globaal` (elk achter zijn eigen vlag, met jouw OK per repo)

Klaar als (op jouw Mac):
- [ ] `npm start` + `node tools/nep-app.mjs --sectie`: de cockpit toont onder Globaal elke 8 s een andere sectie met een flits; nep-app weg (Ctrl-C) → de laatste sectie blijft staan, de tooltip zegt "geen bron meer"
- [ ] (na de Varve-kant) Varve DJ speelt een nummer: de cockpit volgt intro → opbouw → drop op de tel

Keuzes om na te lopen (zeg het als je het anders wilt):
- **Bevriezen, niet terug naar 0**, als de bron wegvalt: de muziek speelt in het tabblad door als alleen de verbinding hapert. Stopt de muziek echt, dan stuurt de app zelf energie 0.
- **De eerste leverancier wint** (zoals de adem), niet de app met focus: de focus zegt welke app je bedient, niet welke je hoort.

## Volgende
- Hardware-avond 1: volg `docs/HARDWARE-AVOND.md` (F0-proef, oefenruimte, set, opnemen), daarna de koppelings-PR's mergen en een echte avond spelen
- av-kern na 25 okt: patch toepassen, `sets/meditatie.json` op `wacht: "kern"` zetten

## Bekende risico's (gevonden door de duurtest, golf 7 — opgelost in golf 8)
De duurtest oefent ze nu zelf, zonder omwegen, met een invariant per punt (`docs/DUURTEST.md`, "Gevonden en opgelost (golf 8)"); `test/duurtest.test.js` kijkt of de korte avond ze raakt.
- [x] **Tablet-cockpit verliest wifi terwijl hij een trigger vasthoudt** → opgelost in golf 8: de hub laat de trigger los (`src/transports/server.js`, PROTOCOL §10). Bekende grens: een cockpit die netjes `v:0` stuurt terwijl Stop All of P1 dezelfde paniek vasthoudt, beëindigt die paniek meteen (`it.todo` in `test/golf8-cockpit-trigger.test.js`).
- [x] **Dezelfde toets twee keer ingedrukt** (APC én cockpit, of twee cockpits) met een focuswissel ertussen → opgelost in golf 8: de eerste app krijgt zijn los, Stop All loopt uit (`src/core/kern.js`, `invoer`/`#laatLos`, PROTOCOL §11).
- [x] **Kabel korter los dan één hotplug-ronde** → opgelost in golf 8 voor de nep-poort en voor uittrekken langer dan 250 ms; op hardware nog te bevestigen (`src/core/aansluiting.js`, PROTOCOL §16; `docs/HARDWARE-AVOND.md` blok 4, "APC kort los").
- [x] Mislukt sturen naar de APC/LPD8 → opgelost in golf 8: één logregel per storing in het hubvenster (`APC: sturen mislukt — kabel los? de hub probeert opnieuw`, `src/hub.js`).
