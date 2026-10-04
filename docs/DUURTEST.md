# Duurtest — een hele avond in een paar minuten

Een optreden duurt uren; de tests en de generale repetitie duren minuten. De duurtest speelt een hele avond na
met de **echte hub** in versneld tempo en kijkt of er onderweg iets groeit dat niet hoort te groeien (geheugen,
Maps, wachtrijen, timers, sockets), of de event-loop het bijhoudt, en of na paniek, wegvallen en terugkomen de
staat nog klopt.

- `tools/duurtest.mjs` — het script (en de functie `draaiDuurtest`, die de test ook gebruikt).
- `test/duurtest.test.js` — een korte versie in CI (drie minuten nep-tijd plus afbouw, seed 7, één opname de hele
  avond, ±10 s echt), de opdrachtregel, gerichte tests voor elk lek dat de duurtest vond, en per punt van golf 8 een
  test dat de korte avond het echt oefent (en de invariant ervan niet geschonden is).
- Rapporten: `tools/uitvoer/duurtest-<datum>-seed<seed>.json` (`tools/uitvoer/` staat in `.gitignore`; een rapport
  dat je bewust meelevert, voeg je toe met `git add -f`).

## Draaien

```bash
node --expose-gc tools/duurtest.mjs --minuten 3 --seed 7
```

| optie | |
|---|---|
| `--minuten 3` | zo lang (echte tijd) spelen; standaard 3 |
| `--nep-minuten 30` | of: tot de nep-klok zo ver is. Dezelfde seed geeft dan dezelfde reeks handelingen op APC en LPD8 op dezelfde nep-tijden, ook op een tragere machine; de tellingen (berichten naar apps, cockpit-zets, rommelberichten) kunnen een fractie verschillen, want wanneer een echte socket opengaat of iets aankomt, bepaalt mee wat er gebeurt |
| `--seed 7` | welke avond: elke seed is een andere, maar dezelfde seed is altijd dezelfde reeks handelingen |
| `--opname doorlopend` | `doorlopend` (standaard): één opname van het begin tot de afbouw, zoals een echte avond; `wisselend`: LPD8 P4 gemiddeld elke 150 s nep (aan, uit, aan, …). Beide trekken hetzelfde toeval |
| `--stap 50` | hoeveel nep-ms de klok per ronde vooruit gaat (groter = sneller, maar grover) |
| `--meet-s 2` | om de hoeveel echte seconden er gemeten wordt |
| `--uit <map>` | waar het JSON-rapport komt (standaard `tools/uitvoer`) |
| `--stil` | geen voortgang, alleen het rapport |
| `--bewaar` | de tijdelijke map (avondmap met opnames, geheugenbestand) niet opruimen; het pad staat in het rapport |

Zonder `--expose-gc` zet het script gc zelf aan (via V8); dat werkt in Node 22, maar `--expose-gc` is de nette
weg. (De korte versie in vitest meet zonder gc en laat V8 met rust: `heap: false`.) Exitcode **0** = goed, **1** =
een lek of een geschonden invariant, **2** = een verkeerde optie (een onbekende optie, een ontbrekende waarde, een
getal dat geen getal of niet groter dan 0 is: het script zegt wat er mis is en geeft een voorbeeld) of de duurtest
zelf crashte.

**Ctrl-C** stopt de avond: de afbouw loopt nog (hub stoppen, tijdelijke map weg) en het rapport van wat er tot dan
gemeten is, komt er met `AFGEBROKEN` erboven. Nog eens Ctrl-C stopt meteen, zonder op te ruimen. Gaat de opbouw of de
afbouw mis, dan worden drivers en hub toch gestopt en verdwijnt de tijdelijke map (tenzij `--bewaar`).

Er is geen hardware, browser of andere repo nodig: alles draait in één Node-proces (CI-veilig).

## Wat er draait

