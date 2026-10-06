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
