# Generale repetitie — alles samen

Eén avond naspelen met de hub en de **echte** app-koppelingen: Formula Lab, Waterschaal, MediSynth, flux en
Varve DJ. Niet "werkt elke koppeling op zichzelf" (dat doet `node tools/nep-hub.mjs --toets` per app), maar:
komt elke bediening bij de juiste app aan als alles tegelijk draait, hoe snel, en gaat er onderweg iets stuk?

- `tools/repetitie.mjs` — het script (lokaal, niet in CI).
- `tools/repetitie-avond.mjs` — het draaiboek en de metingen, los van hoe de apps draaien.
- `tools/repetitie-flux.py` — de echte flux, onveranderd, met een meetlat eromheen.
- `test/repetitie.test.js` — hetzelfde draaiboek in CI, met nep-apps die de echte manifesten sturen
  (`test/fixtures/manifesten/<app>.json`).
- Rapporten: `tools/uitvoer/repetitie-<datum>.md` en `.json` (en een schermafdruk van de cockpit).

## Draaien

```bash
npm ci                                   # playwright-core en ws zitten al in de devDependencies
node tools/repetitie.mjs                 # hub + vijf apps + Chromium, ±1,5 minuut
```

Nodig: Node 22, Python 3, een Chromium (`$CHROMIUM`, anders `/opt/pw-browsers/chromium`, anders kiest
playwright-core zelf), en de vijf repo's met hun koppeling:

| app | repo (config.json → `apps.<id>.repo`) | tak | hoe hij draait |
|---|---|---|---|
| formula-lab | `formula-lab` | `claude/varve-hub-koppeling` | Vite-dev-server op `apps.formula-lab.poort`, vaste formule |
| waterschaal | `waterschaal` | `claude/varve-hub-koppeling` | `python3 -m http.server` op `apps.waterschaal.poort`, `td/waterschaal-lokaal.html` |
| medisynth | `medisynth` | `claude/varve-hub-koppeling` | Vite-dev-server op `apps.medisynth.poort`, met `?debug` en één klik (start de klank) |
| flux | `flux-screensaver` | `claude/varve-hub-koppeling` | pseudo-terminal (`pty.spawn`), eigen lege `XDG_CONFIG_HOME` |
| varve-dj | `youtube-mixer` | `origin/main` + `koppelingen/varve-dj/*.patch` | eigen server op `apps.varve-dj.poort`, tijdelijke database |

De paden komen uit hetzelfde bestand als de sets (`docs/SETS.md`): **`sets/paden.json`** (niet in git), of
`$VARVE_HUB_PADEN`, of `--paden <bestand>`. Sleutel = repo-naam, `~` = thuismap:

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
repo's naast deze repo. **Varve DJ wordt nooit in jouw map veranderd**: het script maakt een tijdelijke
`git worktree` van `youtube-mixer` op `origin/main`, past de patches toe en ruimt hem na afloop weer op
(er wordt niets gecommit of gepusht). Heb je al een checkout mét de patch, zet die dan onder de sleutel
`"varve-dj"`.

Opties:

| optie | |
|---|---|
| `--uit <map>` | waar het rapport komt (standaard `tools/uitvoer`) |
| `--zonder flux,medisynth` | apps overslaan |
| `--herstart formula-lab,varve-dj,flux` | welke apps halverwege herstarten (standaard deze drie; de 2e, 4e, … mét focus) |
| `--hub-poort 7799` | als er al een hub op `poorten.http` draait |
| `--fixtures` | de manifesten die de apps echt stuurden vastleggen in `test/fixtures/manifesten/` |
| `--zichtbaar` | Chromium met vensters |

Poorten komen uit `config.json` (huisregel 6). Is er een bezet, dan stopt het script met een melding.

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
| herstart | pagina herladen / flux stoppen (SIGTERM) en opnieuw | nieuwe `inst`, zelfde slot, focus blijft, geen dubbele app, bediening werkt weer; met focus: `{focus aan}` opnieuw, lease-LEDs opnieuw |
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
  het ontving (zelfde inhoud, eerst-in-eerst-uit per app). p50/p95/max per stap en per app, en apart "alleen
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
masterfader en tekent LEDs bij focus, zoals de echte. Elke stap is een eigen test.

Een koppeling veranderd (nieuwe parameter, andere rol)? Draai `node tools/repetitie.mjs --fixtures` en commit de
nieuwe `test/fixtures/manifesten/*.json` mee; de test speelt dan de avond met het nieuwe manifest.

## Wat de repetitie (nog) niet doet

- Geen echte hardware en geen echte RtMidi: de controllers zijn `NepSysteem`. Wat de APC/LPD8 echt doen, staat in `proef/`.
- Geen klank of beeld beoordeeld: alleen wat de app zegt dat hij doet.
- TouchDesigner, Logic/Sediment, uurwerk en av-kern doen niet mee (drivers staan uit).