- **De hub zoals `varve-hub start` hem start**: `startHub` (apparaten, kern, server, opname naar een avondmap,
  geheugen naar een bestand), met `config.json` zoals hij is, op één ding na: `avondmap` wijst altijd naar een map
  binnen de tijdelijke map. Ook als je avondmap een absoluut pad is (een extern volume), komen de nep-avonden nooit
  in je echte avondarchief. De drivers via `startDrivers`, precies wat de hub
  zelf doet, maar van buitenaf gestart zodat hun interne structuren te meten zijn: Scene Kit en Sediment (MIDI,
  op virtuele nep-poorten) en uurwerk (HTTP, tegen een nep-brug die ook even weg kan zijn). td-lab staat in
  `config.json` uit en blijft uit.
- **Nep-MIDI**: een nep-APC40 mkII en een nep-LPD8 mk2 (`src/ports/nep.js`); de APC antwoordt op de intro (zoals de
  echte, met een intro-antwoord), de LPD8 op de identiteitsvraag. Een losgetrokken nep-poort gooit bij sturen en meldt
  `levend()` false, ook als hij al terug is (een nieuwe poort met dezelfde naam).
- **Nep-tijd**: een `NepKlok` die in stappen van `--stap` ms vooruit gezet wordt; tussen twee stappen krijgt de
  event-loop één ronde voor de echte WebSockets. Alle hub-timers (hartslag, adem, slew, wachtrij, LED-tempo,
  hotplug, opname, geheugen) lopen dus versneld, eerlijk, want ze lopen allemaal via de `Klok`. Op een gewone
  machine ±×25–30: drie echte minuten zijn anderhalf uur avond. Wat níet versneld is: de pinger van de server
  (15 s echt) en het inhalen van een trage cockpit (50 ms echt) — die lopen op de echte klok en zien dus minder
  "avond" dan de rest.
- **Apps** (`tools/nep-app.mjs`, over echte WebSockets): Formula Lab, Waterschaal, MediSynth, flux en Varve DJ
  met hun echte manifesten (`test/fixtures/manifesten`), de nep-app, en een nep-app met `truth:"hub"`. Hun
  hartslag loopt op de nep-klok. Varve DJ is een lease-app die LEDs terugtekent; Waterschaal zet bij paniek zelf
  zijn volume op 0, zoals de echte.
- **Cockpits** (2 tot 5) die komen en gaan, schuiven, focus kiezen, snapshots bewaren en laden, triggers
  indrukken en loslaten, virtueel op de APC en de LPD8 drukken (soms blijft een toets hangen tot de cockpit
  weggaat; dan laat de hub hem los), en soms een tijd niets lezen (een trage tablet: de hub moet dan overslaan en
  later inhalen). Een cockpit die weggaat, valt abrupt weg (`terminate`, zoals een tablet waarvan de wifi uitvalt):
  niets losgelaten, ook geen ingedrukte trigger. Dat doet de hub (PROTOCOL §10).
- **Eén hand, twee kanten.** De "hand" op de APC drukt nooit een toets in die hij al vasthoudt (dat kan met één hand
  niet). De cockpits drukken virtueel op dezelfde toetsen als de hand, ook op Stop All en op LPD8 P5–P8, ook als de
  hand of een andere cockpit die toets op dat moment vasthoudt (in het rapport: `dubbeledruk`). Voor de hub is dat één
  toets die in of uit is; de eerste los laat hem los, en wisselde de focus ertussen, dan krijgt de eerste app eerst
  zijn los (PROTOCOL §11).

## Wat er gebeurt (gemiddeld, in nep-tijd)

