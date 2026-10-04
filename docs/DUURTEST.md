# Duurtest — een hele avond in een paar minuten

Een optreden duurt uren; de tests en de generale repetitie duren minuten. De duurtest speelt een hele avond na
met de **echte hub** in versneld tempo en kijkt of er onderweg iets groeit dat niet hoort te groeien (geheugen,
Maps, wachtrijen, timers, sockets), of de event-loop het bijhoudt, en of na paniek, wegvallen en terugkomen de
staat nog klopt.

- `tools/duurtest.mjs` — het script (en de functie `draaiDuurtest`, die de test ook gebruikt).
- `test/duurtest.test.js` — een korte versie in CI (drie minuten nep-tijd plus afbouw, seed 7, ±10 s echt), plus gerichte tests
  voor elk lek dat de duurtest vond.
- Rapporten: `tools/uitvoer/duurtest-<datum>-seed<seed>.json` (`tools/uitvoer/` staat in `.gitignore`; een rapport
  dat je bewust meelevert, voeg je toe met `git add -f`).

## Draaien

```bash
node --expose-gc tools/duurtest.mjs --minuten 3 --seed 7
```

| optie | |
|---|---|
| `--minuten 3` | zo lang (echte tijd) spelen; standaard 3 |
| `--nep-minuten 30` | of: tot de nep-klok zo ver is (dezelfde seed = precies dezelfde avond, ook op een tragere machine) |
| `--seed 7` | welke avond: elke seed is een andere, maar dezelfde seed is altijd dezelfde reeks handelingen |
| `--stap 50` | hoeveel nep-ms de klok per ronde vooruit gaat (groter = sneller, maar grover) |
| `--meet-s 2` | om de hoeveel echte seconden er gemeten wordt |
| `--uit <map>` | waar het JSON-rapport komt (standaard `tools/uitvoer`) |
| `--stil` | geen voortgang, alleen het rapport |
| `--bewaar` | de tijdelijke map (avondmap met opnames, geheugenbestand) niet opruimen; het pad staat in het rapport |

Zonder `--expose-gc` zet het script gc zelf aan (via V8); dat werkt in Node 22, maar `--expose-gc` is de nette
weg. Exitcode **0** = goed, **1** = een lek of een geschonden invariant, **2** = de duurtest zelf crashte.

Er is geen hardware, browser of andere repo nodig: alles draait in één Node-proces (CI-veilig).

## Wat er draait

- **De hub zoals `varve-hub start` hem start**: `startHub` (apparaten, kern, server, opname naar een avondmap,
  geheugen naar een bestand), met `config.json` zoals hij is. De drivers via `startDrivers`, precies wat de hub
  zelf doet, maar van buitenaf gestart zodat hun interne structuren te meten zijn: Scene Kit en Sediment (MIDI,
  op virtuele nep-poorten) en uurwerk (HTTP, tegen een nep-brug die ook even weg kan zijn). td-lab staat in
  `config.json` uit en blijft uit.
- **Nep-MIDI**: een nep-APC40 mkII en een nep-LPD8 mk2 (`src/ports/nep.js`); de LPD8 antwoordt op de
  identiteitsvraag.
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
  later inhalen). Een cockpit die weggaat, laat eerst zijn triggers los, zoals `ui/cockpit.js` doet als de pagina
  sluit (zie de open punten).
- **Eén hand, één toets.** De hub ziet een virtuele toets en dezelfde fysieke toets als één toets; twee keer
  indrukken zonder loslaten kan met één hand niet. Daarom drukt de "hand" op de APC nooit een toets die hij al
  vasthoudt opnieuw in, drukken de cockpits virtueel alleen op de pads in rij 1–2 (en LPD8 P7, P8) en de hand op
  de rest (en LPD8 P5, P6), en neemt een cockpit geen virtuele toets die een andere cockpit vasthoudt of net
  losliet.

