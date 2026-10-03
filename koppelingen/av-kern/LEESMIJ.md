# av-kern — koppeling met de hub (patch)

Tot de publicatie van **25 okt** raken we av-kern niet aan: geen push, geen PR, geen branch op GitHub. Daarom staat de koppeling hier als twee patches. Pas ze toe als de publicatie de deur uit is.

## Wat zit erin
- **0001 — ◄/► volgens protocol v1.2** (losse commit). In `src/kern/apc40.ts` stonden de pijlen omgedraaid (left = 96, right = 97). Volgens Akai protocol v1.2 is ► (right) 0x60 = 96 en ◄ (left) 0x61 = 97. `apc40.ts` valt **niet** onder de bevroren regel (die geldt alleen voor `midi.ts` en `bus.ts`), dus hier is het echt gerepareerd, met een test die zonder de fix faalt. In de Ademmachine zitten op ◄/► alleen AI-stubs, dus je hoort niets anders.
- **0002 — de hub-koppeling**, helemaal buiten de kern:
  - `src/ui/hub.ts` (nieuw, alleen geladen met de vlag): APC-invoer van de hub (`{t:'midi'}`) gaat door `Driver.input(bytes, 'hub')`, hetzelfde pad als de echte APC. De LED- en ringuitvoer van de driver (`Driver.onSend`, dezelfde haak als de virtuele APC) gaat per beeld gebundeld als `{t:'led'}` naar de hub. Bij (her)verbinden de hele set: ringtypes, LED's, ringen.
  - Met `?hub=ws://localhost:7700/app` roept av-kern **nooit** `requestMIDIAccess` aan en gebruikt de Web Lock `av-kern-apc` niet. De knop wordt "APC via hub". De hub zet de APC in 0x42 en tekent de ringen mee met de knop (`rings:"auto"`), zoals de APC zelf in 0x41 doet. Een `?hub=` naar een host buiten je Mac, het LAN en de tailnet wordt geweigerd (tenzij `&hub_extern=1`), en opent dan óók geen MIDI.
  - `src/ui/hub-manifest.json`: `lease:true`, `rings:"auto"`, en rollen voor de LPD8:

    | LPD8 | rol | av-kern |
    |---|---|---|
    | K1 | `macro.intensiteit` | master |
    | K2 | `macro.helderheid` | macro helderheid |
    | K3 | `macro.ruimte` | macro ruimte |
    | K4 | `macro.beweging` | macro beweging |
    | K5 | `macro.kleur` | macro kleur |
    | K6 | `macro.dichtheid` | macro dichtheid |
    | K7 | `klok.adem_periode` | ademtempo (4–14 s; de hub kent 4–16 s, boven 14 s blijft av-kern op 14) |
    | K8 | `macro.balans` | balans geluid ↔ beeld (xf) |
    | P1 (1 s) | `paniek` | Stop All: alles langzaam naar stilte en zwart |

    Korrel, contrast en adem (de diepte-macro) hebben geen passende rol en blijven van de APC. Slew zoals op de APC zelf: macro's en balans τ 1,5 s, master τ 0,15 s; een hub-snapshot (P5–P8) glijdt met τ 2 s, ook master.
  - Wat av-kern zelf verandert (APC-knop, scène) gaat terug als `zet`; de hub heeft dus altijd de echte stand (voor pickup en snapshots).
  - Kleine aansluiting in `src/main.ts`, `test/hub.test.ts` (16 tests), `scripts/hub-headless.mjs`, en `CLAUDE.md` en `LOG.md` bijgewerkt.
  - **Zonder `?hub=` verandert er niets** (headless nagemeten: geen WebSocket, `hub.ts` wordt niet geladen, "Verbind APC40" vraagt Web MIDI en de lock zoals altijd).

## Getest
- `npm test` in av-kern: 57 groen (40 bestaande + 1 voor ◄/► + 16 voor de koppeling). `npm run build` groen; `hub.ts` is een eigen chunk.
- `node scripts/hub-headless.mjs` (Chromium, met `AVKERN_HUB_REPO` naar deze repo): de conformiteitstoets van de hub (`toetsApp`) slaagt helemaal, en tegen de echte hub (`startHub` met NepSysteem, eerst een andere app met de focus): **Bank + Track Select geeft av-kern de focus**, de volledige LED-kaart van av-kern komt op de nep-APC, pad 2-1 kleurt in de Drone-kleur, tk3 zet de macro en de ring staat op de APC, LPD8 K5 → macro kleur → av-kern tekent de ring van tk1 op de APC, K1 → master, P1 → Stop All, en terug naar de andere app = geen invoer meer naar av-kern. Nooit `requestMIDIAccess`, nooit de Web Lock, alleen de hub stuurt een modus (0x42).
- In de hub: `test/koppeling-av-kern.test.js` leest het manifest uit de patch zelf en toetst het tegen de kern (focus, LED's/ringen, alle acht LPD8-knoppen, paniek).
- Gecontroleerd: beide patches passen op av-kern main **ab7e115** ("Fase 0.4: reference/ademmachine.html …") en daarna is `npm test` groen.
- **Nog niet** met je echte APC en LPD8 in je eigen Chrome.

## Toepassen (na 25 okt)
```bash
cd ~/…/av-kern                     # waar je av-kern hebt staan, op main
git switch -c varve-hub-koppeling
git am /pad/naar/AV-app-hub/koppelingen/av-kern/0001-*.patch   # ◄/► (kan ook los, eerder)
git am /pad/naar/AV-app-hub/koppelingen/av-kern/0002-*.patch   # de koppeling
npm test && npm run build
```
Staat main verder dan ab7e115 en past hij niet meer, kijk dan eerst met `git apply --check …patch`. Wil je alleen de ◄/►-fix: alleen 0001.

Gebruik: start de hub (`npm start` in AV-app-hub), dan `npm run dev` in av-kern en open `http://localhost:5173/?hub=ws://localhost:7700/app`. Focus: Bank vasthouden + Track Select van het av-kern-slot. Zonder `?hub=` is av-kern zoals altijd (dan wél eerst de hub dicht: één app tegelijk met de APC).

## Open vragen voor jou
- **Master op K1 (`macro.intensiteit`)?** Zo gevraagd. Maar de pickup van een LPD8-knop volgt de *eerste* app met die rol; staat er een andere app eerder in de hub die intensiteit als beeldintensiteit gebruikt (zoals bij Varve DJ bleek), dan kan K1 ook het geluid van av-kern dempen terwijl je naar iets anders kijkt. Voor av-kern (meditatie, alles langzaam) leek het juist goed. Eén veld weghalen in `hub-manifest.json` als je het anders wilt.
- **Balans op K8 en ademtempo op K7** heb ik erbij gedaan omdat ze precies passen (geluid ↔ beeld, ademklok). Goed zo?
- **Paniek = Stop All** (τ 10 s naar stilte en zwart, zoals de knop op de APC). Snel genoeg als paniek, of wil je een snellere variant?
- **Actielog/replay:** wat de hub zet (LPD8-knoppen, snapshots) gaat buiten `Driver.input` om en staat dus niet in het actielog. Een opname met LPD8-bewegingen speelt niet identiek terug. Oplossen kan alleen in de kern (bevroren), dus na 25 okt beslissen.
- **Tabblad op de achtergrond:** `computeLeds` loopt in `requestAnimationFrame`; staat av-kern op de achtergrond, dan komen LED-wijzigingen pas als het tabblad weer zichtbaar is (hartslag en invoer lopen wel door). Is dat zo zonder hub ook, maar met de hub wissel je vaker. Laten zo?
