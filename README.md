# AV-app-hub (`varve-hub`)

Eén hub voor de **APC40 mkII** en de **LPD8**, zodat al je Varve-projecten (Varve DJ, av-kern, formula-lab, av-scene-kit, uurwerk, waterschaal, …) met die twee controllers te bespelen zijn — zonder dat apps om de controller vechten.

**Stand: golf 6** — klaar voor de eerste avond met de echte controllers: volg `docs/HARDWARE-AVOND.md`. Golf 6: paniek voor de driver-apps, uurwerk leest terug wat je in de tab verandert, td-lab als driver (standaard uit). Eerder: kern, cockpit, server en drivers staan; koppelingen voor formula-lab, waterschaal, medisynth en flux staan klaar op hun eigen tak, Varve DJ en av-kern als patch (`koppelingen/`). Nieuw: sets (een hele avond met één commando), avondmap, geheugen en het netwerk. Zie `STATUS.md`.

## Op de Mac

Nodig: Node 22 (`brew install node`).

```bash
cd AV-app-hub
npm install            # haalt ook @julusian/midi (RtMidi) binnen
node src/cli.js doctor # wat ziet de hub? controllers, poorten, draaiende apps
```

Sluit eerst alles wat de APC zelf aanstuurt: Chrome-tabs met Varve DJ of av-kern, Ableton, en een APC-control-surface in Logic. Op macOS kunnen meerdere apps tegelijk naar de APC schrijven en dan vechten de lampjes.

| Opdracht | Wat |
|---|---|
| `node src/cli.js start` | **de hub**: cockpit op http://localhost:7700 (virtuele APC40/LPD8, apps, live invoer), apps verbinden op `ws://localhost:7700/app`. `--zonder-midi` om zonder controllers te draaien, `--zonder-geheugen` om niets te onthouden |
| `npm start -- meditatie` | **een hele avond**: de hub plus alle apps van de set (`sets/meditatie.json`, `dj`, `scene-kit`): apps starten, Chrome-tabs openen, beginstand en focus zetten; Ctrl-C ruimt op wat de set startte. Eenmalig `cp sets/paden.voorbeeld.json sets/paden.json` en je mappen invullen. Zie `docs/SETS.md` |
| `npm start -- --lan` | ook op het netwerk (tablet als cockpit, flux op een andere machine), met token en mDNS. `node src/cli.js token` toont de adressen; `node src/cli.js installeer` laat de hub altijd draaien (launchd). Zie `docs/NETWERK.md` |
| `npm run check -- meditatie` | **alles nalopen vlak vóór een optreden**: hub, controllers, LPD8-profiel, de statische manifesten in `apps/`, F0-proef, geheugen, avondmap (vrije ruimte), Chrome, token, en per app van de set map/node_modules/poort/hub-koppeling. ✓/!/✗ met wat te doen. Zie `docs/CHECK.md` |
| http://localhost:7700/oefen | **oefenen**: 14 korte lessen om de basis onder de knie te krijgen (focus, pickup, pads, LPD8-rollen, slew, snapshots, paniek, tempo, glijden zien), met twee oefen-apps (Zon en Zee). Werkt met je echte APC40/LPD8 of met de virtuele op de pagina. Start eerst de hub. Zie `docs/OEFENEN.md` |
| `node src/cli.js doctor` | overzicht: MIDI-poorten, APC/LPD8 (model + programma 1), poorten 7700/7701, welke apps draaien. `--json` voor machineleesbaar |
| `node src/cli.js proef` | **begeleide hardwareproef F0** (±35-45 min; volg `docs/HARDWARE-AVOND.md`). Neemt alles op in `proef/…jsonl` en leert je LPD8 (`lpd8-profiel.json`) |
| `node src/cli.js testpatroon` | regenboog op de APC, en live in de terminal wat elke knop stuurt. Ctrl-C = alles uit |
| `node src/cli.js opname [naam]` | speelsessie opnemen in `proef/` — voor hardwareproeven (wordt een golden test), niet om een avond te bewaren |
| `npm run herhaal -- <avondmap>` | een opgenomen avond opnieuw afspelen tegen de draaiende hub en de eindstand per app vergelijken (`--snelheid x`, `--zonder-beginstand`) |

**LPD8-pad 4** = de avond opnemen naar `~/Movies/varve-avonden/<datum-tijd>/` (sleutel `avondmap` in `config.json`), terwijl de hub draait; de cockpit toont dan een rode REC. Zie `docs/OPNAME.md`.

**Paniek** (LPD8-pad 1 een seconde vasthouden): wat een app daarna zelf verandert (bv. volume naar 0) koppelt de LPD8-knoppen niet los; `paniek.naloop_s` in `config.json` (standaard 5) bepaalt hoe lang na het loslaten (PROTOCOL §14). Ook de driver-apps doen mee: uurwerk zet het volume op 0 (terug met de trigger `master_terug`), Sediment zet alle noten uit (CC 123), Scene Kit zet de master dicht (na de TD-patch in `koppelingen/av-scene-kit/`).

**td-lab** doet mee als driver over zijn eigen bridge, standaard uit: zie `docs/TDLAB.md`.

**Geheugen.** De hub onthoudt de snapshots en de waarden van TD, Sediment en andere `truth:"hub"`-apps over een herstart heen, in `~/.varve-hub/staat.json` (bij de start staat in de terminal waar). Leeg beginnen: gooi dat bestand weg terwijl de hub uit staat, of start met `--zonder-geheugen`. Een `staat.json.kapot` is een oud bestand dat de hub niet kon lezen; je kunt het weggooien. Een ander pad: `geheugen.pad` in `config.json`, of `VARVE_HUB_STAAT=/pad/naar/staat.json npm start`.

Tijdens de proef: Enter = ja/door, `n` + notitie = klopt niet ("n pad 2-3 werd blauw"), `o` = stap overslaan.

**Na de proef:** push het bestand, dan maak ik er een vaste test van en verwerk ik de uitkomsten:

```bash
git add proef/ lpd8-profiel.json
git commit -m "proef f0-hardware"
git push
```

## Voor ontwikkelen

```bash
npm test            # alles, zonder hardware: nep-poorten en een gesimuleerde gebruiker
npm run repetitie   # generale repetitie: de hub met de échte app-koppelingen, één avond lang (docs/REPETITIE.md)
```

Indeling: `src/devices/` (APC40, LPD8) · `src/ports/` (poort-interface, nep, RtMidi) · `src/core/` (kern, indeling, pickup, slew, klok, wachtrij, LED-beeld, hotplug, logboek) · `src/protocol/` (het contract, PROTOCOL.md) · `src/transports/` (HTTP- en WebSocket-server) · `src/drivers/` (MIDI, HTTP, TD) · `src/sets/`, `src/opname/`, `src/check/` · `src/apparaten.js` (sessies) · `src/proef/` (runner + protocollen) · `src/hub.js` (alles samen) · `src/cli.js` · `ui/` (cockpit en oefenruimte). Werkafspraken in `CLAUDE.md`.