| wat | hoe vaak |
|---|---|
| APC-fader, -knop, -toets met de hand (stapjes van ~15 ms) | elke ¼–½ s |
| focus wisselen met Bank + Track Select | elke 8 s |
| hub-snapshot laden of bewaren (Bank + Scene, Shift erbij) | elke 25 s |
| Stop All ingedrukt houden (0,15–3 s) | elke 40 s |
| LPD8-macroknop draaien | elke 1,5 s |
| LPD8 P2 tap tempo, P3 adem, P5–P8 snapshot kort/lang | elke 30 s, 60 s, 15 s |
| LPD8 P1 paniek vasthouden (kort, of 1,3–5 s) | elke 90 s |
| LPD8 P4: één opname van het begin tot de afbouw (`--opname doorlopend`), of aan/uit (`wisselend`) | eenmaal; of elke 150 s |
| cockpit: zet (een trigger: indrukken en weer los) / focus / snapshot / virtuele toets (1 op 10 Stop All) | elke 0,4 s |
| cockpit erbij of weg; een cockpit 2–12 s traag | elke 20 s; elke 30 s |
| een app: netwerkhapering, herstart (nieuwe inst), stil (geen hartslag), lang weg, of een tweede tab | elke 20 s |
| rommel-app: kapotte JSON, binair, berichten vóór hallo, ongeldige manifesten, onbekende parameters, LED-SysEx, hartslagvloed, een bericht boven 256 kB, abrupt weg, steeds een ander manifest | elke 1,5 s |
| een half afgebouwde app met steeds een andere naam (alleen `hallo`) | elke 45 s |
| APC eruit (1 op 3 keer 0,1–0,25 s, korter dan één tik van de poortlijst; anders 0,25–10 s); LPD8 eruit (idem); uurwerk-brug weg (5–40 s) | elke 5 min; 6,7 min; 3,3 min |
| APC en LPD8 allebei één keer 0,15 s los, vroeg in de avond (zonder toeval, zodat ook de korte run het oefent) | na 40 s en 70 s |

Aan het eind de **afbouw**: wat nog gepland stond afmaken, alles loslaten, alle apps terug en 15 s rust; dan
de staat vergelijken; dan drukt elke cockpit een trigger in en valt abrupt weg; dan alle apps en de rommel weg; dan de
hub stoppen.

## Het rapport lezen

Op stdout (en hetzelfde, plus alle metingen, in de JSON):

- **UITSLAG** — goed, of de lekken en geschonden invarianten met hun nep-tijd.
- **Heap** — `heapUsed` direct na `gc()` (twee keer), min–max over de run. Het oordeel: na het opwarmen (eerste
  20% van de metingen) het **minimum** van het eerste en het laatste derde. Een lek duwt ook het minimum na gc
  omhoog; ruis en pieken niet. Lek = meer dan 6 MB én meer dan 15% gegroeid (de grootste van de twee drempels
  telt; bij een heap van ±13 MB is dat gewoon 6 MB). Alleen meegeteld bij een run met gc.
- **Event-loop-vertraging** — `monitorEventLoopDelay` (p50/p99/max), min de resolutie (5 ms). Let op: in
  versneld tempo doet de hub per echte seconde ±25× het werk van een echte seconde; dit is dus een bovengrens.
  De eigen `gc()` van de meting (`gcMsMax`) zit in de max.
- **Berichten** per echte en per nep-seconde: wat de kern naar apps stuurde (`naarApp`), wat de apps en cockpits
  ontvingen (en hoeveel MB naar de cockpits), invoer van APC en LPD8, wat de hub naar de controllers stuurde,
  rommelberichten, fetch-verzoeken van de uurwerk-driver.
- **Klok-timers en handles** — hoeveel timers er op de nep-klok staan (bij de start, zonder clients, na stoppen:
  moet 0 zijn) en de open handles van het proces (`process.getActiveResourcesInfo()`).
- **Structuren** — per structuur `begin`, `max`, `eind` en `zonder clients`: alle Maps en Sets van de kern
  (apps, verbindingen, slews, routes, padDruk, pickups, paniek, LED-wachtrij, snapshots, …), per app opgeteld
  (waarden, LED-kaart, pickups, ingedrukte triggers, ringknoppen), de wachtrijen naar de APC en LPD8, de opname
  (lopende afsluitingen, buffer in KB), de drivers (verstuurd, interne Maps, timers, open POSTs), en het aantal
  luisteraars op kern, apparaten en opnemer. Bij de opname ook de tellers per app en per soort bericht
  (`opname.naarSleutels`) en per invoerbron (`opname.invoerSleutels`), en de grootte van `gebaren.jsonl` op schijf
  (`opname.bestandKB`: die mag groeien, het is een opname van de hele avond). Een structuur met een vaste grens (bv. snapshots ≤ 99) moet
  daaronder blijven; voor de rest geldt: **groei** = de mediaan in het laatste kwart van de run is anderhalf keer
  die in het tweede kwart, en minstens 50 hoger. Schommelen (slews) en pieken (een wachtrij die net een volle
  repaint heeft op het moment van meten) zijn geen groei; een structuur die gestaag oploopt wel. Open handles
  per soort net zo (minstens 20 hoger).
