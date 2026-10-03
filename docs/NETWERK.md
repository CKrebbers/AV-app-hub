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

Dat toont het token, de cockpit-adressen en de regel voor flux. **Ander token** (tablet kwijt, token gelekt):
`node src/cli.js token --nieuw` en herstart de hub; open daarna op de tablet het nieuwe adres.

Ook een `--host` (of `server.host` in `config.json`) die niet `127.0.0.1`/`localhost` is, start met token:
een open hub op het netwerk kan niet meer per ongeluk.

## Waar het token in moet

| Wie | Hoe |
|---|---|
| cockpit op een tablet | open één keer `http://<mac>.local:7700/?token=…` (zet hem als bladwijzer). De hub geeft de browser een cookie (`HttpOnly`, `SameSite=Strict`); de scripts en de `/cockpit`-WebSocket gebruiken dat vanzelf. |
| apps (WebSocket `/app`) | `?token=…` in de URL: `ws://<mac>.local:7700/app?token=…`, **of** `token` in `hallo`: `{t:"hallo", app, inst, v:1, token}` (PROTOCOL.md §3). |
| `/cockpit` van een eigen client | `?token=…` in de URL of het cookie `varve_hub_token`. |

Zonder of met een verkeerd token:

- HTTP en de `/cockpit`-upgrade: `401 token nodig`;
- `/app`: de hub stuurt `welkom`, wacht op `hallo`; zonder geldig token volgt `{t:"fout", reden:"token nodig: …"}` en
  close-code **4003**. Zo'n verbinding bereikt de kern nooit (geen slot, geen LEDs). Het token zelf gaat nooit
  naar de kern of een logboek.

De **Origin- en Host-controle** blijven daarnaast gelden (tegen DNS-rebinding en vreemde websites). Met `--lan`
zijn de eigen namen van de Mac erbij gekomen: `<hostnaam>` en `<hostnaam>.local` (op poort 7700), zodat de cockpit
op `http://<mac>.local:7700` werkt. Heet de Mac in het netwerk nog anders, zet die naam dan in `config.json`:

```json
"server": { "host": "127.0.0.1", "origins": [], "lan_namen": ["studio.lan"] }
```

Een browser-app op een ándere origin (bv. formula-lab op `http://<mac>.local:5174`) moet, net als lokaal, in
`server.origins` staan.

## mDNS

Zonder npm-pakket: de hub start als kindproces

- macOS: `dns-sd -R "Varve hub (<naam>)" _varvehub._tcp local 7700 pad=/cockpit app=/app v=1 token=nodig`
- Linux: `avahi-publish -s "Varve hub (<naam>)" _varvehub._tcp 7700 …`

Het token staat nooit in de aankondiging (`token=nodig` zegt alleen dát er een nodig is). Ontbreekt
`dns-sd`/`avahi-publish`, dan meldt de hub dat en werkt hij gewoon verder (gebruik dan het IP-adres). Stopt het
kindproces, dan start de hub hem opnieuw na 5, 10, 20 … hooguit 60 s.

Controleren:

```bash
dns-sd -B _varvehub._tcp                # macOS
avahi-browse -r _varvehub._tcp          # Linux
```

## Altijd aan

```bash
node src/cli.js installeer              # of: deploy/installeer.sh
```

schrijft het dienstbestand met het pad van **deze** checkout en de node waarmee je het draait, en zegt welke
regel je moet draaien om hem te laden. Nooit met `sudo`: de dienst hoort bij jouw gebruiker (als root weigert
hij).

| | macOS (launchd) | Linux (systemd --user) |
|---|---|---|
| bestand | `~/Library/LaunchAgents/nl.varve.hub.plist` | `~/.config/systemd/user/varve-hub.service` |
| laden | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/nl.varve.hub.plist` | `systemctl --user daemon-reload && systemctl --user enable --now varve-hub.service` |
| stoppen | `launchctl bootout gui/$(id -u)/nl.varve.hub` | `systemctl --user stop varve-hub.service` |
| herstart | `KeepAlive` (altijd opnieuw, na 5 s) | `Restart=on-failure` (na 5 s) |
| logboek | `~/Library/Logs/varve-hub.log` | `journalctl --user -u varve-hub.service -f` |

- De dienst start `start --lan`. Alleen op de Mac zelf: `installeer --lokaal`.
- Opnieuw `installeer` (bv. na verhuizen van de checkout of een andere node) werkt het bestand bij en zegt hoe
  je hem opnieuw laadt.
- `installeer --weg` haalt het bestand weg (op Linux ook de koppeling die `enable` aanlegde) en zegt hoe je de
  draaiende hub stopt.
- Draait de dienst, dan zegt `npm start` dat poort 7700 bezet is: dat is de dienst. Stop die eerst als je met de
  hand wilt starten.
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
genoeg. Zet `flux-args` op `chmod 600` als het token erin staat.

Zonder (geldig) token sluit de hub de verbinding met 4003; flux probeert het dan rustig opnieuw (0,5 → 5 s) en
het beeld merkt er niets van.

## Problemen

| Wat je ziet | Wat het is |
|---|---|
| tablet: `token nodig` | adres zonder (goed) `?token=`; open het adres uit `node src/cli.js token` |
| tablet: `host niet toegestaan` | de naam in de adresbalk is niet de hostnaam van de Mac; gebruik het IP-adres of zet de naam in `server.lan_namen` |
| app sluit met 4003 | geen of verkeerd token (na `token --nieuw` moeten alle adressen het nieuwe token hebben) |
| `mDNS: … niet gevonden` | geen `dns-sd`/`avahi-publish`; installeer avahi (Linux) of gebruik het IP-adres |
| `Deze hub geeft het token niet door` | `src/hub.js` geeft `token` niet aan de server; de hub weigert dan het netwerk |
