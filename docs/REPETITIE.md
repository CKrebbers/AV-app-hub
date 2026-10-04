# Generale repetitie — alles samen

Eén avond naspelen met de hub en de **echte** app-koppelingen: Formula Lab, Waterschaal, MediSynth, flux en
Varve DJ. Niet "werkt elke koppeling op zichzelf" (dat doet `node tools/nep-hub.mjs --toets` per app), maar:
komt elke bediening bij de juiste app aan als alles tegelijk draait, hoe snel, en gaat er onderweg iets stuk?

- `tools/repetitie.mjs` — het script (lokaal, niet in CI).
- `tools/repetitie-avond.mjs` — het draaiboek en de metingen, los van hoe de apps draaien.
- `tools/repetitie-flux.py` — de echte flux, onveranderd, met een meetlat eromheen.
- `test/repetitie.test.js` — hetzelfde draaiboek in CI, met nep-apps die de echte manifesten sturen
  (`test/fixtures/manifesten/<app>.json`).
- `tools/repetitie-proces.mjs` — processen starten en weer opruimen (ook bij Ctrl-C), los te toetsen
  (`test/repetitie-script.test.js`).
- Rapporten: `tools/uitvoer/repetitie-<datum>.md` en `.json` (en een schermafdruk van de cockpit). `tools/uitvoer/`
  staat in `.gitignore`; een rapport dat je bewust meelevert, voeg je toe met `git add -f`.

## Draaien

```bash
npm ci                                   # ws (dependency) en playwright-core (devDependency)
npx playwright-core install chromium     # eenmalig: playwright-core downloadt zelf geen browser
npm run repetitie                        # = node tools/repetitie.mjs: hub + vijf apps + Chromium, ±1,5 minuut
```

Nodig:

- Node 22 en Python 3.
- Een Chromium: `$CHROMIUM` (of `$PW_CHROMIUM`), anders `/opt/pw-browsers/chromium`, anders de Chromium die
  `npx playwright-core install chromium` heeft neergezet. Op de Mac kan ook je eigen Chrome:
  `CHROMIUM="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run repetitie`.
  Zonder browser stopt het script met precies deze twee opties.
- `npm install` in **formula-lab** en **medisynth** (ze draaien op hun eigen Vite-dev-server; formula-lab heeft
  ook `lz-string` nodig). Ontbreekt `node_modules`, dan zegt het script dat meteen.
- flux draait normaal op de Omarchy-machine, niet op de Mac: staat hij hier niet, gebruik dan `--zonder flux`.
- De vijf repo's met hun koppeling:

| app | repo (config.json → `apps.<id>.repo`) | tak | hoe hij draait |
|---|---|---|---|
| formula-lab | `formula-lab` | `claude/varve-hub-koppeling` | Vite-dev-server op `apps.formula-lab.poort`, vaste formule |
| waterschaal | `waterschaal` | `claude/varve-hub-koppeling` | `python3 -m http.server` op `apps.waterschaal.poort`, `td/waterschaal-lokaal.html` |
| medisynth | `medisynth` | `claude/varve-hub-koppeling` | Vite-dev-server op `apps.medisynth.poort`, met `?debug` en één klik (start de klank) |
| flux | `flux-screensaver` | `claude/varve-hub-koppeling` | pseudo-terminal (`pty.spawn`), eigen lege `XDG_CONFIG_HOME` |
| varve-dj | `youtube-mixer` | `origin/main` + `koppelingen/varve-dj/*.patch` | eigen server op `apps.varve-dj.poort`, tijdelijke database |

De paden komen uit **`sets/paden.json`** (hetzelfde bestand dat de sets gebruiken; `sets/.gitignore` houdt het
uit git, je persoonlijke paden worden dus niet per ongeluk gecommit), of `$VARVE_HUB_PADEN`, of
`--paden <bestand>`. Een bestand dat je zelf opgeeft (`--paden`, `$VARVE_HUB_PADEN`) moet bestaan en geldige JSON
zijn, anders stopt het script. Sleutel = repo-naam uit `config.json` → `apps.<id>.repo`, `~` = thuismap:

```json
{
  "formula-lab": "~/Projects/formula-lab",
  "waterschaal": "~/Projects/waterschaal",
  "medisynth": "~/Projects/medisynth",
  "flux-screensaver": "~/Projects/flux-screensaver",
  "youtube-mixer": "~/Desktop/youtube-mixer"
}
```

Per app overschrijven kan met `$REPETITIE_<APP>` (`REPETITIE_FORMULA_LAB=…`). Zonder iets zoekt het script de
repo's naast deze repo. **Varve DJ: je eigen checkout blijft zoals hij is.** Het script maakt een tijdelijke
`git worktree` van `youtube-mixer` op `origin/main` (in `/tmp`), past de patches uit `koppelingen/varve-dj/` toe
en ruimt hem na afloop weer op. Er wordt niets gecommit of gepusht; alleen git's eigen administratie
(`.git/worktrees`) krijgt zolang een regel. Het script doet geen `git fetch`: de patches zijn gemaakt op
`99c7fa2` (`koppelingen/varve-dj/LEESMIJ.md`). Past een patch niet op jouw `origin/main`, dan zegt het script dat;
doe dan `git fetch` in youtube-mixer, of zet onder de sleutel `"varve-dj"` een checkout die de patch al heeft.

Opties:

| optie | |
|---|---|
| `--paden <bestand>` | paden van de repo's (anders `$VARVE_HUB_PADEN`, anders `sets/paden.json`) |
| `--uit <map>` | waar het rapport komt (standaard `tools/uitvoer`) |
| `--zonder flux,medisynth` | apps overslaan (een onbekende naam geeft een waarschuwing) |
| `--herstart formula-lab,varve-dj,flux` | welke apps halverwege herstarten (standaard deze drie; de 2e, 4e, … mét focus) |
| `--hub-poort 7799` | als er al een hub op `poorten.http` draait (`0`: een vrije poort) |
| `--max-duur 300` | na zoveel seconden breekt de waakhond de repetitie af (standaard 300), met een gedeeltelijk rapport |
| `--fixtures` | de manifesten die de apps echt stuurden vastleggen in `test/fixtures/manifesten/` |
| `--zichtbaar` | Chromium met vensters |

Poorten komen uit `config.json` (huisregel 6). Is er een bezet, dan stopt het script met een melding die zegt
wat je kunt doen (`lsof -i :<poort>`, of `--zonder <app>`).

### Afbreken en opruimen

Ctrl-C (of SIGTERM, of de terminal dicht) stopt de repetitie netjes: Chromium, de hub, de app-servers, flux, de
tijdelijke Varve DJ-worktree en `/tmp/repetitie-*` worden opgeruimd, en wat al gespeeld is komt in een
gedeeltelijk rapport. Hetzelfde bij een onverwachte fout en na `--max-duur`. Een tweede Ctrl-C stopt meteen,
zonder opruimen. Teruglezen uit een app-pagina mag hoogstens 2 s duren: een app die vastloopt, telt als
"niet uit te lezen" (en als console-fout `[repetitie] teruglezen duurde langer…`) in plaats van de avond stil te
zetten.

Bleef er toch iets achter (bv. na `kill -9`): stop de servers (`lsof -i :5174`, `:5175`, `:8080`, enz.), ruim in
youtube-mixer de worktree-administratie op met `git worktree prune`, en verwijder `/tmp/repetitie-*`.

## Wat er gebeurt

De hub draait als geheel (`startHub`: apparaten, kern, server, cockpit) met `NepSysteem`: een nep-APC40 mkII
en een nep-LPD8 mk2 die zich als mk2 meldt. Het draaiboek stuurt echte MIDI-bytes in die poorten, precies
wat de hardware zou sturen. Drivers (MIDI, HTTP) staan uit; die horen niet bij deze vijf apps.

