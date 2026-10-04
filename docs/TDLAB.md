# td-lab koppelen aan varve-hub (Genesis)

td-lab bouwt zijn TouchDesigner-netwerken met Python-scripts over een **exec-bridge**: `/td_bridge`, een
Web Server DAT die Python uitvoert in TD's hoofddraad (`td-lab/bridge/td_bridge.py`, poort 9981). De hub praat
over diezelfde bridge met TD. **In td-lab verandert niets**: geen script, geen .toe, geen MIDI-poort.

- Driver: `src/drivers/td.js` (soort `td`). Manifest en mapping: `apps/td-lab.json`.
- Wat er bespeeld wordt: de custom parameters van **`/genesis`** (`td-lab/scripts/genesis.py`), 17 parameters,
  een puls (Reseed) en paniek.
- Achtergrond en keuzes: `docs/VOLGENDE-KOPPELINGEN.md` §6.

**De driver staat standaard uit.** De bridge voert willekeurige Python uit in TD; de hub stuurt er alleen
parameterwaarden heen, maar je zet dat bewust zelf aan.

## Eenmalig: aanzetten (±5 minuten)

1. **Open td-lab in TouchDesigner** (TD 2023.12230) met de bridge erin. Is die er nog niet: plak in de textport
   `exec(open('/Users/claykrebbers/td-lab/bridge/install.py').read())`.
2. **Bouw Genesis** als dat nog niet gebeurd is: `./td run scripts/genesis.py` in de map van td-lab.
3. Controleer de bridge: `./td ping` geeft de TD-versie, en `./td py "op('/genesis').id"` geeft een getal.
4. **Kijk op welk adres de bridge luistert:** `lsof -iTCP:9981 -sTCP:LISTEN`. Staat er `*:9981` in plaats van
   `localhost:9981`/`127.0.0.1:9981`, dan kan iedereen op je netwerk Python in TD draaien (los van de hub; wel goed
   om te weten, zie "Open punten").
5. Zet in `config.json` van de hub bij `apps` → `td-lab`:
   ```json
   "autostart": true
   ```
6. **Start de hub** (`npm start`, oftewel `node src/cli.js start`). Na een paar seconden staat in het log:
   ```
   driver td-lab verbonden met /genesis via http://127.0.0.1:9981
   ```
   en in de cockpit staat **TD-lab · Genesis** als actieve app.

### Andere poort (als av-scene-kit ook draait)

Poort 9981 wordt ook geclaimd door de TD-MCP van av-scene-kit. Draaien beide TD-projecten tegelijk, geef td-lab
dan een andere poort. **De hub leest de poort alleen uit `config.json`** (huisregel 6; `apps/td-lab.json` heeft geen url):

1. In TD (td-lab), in de textport: `op('/td_bridge/server').par.port = 9982` (geen wijziging in td-lab's code;
   na een nieuwe `install.py` staat hij weer op 9981).
2. Het CLI van td-lab: `TD_HOST=http://127.0.0.1:9982 ./td ping`.
3. In `config.json` van de hub: `bekende_apps` → `td-lab` → `"tcp": 9982`. Dat is de ene plek: de driver en
   `varve-hub doctor` lezen hem allebei.

`apps.td-lab.poort` mag ook (die wint van `bekende_apps.td-lab.tcp`), maar dan kijkt doctor nog op de oude poort en
wacht een set ook op die poort. Is de poort geen getal (bv. `"9982"` als tekst), dan start de driver niet en staat er
`driver td-lab niet gestart: config.json → apps.td-lab.poort ("9982") is geen poort …` in het log; hij valt niet stil
terug op 9981.

## Testen op de Mac (±10 minuten)

Zet de cockpit open (`http://localhost:7700`) en het TD-venster van Genesis ernaast.

