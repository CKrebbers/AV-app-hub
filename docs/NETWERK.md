# Netwerk — de hub altijd aan, veilig bereikbaar vanaf tablet en Omarchy

Standaard luistert de hub alleen op de Mac zelf (`127.0.0.1`). Dat is genoeg zolang alles op de Mac draait.
Wil je de cockpit op een tablet, of flux op de Omarchy-machine aan de LPD8 hangen, dan moet de hub op het
netwerk luisteren. Dat gaat alleen met een **token**: wie in hetzelfde wifi zit maar het token niet heeft,
komt er niet in.

## Op het netwerk starten

```bash
npm start -- --lan
```

De eerste keer maakt de hub het token aan in `~/.varve-hub/token` (alleen leesbaar voor jou, `0600`). Daarna:

- de hub luistert op `0.0.0.0` (alle netwerkkaarten), poort 7700 uit `config.json`;
- **lokaal** (vanaf de Mac zelf, `127.0.0.1`) werkt alles zonder token, precies als altijd;
- **van buiten** moet elke verbinding het token tonen (zie hieronder), anders `401` of close-code `4003`;
- de hub kondigt zich aan via mDNS als `_varvehub._tcp` (zie [mDNS](#mdns)).

In een terminal drukt hij de adressen met token af:

```
Op het netwerk (met token):
  http://clays-macbook-pro.local:7700/?token=…
  http://192.168.1.20:7700/?token=…
```

Draait de hub als dienst (zonder terminal), dan komt het token níét in het logboek. Vraag de adressen op met:

```bash
node src/cli.js token
```

Dat toont het token, de cockpit-adressen en de regel voor flux (draait de hub op een andere poort: `token --poort N`). **Ander token** (tablet kwijt, token gelekt):
`node src/cli.js token --nieuw` en herstart de hub; open daarna op de tablet het nieuwe adres.

Ook een `--host` (of `server.host` in `config.json`) die niet `127.0.0.1`/`localhost` is, start met token:
een open hub op het netwerk kan niet meer per ongeluk.

## Waar het token in moet

| Wie | Hoe |
|---|---|
| cockpit op een tablet | open één keer `http://<mac>.local:7700/?token=…`. De hub geeft de browser een cookie (`HttpOnly`, `SameSite=Strict`) en stuurt hem meteen door naar hetzelfde adres zónder `?token=` (zo blijft het token niet in de adresbalk en de geschiedenis). De scripts en de `/cockpit`-WebSocket gebruiken het cookie vanzelf; zet het adres zonder token als bladwijzer. |
| apps (WebSocket `/app`) | `?token=…` in de URL: `ws://<mac>.local:7700/app?token=…`, **of** `token` in `hallo`: `{t:"hallo", app, inst, v:1, token}` (PROTOCOL.md §3). |
| `/cockpit` van een eigen client | `?token=…` in de URL of het cookie `varve_hub_token`. |
| een pagina van de hub zelf (bv. `/oefen` op de tablet) die `/app` opent | het cookie gaat vanzelf mee; ook `/app` accepteert het cookie. |

Zonder of met een verkeerd token:

- HTTP en de `/cockpit`-upgrade: `401 token nodig`;
- `/app`: de hub stuurt `welkom`, wacht op `hallo`; zonder geldig token (of een ander bericht eerst, of geen
  `hallo` binnen 3 s) volgt `{t:"fout", reden:"token nodig: …"}` en close-code **4003** (PROTOCOL.md §13). Zo'n
  verbinding bereikt de kern nooit (geen slot, geen LEDs). Het token zelf gaat nooit naar de kern of een logboek.
- Er mogen hooguit 16 van zulke verbindingen tegelijk op een `hallo` wachten (4 per adres); daarboven gaat een
  nieuwe meteen dicht. Zo kan een apparaat op je wifi zonder token de hub niet dichttrekken met duizenden
  verbindingen. In totaal neemt de hub hooguit 128 verbindingen (apps + cockpits) tegelijk aan; daarboven `503`.

Wat het token níét afschermt:

- **Andere diensten op de Mac zien het cookie.** Browsers scheiden cookies niet per poort: `varve_hub_token` gaat
  ook mee naar andere HTTP-diensten op `<mac>.local` (andere Varve-apps, TouchDesigner-webservers). Draai daar
  niets wat je niet vertrouwt, of gebruik `token --nieuw` als je twijfelt.
- **Lokaal = vertrouwd.** Alles wat via `127.0.0.1` binnenkomt hoeft geen token. Een tunnel of proxy op de Mac
  (`ssh -R`, `tailscale serve`, een reverse proxy) maakt de hub dus zonder token bereikbaar voor wie die tunnel
  kan gebruiken. Zet zo'n tunnel niet op poort 7700. Dat geldt ook voor **andere gebruikers op dezelfde Mac**: hun
  programma's kunnen via `127.0.0.1` alles wat jij kunt (het tokenbestand is wel alleen voor jou leesbaar, maar
  lokaal is het niet nodig). Deel je de Mac, draai de hub dan niet als je er niet bij bent.
- **Het verkeer is niet versleuteld.** Token, cookie en alles wat de cockpit doet gaan als gewone HTTP over je
  wifi. Gebruik `--lan` alleen op een netwerk dat je vertrouwt (thuis, niet op een festivalwifi). Een apparaat
  dat zich voordoet als `<mac>.local` (mDNS-vervalsing) kan het cookie van de tablet opvangen; zet daarom liever
  het **IP-adres** van de Mac als bladwijzer dan `<mac>.local`, en maak bij twijfel een nieuw token
  (`node src/cli.js token --nieuw`).
- **Bestandsrechten.** `~/.varve-hub` is alleen voor jou (0700), het token en `staat.json` ook (0600). Vindt de
  hub het token met te ruime rechten, dan zet hij ze terug en raadt hij `token --nieuw` aan (het kan gelezen zijn).

De **Origin- en Host-controle** blijven daarnaast gelden (tegen DNS-rebinding en vreemde websites). Met `--lan`
zijn de eigen namen van de Mac erbij gekomen: `<hostnaam>` en `<hostnaam>.local` (op poort 7700), zodat de cockpit
op `http://<mac>.local:7700` werkt. Op macOS neemt de hub de Bonjour-naam (`scutil --get LocalHostName`, dezelfde
als in Systeeminstellingen → Algemeen → Delen) erbij, ook als de hostnaam iets als `clays-mbp.fritz.box` is. Heet de Mac in het netwerk nog anders, zet die naam dan in `config.json`:

```json
"server": { "host": "127.0.0.1", "origins": [], "lan_namen": ["studio.lan"] }
```

Een browser-app op een ándere origin (bv. formula-lab op `http://<mac>.local:5174`) moet in `server.origins`
staan. Lokaal mogen apps op elke `localhost`-poort `/app` gebruiken (hun eigen dev-server), maar de **cockpit**
(`/cockpit`, waarmee je alles bedient) alleen vanaf de hub zelf (`http://localhost:7700`) of vanaf wat in
`server.origins` staat: een willekeurige pagina op een andere poort (een dev-server, een gedownload HTML-bestand
in `python -m http.server`) mag de hub niet besturen. De pagina's van de hub zijn ook niet in een frame van een
andere site te laden (tegen klik-trucs).

## mDNS

Zonder npm-pakket: de hub start als kindproces

- macOS: `dns-sd -R "Varve hub (<naam>)" _varvehub._tcp local 7700 pad=/cockpit app=/app v=1 token=nodig`
- Linux: `avahi-publish -s "Varve hub (<naam>)" _varvehub._tcp 7700 …`

Het token staat nooit in de aankondiging (`token=nodig` zegt alleen dát er een nodig is). Ontbreekt
`dns-sd`/`avahi-publish`, dan meldt de hub dat en werkt hij gewoon verder (gebruik dan het IP-adres). Stopt het
kindproces, dan start de hub hem opnieuw na 5, 10, 20 … hooguit 60 s; na 5 mislukte starts op rij (bv.
`avahi-publish` zonder draaiende `avahi-daemon`) geeft hij het op met één melding. Stopt of crasht de hub, dan
gaat het kindproces mee (geen aankondiging van een hub die er niet meer is).

Controleren:

```bash
dns-sd -B _varvehub._tcp                # macOS
avahi-browse -r _varvehub._tcp          # Linux
```

## Altijd aan

```bash
node src/cli.js installeer              # of: deploy/installeer.sh
```

schrijft het dienstbestand met het pad van **deze** checkout en de node zoals je shell hem vindt (`command -v node`,
bv. `/opt/homebrew/bin/node`, níét het opgeloste `/opt/homebrew/Cellar/node/22.x.y/…`), en zegt welke regel je moet
draaien om hem te laden. Staat node in een versiemap (nvm, Cellar), dan waarschuwt hij: na een node-update bestaat dat
pad niet meer en start de dienst stil niet. Draai na een node-update `node src/cli.js installeer` opnieuw.

Nooit met `sudo`: de dienst hoort bij jouw gebruiker (als root weigert hij).

| | macOS (launchd) | Linux (systemd --user) |
|---|---|---|
| bestand | `~/Library/LaunchAgents/nl.varve.hub.plist` | `~/.config/systemd/user/varve-hub.service` |
| laden | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/nl.varve.hub.plist` | `systemctl --user daemon-reload && systemctl --user enable --now varve-hub.service` |
| stoppen | `launchctl bootout gui/$(id -u)/nl.varve.hub` | `systemctl --user stop varve-hub.service` |
| herstart | `KeepAlive` (altijd opnieuw, na 5 s) | `Restart=on-failure` (na 5 s), niet bij exit 3/4 |
| logboek | `~/Library/Logs/varve-hub.log` | `journalctl --user -u varve-hub.service -f` |

- De dienst start `start --lan`. Alleen op de Mac zelf: `installeer --lokaal`.
- Opnieuw `installeer` (bv. na verhuizen van de checkout of een andere node) werkt het bestand bij en zegt hoe
  je hem opnieuw laadt.
- `installeer --weg` haalt het bestand weg (op Linux ook de koppeling die `enable` aanlegde) en zegt hoe je de
  draaiende hub stopt.
- Draait de dienst, dan zegt `npm start` dat poort 7700 bezet is: dat is de dienst (de melding noemt hoe je hem
  stopt). Stop die eerst als je met de hand wilt starten.
- Andersom: draait er al een hub met de hand, dan stopt de dienst met "poort bezet" (exit 3). systemd laat het
  daarbij (`RestartPreventExitStatus=3 4`; start hem later met `systemctl --user restart varve-hub.service`).
  launchd blijft het proberen zolang de poort bezet is, maar de hub wacht dan telkens een minuut voor hij stopt,
  zodat het logboek niet volloopt. Zodra de hub met de hand weg is, neemt de dienst het binnen een minuut over.
- Linux: zonder ingelogde sessie draaien user-units niet. Wil je dat wel: `loginctl enable-linger $USER`.
- Sjablonen: `deploy/nl.varve.hub.plist` en `deploy/varve-hub.service` (`{{…}}` vult `installeer` in).

## flux (Omarchy) met token

flux leest `--hub` of `VARVE_HUB`. Het token gaat in de URL:

```bash
VARVE_HUB='ws://<mac>.local:7700/app?token=…' flux-screensaver
# of een regel in flux-args:
--hub ws://<mac>.local:7700/app?token=…
```

`node src/cli.js token` op de Mac drukt deze regel kant-en-klaar af. Gecontroleerd in flux
(tak `claude/varve-hub-koppeling`): de koppeling neemt het pad **met** de query over in de handdruk
(`GET /app?token=… HTTP/1.1`), stuurt geen `Origin` en geen `token` in `hallo` — het token in de URL is dus
genoeg. Zet `flux-args` op `chmod 600` als het token erin staat. Liever nog `VARVE_HUB` als omgevingsvariabele
dan `--hub` op de opdrachtregel: argumenten zijn voor iedereen op de machine zichtbaar (`ps`), de omgeving niet.

Zonder (geldig) token sluit de hub de verbinding met 4003; flux wacht dan 30 s voor hij het opnieuw probeert, en
het beeld merkt er niets van.

`<mac>.local` lost op Omarchy (Arch) alleen op met avahi én nss-mdns (`sudo pacman -S avahi nss-mdns`, `mdns_minimal`
in `/etc/nsswitch.conf`, `systemctl enable --now avahi-daemon`). Zonder die twee faalt de flux-regel stil (flux blijft
opnieuw proberen): gebruik dan het IP-adres van de Mac uit `node src/cli.js token`.

## Problemen

| Wat je ziet | Wat het is |
|---|---|
| tablet: `token nodig` | adres zonder (goed) `?token=`; open het adres uit `node src/cli.js token` |
| tablet: `host niet toegestaan` | de naam in de adresbalk is niet de hostnaam of Bonjour-naam van de Mac; gebruik het IP-adres of zet de naam in `server.lan_namen` |
| app sluit met 4003 | geen of verkeerd token (na `token --nieuw` moeten alle adressen het nieuwe token hebben) |
| `mDNS: … niet gevonden` | geen `dns-sd`/`avahi-publish`; installeer avahi (Linux) of gebruik het IP-adres |
| `niet op … luisteren zonder token` (exit 4) | een `--host`/`server.host` buiten loopback zonder token; start met `--lan` |
| dienst start niet meer na een node-update | het node-pad in het dienstbestand bestaat niet meer; draai `node src/cli.js installeer` opnieuw |
