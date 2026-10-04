# Hardware-avond — draaiboek

De eerste avond met de echte APC40 mkII en LPD8. Alles in de hub is tot nu toe zonder hardware gebouwd en getest;
vanavond kijken we of de echte controllers doen wat we dachten. Je hoeft niets te weten of te beslissen: volg de
stappen, vink af, en push aan het eind twee bestanden. Daarna maakt Claude er vaste tests van.

**Hoe lang:** ±2 uur in totaal. Je kunt na elk blok stoppen; het belangrijkste is blok 2 (de proef) en blok 6 (pushen).

| Blok | Wat | ±Tijd |
|---|---|---|
| 1 | Voorbereiden | 15 min |
| 2 | De F0-proef: elke knop, elk lampje, vijf open vragen | 35–45 min |
| 3 | Oefenruimte met de echte controllers | 20–30 min |
| 4 | Cockpit en een set (`meditatie`) | 30 min |
| 5 | Opnemen met LPD8-pad 4 | 5 min |
| 6 | Pushen | 5 min |
| 7 | Als iets niet werkt | (naslag) |

---

## 1. Voorbereiden (±15 min)

- [ ] **Bijwerken en installeren.** In de map AV-app-hub:
  ```bash
  git pull
  npm install            # haalt ook @julusian/midi binnen: daarmee praat de hub met USB-MIDI
  ```
  Node 22 is nodig (`node -v`; anders `brew install node`).
- [ ] **Chrome bijwerken** (menu Chrome → Over Google Chrome). Chrome is nodig voor de cockpit, de oefenruimte en de apps.
- [ ] **Sluit alles wat zelf met de APC praat.** Op de Mac mogen meerdere programma's tegelijk naar de APC schrijven;
  dan vechten de lampjes en weet je niet meer wat de hub doet.
  - [ ] Chrome-tabs met Varve DJ of av-kern (zonder `?hub=` in het adres openen die de APC zelf).
  - [ ] Ableton Live.
  - [ ] Logic: haal de APC40 weg als bedieningsoppervlak (Logic Pro → Bedieningsoppervlakken → Configuratie, de APC40 selecteren en verwijderen). Alleen Logic sluiten is ook goed.
  - [ ] Een hub die al draait: een ander Terminal-venster met `npm start` (Ctrl-C), of de hub als dienst als je ooit
    `node src/cli.js installeer` deed. Die zet je voor vanavond uit met `node src/cli.js installeer --weg`, en ná de
    avond weer aan met `node src/cli.js installeer`. (Start je toch per ongeluk een tweede hub, dan noemt de melding
    "poort 7700 is bezet" ook de opdracht die de dienst alleen tijdelijk stopt.)
