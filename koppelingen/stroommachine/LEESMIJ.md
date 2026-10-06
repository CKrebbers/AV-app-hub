# Stroommachine — koppeling met de hub

Realtime generatieve beeld- en geluidsmachine in één HTML-bestand (WebGL2 + Web Audio, geen build). De koppeling zit in de Stroommachine zelf, achter `?hub=` (standaard uit): `src/09c-live.js` (verbinden, herverbinden, macro's) en `src/09j-brug.js` (PROTOCOL.md v1). Er is nog geen eigen GitHub-repo; de bron staat in Clay's zip/werkmap. Daarom staat er in `config.json` geen `repo` en in `src/check/koppelingen.js` geen regel.

## Starten
```bash
npm start                                  # de hub, in AV-app-hub
python3 -m http.server 8090                # in de map van de Stroommachine
```
Open `http://localhost:8090/index.html?hub=ws://localhost:7700/app` (of `index.html` dubbelklikken met `?hub=…` erachter). Binnen een artifact op claude.ai blokkeert de browser localhost: alleen lokaal.

## Hoe hij praat
- Na `{t:"welkom",hub:"varve-hub"}`: `hallo` (vaste `app: "stroommachine"`, `inst` per paginalading), `manifest`, `staat` met alle waarden; daarna `staat` met alleen gewijzigde waarden (elke 0,5 s, drempel 0,01) en `hb` elke 0,8 s.
- Verstaat `zet`, `trig` (alleen `aan:true`), `scene` (index in `scenes` → familie Inkt/Marmer/Kristal/Filament/Glitch) en `globaal.bpm` (tap tempo op de LPD8). `focus` en de rest van `globaal` worden genegeerd; onbekende berichten breken niets.
- Close-code 4001 (vervangen door een nieuwere tab): 30 s wachten voor hij opnieuw probeert (§11). Anders 1 → 2 → 4 … 30 s.
- Daarnaast stuurt hij een eigen kenmerkstroom (`{type:"kenmerken",…}`, zonder `t`) voor TouchDesigner en de Varve-relay; tegen de hub zet hij die uit zodra het welkom binnen is. Berichten zonder `t` zijn voor de hub `onbekend` en worden genegeerd.

## Manifest (90 params)
Kleur `#c8e600`, `truth:"app"`, `hb_s:1`, geen lease. Parameters = de macro's + de poorten van de Stroommachine (één taal met Vormmachines: `id.knop` zetten, `id!actie` uitvoeren; op de draad wordt `!` een `.`).

| Groep | Aantal | Parameters (▸ = trigger) |
|---|---|---|
| macro | 9 | `intensiteit` (rol `macro.intensiteit`) · `helderheid` (`macro.helderheid`) · `feedback` (`macro.ruimte`) · `snelheid` (`macro.beweging`, slew 2 s) · `tint` (`macro.kleur`) · `dichtheid` (`macro.dichtheid`) · `flits` ▸ · `paniek` ▸ · `macro.balans` (geluid ↔ beeld) |
| post | 1 | `glitch` |
| veld | 15 | `veld.schaal` · `veld.warp` · `veld.spiegel` · `veld.radiaal` · `veld.draad` · `veld.scherf` · `veld.leegte` · `veld.nagloei` · `veld.stroming` · `veld.glitch` · `veld.horizon` · `veld.vonken` · `veld.glans` · `veld.pixel` · `veld.gloed` |
| laag | 6 | `laag.veld` · `laag.vloeistof` · `laag.deeltjes` · `laag.simulatie` · `laag.beeld` · `laag.overlay` |
| fx | 30 | `fx.caleido` · `fx.tunnel` · `fx.spiegel` · `fx.crt` · `fx.pixelsort` · `fx.datamosh` · `fx.tijdspleet` · `fx.dither` · `fx.raster` · `fx.randen` · `fx.poster` · `fx.dispersie` · `fx.braille` · `fx.arcering` · `fx.cmyk` · `fx.matrix` · `fx.film` · `fx.godstralen` · `fx.strata-snede` · `fx.beatglitch` · `fx.vhs` · `fx.ascii` · `fx.teletekst` · `fx.kwadrant` · `fx.led` · `fx.kruissteek` · `fx.woordraster` · `fx.tegeltijd` · `fx.zender` · `fx.echo` |
| feedback | 3 | `feedback.zoom` · `feedback.draai` · `feedback.kleurdrift` |
| ruimte | 3 | `ruimte.1` · `ruimte.2` · `ruimte.3` |
| kernel | 2 | `kernel.a` · `kernel.b` |
| regie | 11 | `regie.ontdekken` · `regie.wissel` · `regie.ontdek` ▸ · `regie.muteer` ▸ · `regie.kweek` ▸ · `regie.volgende` ▸ · `regie.vasthouden` ▸ · `regie.moment` ▸ · `regie.paniek` ▸ · `regie.flits` ▸ · `regie.vrij` ▸ |
| tempo · geluid · opname · lab · seed · effecten · beeld | 10 | `tempo.bpm` · `tempo.tik` ▸ · `geluid.volume` · `geluid.aanuit` ▸ · `opname.aanuit` ▸ · `lab.nieuw` ▸ · `seed.nieuw` ▸ · `effecten.uit` ▸ · `effecten.auto` ▸ · `beeld.verberg` ▸ |

Scenes: `inkt`, `marmer`, `kristal`, `filament`, `glitch`. De 35 bronnen (`beeld.licht`, `geluid.bas`, `mod.lorenz`, …) zijn geen params: die gaan via de kenmerkstroom naar TouchDesigner of de Varve-relay (Stroommachine-repo, `koppel/LEESMIJ.md`).

## Getest
`toetsApp` uit `tools/nep-hub.mjs` met de Stroommachine headless in Chromium (swiftshader), via `tools/test-varvehub.mjs` in de Stroommachine:
- canvas 160×90: **conform PROTOCOL.md** — hallo, geldig manifest (90 params), staat van alle params, hartslag (grootste gat 1001 ms), zet/trig/focus/globaal/onbekend overleefd, herverbinden, geen ongeldige berichten; 0 console-fouten.
- canvas 480×270: alles ok behalve de hartslag (gat 1,8–2,5 s): in swiftshader blokkeert één frame daar de hoofdthread zo lang dat geen timer ertussen komt. Op een echte GPU niet gemeten; de hub noemt een app pas na 3 s `stil`.
- `npm test` in AV-app-hub met deze config: 79 bestanden, 1227 tests groen (lokaal, browsertests overgeslagen).

## Open voor Clay
- Op de M1 met de echte hub: komt de hartslag binnen de seconde, en kloppen de APC-pagina's met 16 groepen (veld, fx en regie zijn de grootste)?
- Repo `stroommachine` op GitHub aanmaken; dan kan er een `repo` in `config.json` en een regel in `src/check/koppelingen.js` (`bestand: 'src/09j-brug.js'`).
