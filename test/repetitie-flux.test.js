// @ts-check
// tools/repetitie-flux.py: de meetlat om flux heen moet flux ook kunnen laden. Sinds flux-screensaver PR #2
// (19 okt) is het bestand flux-screensaver een starter van een paar regels en zit alles in het pakket
// varve_album ernaast (hub.py, runtime.py). Hier een nagebouwde flux in beide vormen (pakket en het oude
// losse bestand); de echte flux is niet nodig. Zonder python3: overgeslagen.
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../tools/repetitie-flux.py', import.meta.url));
const PY = spawnSync('python3', ['--version']).status === 0;
const tmp = mkdtempSync(join(tmpdir(), 'repetitie-flux-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Wat hub.py van flux nodig heeft voor de meetlat: Hub met _ontvang/_stuur/toepassen, HUB_WAARDEN, PALETTEN. */
const HUB_PY = `
HUB_WAARDEN = (("tempo", "Tempo", 0.1, 2.0, "fader", "macro.beweging", 2),
               ("helderheid", "Helderheid", 0.4, 1.6, "fader", "macro.helderheid", 1))
PALETTEN = ("bordeaux", "aubergine", "bloedrood", "wijn", "as")

class Hub:
    def __init__(self):
        self.staat, self.binnen = {"helderheid": 0.5}, []
    def _stuur(self, bericht):
        pass
    def _ontvang(self, data):
        self.binnen.append(data)
    def toepassen(self, a):
        if not self.binnen:
            return set()
        self.binnen.clear()
        a.tempo = 1.05
        return {"tempo"}
`;
/** main() zoals runtime.py: leest sys.argv en praat met een Hub. */
const MAIN_PY = (/** @type {string} */ hubImport) => `
import sys, types
${hubImport}
def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    a = types.SimpleNamespace(tempo=0.1, palet=None)
    h = Hub()
    h._stuur({"t": "hallo", "args": args})
    h._ontvang(b'{"t":"zet","id":"tempo","v":0.5}')
    h.toepassen(a)
`;

/** @param {string} map @param {string} naam */
function draai(map, naam) {
  const log = join(map, `${naam}.jsonl`);
  const r = spawnSync('python3', [SCRIPT, join(map, 'flux-screensaver'), log, '--track', 'flux'], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  const regels = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { status: r.status, regels };
}

/** @param {{ status: number|null, regels: any[] }} u */
function controleer(u) {
  expect(u.regels.filter((x) => x.r === 'fout')).toEqual([]);
  expect(u.status).toBe(0);
  expect(u.regels.find((x) => x.r === 'uit')?.d).toBe('{"t":"hallo","args":["--track","flux"]}');
  expect(u.regels.find((x) => x.r === 'in')?.d).toBe('{"t":"zet","id":"tempo","v":0.5}');
  const staat = u.regels.find((x) => x.r === 'staat');
  expect(staat.nieuw).toEqual(['tempo']);
  expect(staat.w.tempo).toBeCloseTo(0.5, 6);
  expect(staat.w.klok).toBe(1);
  expect(staat.w.helderheid).toBe(0.5);
}

describe.skipIf(!PY)('repetitie-flux.py laadt flux', () => {
  it('flux als pakket varve_album naast een starter (flux-screensaver na PR #2, 19 okt)', () => {
    const map = join(tmp, 'pakket');
    mkdirSync(join(map, 'varve_album'), { recursive: true });
    writeFileSync(join(map, 'varve_album', '__init__.py'), '');
    writeFileSync(join(map, 'varve_album', 'hub.py'), HUB_PY);
    writeFileSync(join(map, 'varve_album', 'runtime.py'), MAIN_PY('from .hub import Hub'));
    // De echte starter: zet zijn eigen map op sys.path en importeert main uit het pakket.
    writeFileSync(join(map, 'flux-screensaver'), [
      '#!/usr/bin/env python3', 'import os, sys',
      'sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))',
      'from varve_album.runtime import main', 'if __name__ == "__main__":', '    main()', '',
    ].join('\n'));
    controleer(draai(map, 'pakket'));
  });

  it('flux als één bestand (de oude vorm) werkt nog', () => {
    const map = join(tmp, 'los');
    mkdirSync(map, { recursive: true });
    writeFileSync(join(map, 'flux-screensaver'), HUB_PY + MAIN_PY(''));
    controleer(draai(map, 'los'));
  });
});