- [ ] **Voor blok 4 (de set):** de hub-koppeling van MediSynth en Waterschaal staat nog op een eigen tak (de PR's
  wachten op jouw OK). Zet die twee repo's daarop, anders worden ze in de set "niet klaar":
  ```bash
  cd <map van medisynth>  && git fetch && git checkout claude/varve-hub-koppeling
  cd <map van waterschaal> && git fetch && git checkout claude/varve-hub-koppeling
  ```
  (Of keur eerst die twee PR's goed en zet ze op main.)
- [ ] **Sluit de APC40 en de LPD8 aan** via USB, het liefst rechtstreeks op de Mac.
- [ ] **Kijk of de hub ze ziet:**
  ```bash
  node src/cli.js doctor
  ```
  Je wilt zien: MIDI werkt, de APC40 gevonden, de LPD8 gevonden (met model en programma 1), poort 7700 vrij.
  Zie je iets anders, kijk dan in blok 7.
- [ ] *(Optioneel, 2 min, leuk als eerste kennismaking)* `node src/cli.js testpatroon`: een regenboog op de APC en in
  de terminal live wat elke knop stuurt. Ctrl-C zet alles weer uit.
- [ ] Maak het Terminal-venster breed (de proef toont kleurvoorbeelden van 8 vakjes breed).
- [ ] **Spiekbrief printen** (wat doet welke knop, één A4 per set): `npm run spiekbrief -- alle`, open `tools/uitvoer/spiekbrief-alle.html` in Chrome en druk ⌘P (`docs/SPIEKBRIEF.md`).

---

## 2. De F0-proef (±35–45 min)

```bash
node src/cli.js proef
```

De proef praat je door alles heen. Hij laat elke knop en elk lampje een keer werken, stelt vragen, en neemt alles op
in een logboek. Tijdens de proef:

| Toets | Betekent |
|---|---|
| **Enter** | ja / klopt / door |
| **n** + notitie + Enter | klopt niet, bv. `n pad 2-3 werd blauw` |
| **o** + Enter | deze stap overslaan (bv. geen footswitch) |
| **Ctrl-C** | stoppen; wat tot dan toe gemeten is, blijft in het logboek bewaard (behalve `lpd8-profiel.json`: dat komt alleen als de proef tot het einde loopt) |

Wat er gebeurt, stap voor stap:

| # | Stap | Wat je doet | ±Tijd |
|---|---|---|---|
| 1 | Voorbereiding | lezen, Enter | 1 min |
| 2 | Apparaten zoeken | niets: de hub zoekt de APC en de LPD8 | — |
| 3 | Identiteit en LPD8-programma's (V5) | niets: de hub vraagt beide apparaten wie ze zijn en leest de LPD8-programma's | — |
| 4 | Faderstanden bij opstart (V4) | fader 1 omhoog, de rest omlaag, Enter | 1 min |
| 5 | Alle 40 pads | elke pad indrukken; hij wordt groen | 2 min |
| 6 | Scene launch, clip stop, stop all, master | die knoppen indrukken | 1 min |
| 7 | Knoppen per track (5 rijen × 8) | Track Select, nummer, A\|B, S, ● per track | 2 min |
| 8 | Faders en crossfader | elke fader van onder naar boven | 2 min |
| 9 | 16 draaiknoppen met lichtring | elke knop een flink stuk draaien | 2 min |
| 10 | TEMPO en CUE LEVEL (relatief) | beide naar links en rechts | 1 min |
| 11 | Losse knoppen één voor één | de knop drukken die de proef noemt | 3 min |
| 12 | De hubtoets vasthouden + een andere knop | BANK vast + Track Select 3; BANK + SHIFT vast + Scene 2 | 1 min |
| 13 | Footswitch (optioneel) | indrukken, of `o` | — |
| 14 | Nemen de knoppen een waarde van de hub over? (V1) | twee knoppen een klein tikje draaien | 1 min |
| 15 | Het kleurenpalet (128 kleuren in 4 pagina's) | vergelijken met het voorbeeld in de terminal | 3 min |
| 16 | Pulseren, knipperen, one-shot | kijken en vier vragen beantwoorden | 2 min |
| 17 | Volgen animaties de MIDI-clock? (V2) | kijken of het knipperen sneller/langzamer gaat | 2 min |
| 18 | LED veranderen terwijl je een pad vasthoudt (V3) | blauwe pad vasthouden, kijken, loslaten | 1 min |
| 19 | Volledige repaint: snelheid | kijken of alles tegelijk verschijnt | 1 min |
| 20 | USB eruit en erin (hotplug) | APC-kabel eruit en er weer in | 1 min |
| 21 | LPD8: pads en knoppen leren | pad 1–8 en knop 1–8, in volgorde | 2 min |
| 22 | LPD8: herkent de hub alles? | alles nog een keer | 1 min |
| 23 | LPD8: lang drukken (snapshots P5–P8, paniek P1) | pad 8 tot drie tellen vasthouden, pad 5 kort tikken | 1 min |
| 24 | LPD8: pad-lampjes vanuit de hub (V5) | kijken of de pad-lampjes aangaan | 1 min |
| 25 | LPD8: USB eruit en erin (hotplug) | LPD8-kabel eruit en erin, pad 1 en knop 1 | 1 min |
| 26 | Klaar | — | — |

Aan het eind staat er een samenvatting in de terminal, en twee bestanden:

- `proef/<datum-tijd>-f0-hardware.jsonl` — het logboek: alles wat binnenkwam en wat je antwoordde.
- `lpd8-profiel.json` — welke noot en welke CC jouw LPD8 stuurt per pad en knop (alleen als alle 8 pads geleerd zijn).
  De hub leest dit bestand bij elke start.

### De vijf open vragen, in gewone woorden

Dit zijn de dingen die in de handleiding van Akai niet (zeker) staan, en waar de hub op dit moment een gok doet.

**V1 — Neemt een draaiknop de waarde van de hub over?** De draaiknoppen van de APC hebben geen begin en eind; de
lichtring eromheen wordt door de hub getekend. Als je van app wisselt, zet de hub elke ring op de waarde van de nieuwe
app. De vraag is of de knop dan ook echt vanaf díe waarde verder telt. *Waarom het ertoe doet:* zo ja (dat verwachten
we), dan voelt een knop na een appwissel meteen goed. Zo nee, dan moet de hub voor de knoppen hetzelfde doen als voor de
faders (pas meenemen als je langs de oude waarde draait). Dat is één instelling: `ringen_nemen_waarde_over` in
`config.json` (nu `true`). Claude zet hem om als de proef "nee" zegt.

**V2 — Volgt het knipperen het tempo dat de hub stuurt?** De APC kan lampjes zelf laten pulseren en knipperen. De vraag
is of dat op een vaste snelheid gaat of meeloopt met een tempo (MIDI-clock) dat de hub stuurt. *Waarom:* zo ja, dan kan
het knipperen straks op de maat van je tap-tempo (LPD8-pad 2) of op de ademklok lopen.

**V3 — Luistert een pad naar de hub terwijl je hem vasthoudt?** Er is een melding dat de APC een kleurwissel negeert
zolang je een pad indrukt. *Waarom:* zo ja, dan moet de hub de kleur opnieuw sturen zodra je loslaat; anders blijft er
een verkeerde kleur staan na het indrukken.

**V4 — Vertelt de APC bij het opstarten waar de faders staan?** De APC antwoordt op het startbericht van de hub met een
rij getallen. Misschien zijn dat de faderstanden. *Waarom:* zo ja, dan weet de hub vanaf de eerste seconde waar je
faders staan en hoeft het lampje "pak de fader op" (clip-stop knippert) niet te knipperen bij de start.

**V5 — Welke LPD8 heb je en wat staat erin?** mk1 of mk2, wat elk programma stuurt, en of de hub de pad-lampjes kan
aanzetten. *Waarom:* dat bepaalt welke noten de hub verwacht (het profiel) en of we de lampjes van de LPD8 kunnen
gebruiken (bv. pad 4 laten branden tijdens een opname) of dat alles via de cockpit moet.

### Drie extra metingen (wat de hub sinds golf 1 van de hardware vraagt)

- **De hubtoets (stap 12).** Focus wisselen is BANK vasthouden + Track Select; een hub-snapshot bewaren is BANK +
  SHIFT + Scene. Dat werkt alleen als de APC elke knop gewoon doorgeeft terwijl je er een andere vasthoudt. Laat je
  BANK te vroeg los, dan zegt de proef dat en mag je het nog een keer doen.
- **Lang drukken op de LPD8 (stap 23).** Pad 5–8: kort = snapshot laden, langer dan 0,6 s = bewaren. Pad 1 een seconde
  vasthouden = paniek. Dat kan de hub alleen goed zien als de pad bij het *loslaten* meteen iets stuurt (MOMENTARY).
  In de TOGGLE-modus van de LPD8 zet de eerste tik een pad aan en pas de volgende tik weer uit. De hub denkt dan dat
  je de pad al die tijd vasthield: één tik op pad 1 geeft paniek die blijft hangen tot je nog eens tikt, en pad 5–8
  *bewaart* bij de tweede tik (je snapshot wordt overschreven). De proef herkent dat; dan zet je de pads op MOMENTARY
  (zie blok 7).
- **LPD8 eruit en erin (stap 25).** Of de hub de LPD8 na opnieuw aansluiten zelf terugvindt, met het geleerde profiel.

---

## 3. Oefenruimte met de echte controllers (±20–30 min)

```bash
npm start
```

Open **http://localhost:7700/oefen** in Chrome. Sluit de controllers aan *voordat* je de hub start. Dertien korte lessen
leren je de basis met twee oefen-apps, Zon en Zee (alles staat in `docs/OEFENEN.md`).

Let vanavond vooral op wat alleen echte hardware kan laten zien:

- [ ] **Focus (les 2):** zolang je BANK vasthoudt, toont de bovenste rij de apps in hun eigen kleur en pulseert de app met focus; Track Select erbij wisselt tussen Zon en Zee.
- [ ] **Pickup (les 4):** een fader doet pas iets als hij langs de waarde van de app komt; tot dan knippert de clip-stop-lamp van die strip. Voelt dat natuurlijk?
- [ ] **Device-knop (les 5):** loopt de lichtring mee, en springt er niets na een appwissel (dat is V1 in het echt)?
- [ ] **Snapshot (les 10):** pad 8 lang = bewaren, kort = laden.
- [ ] **Paniek (les 11):** pad 1 een seconde vasthouden.
- [ ] Schrijf op wat raar voelt (te traag, verkeerde kleur, knop die niets doet). Dat is net zo waardevol als de proef.

Snapshot 4 en het tempo blijven na de les staan, net als op een echte avond. Ctrl-C stopt de hub.

---

## 4. Cockpit en een set (±30 min)

Eenmalig: vertel de hub waar je repo's staan.

```bash
cp sets/paden.voorbeeld.json sets/paden.json   # en zet daarin je eigen mappen (docs/SETS.md)
```

Dan een hele avond met één commando:

```bash
npm start -- meditatie
```

De hub start MediSynth, Waterschaal, Uurwerk en av-kern, opent ze in Chrome met `?hub=` erachter, zet de beginwaarden
en geeft Waterschaal de focus. MediSynth en Waterschaal praten alleen met de hub als ze op de tak
`claude/varve-hub-koppeling` staan (blok 1).

> **av-kern** gaat wel open, maar praat nog niet met de hub (die koppeling komt na 25 oktober). Klik in av-kern
> **niet** op "Verbind APC40": dan opent av-kern de APC zelf en vechten de lampjes.
 De cockpit staat op **http://localhost:7700**: welke apps er zijn, wat er in focus is, en
een virtuele APC en LPD8 die meelopen met de echte.

- [ ] Wisselen van app: BANK vast + Track Select. Kloppen de kleuren in de bovenste rij (zolang BANK vast is) met de apps?
- [ ] Faders en knoppen op de app met focus; kijk in de cockpit mee.
- [ ] LPD8-knoppen K1–K8 werken op alle apps tegelijk (K2 helderheid, K3 ruimte, …).
- [ ] P2 tappen (tempo), P5–P8 snapshots, P1 paniek.
- [ ] Een app niet klaar? De starter zegt welke en waarom; de rest werkt gewoon. Na 60 s "niet klaar" voor MediSynth of
  Waterschaal: staat die repo op `claude/varve-hub-koppeling` (blok 1)?

Ctrl-C stopt alles wat de set zelf startte, en dan de hub.

---

## 5. Opnemen met LPD8-pad 4 (±5 min)

Terwijl de hub draait (blok 3 of 4):

- [ ] Druk **pad 4**: de opname start. In het hubvenster komt `opname loopt: <map>`.
- [ ] Speel een paar minuten.
- [ ] Druk nog een keer **pad 4**: de opname stopt en er komt een `samenvatting.md` bij.

Die avond staat in `~/Movies/varve-avonden/<datum-tijd>/` (zie `docs/OPNAME.md`) en blijft op je Mac; je kunt hem
later opnieuw afspelen met `npm run herhaal -- <map>`.

*(Optioneel)* Met de hub **uit** neemt `node src/cli.js opname eerste-avond` ruw op wat je controllers sturen, in
`proef/`. Speel vijf minuten vrij (faders, knoppen, BANK-akkoorden, LPD8 lang en kort) en stop met Ctrl-C. Claude kijkt
ernaar. Een vaste test wordt het voorlopig alleen als je LPD8 op het fabrieksprogramma staat (de opname onthoudt nog niet
welk LPD8-profiel er gold); doe het dus gerust, maar het is niet erg als het een keer niet lukt.

---

## 6. Pushen (±5 min)

```bash
git add proef/
git add lpd8-profiel.json      # alleen als dat bestand er is; "did not match" mag je negeren
git status                     # onder "Changes to be committed" moet minstens één proef/…jsonl staan (groen)
git commit -m "proef f0-hardware"
git push
```

Staat er bij `git status` niets groen, dan is er niets om te pushen: kijk of de proef een logboek in `proef/` schreef
(de laatste regel van de proef noemt het pad).

Wat Claude daarmee doet:

- Elk bestand in `proef/` wordt een *golden test*: dezelfde ruwe MIDI moet voortaan altijd hetzelfde betekenen.
  Verandert de hub ooit hoe hij jouw hardware leest, dan valt die test om.
- De antwoorden op V1–V5 en de drie extra metingen gaan naar `STATUS.md`, en waar nodig naar `config.json`
  (bv. `ringen_nemen_waarde_over`) of naar de kern (bv. de kleur opnieuw sturen bij loslaten, als de APC een
  kleurwissel negeert terwijl je de pad vasthoudt).
- `lpd8-profiel.json` wordt het profiel waar de virtuele en echte LPD8 mee getest worden.

Zet een avondmap uit blok 5 **niet** los in `proef/` (de golden test leest elk `.jsonl` daar als proeflog). Wil je dat
Claude er een kijkt, zet hem dan in een eigen submap, bv. `proef/avonden/<datum-tijd>/`, en zeg het erbij.

---

## 7. Als iets niet werkt

**De lampjes van de APC vechten** (flikkeren, verkeerde kleuren, dingen gaan aan die de hub niet aanzette).
*Oorzaak:* een ander programma schrijft ook naar de APC; macOS mengt dat. Meestal een Chrome-tab met Varve DJ of av-kern
*zonder* `?hub=`, av-kern waarin op "Verbind APC40" is geklikt (av-kern heeft nog geen hub-koppeling, zie blok 4),
Ableton, een APC-bedieningsoppervlak in Logic, of twee hubs tegelijk (bv. de proef terwijl de hub als dienst draait).
*Oplossing:* sluit die (blok 1; `node src/cli.js doctor` laat zien of er al een hub draait: "poort 7700 BEZET"; Chrome-tabs,
Ableton en Logic moet je zelf nalopen), en trek daarna de APC
één keer los en weer vast: de hub zet hem binnen ±2 s zelf weer goed (de APC vergeet bij elke herstart zijn modus; de
hub stuurt hem opnieuw en tekent alles opnieuw).

**De hub vindt de APC of de LPD8 niet.** *Oorzaak:* geen MIDI (`npm install` niet gedaan; doctor zegt dan "✗ geen MIDI" met de
reden), of de poortnaam is anders dan verwacht. *Oplossing:* `npm install`; `node src/cli.js doctor` toont de
namen van alle MIDI-poorten. Staat de APC er onder een andere naam, zet dan een stukje van die naam bij
`apparaten.apc40.naam` (of `apparaten.lpd8.naam`) in `config.json`.

**De LPD8 stuurt andere noten** (pads doen niets of het verkeerde, de cockpit ziet ze niet). *Oorzaak:* de LPD8 staat op
een ander programma dan tijdens de proef, of op een andere padmodus (de knoppen linksboven: CC of PROG CHNG in plaats
van de noten-stand). De hub kent alleen wat hij in de proef leerde (`lpd8-profiel.json`). *Oplossing:* zet de LPD8 terug
op het programma en de modus van de proef. Wil je echt een ander programma, draai de proef dan opnieuw en sla alles
behalve de LPD8-stappen over met `o` (dat zijn veel `o`'s; een korte proef alleen voor de LPD8 is een idee voor
later); het nieuwe profiel geldt na een herstart van de hub.

**Paniek blijft hangen na één tik op pad 1, of pad 5–8 doet bij de eerste tik niets en BEWAART bij de tweede tik**
(je snapshot wordt overschreven in plaats van geladen). *Oorzaak:* de pads staan in TOGGLE: de eerste tik zet een pad
"aan", pas de volgende tik zet hem "uit". De hub denkt dan dat je de pad al die tijd vasthield. Stap 23 van de proef
meet dit. *Oplossing:* zet in de LPD8 Editor van Akai de pads op MOMENTARY, schrijf het programma naar de LPD8, en kijk
opnieuw. Hangt de paniek nu: tik pad 1 nog één keer.

**"poort 7700 is bezet".** *Oorzaak:* er draait al een hub (een ander Terminal-venster, of als dienst via `installeer`),
of een ander programma gebruikt 7700. De melding zegt welk commando de dienst stopt. *Oplossing:* stop de andere hub
(Ctrl-C in dat venster, of het commando uit de melding), of start op een andere poort: `npm start -- --poort 7710`
(apps dan met `?hub=ws://localhost:7710`). Wie de poort heeft: `lsof -i :7700`.

**Chrome blokkeert de verbinding met `ws://`** (een app meldt zich niet bij de hub). Er zijn drie echte oorzaken:
- *Het adres mist `?hub=ws://localhost:7700`.* Zonder die vlag werkt de app zoals vroeger en opent hij de APC zelf
  (en dan vechten de lampjes). *Oplossing:* adres met `?hub=…`, of start via een set (die zet het er zelf achter).
- *De app is geopend als bestand* (dubbelklik op een HTML-bestand, het adres begint met `file://`). De hub weigert die
  verbinding; in het hubvenster staat `origin geweigerd: null`. *Oplossing:* open de app via zijn eigen server
  (`http://localhost:<poort>`), zoals de set dat doet.
- *De app komt van een ander adres* dan `localhost`/`127.0.0.1` (bv. `http://<mac>.local:5174`, of een `https://`-site op
  internet). De hub weigert onbekende adressen (`origin geweigerd: …` in het hubvenster), en Chrome houdt een
  `https://`-pagina soms tegen of vraagt toestemming voor je lokale netwerk. *Oplossing:* gebruik de lokale versie op
  `http://localhost:<poort>`; een eigen adres dat je vertrouwt kun je toevoegen aan `server.origins` in `config.json`
  (`docs/NETWERK.md`).

**Een fader doet niets.** Waarschijnlijk geen fout: dat is pickup. De clip-stop-lamp van die strip knippert tot de fader
langs de waarde van de app komt; de cockpit toont waar die waarde staat. Beweeg de fader erlangs.

**Na USB eruit/erin blijven de lampjes uit.** Wacht ±2 seconden (de hub kijkt elke 2 s). Blijft het uit: noteer het
(`n …` in de proef), stop met Ctrl-C en start opnieuw. Het logboek laat zien wat er misging.

**De kleuren in de terminal kloppen niet of je ziet rare tekens** (stap 15). Sommige Terminal-versies tonen geen echte
kleuren. Gebruik iTerm2, of beoordeel op het oog: de vraag is alleen of het *ongeveer* klopt.

**De proef blijft hangen bij een stap.** `o` + Enter slaat de stap over; noteer wat er niet werkte. Ctrl-C stopt de
hele proef; wat tot dan toe gemeten is, staat in het logboek in `proef/` en is net zo goed om te pushen (alleen
`lpd8-profiel.json` komt er dan niet bij; `git add proef/` is genoeg, zie blok 6).

### Als de hub omvalt

De hub kan midden in een set wegvallen: een fout in de hub zelf, of een harde stop (`kill -9`, of Activiteitenweergave →
Forceer stop). **Wat je ziet:** de cockpit toont "geen hub — opnieuw over … s", de APC-lampjes blijven staan zoals ze waren
(maar doen niets meer), en de apps spelen gewoon door: klank en beeld draaien in hun eigen programma, niet in de hub.
In het hubvenster staat bij een fout `De hub viel om door een fout: …` (die regel is handig voor Claude).

**Wat je doet:** start hem opnieuw met precies hetzelfde commando, bv. `npm start -- meditatie`. Binnen ±5 s:

- In het hubvenster staat `De vorige hub stopte niet netjes — herstart: …`. Apps die de set startte en die nog draaien,
  start hij **niet** opnieuw (`draait nog sinds vóór de herstart van de hub`); de beginwaarden van de set zet hij dan
  ook niet (`snapshot …: overgeslagen`): je speelt verder waar je was. De open Chrome-tabs en de cockpit verbinden vanzelf weer.
  Is zo'n app intussen toch gestopt, dan start de hub hem opnieuw (met de beginwaarden van de set: hij begon ook opnieuw).
- Elke app staat weer in **zijn eigen slot met zijn eigen kleur** (BANK vast: de bovenste rij is zoals daarnet), ook als
  de apps in een andere volgorde terugkomen. De **focus** gaat terug naar de app die hem had, als die binnen een minuut
  terug is (en jij intussen niet zelf een andere koos).
- **Niets springt.** De hub weet niet waar je faders en knoppen nu fysiek staan: de clip-stop-lamp knippert tot je de
  fader langs de waarde van de app beweegt, en een LPD8-knop doet pas iets als hij langs de huidige waarde komt.
- **Snapshots** en de onthouden waarden (TD, Sediment, uurwerk) zijn er weer (`~/.varve-hub/staat.json`). Wat je in de
  laatste seconde vóór het omvallen bewaarde, kan ontbreken.
- **Opname (pad 4):** liep die, dan loopt hij meteen door in een **nieuwe** avondmap (de cockpit toont weer REC; het
  lampje van pad 4 op de LPD8 zelf kan uit staan, de hub stuurt de LPD8-lampjes niet). De afgebroken avond blijft
  leesbaar en krijgt een `samenvatting.md` met "afgebroken"; de laatste seconde kan ontbreken.

Stopte je de hub zelf (Ctrl-C, ook per ongeluk, of het Terminal-venster dicht), dan is dat geen omvallen: hij ruimt
netjes op en stopt ook de apps van de set (een lopende opname wordt afgesloten). Een nieuwe start is dan een gewone
nieuwe avond: de apps starten opnieuw met de beginwaarden van de set, de BANK-rij begint weer bij slot 1; de snapshots
blijven. Let dus op met Ctrl-C midden in een set: er is geen "weet je het zeker?".

**Vanzelf opnieuw starten:** met `--blijf` erachter (`npm start -- meditatie --blijf`) start de hub zichzelf na een
crash (een fout of `kill -9`) binnen een seconde opnieuw, met alles hierboven. Valt hij vaker dan 5 keer binnen een minuut
om, dan stopt hij met `de hub viel … keer om … — gestopt`: dan zit er een echte fout in; lees de melding erboven en start
met de hand. Een tikfout in de setnaam meldt hij meteen, zonder opnieuw te proberen. Ctrl-C stopt alles zoals altijd.

**De Mac sliep even:** dan pauzeren hub en apps samen. Bij het wakker worden kan een app in de BANK-rij kort knipperen
(even geen hartslag) of even als weg staan; hij hoort vanzelf terug te komen in zijn eigen slot. Dat is niet met een
echte slaap getest: zie je iets anders, noteer het.

**Na een stroomstoring of een herstart van de Mac** is er niets meer om over te nemen: de hub zegt `… vóór de laatste
herstart van de computer — dit is een gewone start` en start de set gewoon (een afgebroken opname herstelt hij wel).

**Zonder geheugen** (`--zonder-geheugen`) weet de hub na een crash niets: geen herstart, geen doorlopende opname, en
de apps van de set stoppen mee als de hub omvalt.

**Wat de apps zeggen** (hun uitvoer) staat tijdens een set in `~/.varve-hub/uitvoer/<app>.log`, en dat van de start
daarvoor in `<app>.vorige.log` (daar staat wat de app zei rond een crash). Met `--uitvoer` zie je het ook in het
hubvenster. Zo draaien de apps door als de hub wegvalt. Lukt het opnieuw starten niet met "poort 7700 is bezet",
dan draait de oude hub nog half: `lsof -i :7700` laat zien welk proces; stop dat en start opnieuw.