- **Opname van de hele avond** (bij `doorlopend`) — hoeveel nep-minuten, hoe groot `gebaren.jsonl` en
  `samenvatting.md` werden, en voor hoeveel apps en invoerbronnen er tellers waren.
- **Golf 8 gecontroleerd** — hoe vaak de invarianten van golf 8 echt aan de beurt kwamen (een cockpit die wegviel met
  een trigger vast, Stop All los terwijl niemand hem vasthield, een replug van de APC en de LPD8), en hoeveel logregels
  `sturen mislukt` er per controller kwamen.
- **Acties** — hoe vaak elke soort handeling voorkwam (ook `dubbeledruk`, `cockpit.virtueel.stopall`,
  `cockpit.weg.trigger`, `apc.kortlos`, `lpd8.kortlos`).
- **Hub-meldingen** — het aantal, en de laatste vijf (de laatste dertig staan in de JSON).

### Invarianten

| invariant | wanneer |
|---|---|
| P1 langer dan 1 s vast → de paniek loopt (`globaal.paniek` 1) | 150 ms na het ingaan |
| na loslaten + naloop (`paniek.naloop_s`) + 1 s: paniek voorbij, geen P1-timer, `paniekTot` verlopen; geen Stop All op Infinity; elke app die bij het loslaten verbonden was, hoorde daarna "paniek uit" (een app met een paniek-trigger `trig aan:false`, de rest `globaal paniek 0`) | na elke paniek |
| geen slew loopt meer dan 1 s over zijn eindtijd, en geen slew duurt langer dan 120 s | elke 5 s nep |
| een paniek op Infinity (`appPaniekTot`) hoort alleen bij de app waar de Stop All die nu in is heen ging (`kern.routes`) | elke 5 s nep |
| Stop All los (hand en cockpits) → geen app met `appPaniekTot` Infinity | na elke paniek, als niemand Stop All vasthoudt |
| een cockpit die wegviel met een trigger vast: 1,5 s later staat die trigger in de app uit, tenzij een andere cockpit, LPD8 P1, Stop All of een APC-pad hem nog vasthoudt | na elke cockpit die wegvalt |
| na elke replug: binnen `hotplug_ms` + 300 ms kreeg de nieuwe nep-poort de intro met de modus (APC) of de identiteitsvraag (LPD8), en zijn antwoord bereikte de kern | na elke replug, en in de afbouw |
| hooguit één logregel `sturen mislukt` per keer dat een controller eruit ging | einde |
| na rust: geen slews meer; elke verbonden app heeft precies de waarden die de hub denkt; elke cockpit ziet de focus, status en waarden van de kern | afbouw |
| na rust en zonder cockpits (die net abrupt wegvielen met een trigger vast): in geen app staat nog een trigger aan, geen paniek op Infinity, geen APC-toets meer in | afbouw |
| elke app bewaart alleen waarden van zijn eigen parameters | afbouw |
| de opname van de hele avond (`doorlopend`) loopt tot de afbouw, en sluit daar binnen 30 s nep af met `gebaren.jsonl` en `samenvatting.md` | begin en afbouw |
| zonder clients: alleen de drivers verbonden; routes, padDruk, ingedrukte triggers, LED-wachtrij, slews leeg; geen paniek op Infinity; elke app `weg`; een app zonder manifest is vergeten; precies evenveel luisteraars op de kern en evenveel klok-timers als bij de start (vóór de apps kwamen); geen sockets meer open | afbouw |
| na `hub.stop()`: niets meer op de klok | einde |

Wat de duurtest **niet** van binnen ziet: de Maps in `src/transports/server.js` (welke socket welke app is,
verdrongen insts, wachtende verbindingen, de cockpit-uitzender) zitten in een closure. Die worden indirect
gecontroleerd: sockets dicht (handles), heap, en de kern-kant van elke verbinding.

## Gevonden en opgelost (golf 7)

