# Check voor de avond

```bash
npm run check -- meditatie          # = node src/cli.js check meditatie
npm run check                       # zonder set: alleen de hub, controllers en bestanden
npm run check -- dj --lan           # ook het token voor een tablet
node src/cli.js check dj --json     # voor een script (of: npm run -s check -- dj --json)
```

Voor een script altijd `node src/cli.js check … --json` of `npm run -s check -- … --json`: zonder `-s` schrijft npm
eerst zijn eigen regels (`> varve-hub@… check`) op stdout, en dan is de uitvoer geen JSON meer.

Eén commando, vlak voor een optreden, dat alles naloopt. Per punt één regel:

| Teken | Betekent | |
|---|---|---|
| ✓ | goed | |
| ! | let op, maar speelbaar | met `→` wat je kunt doen als er tijd is |
| ✗ | eerst oplossen | met `→` wat te doen |

Exitcode **0** als er niets ✗ is (alleen ✓ en !), **1** als er minstens één ✗ is, **2** bij een ongeldige
`--poort`. `check` verandert niets: het
opent geen MIDI-poort (alleen de lijst, zoals `doctor`), hernoemt geen kapot geheugen en maakt geen token.

```
varve-hub check — set meditatie

Hub
  ✓ de hub draait op poort 7700 (2 app(s) verbonden)

Controllers
  ✓ APC40 verbonden met de hub (APC40 mkII)
  ✗ de hub ziet de LPD8 niet
      → steek de LPD8 in (USB; de hub vindt hem vanzelf binnen 2 s)

Bestanden
  ✓ LPD8-profiel geleerd (mk2, 2026-10-03)
  ✓ 4 statische manifesten in orde (av-scene-kit, sediment, td-lab, uurwerk)
  ✓ de F0-proef is gedaan (1×, laatst 2026-10-03 22:10)
  ✓ geheugen leesbaar (~/.varve-hub/staat.json)
  ! avondmap ~/Movies/varve-avonden: 1,6 GB vrij (krap)
      → maak liefst een paar GB vrij: ruim marge voor geheugen, logboeken en de dev-servers van de apps

Programma's
  ✓ Chrome aanwezig (/Applications/Google Chrome.app)

Set
  ✓ sets/paden.json aanwezig
  ✓ medisynth: map ~/Projects/medisynth
  ✓ medisynth: node_modules aanwezig
  ✓ medisynth: poort 5175 vrij
  ✗ medisynth: geen hub-koppeling in ~/Projects/medisynth (src/hub.js ontbreekt)
      → de app meldt zich niet bij de hub tot de koppeling erin zit (zie koppelingen/ of de PR): de tak claude/varve-hub-koppeling van medisynth (de PR)
  …

1 × ✗, 1 × ! — los eerst de ✗ op en draai check opnieuw.
```

## Wat er nagegaan wordt

**De hub** — `GET /api/beeld` op de poort uit `config.json` (`poorten.http`, of `--poort N`), op 127.0.0.1; staat
in `config.json` → `server.host` een eigen LAN-adres, dan op dat adres (met het token).
- Draait hij: zijn de APC40 en de LPD8 verbonden (`apparaten` in het beeld)? Niet verbonden = ✗. Het aantal
  verbonden apps telt alleen apps die zich zelf aanmelden; drivers (MIDI, HTTP, TD) staan er apart achter.
- Draait hij niet (niemand op de poort): ! met de startregel (met de set als die bestaat, en `--lan` als je check met
  `--lan` draaide), en dan zoals `doctor`: staan de APC40 en de LPD8 als MIDI-poort in de lijst (naam uit
  `config.json` → `apparaten`)? Niet gevonden, of geen MIDI = ✗.
- Antwoordt er iets anders dan de hub, iets dat niet antwoordt (een vastgelopen hub) of iets dat geen HTTP spreekt:
  ✗ met het `lsof`-commando om te zien wat het is.

**Bestanden van de hub**
- `lpd8-profiel.json`: geleerd = ✓ met het model en de datum van het bestand; ontbreekt of `null` = ! (de hub
  gebruikt de standaardnoten; `npm run proef`); kapot = ✗ (dan start de hub niet) en zonder `pads`/`knoppen` = ✗ (dan
  werkt de LPD8 niet), allebei met `mv lpd8-profiel.json lpd8-profiel.json.oud` of de proef opnieuw.
- De statische manifesten in `apps/` (de driver-apps: Scene Kit, Sediment, td-lab, uurwerk; PROTOCOL.md §2): dezelfde
  controle als de hub doet voor hij de drivers start (`valideerStatisch` in `src/drivers/index.js`), ook van het
  teruglezen (`driver.lees`, of de standaard-patchtaal van uurwerk). Een ongeldig bestand = ✗ per bestand met wat er
  mis is (de hub slaat die driver stil over: de app doet die avond niet mee); allemaal goed = één ✓; geen map
  `apps/` = !.
- De F0-proef: een `proef/<stempel>-f0-hardware.jsonl` (de synthetische testfixture telt niet; opnames in dezelfde
  map worden niet gelezen). Hij telt als gedaan als het logboek de slotregel `samenvatting` heeft; een afgebroken
  proef (Ctrl-C) = !. De tijd is lokale tijd (de stempel in de bestandsnaam is UTC). Nooit gedaan = !.
- Het geheugen (`config.json` → `geheugen.pad`, `$VARVE_HUB_STAAT` gaat voor): afwezig of leesbaar (JSON met `"v": 1`) = ✓, kapot, een onbekende versie
  of onleesbaar = ✗ (de hub begint dan leeg en zet het opzij als `.kapot`), `geheugen.pad` wijst naar een map = ✗,
  een achtergebleven `<pad>.kapot` = !. Geheugen uit = !.
