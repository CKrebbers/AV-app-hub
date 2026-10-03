# av-kern — koppeling met de hub (patch)

Tot de publicatie van **25 okt** raken we av-kern niet aan: geen push, geen PR, geen branch op GitHub. Daarom staat de koppeling hier als twee patches. Pas ze toe als de publicatie de deur uit is.

## Wat zit erin
- **0001 — ◄/► volgens protocol v1.2** (losse commit). In `src/kern/apc40.ts` stonden de pijlen omgedraaid (left = 96, right = 97). Volgens Akai protocol v1.2 is ► (right) 0x60 = 96 en ◄ (left) 0x61 = 97. `apc40.ts` valt **niet** onder de bevroren regel (die geldt alleen voor `midi.ts` en `bus.ts`), dus hier is het echt gerepareerd, met een test die zonder de fix faalt. In de Ademmachine zitten op ◄/► alleen AI-stubs, dus je hoort niets anders.
- **0002 — de hub-koppeling**, helemaal buiten de kern:
  - `src/ui/hub.ts` (nieuw, alleen geladen met de vlag): APC-invoer van de hub (`{t:'midi'}`) gaat door `Driver.input(bytes, 'hub')`, hetzelfde pad als de echte APC. Alleen volledige note- en CC-berichten (3 bytes, databytes ≤ 127). De LED- en ringuitvoer van de driver (`Driver.onSend`, dezelfde haak als de virtuele APC) gaat per beeld gebundeld als `{t:'led'}` naar de hub. Bij (her)verbinden de hele set: ringtypes, LED's, ringen.
  - De LPD8-rollen (`zet`) en paniek (`trig`) zet `hub.ts` **direct** op de bus (`Bus.set`/`stopAll`), dus buiten `Driver.input` om en niet in het actielog (zie open vragen). Tijdens een replay negeert hij zets van de hub; paniek werkt dan bewust wel.
  - Met `?hub=ws://localhost:7700/app` roept av-kern **nooit** `requestMIDIAccess` aan en gebruikt de Web Lock `av-kern-apc` niet. De knop wordt "APC via hub". De hub zet de APC in 0x42 en tekent de ringen mee met de knop (`rings:"auto"`), zoals de APC zelf in 0x41 doet. De keuze zit in één pure functie, `apcBron()` in `src/ui/hub-vlag.ts`, met tests.
  - Een `?hub=` wordt geweigerd (en opent dan óók geen MIDI) als het geen `ws://`/`wss://`-adres is (melding: "moet met ws:// beginnen, bv. …"), of als de host niet op je Mac, het LAN (ook `.local`) of je tailnet-IP's (100.64.0.0/10) staat. Namen op `*.ts.net` tellen **niet** als eigen tailnet: daar vallen ook publieke Funnel-adressen van anderen onder. Voor zo'n host: `&hub_extern=1`.
  - `src/ui/hub-manifest.json`: `lease:true`, `rings:"auto"`, en rollen voor de LPD8. Geen `kleur`: die komt uit `config.json` van de hub (`apps.av-kern.kleur`), één bron.

    | LPD8 | rol | av-kern |
    |---|---|---|
    | K1 | `macro.intensiteit` | master |
    | K2 | `macro.helderheid` | macro helderheid |
    | K3 | `macro.ruimte` | macro ruimte |
    | K4 | `macro.beweging` | macro beweging |
    | K5 | `macro.kleur` | macro kleur |
    | K6 | `macro.dichtheid` | macro dichtheid |
    | K7 | `klok.adem_periode` | ademtempo (4–14 s; de hub kent 4–16 s, boven 14 s blijft av-kern op 14 en meldt dat terug) |
    | K8 | `macro.balans` | balans geluid ↔ beeld (xf) |
    | P1 (1 s) | `paniek` | Stop All: alles langzaam naar stilte en zwart |

    Korrel, contrast en adem (de diepte-macro) hebben geen passende rol en blijven van de APC. Slew zoals op de APC zelf: macro's en balans τ 1,5 s, master τ 0,15 s; een hub-snapshot (P5–P8) glijdt met τ 2 s, ook master.
  - Wat av-kern zelf verandert (APC-knop, scène), of niet overneemt (ademtempo > 14 s), gaat terug als `zet`; de hub heeft dus altijd de echte stand (voor pickup en snapshots).
  - Valt de hub weg, dan laat av-kern alleen een Shift los die via de hub kwam. Een Shift van het toetsenbord of de virtuele APC blijft staan.
  - Statusregel: "Hub niet bereikbaar (…): start de hub met `npm start` in AV-app-hub; AV-kern probeert het zelf opnieuw". Bij een nieuwer tabblad: "…: sluit dit tabblad". Mislukt het laden van `hub.ts`, dan staat dat er ook.
  - Kleine aansluiting in `src/main.ts`, `test/hub.test.ts` (25 tests), `scripts/hub-headless.mjs`.
  - **`LOG.md` en `CLAUDE.md` zitten er bewust níét in**: die veranderen elke sessie, en dan loopt `git am` vast. De tekst staat hieronder, om na het toepassen te plakken.
  - **Zonder `?hub=` verandert er niets** (`apcBron` → `midi`; headless nagemeten: geen WebSocket, `hub.ts` wordt niet geladen, "Verbind APC40" vraagt Web MIDI en de lock zoals altijd).

