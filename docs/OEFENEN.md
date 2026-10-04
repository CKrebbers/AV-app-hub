# Oefenen

Een pagina in de hub om de basis te leren, in 14 korte lessen. Je oefent met twee eenvoudige apps, **Zon** en **Zee**. Die praten met de hub zoals formula-lab of waterschaal dat doen. Zo leer je het echte gedrag: focus, pickup, rollen, slew, snapshots en paniek.

## Starten

```bash
npm start              # de hub
```

Open daarna **http://localhost:7700/oefen**, of klik op "oefenen" in de cockpit. Zon en Zee verbinden vanzelf.

- **Met je APC40 en LPD8:** sluit ze aan voordat je de hub start.
- **Zonder controllers:** gebruik de virtuele APC40 en LPD8 onderaan de pagina. Die klappen vanzelf open als er niets is aangesloten.
- **Wat te doen:** de knop die je moet gebruiken, licht geel op op de virtuele controllers. Scroll je naar beneden, dan blijft de opdracht onderaan in beeld.
- **Vastgelopen?** Na 20 seconden verschijnt een tip.
- **Glijdt iets** (slew, PROTOCOL.md §12), dan toont de rij van die parameter bij Zon of Zee een gele streep op het doel en `→ 80% · 2,1 s` (doel en resttijd), net als in de cockpit; de balk zelf is waar de app nu is.
- **Voortgang:** de pagina onthoudt waar je was. Met de bolletjes bovenaan spring je naar elke les.

## De lessen

| # | Les | Wat je doet |
|---|---|---|
| 1 | Welkom | Zon en Zee verbinden met de hub |
| 2 | Focus | Bank vasthouden + Track Select: van app wisselen |
| 3 | Fader | fader 1 en 2 bedienen de app met focus |
| 4 | Pickup | waarom een fader soms niets doet, en hoe hij oppakt |
| 5 | Device-knop | knop + lichtring |
| 6 | Pads | schakelaar, trigger, keuze-kolom |
| 7 | Wisselen | dezelfde fader, een andere app |
| 8 | LPD8 | K2 (helderheid): één knop, alle apps |
| 9 | Slew | K3 (ruimte): de Galm van de Zee glijdt na |
| 10 | Snapshot | pad 8 lang = bewaren, kort = laden (snapshot 4) |
| 11 | Paniek | pad 1 een seconde vasthouden |
| 12 | Tempo en adem | pad 2 tappen, K7 draaien |
| 13 | Opnemen | pad 4 (alleen uitleg) |
| 14 | Glijden zien | K3 weg, dan pad 8 kort (snapshot 4 uit les 10; zonder die snapshot alleen K3): het glij-teken bij de Galm (→ doel · resttijd) verschijnt en verdwijnt; waarom een snapshot of de LPD8 zacht gaat |

## Goed om te weten

- **Andere apps die ook verbonden zijn**, merken het als je oefent. De LPD8, snapshots en paniek werken ook op die apps. De pagina waarschuwt als er andere apps verbonden zijn. Oefen daarom liefst met alleen de hub.
- **Eén tab tegelijk.** Open je /oefen in een tweede tab of venster, dan neemt die Zon en Zee over; de oude tab zegt dat en probeert het elke 30 s opnieuw.
- **Na het sluiten van de pagina** staan Zon en Zee als "weg" in de cockpit. Hun slots komen vrij zodra een echte app een slot nodig heeft.
- **Snapshot 4 en het tempo** blijven na de les staan, net als op een echte avond. De les gebruikt snapshot 4, zodat je snapshots 1–3 heel blijven. Staat er al een snapshot 4, dan waarschuwt de les eerst.

## Hoe het werkt (voor ontwikkelaars)

- `ui/oefen/apps.js`: de manifesten van Zon en Zee en een kleine app-client (`OefenApp`).
- `ui/oefen/lessen.js`: de lessen en de `Leraar`. Puur, zonder DOM of timers. Na elke gebeurtenis kijkt de Leraar of de stap gelukt is. Er zijn drie soorten gebeurtenissen: het cockpit-beeld, controller-invoer, en wat de hub naar Zon en Zee stuurt.
- `ui/oefen/tekening.js`: het tafereel.
- `ui/oefen.js`: de pagina zelf.
- Tests:
  - `test/oefen.test.js`: een gesimuleerde leerling haalt alle lessen tegen de echte hub, via de virtuele controllers.
  - `test/oefen-ui.test.js`: dezelfde pagina in Chromium.