## Wat er gebeurt (gemiddeld, in nep-tijd)

| wat | hoe vaak |
|---|---|
| APC-fader, -knop, -toets met de hand (stapjes van ~15 ms) | elke ¼–½ s |
| focus wisselen met Bank + Track Select | elke 8 s |
| hub-snapshot laden of bewaren (Bank + Scene, Shift erbij) | elke 25 s |
| Stop All ingedrukt houden (0,15–3 s) | elke 40 s |
| LPD8-macroknop draaien | elke 1,5 s |
| LPD8 P2 tap tempo, P3 adem, P5–P6 snapshot kort/lang | elke 30 s, 60 s, 15 s |
| LPD8 P1 paniek vasthouden (kort, of 1,3–5 s) | elke 90 s |
| LPD8 P4 opname aan/uit | elke 150 s |
| cockpit: zet (een trigger: indrukken en weer los) / focus / snapshot / virtuele toets | elke 0,4 s |
| cockpit erbij of weg; een cockpit 2–12 s traag | elke 20 s; elke 30 s |
| een app: netwerkhapering, herstart (nieuwe inst), stil (geen hartslag), lang weg, of een tweede tab | elke 20 s |
| rommel-app: kapotte JSON, binair, berichten vóór hallo, ongeldige manifesten, onbekende parameters, LED-SysEx, hartslagvloed, een bericht boven 256 kB, abrupt weg, steeds een ander manifest | elke 1,5 s |
| een half afgebouwde app met steeds een andere naam (alleen `hallo`) | elke 45 s |
| APC eruit (2,5–10 s, altijd langer dan één hotplug-ronde); LPD8 eruit (idem); uurwerk-brug weg (5–40 s) | elke 5 min; 6,7 min; 3,3 min |

Aan het eind de **afbouw**: wat nog gepland stond afmaken, alles loslaten, alle apps terug en 15 s rust; dan
de staat vergelijken; dan alle apps, cockpits en de rommel weg; dan de hub stoppen.

## Het rapport lezen

Op stdout (en hetzelfde, plus alle metingen, in de JSON):

- **UITSLAG** — goed, of de lekken en geschonden invarianten met hun nep-tijd.
- **Heap** — `heapUsed` direct na `gc()` (twee keer), min–max over de run. Het oordeel: na het opwarmen (eerste
  20% van de metingen) het **minimum** van het eerste en het laatste derde. Een lek duwt ook het minimum na gc
  omhoog; ruis en pieken niet. Lek = meer dan 6 MB of 15% gegroeid. Alleen meegeteld bij een run met gc.
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
  luisteraars op kern, apparaten en opnemer. Een structuur met een vaste grens (bv. snapshots ≤ 99) moet
  daaronder blijven; voor de rest geldt: **groei** = de mediaan in het laatste kwart van de run is anderhalf keer
  die in het tweede kwart, en minstens 50 hoger. Schommelen (slews) en pieken (een wachtrij die net een volle
  repaint heeft op het moment van meten) zijn geen groei; een structuur die gestaag oploopt wel. Open handles
  per soort net zo (minstens 20 hoger).
- **Acties** — hoe vaak elke soort handeling voorkwam.

### Invarianten

| invariant | wanneer |
|---|---|
| P1 langer dan 1 s vast → de paniek loopt (`globaal.paniek` 1) | 150 ms na het ingaan |
| na loslaten + naloop (`paniek.naloop_s`) + 1 s: paniek voorbij, geen P1-timer, `paniekTot` verlopen; geen Stop All op Infinity; elke app die bij het loslaten verbonden was, hoorde daarna "paniek uit" (een app met een paniek-trigger `trig aan:false`, de rest `globaal paniek 0`) | na elke paniek |
| geen slew loopt meer dan 1 s over zijn eindtijd, en geen slew duurt langer dan 120 s | elke 5 s nep |
| na rust: geen slews meer; elke verbonden app heeft precies de waarden die de hub denkt; elke cockpit ziet de focus, status en waarden van de kern | afbouw |
| elke app bewaart alleen waarden van zijn eigen parameters | afbouw |
| zonder clients: alleen de drivers verbonden; routes, padDruk, ingedrukte triggers, LED-wachtrij, slews leeg; elke app `weg`; een app zonder manifest is vergeten; even veel luisteraars en timers als bij de start; geen sockets meer open | afbouw |
| na `hub.stop()`: niets meer op de klok | einde |

