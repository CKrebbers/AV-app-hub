# Avondmap — een avond opnemen en opnieuw afspelen

Elke avond waarop je speelt kan de hub vastleggen: wat je met je handen deed (de ruwe MIDI van de APC40 en de
LPD8, ook de virtuele uit de cockpit) en wat er daardoor naar de apps ging. Later speel je dat opnieuw af tegen
een draaiende hub — met dezelfde timing of sneller — en de hub controleert of elke app op dezelfde stand eindigt.

## Opnemen

1. **Start eerst de hub** (`npm start`) en open je apps.
2. Druk op **LPD8-pad 4**: de opname start. Het hubvenster meldt eerst `opname gestart — map wordt gemaakt in …`
   en, zodra de map er is, `opname loopt: <map>`. Komt die tweede regel niet, maar een melding *kan niet
   schrijven*, dan wordt er niets bewaard (zie hieronder). Nog een keer pad 4 = stoppen.
3. Klaar. Bij stoppen schrijft de hub een `samenvatting.md` naast de opname.

In de cockpit staat dan bovenin een rode **● REC** met de mapnaam en de looptijd, en P4 van de virtuele LPD8 is rood. De laatste opname-melding staat ernaast (rood = fout) en blijft staan tot er een nieuwe komt. Staat er "REC — niets bewaard" (doorgestreept), dan wordt er niets opgeslagen: lees de melding.

Waar: `config.json` → `"avondmap"` (`~/Movies/varve-avonden`; `~` is je thuismap). Een relatief pad geldt vanaf
de AV-app-hub-map (zoals `proefmap`), niet vanaf waar je `npm start` typte. Zonder `"avondmap"` neemt de hub
niets op en zegt dat. Elke avond krijgt een eigen map met datum en tijd, bv.
`~/Movies/varve-avonden/2026-10-03_21-04-05/`. Twee opnames in dezelfde seconde krijgen `-2`, `-3`, …

Bij stoppen wacht de hub even tot er niets meer vanzelf beweegt — een LPD8-macro die nog naar zijn doel
glijdt (slew), of P1 die je nog vasthoudt (paniek) — en legt dan pas de eindstand vast (hooguit de langste
slew plus een fractie). Wat je in die uitloop nog doet, gaat mee de opname in.

Stopt de hub (Ctrl-C) terwijl de opname loopt, dan wordt de avond meteen afgesloten (zonder op een slew te
wachten; dan staat er `rust:false` in de eindregel). Reageert de schijf niet (extern volume weg), dan wacht
de hub hooguit 2 s, meldt *opname niet volledig weggeschreven* en stopt toch: LEDs uit, poorten dicht.
Nog een keer Ctrl-C stopt meteen.

### Wat er in de map staat

`gebaren.jsonl` — één JSON-waarde per regel, in hetzelfde formaat als de logboeken in `proef/`:

| Regel | Inhoud |
|---|---|
| 1 (kop) | `{ v:1, soort:"avond", begon, "hub-git", apps: { <app>: { naam, status, manifest: <hash> } }, lpd8: <profiel> }` |
| 2 | `{ ms:0, e:"beginstand", focus, globaal, apps: { <app>: { <param>: waarde } }, snapshots: { <nr>: … } }` |
| | `[ms, "in", dev, bytes]` — elke controller-invoer; `dev` is `apc40`, `lpd8`, `apc40-virtueel` of `lpd8-virtueel` |
| | `[ms, "naar", app, bericht]` — elke `zet`, `trig`, `scene` en `focus` die naar een app ging |
| | `{ ms, e:"lpd8profiel", profiel }` — het LPD8-profiel veranderde (nodig om latere LPD8-bytes te lezen) |
| laatste | `{ ms, e:"eind", duur_ms, "hub-git", apps: { <app>: { waarden, hash } }, rust? }` — de eindstand en zijn staat-hash; `rust:false` = er liep nog een slew (hub gestopt) |

`ms` is milliseconden sinds het begin van de opname. De **manifest-hash** zegt of een app sindsdien veranderd
is; de **staat-hash** is een vingerafdruk van alle waarden van een app (op 6 decimalen, op naam gesorteerd).

`samenvatting.md` — duur, hub-versie, aantallen per controller en per app (zet/trig/scene/focus) en de
eind-hash per app.

### Schrijven stoort het spelen nooit

De hub schrijft niet per gebaar naar schijf: regels gaan in een buffer en worden elke seconde (of zodra er
64 kB klaarstaat) op de achtergrond weggeschreven. Lukt dat niet — **schijf vol**, **map niet schrijfbaar**,
een extern volume dat weg is — dan meldt de hub dat één keer in zijn venster, met de map en wat je kunt doen
(*maak ruimte vrij* of *kies een andere map met "avondmap" in config.json*), en speel je gewoon door. Wat nog
niet geschreven is blijft in het geheugen (tot 16 MB) en gaat er alsnog in zodra schrijven weer lukt, in de
goede volgorde. Ging een schrijfactie halverwege mis (schijf vol midden in een blok), dan kort de hub het
bestand eerst terug tot de laatste hele regel: geen halve of dubbele regels. Wat er bij het stoppen nog steeds
niet in kon, telt de samenvatting als *verloren*.

