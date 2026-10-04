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

## Volgende
- Hardware-avond 1: volg `docs/HARDWARE-AVOND.md` (F0-proef, oefenruimte, set, opnemen), daarna de koppelings-PR's mergen en een echte avond spelen
- av-kern na 25 okt: patch toepassen, `sets/meditatie.json` op `wacht: "kern"` zetten

## Bekende risico's (gevonden door de duurtest, golf 7 — werk voor de volgende golf)
De duurtest (`docs/DUURTEST.md`, "Open punten") omzeilt ze bewust, dus hij meldt ze niet; elk heeft een `it.todo` in `test/duurtest.test.js`.
- [ ] **Tablet-cockpit verliest wifi terwijl hij een trigger vasthoudt**: de app houdt `trig aan:true` (bv. de paniek-trigger van Waterschaal: volume blijft 0) tot iemand hem opnieuw indrukt en loslaat. Herstel in `src/transports/server.js` (ingedrukte triggers per cockpit-socket, bij sluiten loslaten).
- [ ] **Dezelfde toets twee keer ingedrukt** (APC én cockpit, of twee cockpits) met een focuswissel ertussen: de eerste app krijgt zijn `los` nooit; bij Stop All eindigt de paniek van die app niet. Herstel in `src/core/kern.js` (`invoer`).
- [ ] **Kabel korter los dan één hotplug-ronde** (2 s): de hub ziet geen `weg`/`verbonden`, de APC blijft donker in modus 0x40 en de hub hoort hem niet meer. Herstel in de hotplug (`src/core/aansluiting.js`).
- [ ] Mislukt sturen naar de APC/LPD8 (`fout` op de apparaten) komt nog nergens in beeld: `src/hub.js` luistert er niet naar. Eén logregel met advies ("APC: sturen mislukt — kabel los? de hub probeert opnieuw").