Wat de duurtest **niet** van binnen ziet: de Maps in `src/transports/server.js` (welke socket welke app is,
verdrongen insts, wachtende verbindingen, de cockpit-uitzender) zitten in een closure. Die worden indirect
gecontroleerd: sockets dicht (handles), heap, en de kern-kant van elke verbinding.

## Gevonden en opgelost (golf 7)

1. **Apps zonder manifest bleven voor altijd bekend** (`src/core/kern.js`, `verbreek` → `#vergeet`). Een app die
   alleen `hallo` stuurde (een half afgebouwde koppeling, een app die steeds een andere naam kiest, de rommel-app)
   bleef na het verbreken met status `weg` in `kern.apps` staan, met slot, in elk beeld voor de cockpit. Elke
   nieuwe naam = een AppStaat erbij, de hele avond. Nu: zonder manifest wordt hij bij het verbreken vergeten; zijn
   slot komt vrij (een volgende app krijgt het eerst), had hij de focus, dan heeft niemand die. Een app mét
   manifest blijft zoals altijd bekend met status `weg` en zijn waarden.
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

## Open punten (gevonden, niet in deze golf opgelost)

Geen lekken, maar plekken waar iets kan blijven hangen. De duurtest omzeilt ze (zie "Eén hand, één toets" en de
cockpit die zijn triggers loslaat); haal die omweg weg zodra ze opgelost zijn.

1. **Een cockpit die abrupt wegvalt terwijl hij een trigger vasthoudt** (wifi van de tablet weg midden in een
   ingedrukte trigger-knop): de hub laat virtuele toetsen los (§10), maar geen `zet` op een trigger (`v:1`). De
   app houdt `trig aan:true` (bv. de paniek-trigger van Waterschaal) tot iemand hem opnieuw indrukt en loslaat.
   Herstel hoort in `src/transports/server.js`: per cockpit-socket onthouden welke triggers (`zet` met `v > 0` op
   een parameter met `soort:"trigger"`) ingedrukt zijn, en bij sluiten `kern.cockpit({ t:'zet', app, id, v:0 })`.
2. **Dezelfde toets twee keer ingedrukt zonder los** (dezelfde pad virtueel in de cockpit én op de APC, of in twee
   cockpits): de kern houdt per control één route (`kern.routes`); de tweede `druk` overschrijft hem. Wisselt de
   focus ertussen, dan krijgt de eerste app zijn `los` nooit: een trigger blijft aan, en bij Stop All blijft
   `appPaniekTot` op Infinity, de paniek van die app eindigt dan nooit (§14). Na: focus A, Stop All (APC), focus B
   (cockpit), Stop All (cockpit virtueel), twee keer los → A heeft `trig paniek aan:true` en nooit `aan:false`.
   Herstel hoort in `src/core/kern.js` (`invoer`): een `druk` op een control die al een route heeft, stuurt eerst
   de `los` naar die route.
3. **Een controller die sneller terug is dan één hotplug-ronde** (`hotplug_ms`, 2 s): `src/core/aansluiting.js`
   vergelijkt alleen de naam in de poortlijst. Is het apparaat er bij de volgende ronde alweer (een kabel die even
   loszat), dan ziet de hub geen `weg` en geen `verbonden`: geen `ApcSessie.init()`, dus de APC blijft in modus
   0x40 (waar hij na elke replug op terugvalt) en donker, en met de nep-poort hoort de hub het apparaat daarna niet
   meer. Na: verwijderen, 0,5 s later weer toevoegen, 5 s laten lopen → nog steeds één keer `verbonden`, geen `weg`.
   De duurtest trekt een controller daarom altijd langer dan één ronde los. Herstel hoort in de hotplug (bv. een
   poort die meldt dat hij dicht is, of een `fout` bij sturen, zie "Gevonden en opgelost" punt 4, als reden om meteen opnieuw
   te openen en te initialiseren).

