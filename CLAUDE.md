# varve-hub — werkafspraken

Eén Node-daemon die als **enige** de APC40 mkII en de LPD8 opent en al Clay's Varve-projecten bespeelbaar maakt. Achtergrond: `ONDERZOEK.md` (wat er is, wat ontbreekt), `PLAN.md` (fasen, rolverdeling). Voortgang: `STATUS.md`.

## Huisregels
1. **De hub is de enige die een controller opent.** Geen app roept met hub-vlag `requestMIDIAccess` aan. Mode-SysEx van apps wordt ingeslikt.
2. **`src/core/` heeft geen I/O en geen eigen klok** — tijd komt binnen via `Klok` (`echteKlok` / `NepKlok`). Alles in `core/` is te testen zonder poorten.
3. **MIDI alleen via de `Poort`/`Systeem`-interface** (`src/ports/poort.js`). Tests gebruiken `NepSysteem`; `@julusian/midi` wordt lazy geladen en mag ontbreken (de cloud heeft geen `/dev/snd`).
4. **Op de draad naar apps altijd 0..1**, triggers boolean; de app schaalt zelf.
5. **Elke app-adapter zit achter een vlag** (`?hub=ws://localhost:7700`), standaard uit. Zonder hub werkt elke app als nu. Respecteer de regels van elk repo (av-kern-kern bevroren, Varve DJ geen build/deps, formula-lab geen backend/TS, waterschaal één HTML-bestand, NEXUS niet aanraken).
6. **`config.json` is de enige bron** voor poorten, apparaatnamen, hubtoets, LED-tempo. Nooit hardcoden.
7. **Control-ids zijn die van av-kern** (`pad{rij}-{kolom}` met rij 1 = onder, `dk1-8`, `tk1-8`, `fader1-8`, …), behalve ◄/►: volgens protocol v1.2 is `right` = note 96 en `left` = note 97.
8. **Hardware-waarheid komt uit `proef/`.** Elk proef- of opnamebestand is een golden test (`test/golden.test.js`). Verandert een test daar, dan is dat een bewuste wijziging in hoe we Clay's hardware lezen — leg uit waarom.
9. **Elke fase eindigt speelbaar** en heeft "Klaar als"-criteria in `STATUS.md`. Nieuwe ideeën → `IDEEEN.md`, niet in de lopende fase.
10. Nederlands in code, docs en commits. JS + JSDoc (`// @ts-check`), ESM, Node 22, geen build.

## Testen
- Protocol: `PROTOCOL.md` is het contract; `src/protocol/` valideert. Elke app-koppeling moet slagen voor `node tools/nep-hub.mjs --toets`.
- `npm test` — unit, apparaatsessies, golden, en de volledige F0-proef met een gesimuleerde gebruiker (`test/gesimuleerd.js`).
- Een nieuwe proefstap moet door de gesimuleerde gebruiker te doorlopen zijn: meld wat de gebruiker moet doen via `h.verwacht(...)` (doen `h.wachtOp`, `h.eerste`, `h.vraag` automatisch).
- `test/fixtures/synthetisch-f0.jsonl` alleen opnieuw maken (`node test/maak-fixture.mjs`) als het logformaat bewust verandert.

## Hardwarefeiten (protocol v1.2, zie ONDERZOEK.md §6)
- Intro `F0 47 7F 29 60 00 04 <modus> 00 00 00 F7`; de APC valt na elke replug terug op modus 0x40 → `ApcSessie.init()` bij elke (her)aansluiting.
- RGB: velocity = paletindex; kanaal 0 vast, 1-5 one-shot, 6-10 puls, 11-15 knipper.
- Ringen: type op CC 24-31 / 56-63, waarde op de CC van de knop zelf.
- Uitgaand max 16 berichten per 4 ms (`Wachtrij`).
