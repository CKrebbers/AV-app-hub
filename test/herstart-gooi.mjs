// Alleen voor test/herstart-fout.test.js, via NODE_OPTIONS=--import: laat de hub (`node src/cli.js start`, niet de
// bewaker van --blijf en niet een app) een fout gooien zodra het bestand `$VARVE_TEST_GOOI.nu` verschijnt — één keer:
// beide bestanden gaan dan weg, zodat de volgende start niet ook gooit. `$VARVE_TEST_GOOI_HOE`: 'throw' (standaard) of
// 'reject' (een promise die niemand afvangt).
import { existsSync, rmSync } from 'node:fs';

const merk = process.env.VARVE_TEST_GOOI;
const isHub = /cli\.js$/.test(process.argv[1] ?? '') && process.argv[2] === 'start' && !process.argv.includes('--blijf');
if (merk && isHub && existsSync(merk)) {
  const t = setInterval(() => {
    if (!existsSync(`${merk}.nu`)) return;
    clearInterval(t);
    rmSync(merk, { force: true }); rmSync(`${merk}.nu`, { force: true });
    if (process.env.VARVE_TEST_GOOI_HOE === 'reject') void Promise.reject(new Error('proef: een afgewezen promise in de hub'));
    else throw new Error('proef: een fout in de hub');
  }, 50);
  t.unref();
}