## Uitslag van de lange run

`node --expose-gc tools/duurtest.mjs --minuten 8 --seed 7` (4 oktober 2026, Node 22.22, cloud-container met 4
kernen, met de herstellingen hierboven): **8 minuten echt = 3 uur 34 minuten avond (×26,6). Goed: geen lek, geen
geschonden invariant.** Daarnaast seeds 3, 5, 11, 42 en 99, elk anderhalf uur avond: ook goed.

| | |
|---|---|
| gespeeld | 51 052 fader-, 42 110 knop- en 25 545 toetsbewegingen op de APC, 1 595 focuswissels, 8 541 LPD8-macro's, 135 keer paniek, 310 keer Stop All, 86 keer opname aan/uit, 1 383 snapshots op APC en LPD8 en 3 115 vanuit de cockpit, 15 969 cockpit-zets, 5 477 virtuele toetsen, 296 cockpits erbij en 295 weg (366 keer traag), 104 haperingen, 115 herstarts, 116 keer stil, 102 keer lang weg en 125 keer een tweede tab, 275 half afgebouwde apps, 8 507 rommelacties (30 594 rommelberichten), 39 keer de APC en 32 keer de LPD8 eruit, 64 keer de uurwerk-brug weg |
| berichten | kern → apps 306 per nep-seconde (8 129 per echte seconde); bij de cockpits 13 445 per echte seconde, 6,9 GB in totaal; naar APC en LPD8 1 803 per echte seconde |
| heap na gc | 12,6 MB na 10 s, 13,4 MB na 1 min, 14,0 MB na 3 min, 14,4 MB na 5 min, 14,6 MB na 8 min; oordeel: minimum +0,9 MB, geen lek. Wat er nog bijkomt is begrensd en vult zich langzaam: hub-snapshots (19 → 85 van de 99 nummers, de cockpit kiest er willekeurig één), de LED-kaart van de lease-app (136 → 456 adressen) en door V8 gecompileerde code (heap-snapshots na 36 s en 206 s: vooral `code`, verder strings, getallen en objecten van die snapshots). De groei per minuut neemt af. rss max 119 MB |
| event-loop | p50 0,2 ms, p99 4,8 ms, max 75 ms (de eigen `gc()` van de meting: tot 39 ms) — bij ±26× het werk van een echte avond per seconde |
| timers en handles | 13 klok-timers bij de start, 38 op het drukste moment, 13 zonder clients, **0** na `hub.stop()`; zonder clients alleen nog de luisterende server-socket open, na stoppen niets |
| structuren | alles vlak of binnen zijn grens: `kern.apps` 10–15 (11 zonder clients: 7 apps, 3 drivers en de rommel-app, die een manifest stuurde), `kern.verbindingen` 3 zonder clients (de drivers), `kern.slews` hooguit 10, routes, padDruk, ingedrukte triggers en LED-wachtrij zonder clients 0, luisteraars op de kern steeds 8, driver-diagnose op de ringbuffer (3 × 256), opnamebuffer hooguit 36 kB |

Ter controle, zonder de herstellingen in de kern (`src/core/kern.js` van vóór golf 7, `--nep-minuten 60`): FOUT,
`app.waarden` groeit (mediaan 210 → 324; de rommel-app tot 296 waarden, grens 128) en 86 geschonden invarianten:
290 vreemde waarden bij de rommel-app en elke half afgebouwde app van dat uur nog in de lijst.