| stap | wat | gecontroleerd |
|---|---|---|
| opkomst | alle apps verbinden | elke app `actief`, elk een eigen slot |
| focus | Bank + Track Select 1…5 | focus wisselt, `{focus aan}` naar de nieuwe, `{focus aan:false}` naar de vorige |
| bediening per app | fader, device-knop, een pad, Scene 1 (lease: masterfader, knop, pad als ruwe MIDI) | de zet/trig/scene komt aan (als laatste waarde), de app leest het zelf terug, **geen andere app** krijgt iets; lease: LEDs van de app bereiken de APC en de app meldt master terug |
| LPD8-macro's | K1–K8 tegelijk naar een doel (met pickup, slew) | elke app met die rol eindigt op het doel en leest het terug; iedereen krijgt `globaal` |
| verder draaien | elke knop twee tikjes verder | de knoppen blijven gevangen (niets maakt de pickup los) |
| snapshot | P5 lang (bewaren), K2/K6/fader veranderen, P5 kort (laden) | elke veranderde waarde komt terug met `bron:"snapshot"` en de app leest hem terug |
| paniek | P1 1,3 s vasthouden, loslaten, dan K1 weer opendraaien | `trig paniek` aan/uit voor wie hem heeft, `globaal paniek` 1/0 voor iedereen; waterschaal: volume 0; Varve DJ: beeld zwart en weer terug; K1 werkt daarna meteen weer |
| herstart | pagina herladen / flux stoppen (SIGTERM) en opnieuw | nieuwe `inst`, zelfde slot, focus blijft, geen dubbele app; de fader wacht eerst op pickup (een stukje schuiven zonder de app-waarde te kruisen geeft géén zet), daarna werkt hij weer; met focus: `{focus aan}` opnieuw, lease-LEDs opnieuw |
| eindstand | — | hub en app zijn het eens over elke waarde die de app laat lezen |
| cockpit | de cockpit in Chromium | toont alle apps, is verbonden, focus kiezen vanuit de cockpit werkt, geen console-fouten |
| afsluiting | 2 s rust | iedereen `actief`, niemand viel onverwacht `stil`/`weg` |

### Hoe er gemeten wordt

- **Wat de app ontving**: in elke pagina zit een WebSocket-spion (`addInitScript`) die elk bericht van en naar de
  hub met de wandklok van de pagina meldt; voor flux logt `tools/repetitie-flux.py` hetzelfde vanuit Python.
  Het logboek loopt door over een herstart heen.
- **Wat de app zelf vindt** (terugleespunt): Formula Lab de schuiven, Waterschaal `P` (de klankschuiven),
  MediSynth de doelen van zijn glijders (`window.medisynth`, alleen met `?debug`), Varve DJ `midi.read()`, flux
  de opties die hij werkelijk toepast. Wat niet te lezen is (MediSynth `ruimte`, Waterschaal `druk`/`draai`),
  wordt alleen op aankomst gecontroleerd.
- **Latency hub→app**: elk bericht dat de kern verstuurt (`naarApp`) wordt gekoppeld aan het moment dat de app
  het ontving: zelfde inhoud, en in de volgorde van de verbinding (per app één geordende WebSocket; wat
  verloren gaat, valt er alleen tussenuit). Een gelijk bericht dat later wél aankomt (`globaal`, een herhaalde
  zet), krijgt zo niet de ontvangst van een eerder verloren bericht. Grens: gaat een bericht verloren en is het
  eerstvolgende bericht dat aankomt precies gelijk, zonder iets anders ertussen, dan telt het eerste als
  aangekomen en het tweede als verloren (de latency van dat ene bericht is dan te hoog). p50/p95/max per stap en per app, en apart "alleen
  bediening" (zonder de `globaal`-adem die 10×/s naar iedereen gaat). De klokken zijn de wandklok van Node,
  Chromium en Python op dezelfde machine: verschillen onder ±0,5 ms zijn ruis. Het tijdstip van de hub wordt
  genomen direct ná `stuur()`, dus de gemeten latency is een fractie te laag.
