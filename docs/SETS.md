# Sets — één commando zet een hele avond klaar

```bash
npm start -- meditatie            # = node src/cli.js start meditatie
```

Dat start de hub (zoals `npm start`), daarna elke app van de set, opent de URL's met `?hub=` in Chrome, wacht tot
elke app zich bij de hub meldt, zet de beginwaarden (beginsnapshot) en geeft de juiste app de APC-focus.
**Ctrl-C** stopt alles wat de set zelf startte, en dan de hub. Wat al draaide, blijft draaien.

Zonder set gedraagt `start` zich precies als altijd.

| Set | Apps | Focus |
|---|---|---|
| `meditatie` | MediSynth, Waterschaal, Uurwerk, av-kern | Waterschaal |
| `dj` | Varve DJ, Formula Lab | Varve DJ |
| `scene-kit` | Scene Kit (TouchDesigner), Varve DJ | Scene Kit |

## Eenmalig: waar staan je repo's?

Kopieer `sets/paden.voorbeeld.json` naar `sets/paden.json` en zet er de mappen in zoals ze op jouw Mac staan.
De sleutel is de repo-naam uit `config.json` → `apps.<id>.repo`; `~` is je thuismap. `sets/paden.json` staat
niet in git (elke computer heeft zijn eigen paden).

```json
{ "youtube-mixer": "~/Desktop/youtube-mixer", "waterschaal": "~/Projects/waterschaal", "…": "…" }
```

Ontbreekt een pad, dan meldt de starter dat voor die ene app en gaat hij door met de rest.

## Wat er gebeurt, per app

1. **Draait hij al?** Is de app al verbonden met de hub, dan doet de starter niets (geen tweede tab: die zou de
   eerste verdringen, PROTOCOL.md §11). Is alleen zijn poort al bezet (de server draait, de tab nog niet), dan
   start hij niets maar opent hij wel de URL.
2. **Starten:** het commando uit de set, in de map van de repo, in een eigen procesgroep. Zo stopt bij Ctrl-C
   ook wat het commando zelf startte (vite onder `npm run dev`, de servers die `./start.sh` op de achtergrond zet).
3. **Chrome:** de URL gaat open zodra de poort van de app open is (anders zie je een foutpagina). macOS:
   `open -a "Google Chrome" <url>`, Linux: `xdg-open <url>`.
4. **Wachten** tot de app zich meldt (`kern.beeld`: status `actief`), tot de time-out (standaard 60 s).
5. **Beginsnapshot en focus**, als alle apps klaar of mislukt zijn. Een app die niet klaar is, wordt
   overgeslagen; de rest krijgt gewoon zijn waarden.

Lukt een app niet, dan zegt de starter waar het hangt:

```
  waterschaal: MIS — niet klaar binnen 60 s — meldt zich niet bij de hub — is de tab open met die URL,
               en heeft deze versie van de app de hub-koppeling?; laatste uitvoer: …
  formula-lab: MIS — het startcommando stopte met code 1; laatste uitvoer: Error: Port 5174 is already in use
  medisynth:   MIS — geen map voor repo "medisynth" in sets/paden.json (voorbeeld: sets/paden.voorbeeld.json)
```

De hub blijft dan draaien: start wat mist met de hand, of los het op en draai de set opnieuw (wat al draait,
wordt niet opnieuw gestart).

**Draaide de hub al** (poort 7700 bezet)? Dan start `start <set>` geen tweede hub, maar verbindt hij als cockpit
met de hub die er is en zet hij de set daarbij klaar. Ctrl-C stopt dan alleen wat de set startte.

