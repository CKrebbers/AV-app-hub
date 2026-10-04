# Spiekbrief — wat doet welke knop

Eén A4 (liggend) per set met wat elke knop van de APC40 mkII en de LPD8 doet. Leg hem naast de controllers.

## Maken en printen

**Zonder hub** (thuis, vooraf):

```bash
npm run spiekbrief -- meditatie          # → tools/uitvoer/spiekbrief-meditatie.html
npm run spiekbrief -- alle               # alle sets, elk op een eigen blad
npm run spiekbrief -- dj --uit ~/Desktop/dj.html
```

Open het bestand in Chrome en druk **⌘P**: A4 liggend staat al goed, één blad per set. Zwart-wit printen is prima;
de kleur van elke app staat als randje links van zijn vak.

**Met de hub aan:** **http://localhost:7700/spiekbrief**.
Kies een set. Dan staat er wat de hub *nu* doet: de manifesten van de apps die verbonden zijn, en het echte
**Track Select-nummer** van elke app (zonder hub hangt dat af van wie zich eerst meldt, dus staat er "onder zijn kleur").

## Wat erop staat

- **LPD8 (links):** K1–K8 met per knop welke apps van deze set meedraaien (bv. K3 ruimte → MediSynth: Ruimte ·
  Waterschaal: Uitklank), en P1–P8: paniek (1 s vasthouden), tap tempo, adem opnieuw, opname, snapshots 1–4
  (kort = laden, lang = bewaren).
- **APC met Bank vast:** Track Select = focus, Scene 1–5 = hub-snapshot (+ Shift = bewaren).
- **Per app:** de faders, track- en device-knoppen (met de pagina's van Device ◄/►), de pads (alleen de kolommen
  die iets doen, rij 5 = bovenaan), de scènes en Stop All, zoals ze werken als die app focus heeft. Wat niet op de
  APC past staat eronder ("niet op de APC").
- **Lease-apps** (Varve DJ, AV-kern): met focus is de hele APC van de app zelf; alleen Bank blijft van de hub.
- **"Indeling volgt als de app zich meldt":** de hub kent die app nog niet (hij meldde zich nooit). Start de app
  één keer met de hub aan en open de spiekbrief op de hub.

## Waar de indeling vandaan komt

De spiekbrief typt niets over: hij meldt de manifesten aan bij een echte kern (`src/core/kern.js`, dezelfde
indeling als de hub, met de kaarten uit `maps/`) en schrijft op wat die ervan maakt. `test/spiekbrief.test.js`
drukt elke knop van elke spiekbrief op een echte kern en kijkt of de app krijgt wat er op papier staat.

Manifesten, in deze volgorde:

1. **de draaiende hub** (alleen op `/spiekbrief`): wat de app echt stuurde;
2. **`apps/<app>.json`**: de driver-apps (uurwerk, Scene Kit, Sediment, td-lab);
3. **wat de app het laatst stuurde**, vastgelegd bij de generale repetitie (`tools/repetitie.mjs --fixtures` →
   `test/fixtures/manifesten/`; de datum staat op de spiekbrief). Verandert een app zijn knoppen, draai dan de
   repetitie opnieuw met `--fixtures`, of open de spiekbrief op de hub terwijl de app draait.

De opgeslagen staat (`~/.varve-hub/staat.json`) en een avondopname bewaren geen manifesten, dus die tellen niet mee.

Code: `src/spiekbrief/` (model, bronnen, HTML), `ui/spiekbrief.css` (scherm en print), de route in
`src/transports/server.js`, de opdracht in `src/cli.js`.
