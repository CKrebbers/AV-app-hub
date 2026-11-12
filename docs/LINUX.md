# De hub op Linux (Omarchy)

Thuis draait de hub op de Omarchy-pc (Arch, Hyprland), onderweg op de Mac (werkplek `bediening/SYSTEEM.md` §6). De
eerste Linux-test (22-10-2026, zonder hardware) liet zien dat alles werkt: installeren, alle tests, `doctor`, `check` en
`start`, MIDI via ALSA (ook de virtuele poorten) en HID voor de Maschine. Wat op Linux anders is, staat hieronder.

## Installeren

Er is **geen systeempakket nodig**: `@julusian/midi` (RtMidi/ALSA) en `node-hid` (hidraw) komen als kant-en-klare
prebuilds voor `linux-x64`; er wordt niets gecompileerd (geen ALSA-headers, hidapi of libusb).

- **Node via mise** (zoals de rest op deze pc): `mise use -g node@22` of nieuwer (de hub vraagt Node ≥ 22; Node 26 werkt).
  `node --version` moet het tonen.
- In de map van de hub:

```bash
npm ci                      # precies wat in package-lock.json staat
node src/cli.js doctor      # wat ziet de hub? MIDI-poorten, controllers, poorten 7700/7701
npm test                    # alles zonder hardware
PW_CHROMIUM=/usr/bin/google-chrome-stable npm test   # ook de browsertests (cockpit, oefenruimte, spiekbrief)
```

Zonder `PW_CHROMIUM` zoeken de browsertests een Chromium in `/opt/pw-browsers` en worden ze overgeslagen.

## Starten

```bash
node src/cli.js start       # of: npm start — cockpit op http://localhost:7700
node src/cli.js check       # vlak vóór een avond: alles nalopen
```

`--zonder-midi` start zonder controllers (alleen de virtuele in de cockpit), `--zonder-geheugen` onthoudt niets.

**Thuismap leeg houden.** Op deze pc hoort `~` leeg te blijven (alles staat in `~/Documents`, `~/Projecten`, …). De hub
schrijft standaard twee dingen in de thuismap: het geheugen (`~/.varve-hub/staat.json`, `config.json` → `geheugen.pad`)
en de avonden (zie *Avondmap*). Wil je die ergens anders, zet ze in een eigen kopie van `config.json` buiten de repo en
start met `VARVE_HUB_CONFIG=<pad naar die kopie> npm start`, of zet `VARVE_HUB_STAAT=<pad>` voor alleen het geheugen.

## De Maschine MK2: een udev-regel

Een nieuw hidraw-toestel is op deze pc `root:root 0600`. node-hid **ziet** de Maschine dan wel (de opsomming gaat via
sysfs), maar **openen** mislukt met `Permission denied`. De hub zegt dan `Maschine: geen rechten (…) — udev-regel
nodig, zie docs/LINUX.md` (status `geen-rechten` in de cockpit; op de Mac heet zo'n fout "bezet", daar betekent het
dat een NI-programma hem heeft). `doctor` zegt `✗ geen rechten`.

De regel, in `/etc/udev/rules.d/70-maschine-mk2.rules` (een nummer **onder 73**, anders werkt `uaccess` niet):

```
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="17cc", ATTRS{idProduct}=="1140", MODE="0660", TAG+="uaccess"
```

`uaccess` geeft wie aan de computer zit (de actieve sessie) lees- en schrijfrechten; er is geen groep `input` of
`plugdev` nodig. Daarna:

```bash
sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=hidraw
```

en de Maschine opnieuw insteken. Controleren: `ls -l /dev/hidraw*` toont een `+` (ACL) en `getfacl /dev/hidrawN` een
regel `user:<jij>:rw-`; `node src/cli.js doctor` zegt dan `✔ invoer komt binnen`.
**Terugweg:** het bestand weghalen en dezelfde twee udev-opdrachten.

Volgens de huisregel van deze pc gaat dit als droog/`--echt`-script naar `~/Documents/systeem/scripts/` en draait Clay
het zelf in zijn eigen terminal; de hub en Claude doen niets met sudo. Nog te meten met het echte toestel: of de
Maschine MK2 op Linux zonder NI-software rapporten stuurt (op de Mac wel, zonder NI-software). Komt er na openen niets
binnen, dan zegt de hub dat (status `geen-invoer`), met een Linux-hint in plaats van de macOS-Invoermonitoring.

## MIDI: de APC40, de LPD8, en de KP3+ en EFX-500