1. **Apps zonder manifest bleven voor altijd bekend** (`src/core/kern.js`, `verbreek` → `#vergeet`). Een app die
   alleen `hallo` stuurde (een half afgebouwde koppeling, een app die steeds een andere naam kiest, de rommel-app)
   bleef na het verbreken met status `weg` in `kern.apps` staan, met slot, in elk beeld voor de cockpit. Elke
   nieuwe naam = een AppStaat erbij, de hele avond. Nu: zonder manifest wordt hij bij het verbreken vergeten; zijn
   slot komt vrij (een volgende app krijgt het eerst: `#geefSlot` vult een gat vóór een nieuw slot achteraan), had
   hij de focus, dan heeft niemand die. Dat laatste gaat niet via `focus(null)` (een keuze van Clay of de set), zodat
   de kern na een herstart midden in de set (golf-7-herstart, `bewaardFocus`) nog weet wie de focus terug hoort te
   krijgen. Een app mét manifest blijft zoals altijd bekend met status `weg` en zijn waarden. Het contract staat in
   PROTOCOL.md §15.
2. **`waarden` groeide met elke onbekende parameter** (`#zetWaarde`, `#manifest`). Vóór het manifest werd elke
   `zet`/`staat` met een willekeurige id bewaard, en een nieuw manifest liet de waarden van parameters die het
   niet meer had staan. Een app in ontwikkeling (steeds een ander manifest) of een app die rommel stuurt, liet
   `waarden` (en elk beeld) onbeperkt groeien. Nu: vóór het manifest alleen geldige ids, hooguit 128 (zoveel als
   een manifest kan hebben); een nieuw manifest ruimt de waarden (en lopende slews) op van parameters die het niet
   heeft.
3. **Een wachttimer bleef na `hub.stop()` staan** (`src/apparaten.js`, `ApcSessie.zwartEnWacht`). De time-out van
   500 ms werd nooit gewist als de APC op tijd zwart was: na elke stop hield de hub het proces nog 0,5 s in leven.
   `Sessie.stop()` gooit nu ook de wachtrij weg (de poort is dicht, er kan niets meer heen).
4. **De hub viel om als je de APC lostrok terwijl er nog LEDs in de wachtrij stonden** (`src/apparaten.js`). De
   wachtrij stuurt in een timer; een poort waarvan het apparaat net weg is, mag gooien (de nep-poort doet dat, de
   MIDI-driver ving het al af; of RtMidi het doet, hangt van het platform af), terwijl de hotplug-ronde het pas tot
   2 s later ziet. Die uitzondering in een timer stopte het hele proces — midden in een optreden, bij een kabel die
   eruit schiet. Nu: één melding (`fout`, en in het logboek) per storing; de hotplug-ronde ruimt daarna op.

Elk heeft een gerichte test in `test/duurtest.test.js` ("lekken die de duurtest vond") die zonder het herstel faalt.

## Gevonden en opgelost (golf 8)

Drie plekken waar midden in een optreden iets kon blijven hangen. De duurtest omzeilde ze eerst (de cockpit liet zijn
triggers zelf los, hand en cockpits drukten op verschillende toetsen, een controller ging altijd langer dan één
hotplug-ronde los); die omwegen zijn weg, en elk punt heeft nu een invariant die een regressie meldt (zie de tabel
hierboven). Zonder het herstel faalt de duurtest: met seed 7 (3 minuten nep) zonder het loslaten in de server 6
geschonden invarianten (triggers die blijven staan), zonder het herstel in de kern 91 (een paniek op Infinity na Stop All
los), met de hotplug van vóór golf 8 4 (geen intro of identiteitsvraag na een snelle replug; de LPD8 bleef de rest
van de avond doof, zodat ook de opname niet meer te stoppen was). De gerichte tests staan in `test/golf8-*.test.js`; `test/duurtest.test.js` kijkt of de korte avond elk punt
echt raakt.

1. **Een cockpit die abrupt wegvalt terwijl hij een trigger vasthoudt** (wifi van de tablet weg midden in een
   ingedrukte trigger-knop). Gekozen gedrag (`src/transports/server.js`, PROTOCOL §10): de server onthoudt per
   cockpit-socket welke triggers hij met `zet v > 0` indrukte, en laat ze bij het sluiten (ook een fout of geen pong) los
   met `zet v:0` → `trig aan:false`. Niet als iemand anders hem nog vasthoudt: een andere cockpit, of de hardware (LPD8
   P1 op `paniek`, Stop All op de paniek-trigger van die app, een APC-pad); dan laat die hem los. Bekende grens: een
   cockpit die netjes `v:0` stuurt terwijl Stop All of P1 dezelfde paniek vasthoudt, beëindigt die meteen (de kern telt
   de bronnen van een cockpit-trigger niet; `it.todo` in `test/golf8-cockpit-trigger.test.js`). In de duurtest: een
   cockpit valt nu altijd abrupt weg (`terminate`), en in de afbouw drukt elke cockpit eerst nog een trigger in.
