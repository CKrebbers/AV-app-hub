# AV-app-hub (`varve-hub`)

Eén hub voor de **APC40 mkII** en de **LPD8**, zodat al je Varve-projecten (Varve DJ, av-kern, formula-lab, av-scene-kit, uurwerk, waterschaal, …) met die twee controllers te bespelen zijn — zonder dat apps om de controller vechten.

**Stand: golf 1** — kern, cockpit, server en drivers staan; app-koppelingen volgen. Zie `STATUS.md`.

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
| `node src/cli.js start` | **de hub**: cockpit op http://localhost:7700 (virtuele APC40/LPD8, apps, live invoer), apps verbinden op `ws://localhost:7700/app`. `--zonder-midi` om zonder controllers te draaien |
| `node src/cli.js doctor` | overzicht: MIDI-poorten, APC/LPD8 (model + programma 1), poorten 7700/7701, welke apps draaien. `--json` voor machineleesbaar |
| `node src/cli.js proef` | **begeleide hardwareproef F0** (±30-40 min). Neemt alles op in `proef/…jsonl` en leert je LPD8 (`lpd8-profiel.json`) |
| `node src/cli.js testpatroon` | regenboog op de APC, en live in de terminal wat elke knop stuurt. Ctrl-C = alles uit |
| `node src/cli.js opname [naam]` | speelsessie opnemen in `proef/` |

Tijdens de proef: Enter = ja/door, `n` + notitie = klopt niet ("n pad 2-3 werd blauw"), `o` = stap overslaan.

**Na de proef:** push het bestand, dan maak ik er een vaste test van en verwerk ik de uitkomsten:

```bash
git add proef/ lpd8-profiel.json
git commit -m "proef f0-hardware"
git push
```

## Voor ontwikkelen

```bash
npm test   # alles, zonder hardware: nep-poorten en een gesimuleerde gebruiker
```

Indeling: `src/devices/` (APC40, LPD8) · `src/ports/` (poort-interface, nep, RtMidi) · `src/core/` (klok, wachtrij, LED-beeld, hotplug, logboek) · `src/apparaten.js` (sessies) · `src/proef/` (runner + protocollen) · `src/cli.js`. Werkafspraken in `CLAUDE.md`.