| # | Doe | Verwacht |
|---|---|---|
| 1 | Schuif in de cockpit **Snelheid wereld** naar 0 | de wereld staat stil; `./td py "op('/genesis').par.Speed.eval()"` geeft 0 |
| 2 | Geef TD-lab de focus (Bank + Track Select) en beweeg fader 1–8 | Speed, Flow, Climb, Wander, Size, Trails, Hue, Restless (in die volgorde; eerst "pakken": de clip-stop-LED knippert tot de fader de stand kruist) |
| 3 | Device-knoppen 1–7 | Fert, Cruel, Fieldmix, Bright, Glow, Bg, Grain |
| 4 | Pads (grid) | Regisseur aan/uit, HUD aan/uit, **Opnieuw zaaien** (puls). Paniek zit niet op een pad: die gaat met Stop All of LPD8-P1 (rij 5) |
| 5 | **LPD8-P1 een seconde vasthouden** (of Stop All met focus op TD-lab) | beeld zwart, HUD weg; de chemie loopt door. Terug: een snapshot laden (P5–P8) of de knoppen terugdraaien |
| 6 | LPD8 K1–K6 | Glow (intensiteit), Bright (helderheid), Trails (ruimte), Speed (beweging), Hue (kleur), Fert (dichtheid) |
| 7 | Herbouw: `./td run scripts/genesis.py` | log: `/genesis is herbouwd: de hub speelt alles opnieuw af`; de standen van de hub komen terug |
| 8 | Sluit TouchDesigner | log één keer: `bridge niet bereikbaar …`; in de cockpit wordt TD-lab "stil" en daarna "weg". Geen herhaalde meldingen: de hub probeert het opnieuw na 2, 4, 8 en daarna elke 10 s |
| 9 | Open TouchDesigner weer | binnen 10 s: `verbonden met /genesis`, en de hub speelt alles opnieuw af (na elke storing meldt de driver zich opnieuw aan, ook als `/genesis` dezelfde id heeft); de standen uit de cockpit staan weer in TD |

**Meetpunt belasting.** De bridge herlaadt `td_bridge.py` bij elk verzoek. De hub stuurt hooguit 10 batches per
seconde (`driver.max_hz` in `apps/td-lab.json`) plus elke 2 s een check. Open in TD de *Performance Monitor* en
beweeg een fader: haperen de frames, zet dan `"max_hz": 5`.

## Wat de hub naar TD stuurt

Alleen deze twee vormen Python, met namen uit `apps/td-lab.json` (gecontroleerd op `[A-Z][A-Za-z0-9]*`; er komt
nooit tekst van buiten in):

- **Check** (elke 2 s): `(lambda c: c.id if c is not None else None)(op('/genesis'))` — de id van de COMP
  (alleen een geheel getal telt). Een andere id dan vorige keer = herbouwd: de hub meldt td-lab opnieuw aan als
  "herstart" en de waarden lopen vanaf de standaard naar de stand van de hub (`slew_s`). Na een storing met dezelfde
  id (TD hapert, of was even dicht) meldt de hub hem opnieuw aan als "hapering": de standen gaan meteen opnieuw, zonder
  sprong naar de standaard. Een paniek gaat altijd meteen, ook als de laatste check misging.
- **Batch** (per tik alle gewijzigde parameters, laatste waarde wint):
  ```python
  _hub_c = op('/genesis')
  if _hub_c is None: raise RuntimeError('varve-hub: geen COMP /genesis')
  _hub_fout = []
  def _hub_par(n): ...
  try: _hub_par('Speed').val = 0.7
  except Exception: _hub_fout.append('Speed')
  try: _hub_par('Reseed').pulse()
  except Exception: _hub_fout.append('Reseed')
  if _hub_fout: raise RuntimeError('varve-hub: niet gezet: ' + ','.join(_hub_fout))
  ```
  Waarde = `min + v·(max-min)` uit `driver.pars.<id>.bereik`; schakelaar = `True`/`False`. Eén hernoemde parameter
  houdt de rest niet tegen; de hub meldt hem één keer in het log.

