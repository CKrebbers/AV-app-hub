# Check voor de avond

```bash
npm run check -- meditatie          # = node src/cli.js check meditatie
npm run check                       # zonder set: alleen de hub, controllers en bestanden
npm run check -- dj --lan           # ook het token voor een tablet
npm run check -- dj --json          # voor een script
```

Eén commando, vlak voor een optreden, dat alles naloopt. Per punt één regel:

| Teken | Betekent | |
|---|---|---|
| ✓ | goed | |
| ! | let op, maar speelbaar | met `→` wat je kunt doen als er tijd is |
| ✗ | eerst oplossen | met `→` wat te doen |

Exitcode **0** als er niets ✗ is (alleen ✓ en !), **1** als er minstens één ✗ is. `check` verandert niets: het
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
  ✓ LPD8-profiel geleerd (proef 2026-10-03)
  ✓ de F0-proef is gedaan (1×, laatst 2026-10-03 20:10)
  ✓ geheugen leesbaar (~/.varve-hub/staat.json)
  ! avondmap ~/Movies/varve-avonden: 1,6 GB vrij (krap)
      → maak liefst een paar GB vrij voor een lange avond

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

**De hub** — `GET /api/beeld` op de poort uit `config.json` (`poorten.http`, of `--poort N`).
- Draait hij: zijn de APC40 en de LPD8 verbonden (`apparaten` in het beeld)? Niet verbonden = ✗.
- Draait hij niet (niemand op de poort): ! (start hem straks), en dan zoals `doctor`: staan de APC40 en de LPD8 als
  MIDI-poort in de lijst (naam uit `config.json` → `apparaten`)? Niet gevonden, of geen MIDI = ✗.
- Antwoordt er iets anders dan de hub, of iets dat niet antwoordt (een vastgelopen hub): ✗.

**Bestanden van de hub**
- `lpd8-profiel.json`: ontbreekt = ! (de hub gebruikt de standaardnoten; `npm run proef`), kapot = ✗ (dan start de
  hub niet).
- De F0-proef: een `proef/<stempel>-f0-hardware.jsonl` (de synthetische testfixture telt niet). Nooit gedaan = !.
- Het geheugen (`config.json` → `geheugen.pad`, `$VARVE_HUB_STAAT` gaat voor): afwezig of leesbaar (JSON met `"v": 1`) = ✓, kapot, een onbekende versie
  of onleesbaar = ✗ (de hub begint dan leeg), een achtergebleven `<pad>.kapot` = !. Geheugen uit = !.
- De avondmap (`config.json` → `avondmap`): schrijfbaar (bestaat hij nog niet, dan de map erboven), en de vrije
  ruimte op die schijf: onder 2 GB = !, onder 500 MB = ✗.

**Chrome** — macOS: `/Applications/Google Chrome.app` (of in `~/Applications`), anders ✗ (de set opent de apps
met `open -a "Google Chrome"`). Linux: `google-chrome`, `google-chrome-stable`, `chromium` of `chromium-browser` in
`PATH`, anders ! (`xdg-open` opent dan je standaardbrowser).

**Met `--lan`** — het token (`~/.varve-hub/token`): ontbreekt of ongeldig = ✗ (`node src/cli.js token`), leesbaar
voor anderen = ! (`chmod 600`; de hub doet het ook zelf bij de start).

**Met een set** — dezelfde regels als de starter (docs/SETS.md):
- `sets/paden.json` aanwezig (anders ✗ met het `cp`-commando).
- Per app met een startcommando: de map (`paden.json` → repo, plus `start.map`) bestaat, en waar het commando
  `npm`/`npx`/`node`/`vite` is en `package.json` (dev)dependencies heeft: `node_modules` (en daarin `vite` als die
  erin staat). Anders ✗ met `cd … && npm install`.
- De poort: vrij = ✓. Bezet: via `lsof` wie er luistert. Draait dat proces in de map van de app = ✓ (de starter
  start hem niet opnieuw); een ander proces = ✗ met pid (`kill …` of een andere poort in `config.json`); niet na te
  gaan (geen `lsof`) = !.
- De hub-koppeling in die checkout:

  | App | Wat er moet zijn | Waar hij vandaan komt |
  |---|---|---|
  | formula-lab | `src/sync/hub.js` | tak `claude/varve-hub-koppeling` (PR) |
  | medisynth | `src/hub.js` | tak `claude/varve-hub-koppeling` (PR) |
  | waterschaal | `'hub'` in `td/waterschaal-lokaal.html` | tak `claude/varve-hub-koppeling` (PR) |
  | varve-dj (youtube-mixer) | `src/control/hub.js` | `koppelingen/varve-dj/` (patch) |
  | av-kern | `src/ui/hub.ts` | `koppelingen/av-kern/` (patch, na 25 okt) |
  | av-scene-kit | `td/td_build_hub.py` | docs/TOUCHDESIGNER.md |

  Ontbreekt hij: "de app meldt zich niet bij de hub tot de koppeling erin zit". Dat is ✗ als de set op de hub wacht
  (standaard), en ! als de set alleen op de poort wacht (av-kern tot 25 okt). Uurwerk, TD-lab en Sediment hebben
  geen eigen koppeling nodig (de hub praat via een driver met ze).
- Een app die al verbonden is met de draaiende hub: één ✓, verder niets (de starter laat hem met rust).
- Een app zonder startcommando (`handmatig`, zoals Scene Kit): ! met wat je zelf moet doen.

## Voor scripts en tests

`--json` geeft `{ ok, code, set, hub, punten: [{ groep, naam, status: "ok"|"let"|"fout", teken, uitleg, doen? }] }`.

In code: `check()` uit `src/check/index.js`. Alles wat de buitenwereld raakt is injecteerbaar: `fs`, `fetch`,
`spawn` (voor `lsof`), `platform`, `thuis`, `env`, `poortOpen`, `laadMidi`, de klok (time-outs) en de paden van
de hub-map, de sets en `paden.json`. De tests (`test/check.test.js`) raken de echte thuismap nooit.
