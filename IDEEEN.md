# Ideeën (parkeerplaats)

Niet in de lopende fase. Pas oppakken als een speelavond laat zien dat het nodig is.

- Anbernic-handheld als extra bron voor de hub (gamepad → hub-acties); onderzoek en ontwerp in `docs/VOLGENDE-KOPPELINGEN.md` §7 (usb0 is onbewezen, wifi werkt).
- Open Stage Control als extra touch-UI (client van de hub via OSCQuery).
- Gebarenlog als conditionering voor musicgen-video-glitch.
- Cockpit-telefoonstand (staand op een iPhone): focus-app, LPD8 en snapshots bovenaan, de APC inklapbaar. Clay: "misschien later".
- Speelapparaten (golf 9) in de cockpit: een lampje voor de Xboard49 en de Maschine naast APC/LPD8, en wie er speelt (`beeld.spelers` en `beeld.apparaten` hebben het al).
- `npm run check` ook voor de speelapparaten (Maschine bezet of geen invoer → ✗ met wat te doen); `doctor` zegt het nu al.
- Schermen van de Maschine vanuit de hub: een kleine letterset (zoals die van maschine-code/cabl) zodat apps tekst kunnen sturen in plaats van pixels.
- De Maschine als virtuele controller in de cockpit (zoals de APC en de LPD8), om zonder toestel te oefenen.
- Sectie (golf 10) zonder code in de beeld-apps: een rol `sectie.nieuw` op een trigger en `sectie.energie` op een waarde, zodat de hub ze zelf `trig`/`zet` stuurt (zoals de LPD8-macro's), voor apps die alleen een manifest hebben.
- Meer groepen in `levert`: de maat (tel 1..4, fase in de maat) of het akkoord, als Varve DJ dat weet.

## Uit de grammatica (werkplek, fase C) — bewust niet gedaan
- Opt-out voor de macro-koppeling: een alfabet-parameter die níet op zijn LPD8-macro reageert (bv. `"macro": false`). Nu reageert `alfabet.kleur` altijd op K5; pas toevoegen als een app dat echt niet wil.
- De Maschine terug naar de grammatica vanaf de Maschine zelf: na groep → een app die de Maschine speelt, kan alleen de APC/cockpit terug. Idee: SHIFT + groep is altijd focus, ook in de speelmodus.
- Masterwiel = bladeren door toestanden/snapshots, indrukken = laden (SYSTEEM §3.6); F1–F8 en de andere knoppen hebben in de grammatica nog geen betekenis.
- Meer dan acht alfabet-parameters (Device ◄/► = "volgende acht" op de Maschine): nu toont de Maschine alleen het alfabet, de pagina "meer" alleen de APC.
- Een virtuele Maschine in de cockpit om de draaiknoppen en pads zonder toestel te bedienen (nu alleen kijken: schermen en pads).
- Activator/Solo/Arm, track-knoppen als "zend", de crossfader als morph, raster-toestanden en Clip Stop = laag leeg (SYSTEEM §3.1–3.2): staan op de grammatica-pagina als "komt nog".
- Het scherm van een app (`{t:"scherm"}`) combineren met de grammatica (bv. de onderste regel van de app zelf).
- Waarde op het scherm in eenheden (`min`/`max`/`eenheid`, zoals de cockpit) in plaats van procent.

## Uit fase F (KP3+, EFX-500, Linux) — bewust niet gedaan
- KP3+: de 8 programmageheugens als **favoriete XY-paren** (welke twee parameters X en Y sturen, per app), in plaats van alleen een trigger `kp3.p<nr>` door te geven (werkplek SYSTEEM §3.4).
- KP3+ in de cockpit: een XY-vlak (virtuele KP3+) dat hetzelfde gebaar maakt, om zonder toestel te oefenen; en de KP3+ als lampje naast APC/LPD8.
- `herhaal` speelt de KP3+ af (nu: overgeslagen als onbekend apparaat; de `zet`s naar de apps staan wel in de avondmap).
- Terugveren met een korte glijtijd (zoals `slew_s`) in plaats van in één stap; nu bewust direct, als een hand.
- EFX-500: de fase in de maat (tel 1..4) uit de kloktikken naast Start/Stop, als `globaal` `klok.tel`, zodra de proef zegt dat hij Start stuurt.
- Tap op de APC (Tap Tempo-knop) als tweede tapbron naast LPD8 P2 (SYSTEEM §3.5).
- De proef speelapparaten op Linux: zonder de vraag naar macOS-Invoermonitoring, met de udev-check (nu Mac-gericht).
- Een niet-gevolgd `config.lokaal.json` dat over `config.json` heen gaat (geheugen en avondmap buiten `~` op de pc), in plaats van een kopie met `VARVE_HUB_CONFIG`.
- Browsertests vinden zelf `/usr/bin/google-chrome-stable` of `chromium` als `PW_CHROMIUM` leeg is (zoals `check`), zodat ze op Linux niet stil overgeslagen worden.