De variabelen `_hub_c`, `_hub_fout` en `_hub_par` blijven in de namespace van de bridge staan (die bewaart zijn
namespace tussen verzoeken, `td_state.py`); ze botsen niet met de helpers van td-lab.

## Wat niet via de hub gaat

- **Feed en Kill**: die schrijft de regisseur elke tik (`brain/director.py`); een waarde van de hub zou meteen
  overschreven worden. Zet de regisseur uit (pad "Regisseur aan") als je de chemie met de hand wilt.
- **Seedamt**: dat is de Reseed-puls zelf.
- **Seedthresh, Seedsoft** (vorm van het zaad): bewust niet, zie "Open punten".
- **Readout** (Wlife, Wact, Flash): het protocol kent nog geen alleen-lezen parameters.

## Problemen

| Zie je | Oorzaak | Doe |
|---|---|---|
| `TD-driver staat uit — zet config.json → apps.td-lab.autostart op true` | standaard uit | stap 5 hierboven |
| `bridge niet bereikbaar op http://127.0.0.1:9981 (ECONNREFUSED)` | TD dicht, of de bridge niet geïnstalleerd | `./td ping`; installeer de bridge (stap 1) |
| `bridge niet bereikbaar … (geen JSON van de bridge)` of `(leeg antwoord …)` | iets anders op die poort (de TD-MCP van av-scene-kit?) of een tikfout in `td_bridge.py` | `lsof -iTCP:9981`; zie "Andere poort" |
| `bridge niet bereikbaar … (HTTP 404)` (of een andere 4xx/5xx) | iets anders op die poort: de echte bridge antwoordt altijd met 200 | `lsof -iTCP:9981`; zie "Andere poort" |
| `bridge niet bereikbaar … (antwoord is geen COMP-id; …)` | iets anders op die poort dat wel JSON met `ok:true` geeft | `lsof -iTCP:9981`; zie "Andere poort" |
| `driver td-lab niet gestart: … geen poort` | `bekende_apps.td-lab.tcp` weg, of `apps.td-lab.poort` is geen getal 1..65535 | zie "Andere poort" |
| `bridge draait, maar /genesis bestaat niet` | Genesis nog niet gebouwd | `./td run scripts/genesis.py` |
| `/genesis: parameter X niet te zetten` | parameter hernoemd in `genesis.py` | pas `apps/td-lab.json` → `driver.pars` aan |
| `batch mislukt: geen antwoord binnen 2000 ms` | TD hing (zware frame, dialoogvenster open) | de hub probeert opnieuw en speelt alles opnieuw af zodra TD weer antwoordt |

## Uitzetten

1. Zet in `config.json` bij `apps` → `td-lab` `"autostart": false` (of haal de regel weg: zonder `true` start de
   TD-driver nooit).
2. Herstart de hub. In het log: `td-lab: TD-driver staat uit …`; de hub stuurt niets meer naar TD.
3. Optioneel: de hub onthoudt de standen van td-lab (`truth:"hub"`) in `~/.varve-hub/staat.json` (`geheugen.pad`).
   Die blijven staan en komen terug als je de driver weer aanzet. Wil je opnieuw beginnen: stop de hub en haal in dat
   bestand `"td-lab"` weg uit `waarden` (en uit `inst`). Snapshots met td-lab erin houden hun td-lab-waarden.

## Open punten (voor Clay)

1. Welke COMP bespeelt de hub: `/genesis` (nu), of ook `/world` / `/screensaver`?
2. Mag de hub via de exec-bridge (volledige Python-toegang tot TD) praten? Daarom staat de driver uit tot jij hem aanzet.
3. Luistert de bridge alleen op 127.0.0.1 (stap 4)?
4. Readout (leven/activiteit) in de cockpit? Vraagt een protocoluitbreiding.
5. td-lab en av-scene-kit tegelijk op één avond (twee TD-versies, licentie, poort)?
6. Seedthresh/Seedsoft ook op knoppen, of blijft de chemie buiten de hub?