- **Niet aangekomen**: verstuurd maar nooit ontvangen, per stap (tijdens een herstart is dat normaal).
- **Herhaalde zets**: een `zet` met precies dezelfde waarde als de vorige voor die parameter — werk voor de app
  zonder verandering.
- **Console-fouten** per app, met de URL erbij (een 404 op `favicon.ico` is ruis).
- **Opmerkingen**: geen fout, wel iets dat een besluit vraagt (bv. apps met dezelfde LPD8-rol die na een
  herstart of paniek uiteenlopen). Ze tellen als geslaagd en staan apart in het rapport.

## In CI

`test/repetitie.test.js` speelt hetzelfde draaiboek tegen de hele hub (`startHub`, echte WebSockets) met een
`NepKlok`: de avond duurt in nep-tijd ruim een minuut, echt een paar seconden. De apps zijn `NepApp`s
(`tools/nep-app.mjs`) die de vastgelegde manifesten en beginstaat sturen; de Varve DJ-nep zet `master` bij de
masterfader en tekent LEDs bij focus, zoals de echte; de Waterschaal-nep zet bij paniek zijn volume op 0 en
meldt dat, zoals de echte. Elke stap is een eigen test.

Een bekend probleem in de hub staat in `BEKEND` bovenin de test: die controle telt niet mee in de stap, maar heeft
een eigen `it.fails`. Zolang het probleem er is, is de test groen; wordt de hub gerepareerd, dan slaagt de
controle en meldt vitest dat het `it.fails` niet meer faalt. Haal de regel dan uit `BEKEND`. Op dit moment is `BEKEND`
leeg (de laatste, "K1 na paniek", is in golf 5 opgelost).

Een koppeling veranderd (nieuwe parameter, andere rol)? Draai `node tools/repetitie.mjs --fixtures` en commit de
nieuwe `test/fixtures/manifesten/*.json` mee; de test speelt dan de avond met het nieuwe manifest.

## Gevonden en nog open

- **Waterschaal: hub en app oneens over `tempo`** (koppeling of terugleesformule, nog uit te zoeken). Na de avond
  kent de hub `tempo` 0,709, de app leest 0,667 terug. Repro: `npm run repetitie`, stap eindstand.

## Gevonden en opgelost

- **K1 deed niets meer na paniek** (opgelost in golf 5, PROTOCOL §14). Waterschaal zet bij paniek zijn volume op 0
  en meldt dat terug; de pickup van de LPD8 volgde de *eerste* app met de rol, dus K1 (op 0,283) deed daarna voor
  álle apps met `macro.intensiteit` niets meer. Nu verplaatst wat een app zelf verandert tijdens de paniek (en
  `paniek.naloop_s`, standaard 5 s, daarna) het pickup-doel van een LPD8-macroknop niet: de hub kent volume 0, maar
  de eerste tik van K1 zet Waterschaal en MediSynth weer. In CI: "na de paniek doen K1 en de apps weer mee" in
  `test/repetitie.test.js` (was een `it.fails` in `BEKEND`).
- **Dubbele zets bij een keuze** (opgelost in golf 5, PROTOCOL §14). Een LPD8-macro op een keuze stuurde bij elke
  knoptik een `zet`, ook als de optie niet veranderde: 186 zets naar formula-lab `palette`, 179 identiek (flux
  `palet` net zo). Nu gaat een keuze of schakelaar die al op die stand staat niet nog eens naar de app (replay wel).
  In CI: "een keuze krijgt nooit dezelfde zet nog eens" (kolom "herhaalde zets" in het rapport: `palette` en
  `palet` staan er niet meer in).

## Wat de repetitie (nog) niet doet

- Geen echte hardware en geen echte RtMidi: de controllers zijn `NepSysteem`. Wat de APC/LPD8 echt doen, staat in `proef/`.
- Geen klank of beeld beoordeeld: alleen wat de app zegt dat hij doet.
- TouchDesigner, Logic/Sediment, uurwerk en av-kern doen niet mee (drivers staan uit).