2. **Dezelfde toets twee keer ingedrukt zonder los** (dezelfde pad virtueel in de cockpit én op de APC, of in twee
   cockpits), met een focuswissel ertussen. Gekozen gedrag (`src/core/kern.js`, `invoer` en `#laatLos`, PROTOCOL §11):
   een toets is voor de hub in of uit, van hoeveel bronnen ook. Een druk op een toets die al in is: bij dezelfde
   bestemming niets, bij een andere (focus of Bank wisselde) eerst de los naar de eerste (`trig aan:false`, Stop All in
   de naloop, een note-off voor een lease-app). De eerste los laat de toets los; een los op een toets die al los is, gaat
   nergens heen. In de duurtest drukken de cockpits op dezelfde toetsen als de hand, ook Stop All (tellen mee in
   `stopAllVast`) en LPD8 P5–P8.
3. **Een controller die sneller terug is dan één hotplug-ronde** (een kabel die even loszat). Gekozen gedrag
   (`src/core/aansluiting.js`, `src/apparaten.js`, `src/hub.js`, PROTOCOL §16): de hub kijkt elke 250 ms in de
   poortlijst; zegt de poort dat hij niet meer leeft (de nep-poort na een replug) of gooit sturen, dan sluit, opent en
   initialiseert hij hem meteen (APC: modus, ringen, alle LEDs; LPD8: identiteitsvraag), daarna met oplopende pauzes; één
   logregel per storing (`APC: sturen mislukt — kabel los? de hub probeert opnieuw`). Grens: met RtMidi op de Mac meldt
   een poort niets en gooit sturen niet; een kabel die korter dan 250 ms los is, blijft daar onzichtbaar (de hardware-avond
   meet het, `docs/HARDWARE-AVOND.md` blok 4). In de duurtest gaat een controller nu een op de drie keer 0,1–0,25 s los
   (en één keer allebei vroeg in de avond).

## Uitslag na golf 8 (zonder omwegen)

`node --expose-gc tools/duurtest.mjs --minuten 4 --seed <7|11|3>` (4 oktober 2026, Node 22.22, cloud-container met 4
kernen, de drie tegelijk; één opname van de hele avond): elk **4 minuten echt = ±1 uur 47 avond (×26,3–26,6). Goed:
geen lek, geen geschonden invariant.** Daarnaast seeds 5 en 42 (doorlopend) en 11 en 3 (`--opname wisselend`), elk een
uur avond (`--nep-minuten 60`, vier tegelijk): ook goed. Overal 13 klok-timers bij de start en zonder clients, 0 na
stoppen.

| seed | dubbele druk | Stop All (hand / cockpit) | cockpit weg met trigger vast | APC eruit (kort) | LPD8 eruit (kort) | 'sturen mislukt' APC | heap (minimum, groei) |
|---|---|---|---|---|---|---|---|
| 7 | 1 086 | 148 / 236 | 11 (+5 in de afbouw) | 16 (7) | 14 (4) | 2 | 13,7 → 14,4 MB (+0,69) |
| 11 | 1 411 | 117 / 260 | 12 (+3) | 23 (8) | 17 (5) | 3 | 13,8 → 14,4 MB (+0,59) |
| 3 | 1 137 | 151 / 237 | 9 (+2) | 29 (8) | 17 (7) | 6 | 13,8 → 14,4 MB (+0,60) |

Elke replug is gecontroleerd (intro of identiteitsvraag binnen `hotplug_ms` + 300 ms, en het antwoord in de kern), en
de LPD8 gaf nooit een regel `sturen mislukt` (de hub stuurt hem bijna niets; de dode poort wordt bij de volgende tik van
de lijst gezien). Event-loop p99 ±4 ms, max ±63 ms (de eigen `gc()` van de meting tot 32 ms); rss max 122 MB.