## Herhalen

In de AV-app-hub-map, in een tweede terminalvenster:

```
npm run herhaal -- ~/Movies/varve-avonden/2026-10-03_21-04-05 [--snelheid 2] [--hub 127.0.0.1:7700] [--zonder-beginstand]
```

(Hetzelfde als `node src/cli.js herhaal …`; met `npm link` ook als `varve-hub herhaal …`.) De samenvatting.md
van elke avond heeft de regel al klaar. De hub moet draaien en de apps moeten verbonden zijn.

> **Let op:** herhaal verandert de stand van je apps en overschrijft de snapshots van toen in de hub — doe het
> niet midden in een set. `--zonder-beginstand` laat de beginstand (en de snapshots) met rust.

1. **Beginstand terug** (tenzij `--zonder-beginstand`): de snapshots van toen worden opnieuw bewaard, de waarden
   van toen gezet en de focus teruggezet — via de cockpit, dus de apps krijgen het gewoon mee. De globale stand
   (tempo, paniek, …) komt niet terug. Snapshot-plekken die nu gevuld zijn maar toen leeg waren, blijven staan;
   `herhaal` noemt ze. Een korte LPD8-druk (P5–P8) op zo'n toen lege plek wordt overgeslagen (toen gebeurde er
   niets); laden via de APC-scèneknoppen (hublaag) wordt wél afgespeeld. Een cockpit-`zet` verloopt over
   `slew_s` (PROTOCOL §12), dus `herhaal` wacht daarna de langste `slew_s` af voordat het eerste gebaar gaat.
2. **Afspelen**: de ruwe invoer gaat met dezelfde tussenpozen (gedeeld door `--snelheid`) als virtuele
   controller naar de hub, precies alsof de controllers het deden. LPD8-bytes worden eerst gelezen met het
   profiel van toen en dan als mk2-fabrieksstand gestuurd (zoals de virtuele LPD8), dus het maakt niet uit welke
   LPD8 er nu aan hangt. Overgeslagen: SysEx, **pad 4** (anders zou de herhaling zelf een opname starten) en
   het laden van een lege snapshot-plek (zie 1).
   De berichten naar apps in de opname worden niet afgespeeld — die zijn het verwachte gevolg.
3. **Vergelijken**: op hetzelfde moment als waarop de opname haar eindstand vastlegde (plus een korte naloop)
   vraagt `herhaal` de eindwaarden per app op en vergelijkt de staat-hash met de opname. Exitcode 0 = alles
   klopt, 1 = verschillen (per app en per parameter getoond), 2 = kon niet afspelen (geen hub, geen opname,
   ongeldige of ontbrekende `--snelheid`, of de hub viel halverwege weg: dan stopt `herhaal` meteen en zegt na
   hoeveel gebaren).

### Waarom het soms verschilt

- Een app veranderde tijdens de opname zelf iets (muis, automatie): dat zit niet in de controller-invoer.
- `--snelheid` ≠ 1 verandert wat tijd meet: lang drukken (P5–P8 > 600 ms = bewaren), paniek (P1 1 s vasthouden),
  tap-tempo en de slew van LPD8-macro's.
- De hub stopte (Ctrl-C) terwijl een LPD8-macro nog slewde: de eindstand is dan een tussenstand (`rust:false`,
  het verslag zegt het). Stop je met pad 4, dan wacht de opname de slew af en is er geen verschil.
- De hub weet bij het afspelen niet waar je faders fysiek stonden; pickup kan dan op een ander moment pakken.
- Een app die bij de opname verbonden was en nu niet, telt als verschil ("niet verbonden met de hub").

## Voor ontwikkelaars

- Code: `src/opname/` — `opnemer.js` (luistert naar de kern-events `opname` en `naarApp`; de hub geeft de ruwe
  bytes door vlak vóór `kern.invoer`), `schrijver.js` (buffer + flush, nooit blokkerend), `herhaal.js`
  (lezen, vertalen, afspelen, `doelVanHub` voor in-proces), `cockpit-doel.js` (afspelen via `/cockpit`),
  `staat.js` (staat-hash, vergelijken). Bedrading in `src/hub.js` (`startHub({ opname: false })` zet het uit).
- Tijd komt altijd van de geïnjecteerde `Klok`; datum, git-versie en het bestandssysteem zijn ook injecteerbaar.
- Tests: `test/opname.test.js` (spec-testbank + NepKlok + bestandssysteem in het geheugen: opnemen → afspelen,
  buffer/flush, schijf vol, map niet schrijfbaar) en `test/opname-hub.test.js` (hele hub, echte map, CLI).