ALSA zet het clientnummer achter de poortnaam (`APC40 mkII:APC40 mkII MIDI 1 20:0`). De hub vergelijkt op de naam
zonder dat nummer (`src/ports/poort.js`). Bij opnieuw insteken kan het nummer veranderen; of hotplug dat goed oppakt,
blijkt met de echte APC en LPD8 (`docs/HARDWARE-AVOND.md`).

De **KP3+** en de **EFX-500** hebben MIDI-DIN: ze hangen aan een **USB-MIDI-interface** (de Scarlett heeft geen MIDI).
De poortnaam is dan die van de interface, niet van het apparaat. Zet een stukje van die naam in `config.json` →
`apparaten.kp3plus.poort_patroon` en `apparaten.efx500.poort_patroon` (`doctor` toont alle ingangen), en meet ze met
`node src/cli.js proef kp3plus` en `node src/cli.js proef efx500` (PROTOCOL §20, §21; draaiboek blok 9).

## Avondmap

`"avondmap": "auto"` in `config.json` (de standaard) kiest per besturingssysteem: op macOS `~/Movies/varve-avonden`, op
Linux de XDG-videomap (`xdg-user-dir VIDEOS`) met `varve-avonden` erin, of `~/Videos/varve-avonden` als die niet is
ingesteld (op deze pc geeft `xdg-user-dir VIDEOS` alleen `~`, dus wordt het `~/Videos/varve-avonden`). Een eigen pad in
`avondmap` (bv. op `/mnt/werk`) gaat altijd voor. `check` zegt of de map er is, schrijfbaar is en hoeveel ruimte er is.

## Sets openen de apps in Chrome

Een set (`npm start -- <set>`) opent de apps op Linux met **Chrome**: `config.json` → `linux.chrome` (een pad of naam),
anders de eerste van `google-chrome-stable`, `google-chrome`, `chromium`, `chromium-browser` in `PATH`, als
`<chrome> --new-window <url>`. Lukt dat niet of is er geen Chrome, dan `xdg-open` (je standaardbrowser; op Omarchy
`omarchy-browser`). `check` zoekt Chrome op dezelfde manier. De apps zijn in Chrome getest (Web MIDI, WebGL).

## TouchDesigner en Logic

TouchDesigner en Logic bestaan niet op Linux. Hun drivers (av-scene-kit en td-lab voor TD, sediment voor Logic) starten
daarom op Linux niet: `config.json` → `linux.drivers_uit`. De hub zegt per driver één regel
(`av-scene-kit: overgeslagen op Linux (de hub maakt poort "VARVE-HUB TD" niet aan) — …`), en `check` telt ze niet als
fout. Draait er toch zo'n programma (bv. TD in een VM) en moet de driver mee, haal de naam dan uit `linux.drivers_uit`.
Uurwerk (HTTP) werkt gewoon.

## Altijd laten draaien (systemd --user)

`node src/cli.js installeer` schrijft een user-unit (`~/.config/systemd/user/varve-hub.service`, uit
`deploy/varve-hub.service`) met de paden van deze checkout en zegt welke regel je daarna draait; `--lokaal` laat de hub
alleen op `127.0.0.1` luisteren (zonder `--lokaal` start hij met `--lan`, met token), `installeer --weg` haalt hem weg.
Nooit met sudo: de dienst hoort bij jouw gebruiker.

Een voorbeeld van zo'n unit, met het geheugen buiten de thuismap (niet installeren zonder te kijken; paden aanpassen):

```ini
# ~/.config/systemd/user/varve-hub.service
[Unit]
Description=Varve hub (APC40 mkII + LPD8 voor alle Varve-apps)

[Service]
Type=simple
WorkingDirectory=%h/Projecten/AV-app-hub
Environment=VARVE_HUB_STAAT=%h/Documents/varve-hub/staat.json
ExecStart=%h/.local/share/mise/installs/node/26.8.1/bin/node %h/Projecten/AV-app-hub/src/cli.js start
Restart=on-failure
RestartSec=5
RestartPreventExitStatus=3 4

[Install]
WantedBy=default.target
```

Aanzetten: `systemctl --user daemon-reload && systemctl --user enable --now varve-hub.service`; meekijken:
`journalctl --user -u varve-hub.service -f`; stoppen: `systemctl --user disable --now varve-hub.service`. Let op: met
`installeer` schrijft de hub de node-versie die nu actief is in de unit; na een update van Node via mise moet je
`installeer` opnieuw draaien (of `ExecStart` aanpassen).

Voor `--lan` (tablet als cockpit) is alles er al: `avahi-publish` en `avahi-daemon` (mDNS). Zie `docs/NETWERK.md`.