## Uitslag van de lange run (golf 7)

`node --expose-gc tools/duurtest.mjs --minuten 8 --seed 7` (4 oktober 2026, Node 22.22, cloud-container met 4
kernen, met de herstellingen hierboven en na de reviews; één opname van de hele avond): **8 minuten echt = 3 uur
38 minuten avond (×27,1). Goed: geen lek, geen geschonden invariant.** Daarnaast seeds 3 en 11 (`--opname
wisselend`) en 5 en 42 (doorlopend), elk een uur avond (`--nep-minuten 60`, vier tegelijk): ook goed, en overal
precies 13 klok-timers bij de start en zonder clients.

| | |
|---|---|
| gespeeld | 52 108 fader-, 42 918 knop- en 26 026 toetsbewegingen op de APC, 1 618 focuswissels, 8 710 LPD8-macro's, 137 keer paniek, 315 keer Stop All, 1 405 snapshots op APC en LPD8 en 3 190 vanuit de cockpit, 16 320 cockpit-zets, 5 647 virtuele toetsen, 303 cockpits erbij en 302 weg (378 keer traag), 105 haperingen, 116 herstarts, 117 keer stil, 105 keer lang weg en 128 keer een tweede tab, 278 half afgebouwde apps, 8 663 rommelacties (31 066 rommelberichten), 42 keer de APC en 33 keer de LPD8 eruit, 65 keer de uurwerk-brug weg |
| opname | één opname van 3 uur 38 minuten nep: `gebaren.jsonl` 241 MB (3,8 miljoen regels), `samenvatting.md` 2,7 kB, netjes afgesloten in de afbouw. De schrijfbuffer bleef onder 38 kB; tellers voor 4 invoerbronnen en 41 apps (de 278 half afgebouwde apps met steeds een andere naam; de tellers per app groeien daarmee, een echte avond heeft er een handvol). Let op: dit is ±68 MB per uur bij een hand die onafgebroken ±135 keer per seconde iets op de APC doet; een echte avond is veel rustiger, maar reken bij een extern volume op tientallen MB per uur |
| berichten | kern → apps 305 per nep-seconde (8 281 per echte seconde); bij de cockpits 13 601 per echte seconde, 7,3 GB in totaal; naar APC en LPD8 1 826 per echte seconde |
| heap na gc | 12,6 MB na 10 s, 13,4 MB na 1 min, 14,1 MB na 3 min, 14,4 MB na 5 min, 14,6 MB na 8 min; oordeel: minimum +0,85 MB, geen lek. Wat er nog bijkomt is begrensd en vult zich langzaam: hub-snapshots (13 → 88 van de 99 nummers, de cockpit kiest er willekeurig één), de LED-kaart van de lease-app (79 → 462 adressen) en door V8 gecompileerde code. De groei per minuut neemt af. rss max 120 MB |
| event-loop | p50 0,2 ms, p99 4,5 ms, max 67 ms (de eigen `gc()` van de meting: tot 22 ms) — bij ±27× het werk van een echte avond per seconde |
| timers en handles | 13 klok-timers bij de start, 35 op het drukste moment, 13 zonder clients, **0** na `hub.stop()`; zonder clients alleen nog de luisterende server-socket open, na stoppen niets |
| structuren | alles vlak of binnen zijn grens: `kern.apps` 10–13 (11 zonder clients: 7 apps, 3 drivers en de rommel-app, die een manifest stuurde), `kern.verbindingen` 3 zonder clients (de drivers), `kern.slews` hooguit 9, routes, padDruk, ingedrukte triggers en LED-wachtrij zonder clients 0, luisteraars op de kern steeds 8, driver-diagnose op de ringbuffer (3 × 256) |

Ter controle, zonder de herstellingen in de kern (`src/core/kern.js` van vóór golf 7, `--nep-minuten 60`): FOUT,
`app.waarden` groeit (mediaan 210 → 324; de rommel-app tot 296 waarden, grens 128) en 86 geschonden invarianten:
290 vreemde waarden bij de rommel-app en elke half afgebouwde app van dat uur nog in de lijst.
