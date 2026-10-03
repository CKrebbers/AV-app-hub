# Varve DJ — koppeling met de hub (patch)

Varve DJ (`youtube-mixer`) heeft de huisregel **"Nooit committen"**: de repo staat op je Bureaublad (iCloud) en jij commit zelf. Daarom staat deze koppeling hier als patch en níet als branch in die repo.

## Wat zit erin
- `src/control/hub.js` (nieuw): de hub als nep-Web-MIDI-poort "APC40 mkII (hub)". Varve DJ is een **lease-app**: de hub stuurt de ruwe APC-bytes door als Varve DJ focus heeft, en de LEDs van Varve DJ gaan via de hub naar de APC. Jouw mapping, mapjes, soft-takeover en LED-feedback blijven precies zoals ze zijn.
- Met `?hub=ws://localhost:7700/app` roept Varve DJ **nooit** `requestMIDIAccess` aan (getest met een spion in Chromium). De init-SysEx (0x42) stuurt alleen de hub.
- Manifest met rollen voor de LPD8: master → K1 (`macro.intensiteit`), beeld → K2 (`macro.helderheid`), puls op de tel → K4 (`macro.beweging`), plus de crossfader (zonder rol, glijdt over 2 s bij snapshots).
- Kleine aansluitpunten in `src/ui/vlag.js`, `src/ui/app.js`, `src/ui/midi-opzet.js`; `test/hub.test.mjs` (nieuw), `tools/headless/hub.mjs` (conformiteitstoets + echte hub in Chromium), `CLAUDE.md` en `tools/README.md` bijgewerkt.
- **Zonder `?hub=` verandert er niets** (nagemeten: zelfde MIDI-verkeer, zelfde requests, `hub.js` wordt niet geladen, start niet trager).

## Getest
- `node test/alles.mjs`: alles groen behalve `ingest.test.mjs` en `wachtrij.test.mjs` — die faalden vóór deze wijziging precies zo (geen yt-dlp in de testomgeving).
- `VARVE_HUB_REPO=../AV-app-hub node tools/headless/hub.mjs`: conformiteitstoets + echte hub met nep-APC/LPD8 → alles ok.
- Nog niet met je echte APC in je eigen Chrome.

## Toepassen (jij commit zelf)
```bash
cd ~/Desktop/youtube-mixer        # of waar je VARVE hebt staan
git apply --check /pad/naar/AV-app-hub/koppelingen/varve-dj/0001-*.patch   # past hij?
git apply /pad/naar/AV-app-hub/koppelingen/varve-dj/0001-*.patch
git apply /pad/naar/AV-app-hub/koppelingen/varve-dj/0002-*.patch
node test/alles.mjs
```
Daarna `git add` per pad en committen zoals je gewend bent. Gebruik: start de hub (`npm start` in AV-app-hub) en open `http://localhost:8777/?hub=ws://localhost:7700/app`.

## Open vragen voor jou
- **Paniek:** er bestaat geen veilige "stop alles" in Varve DJ (Stop All = alleen de focus-track remmen). Wat moet paniek hier doen — beeld zwart + alle decks remmen? Nu doet LPD8-P1 niets in Varve DJ.
- **Crossfader op K8 (`macro.balans`)?** Bewust niet: een globale knop die midden in een set van A naar B schuift leek niet veilig. Is één veld als je het wel wilt.
- **Snapshots** (P5–P8) zetten ook master en crossfader (glijdend). Gewenst, of moet Varve DJ snapshots negeren?