Opties: `--zonder-chrome` (URL's alleen tonen), `--uitvoer` (alle uitvoer van de apps meelezen), en de
gewone van `start` (`--poort`, `--zonder-midi`, `--geen-drivers`, …). Een set mag ook een pad naar een
`.json`-bestand zijn.

## Een set schrijven

`sets/<naam>.json`:

```json
{
  "naam": "Meditatie",
  "time_out_s": 60,
  "apps": {
    "medisynth": {
      "start": { "commando": "npm run dev -- --port {poort} --strictPort" },
      "url": "http://localhost:{poort}/?hub={hub}"
    },
    "uurwerk": { "start": { "commando": "./start.sh" }, "url": null },
    "av-kern": {
      "start": { "commando": "npm run dev -- --port {poort} --strictPort", "omgeving": { "BROWSER": "none" } },
      "url": "http://localhost:{poort}/?hub={hub}",
      "wacht": "poort",
      "opmerking": "hub-koppeling pas na 25 okt"
    }
  },
  "snapshot": { "medisynth": { "ruimte": 0.6, "niveau": 0.8 } },
  "focus": "medisynth"
}
```

| Veld | Betekenis |
|---|---|
| `apps` | app-id's uit `config.json` → `apps`, in startvolgorde |
| `start.commando` | via de shell, in de map van de repo (`start.map`: een submap daarvan) |
| `start.omgeving` | extra omgevingsvariabelen (bv. `PORT` voor Varve DJ, `BROWSER: "none"` tegen vite's eigen browser) |
| `start: null` + `handmatig` | de starter start niets en toont de instructie (TouchDesigner) |
| `url` | wat er in Chrome open moet; `null` = niets openen |
| `wacht` | `kern` (standaard): tot de app zich bij de hub meldt (en zijn poort open is, als hij er een heeft) · `poort`: alleen tot de poort open is (apps zonder hub-koppeling) · `geen` |
| `time_out_s` | per set of per app |
| `opmerking` | wordt bij het starten getoond |
| `snapshot` | per app `{ parameter: 0..1 }` (PROTOCOL.md §1: altijd 0..1). Gaat via de cockpit-ingang van de kern, alsof je het in de cockpit zet. Triggers en onbekende ids worden gemeld en overgeslagen |
| `focus` | de app die de APC krijgt |

In tekst mag: `{poort}` (uit `config.json` → `apps.<id>.poort`), `{hub}` (`ws://localhost:7700/app`, met de
echte poort van de hub), `{hub_poort}`, `{repo}` (de map uit `sets/paden.json`). **Nooit** paden of poorten
van apps in een set zelf: paden komen uit `sets/paden.json`, poorten uit `config.json` (huisregel 6).
`varve-hub start <set>` controleert de set vóór er iets start en noemt elke fout.

## De apps (uit hun eigen README/START.md)

| App | Start | Poort | URL | Let op |
|---|---|---|---|---|
| MediSynth | `npm run dev -- --port {poort} --strictPort` | 5175 | `/?hub=` | koppeling op tak `claude/varve-hub-koppeling` |
| Formula Lab | idem | 5174 | `/?hub=` | idem; zonder vaste poort pakt vite 5173 (van av-kern) |
| Waterschaal | `python3 -m http.server {poort} --bind 127.0.0.1` | 8080 | `/td/waterschaal-lokaal.html?hub=` | koppeling op tak `claude/varve-hub-koppeling` |
| Varve DJ | `node server/index.js` met `PORT={poort}` | 8777 | `/?hub=` | koppeling als patch: `koppelingen/varve-dj/LEESMIJ.md` |
| Uurwerk | `./start.sh` | 8766 (brug), 8765 (web) | — | start.sh opent zelf de browser; de hub praat via de HTTP-driver met de brug |
| av-kern | `npm run dev -- --port {poort} --strictPort`, `BROWSER=none` | 5173 | `/?hub=` | **hub-koppeling pas na 25 okt** — zie hieronder |
| Scene Kit (TD) | handmatig | — | — | via de virtuele MIDI-poort "VARVE-HUB TD" (docs/TOUCHDESIGNER.md) |

**av-kern** zit in de meditatie-set, maar zijn hub-koppeling komt pas na 25 oktober. Tot dan start de set
hem alleen en opent hij in Chrome; de starter wacht op zijn poort, niet op de hub, en er is geen snapshot voor
hem. Klik niet op *Verbind APC40* zolang de hub de APC heeft (huisregel 1: de hub is de enige die een
controller opent). Na 25 okt: `"wacht": "kern"` en een snapshot erbij.

**Scene Kit (TD):** de hub kan alleen zien dat zijn virtuele MIDI-poort er is, niet of TouchDesigner luistert;
"klaar" betekent dus "de poort is er". Zonder echte MIDI (`--zonder-midi`, de cloud) is er geen poort en
wordt hij niet klaar.

## Bekende grenzen

- Valt de hub zelf hard weg (geen Ctrl-C maar een crash), dan blijven de gestarte apps draaien: ze zitten in een
  eigen procesgroep. Stop ze dan met de hand.
- Een app die al draait maar nog geen tab heeft, krijgt een nieuwe tab; staat er toch al een tab, dan wint de
  nieuwste (PROTOCOL.md §11) en sluit de oude zijn verbinding.
- De beginsnapshot overschrijft wat een app bij het starten zelf meldt (`staat`); de starter wacht daarvoor
  `RUST_MS` (500 ms) na de laatste aanmelding.

Code: `src/sets/` (`set.js` laden en controleren, `starter.js` de starter, `toegang.js` kern of cockpit,
`systeem.js` processen, Chrome en poorten). Tests: `test/sets*.test.js`.