- De avondmap (`config.json` → `avondmap`): een map (een bestand op die plek = ✗), schrijfbaar (bestaat hij nog
  niet, dan de map erboven; ontbreekt die ook = !, kijk het pad na; op een externe schijf onder `/Volumes` of
  `/media` die niet is aangesloten = !), en de vrije ruimte op die schijf: onder 2 GB = !, onder 500 MB = ✗. De
  avondmap zelf is klein (gebaren en een samenvatting, een paar MB); de grenzen zijn ruime marge, want een volle
  schijf breekt ook het geheugen, de logboeken en de dev-servers van de apps.

**Chrome** — macOS: `/Applications/Google Chrome.app` (of in `~/Applications`), anders ✗ (de set opent de apps
met `open -a "Google Chrome"`). Linux: `google-chrome`, `google-chrome-stable`, `chromium` of `chromium-browser` in
`PATH`, anders ! (`xdg-open` opent dan je standaardbrowser).

**Met `--lan`** — het token (`~/.varve-hub/token`): ontbreekt of ongeldig = ✗ (`node src/cli.js token`), leesbaar
voor anderen = ! (`chmod 600` en voor de zekerheid een nieuw token met `node src/cli.js token --nieuw`). De map
`~/.varve-hub` ruimer dan 700 = ! (`chmod 700`).

**Met een set** — dezelfde regels als de starter (docs/SETS.md):
- `sets/paden.json` aanwezig (anders ✗ met het `cp`-commando).
- Per app met een startcommando: de map (`paden.json` → repo, plus `start.map`) bestaat, en waar het commando
  `npm`/`npx`/`node`/`vite` is en `package.json` (dev)dependencies heeft: `node_modules` (en daarin `vite` als die
  erin staat). Anders ✗ met `cd … && npm install`.
- De poort: vrij = ✓. Bezet: via `lsof` wie er luistert. Draait dat proces in de map van de app = ✓ (de starter
  start hem niet opnieuw; paden worden vergeleken na het oplossen van symlinks en zonder slash erachter, op macOS
  zonder hoofdletterverschil); een ander proces = ✗ met pid (`kill …` of een andere poort in `config.json`); niet na
  te gaan (geen `lsof`) = !.
- De hub-koppeling in die checkout:

  | App | Wat er moet zijn | Waar hij vandaan komt |
  |---|---|---|
  | formula-lab | `src/sync/hub.js` | tak `claude/varve-hub-koppeling` (PR) |
  | medisynth | `src/hub.js` | tak `claude/varve-hub-koppeling` (PR) |
  | waterschaal | `'hub'` in `td/waterschaal-lokaal.html` | tak `claude/varve-hub-koppeling` (PR) |
  | varve-dj (youtube-mixer) | `src/control/hub.js` | `koppelingen/varve-dj/` (patch) |
  | av-kern | `src/ui/hub.ts` | `koppelingen/av-kern/` (patch, na 25 okt) |
  | av-scene-kit | `td/td_build_hub.py` | docs/TOUCHDESIGNER.md |
  | flux | niet nagegaan | |

  Ontbreekt hij: "de app meldt zich niet bij de hub tot de koppeling erin zit". Dat is ✗ als de set op de hub wacht
  (standaard), en ! als de set alleen op de poort wacht (av-kern tot 25 okt). Uurwerk, TD-lab en Sediment hebben
  geen eigen koppeling nodig (de hub praat via een driver met ze).
- Een app die al verbonden is met de draaiende hub: één ✓, verder niets (de starter laat hem met rust). Dezelfde
  regel als de starter: de app-id moet exact kloppen (alleen bij `per_monitor`, zoals flux, telt `flux-<monitor>`),
  en heeft de app een poort, dan moet die ook open zijn.
- Een app waar de hub via een eigen driver mee praat (`koppeling` `midi`, `http` of `td` in `config.json`, zoals
  Scene Kit, Sediment, TD-lab en Uurwerk) staat 'actief' zodra de driver er is, ook als TouchDesigner, Logic of de
  brug dicht is. Daar dus nooit die ene ✓: de gewone punten gaan door (map, poort, en voor Scene Kit de !).
- Een app zonder startcommando (`handmatig`, zoals Scene Kit): ! met wat je zelf moet doen.

## Voor scripts en tests

`--json` geeft `{ ok, code, set, hub, punten: [{ groep, naam, status: "ok"|"let"|"fout", teken, uitleg, doen? }] }`.

De namen van de punten (`naam`), per groep:

| Groep | Namen |
|---|---|
| `hub` | `hub` |
| `apparaten` | `apc40`, `lpd8`, `midi` (alleen als MIDI zelf niet werkt) |
| `bestanden` | `lpd8-profiel`, `apps` (of per ongeldig bestand `apps/<bestand>`), `proef`, `geheugen`, `geheugen-kapot`, `avondmap` |
| `programma` | `chrome` |
| `netwerk` (met `--lan`) | `token`, `token-map` |
| `set` | `set`, `paden`, en per app `<app>.hub`, `<app>.map`, `<app>.node_modules`, `<app>.handmatig`, `<app>.poort`, `<app>.koppeling` |

In code: `check()` uit `src/check/index.js`. Alles wat de buitenwereld raakt is injecteerbaar: `fs`, `fetch`,
`spawn` (voor `lsof`), `platform`, `thuis`, `env`, `poortOpen`, `laadMidi`, de klok (time-outs) en de paden van
de hub-map, de sets en `paden.json`. De tests (`test/check.test.js`) raken de echte thuismap nooit.