## Getest
- `npm test` in av-kern: 66 groen (40 bestaande + 1 voor ◄/► + 25 voor de koppeling). `npm run build` groen; `hub.ts` is een eigen chunk.
- `node scripts/hub-headless.mjs` (Chromium, met `AVKERN_HUB_REPO` naar deze repo): de conformiteitstoets van de hub (`toetsApp`) slaagt helemaal; een geweigerd `?hub=` (`localhost:7700` en `ws://voorbeeld.nl/app`) geeft 0× MIDI, 0× lock en de juiste melding; en tegen de echte hub (`startHub` met NepSysteem, eerst een andere app met de focus): **Bank + Track Select geeft av-kern de focus**, de volledige LED-kaart van av-kern komt op de nep-APC, pad 2-1 kleurt in de Drone-kleur, tk3 zet de macro en de ring staat op de APC, LPD8 K5 → macro kleur → av-kern tekent de ring van tk1 op de APC, K1 → master, P1 → Stop All, en terug naar de andere app = geen invoer meer naar av-kern. Nooit `requestMIDIAccess`, nooit de Web Lock, alleen de hub stuurt een modus (0x42). De hubtoets en de LPD8-knoppen haalt het script uit de config en `ROLLEN` van de hub.
- In de hub: `test/koppeling-av-kern.test.js` leest het manifest uit de patch zelf en toetst het tegen de kern (focus, LED's/ringen, alle acht LPD8-knoppen, paniek), en bewaakt dat de patches `LOG.md`/`CLAUDE.md` niet raken.
- Gecontroleerd: beide patches passen op av-kern main **ab7e115** ("Fase 0.4: reference/ademmachine.html …"), én op ab7e115 plus een extra `LOG.md`-regel en een gewijzigde `CLAUDE.md` (zoals main er na een paar sessies uitziet). Daarna is `npm test` groen.
- **Nog niet** met je echte APC en LPD8 in je eigen Chrome.

## Toepassen (na 25 okt)
```bash
cd ~/…/av-kern                     # waar je av-kern hebt staan, op main
git switch -c varve-hub-koppeling
git apply --check /pad/naar/AV-app-hub/koppelingen/av-kern/000*.patch   # past het nog? (geen uitvoer = ja)
git am -3 /pad/naar/AV-app-hub/koppelingen/av-kern/0001-*.patch   # ◄/► (kan ook los, eerder)
git am -3 /pad/naar/AV-app-hub/koppelingen/av-kern/0002-*.patch   # de koppeling
npm test && npm run build
```
Loopt `git am -3` toch vast op een conflict (iemand heeft `main.ts` of `apc40.ts` intussen veranderd): `git status` toont het bestand met `UU`. Kun je het zelf oplossen, los het op en doe `git add <bestand> && git am --continue`. Anders: `git am --abort` (alles terug zoals het was) en vraag Claude de patch opnieuw te maken op de nieuwe main. Wil je alleen de ◄/►-fix: alleen 0001.

Daarna, met de hand (die bestanden veranderen elke sessie, dus niet in de patch):

1. **`LOG.md`**: zet deze regel onderaan, met de datum van toepassen:

   ```
   - <datum> · koppeling AV-app-hub toegepast (patch van 2026-10-03, Claude Code): `?hub=ws://…` → `src/ui/hub.ts` (lease, `rings:"auto"`, rollen voor de LPD8, paniek = Stop All); zonder vlag niets anders (`apcBron`). 66 tests groen, build groen, headless tegen de conformiteitstoets én de echte hub met nep-APC/LPD8 groen (Bank + Track Select geeft focus, LED's en ringen op de APC). Apart: ◄/► in `apc40.ts` naar protocol v1.2. **Niet getest:** de echte APC/LPD8 via de hub in Clay's Chrome. Let op: `zet`s van de hub (LPD8) staan niet in het actielog, dus een replay met LPD8-bewegingen is niet identiek (tijdens een replay negeert av-kern ze wel).
   ```

2. **`CLAUDE.md`**: zet deze alinea na het stuk over het signaalpad (vóór `## Commando's`):

   ```markdown
   ## AV-app-hub (`?hub=ws://localhost:7700/app`)

   Met die vlag bezit de AV-app-hub (repo AV-app-hub) de APC40 en de LPD8, en praat AV-kern alleen met de hub: `src/ui/hub.ts` (buiten de kern, alleen met de vlag geladen; de keuze zit in `apcBron()` in `src/ui/hub-vlag.ts`). Dan wordt `requestMIDIAccess` **nooit** aangeroepen en de Web Lock `av-kern-apc` niet gebruikt, ook niet bij een geweigerd `?hub=`; de hub zet de APC in modus 0x42 en tekent de ringen mee (`rings:"auto"`). APC-invoer komt als `{t:'midi'}` binnen en gaat door `Driver.input(bytes, 'hub')`; de LED-uitvoer van de driver (`Driver.onSend`) gaat als `{t:'led'}` naar de hub. Focus: Bank + Track Select op de APC. LPD8-macro's via rollen in `src/ui/hub-manifest.json` (master, kleur, ruimte, beweging, dichtheid, helderheid, balans, ademtempo; P1 = Stop All); die zet `hub.ts` direct op de bus, buiten het actielog. **Zonder vlag verandert er niets.** Toets: `npm test` (`test/hub.test.ts`) en `node scripts/hub-headless.mjs` (conformiteitstoets van de hub + echte hub met nep-APC/LPD8 in Chromium; zet `AVKERN_HUB_REPO` als de hub niet naast deze repo staat).
   ```

Optioneel, de headless-toets op je Mac (Chrome in plaats van de Chromium uit de testomgeving):
```bash
AVKERN_HUB_REPO=/pad/naar/AV-app-hub \
AVKERN_CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
node scripts/hub-headless.mjs
```
Veilig met de APC aangesloten: het script vangt `requestMIDIAccess` in elke pagina af.

Gebruik: start de hub (`npm start` in AV-app-hub), dan `npm run dev` in av-kern en open `http://localhost:5173/?hub=ws://localhost:7700/app`. Focus: Bank vasthouden + Track Select van het av-kern-slot. Zonder `?hub=` is av-kern zoals altijd (dan wél eerst de hub dicht: één app tegelijk met de APC).

## Open vragen voor jou
- **Master op K1 (`macro.intensiteit`)?** Zo gevraagd. Maar de pickup van een LPD8-knop volgt de *eerste* app met die rol; staat er een andere app eerder in de hub die intensiteit als beeldintensiteit gebruikt (zoals bij Varve DJ bleek), dan kan K1 ook het geluid van av-kern dempen terwijl je naar iets anders kijkt. Voor av-kern (meditatie, alles langzaam) leek het juist goed. Eén veld weghalen in `hub-manifest.json` als je het anders wilt.
- **Balans op K8 en ademtempo op K7** heb ik erbij gedaan omdat ze precies passen (geluid ↔ beeld, ademklok). Goed zo?
- **Paniek = Stop All** (τ 10 s naar stilte en zwart, zoals de knop op de APC). Snel genoeg als paniek, of wil je een snellere variant? Paniek werkt ook tijdens een replay (bewust: stilte gaat voor), en verandert die replay dan.
- **Actielog/replay:** wat de hub zet (LPD8-knoppen, snapshots) gaat buiten `Driver.input` om en staat dus niet in het actielog. Een opname met LPD8-bewegingen speelt niet identiek terug. Tijdens een replay negeert av-kern hub-zets wel, zodat de replay zelf niet verstoord wordt. Echt oplossen (zets in het log) kan alleen in de kern (bevroren), dus na 25 okt beslissen.
- **Tabblad op de achtergrond:** `computeLeds` loopt in `requestAnimationFrame`; staat av-kern op de achtergrond, dan komen LED-wijzigingen pas als het tabblad weer zichtbaar is (hartslag en invoer lopen wel door). Is dat zo zonder hub ook, maar met de hub wissel je vaker. Laten zo?
- **Hub op een `*.ts.net`-naam?** Die vraagt nu `&hub_extern=1` (publieke Funnel-namen vallen er ook onder). Gebruik je de hub via je tailnet, dan kan het tailnet-IP (100.x) zonder extra vlag; of we halen je eigen tailnet-naam uit een instelling.
