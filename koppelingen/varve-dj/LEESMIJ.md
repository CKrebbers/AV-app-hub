# Varve DJ — koppeling met de hub (patch)

## Stand 6 okt 2026: beide patches staan op `youtube-mixer` main

| patch | wat | stand |
|---|---|---|
| `0001` | Hub-koppeling: VARVE als lease-app (`?hub=ws://…`) | **op main** |
| `0002` | Reviews verwerkt: hartslag op tijd, K1 los van master, paniek | **op main** |

- Toegepast met `git apply` op main `99c7fa2` (de basis van de patches), in zes commits `219880f` … `a95bf6a`, samengevoegd in merge **`0e19b0e`** (PR #6, 5 okt). Clay koos: los op main, niet via de PR-stapel #3 → #5.
- Nagekeken 6 okt via GitHub: `src/control/hub.js`, `test/hub.test.mjs` en `tools/headless/hub.mjs` op main zijn byte-gelijk aan wat 0001 + 0002 uit deze map opleveren (`git hash-object`). Volgens PR #6: `test/hub.test.mjs` 60/60 groen.
- De regel "Nooit committen" in Varve DJ ging alleen over de iCloud-conflictkopieën (bestanden met " 2" in de naam), niet over committen zelf.

### Toepassen
**Niet meer nodig, en niet meer doen.** De patches zitten al in main; `git apply` faalt daar (de nieuwe bestanden bestaan al). Op je Mac alleen main binnenhalen:

```bash
cd ~/…/youtube-mixer      # waar je Varve DJ hebt staan
git switch main && git pull
node test/hub.test.mjs
```
Gebruik: start de hub (`npm start` in AV-app-hub) en open `http://localhost:8777/?hub=ws://localhost:7700/app`.

### Wat nog open is
- **Niet getest met je echte APC en LPD8** in je eigen Chrome. `tools/headless/hub.mjs` is na het toepassen op main niet gedraaid.
- **Vragen N1 en N2** in `docs/VRAGEN.md` (blok N, op main): K1 (`macro.intensiteit`) doet nu niets in VARVE; Bank is met `?hub=` de hubtoets, dus keylock heeft een andere toets nodig.
- **Studio-PR's #3, #4 en #5 staan nog open.** #5 (`studio/integratie`) heeft main `0e19b0e` nu als basis en bevat dezelfde hub-koppeling. PR #6 voorzag bij het mergen van #3 een conflict in `docs/VRAGEN.md` (twee blokken "N": het hub-blok wordt dan **O**) en in `docs/HANDOFF.md` (twee secties "3 OKT").
- **Xboard49 en Maschine MK2 (de Varve-kant)** komen niet als derde patch hier: ze zijn gebouwd op `studio/integratie` (PR #5): `speelt` in het manifest, eigen nep-poorten via `speelPoort(dev)`, `src/control/maschine.js` en `maschine-scherm.js`. Nog **niet op main**; ze komen mee met PR #5. Niet bespeeld.
- **In deze repo nog niet bijgewerkt** (gaan nog uit van "patch, jij commit zelf"): `tools/repetitie.mjs` past de patches nog toe op `origin/main` van youtube-mixer, en dat faalt nu. Tot dat is aangepast: zet `"varve-dj"` in `sets/paden.json` (of `REPETITIE_VARVE_DJ`) naar je youtube-mixer-checkout op main. Ook de hint in `src/check/koppelingen.js`, `STATUS.md`, `sets/scene-kit.json` en `docs/REPETITIE.md` noemen nog de patch.

---

## Geschiedenis (3–5 okt)

Wat hieronder staat, is hoe het op 3 okt was bedoeld. Op 5 okt (middag) kwamen beide patches als commits op de tak `studio/integratie` (PR #5); op 5 okt (avond) los op main (PR #6, zie boven).

Varve DJ (`youtube-mixer`) had volgens ons de huisregel **"Nooit committen"**: de repo staat op je Bureaublad (iCloud) en jij commit zelf. Daarom kwam deze koppeling hier als patch en níet als branch in die repo. (Die regel bleek alleen over de iCloud-conflictkopieën te gaan.)

### Wat zit erin
- `src/control/hub.js` (nieuw): de hub als nep-Web-MIDI-poort "APC40 mkII (hub)". Varve DJ is een **lease-app**: de hub stuurt de ruwe APC-bytes door als Varve DJ focus heeft, en de LEDs van Varve DJ gaan via de hub naar de APC. Jouw mapping, mapjes, soft-takeover en LED-feedback blijven precies zoals ze zijn.
- Met `?hub=ws://localhost:7700/app` roept Varve DJ **nooit** `requestMIDIAccess` aan (getest met een spion in Chromium). De init-SysEx (0x42) stuurt alleen de hub.
- Manifest met rollen voor de LPD8: master → K1 (`macro.intensiteit`), beeld → K2 (`macro.helderheid`), puls op de tel → K4 (`macro.beweging`), plus de crossfader (zonder rol, glijdt over 2 s bij snapshots).
- Kleine aansluitpunten in `src/ui/vlag.js`, `src/ui/app.js`, `src/ui/midi-opzet.js`; `test/hub.test.mjs` (nieuw), `tools/headless/hub.mjs` (conformiteitstoets + echte hub in Chromium), `CLAUDE.md` en `tools/README.md` bijgewerkt.
- **Zonder `?hub=` verandert er niets** (nagemeten: zelfde MIDI-verkeer, zelfde requests, `hub.js` wordt niet geladen, start niet trager).

### Getest (3 okt)
- `node test/alles.mjs`: alles groen behalve `ingest.test.mjs` en `wachtrij.test.mjs` — die faalden vóór deze wijziging precies zo (geen yt-dlp in de testomgeving).
- `VARVE_HUB_REPO=../AV-app-hub node tools/headless/hub.mjs`: conformiteitstoets + echte hub met nep-APC/LPD8 → alles ok.
- Nog niet met je echte APC in je eigen Chrome.

### Toepassen (3 okt; niet meer doen, zie boven)
Gebaseerd op `youtube-mixer` main **99c7fa2** ("Merge remote-tracking branch 'origin/main' into claude/ecstatic-feynman-sm6x58"). Staat je kopie verder terug, haal dan eerst main binnen. Gecontroleerd: beide patches passen op 99c7fa2 en `node test/hub.test.mjs` is daarna groen.

```bash
cd ~/Desktop/youtube-mixer        # of waar je VARVE hebt staan
git apply --check /pad/naar/AV-app-hub/koppelingen/varve-dj/0001-*.patch   # past hij?
git apply /pad/naar/AV-app-hub/koppelingen/varve-dj/0001-*.patch
git apply /pad/naar/AV-app-hub/koppelingen/varve-dj/0002-*.patch
node test/alles.mjs
```
Daarna `git add` per pad en committen zoals je gewend bent. Gebruik: start de hub (`npm start` in AV-app-hub) en open `http://localhost:8777/?hub=ws://localhost:7700/app`.

### Open vragen voor jou (3 okt)
- ~~**Paniek:** er bestaat geen veilige "stop alles" in Varve DJ (Stop All = alleen de focus-track remmen). Wat moet paniek hier doen — beeld zwart + alle decks remmen? Nu doet LPD8-P1 niets in Varve DJ.~~ Opgelost in 0002: LPD8-P1 (1 s vasthouden) = `video.black.hold`, het eindbeeld zwart zolang je vasthoudt; de audio blijft.
- **Crossfader op K8 (`macro.balans`)?** Bewust niet: een globale knop die midden in een set van A naar B schuift leek niet veilig. Is één veld als je het wel wilt.
- **Snapshots** (P5–P8) zetten ook master en crossfader (glijdend). Gewenst, of moet Varve DJ snapshots negeren?

### Volgende stap: de Xboard49 en de Maschine MK2 (stand 3–5 okt)

> **6 okt:** dit is intussen gebouwd op `studio/integratie` (PR #5, open), niet als derde patch hier. Zie "Wat nog open is" boven.

Sinds golf 9 opent de hub ook het keyboard (E-MU Xboard49) en de Maschine MK2 en geeft ze door aan de lease-app die
speelt (PROTOCOL §17; de indeling van de Maschine: `docs/MASCHINE.md`). De hub-kant is af en getest; **de Varve-kant
bouwen we pas met jouw OK**, als een derde patch hier. Tot dan verandert er voor Varve DJ niets: de huidige `HubMidi`
negeert `midi` met een andere `dev` dan `apc40`, en zonder `speelt` in het manifest stuurt de hub hem ook niets.

Wat er in `youtube-mixer` moet gebeuren (zelfde patroon als de APC: geen `requestMIDIAccess`, alles achter `?hub=`):

1. **Manifest:** `speelt: ['xboard49', 'maschine-mk2']` in `MANIFEST` (`src/control/hub.js`). Alleen met `lease: true`
   (dat is Varve DJ al).
2. **Twee nep-poorten erbij in `HubMidi`**, naast "APC40 mkII (hub)":
   - **"Xboard49 (hub)"** — alleen een ingang (`access.inputs`). `{t:'midi', dev:'xboard49', bytes}` →
     `poortXboard.onmidimessage`. Ruwe bytes van het keyboard: noten, aftertouch, pitchbend, CC1, CC64, de 16 knoppen
     (CC's: `xboard49-profiel.json` na de proef), en de schuif als SysEx `F0 7F 7F 04 01 ll mm F7` (dus `sysex: true`).
   - **"Maschine MK2 (hub)"** — ingang én uitgang. `{t:'midi', dev:'maschine-mk2', bytes}` → `poortMaschine.onmidimessage`
     (virtuele MIDI: pads noot 36–51 met status `0x90` (kanaal 0), knoppen noot 0–47 met status `0x91` (kanaal 1),
     draaiknoppen CC 16–23 en masterwiel CC 24, relatief). Wat Varve DJ naar die uitgang stuurt (`send`), gaat per beeld gebundeld als
     `{t:'led', dev:'maschine-mk2', bytes:[…]}`: noot aan op hetzelfde nummer, pads en groepknoppen velocity =
     APC-paletindex (dezelfde kleuren als de APC), andere knoppen velocity = helderheid.
   - **Schermen** (optioneel): `{t:'scherm', dev:'maschine-mk2', nr: 0|1, data: <base64 van 2048 bytes>}` — 256×64,
     1 bit, rij voor rij, hoogste bit links. Bijvoorbeeld de naam van het deck of de BPM.
3. **Niet op focus filteren voor deze twee.** De APC-invoer laat `HubMidi` nu alleen door met focus (of als loslaten).
   Voor de speelapparaten beslist de hub wie speelt (de app met APC-focus, anders de laatst gefocuste die ze speelt), en
   een loslaten komt altijd bij wie het indrukken kreeg. Varve DJ moet ze dus altijd doorlaten.
4. **Mapping:** de `MidiHub`/mapping kent de APC; voor het keyboard en de Maschine is een eigen profiel nodig in
   `src/control/devices/` (welke pad of knop wat doet in Varve DJ). Dat is een keuze voor jou: wat wil je met de pads
   en het keyboard spelen?
5. **Test:** `node tools/nep-hub.mjs --toets` toetst nu ook een app die speelt (hij stuurt de MIDI van beide apparaten
   en kijkt dat LED's en schermen alleen naar apparaten uit `speelt` gaan). Probeer het eerst tegen
   `node tools/nep-app.mjs --speelt` om te zien hoe het hoort.
