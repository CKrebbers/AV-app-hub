// @ts-check
// Hulpscript voor test/repetitie-script.test.js: start een kindproces in een eigen procesgroep (zoals de
// app-servers van tools/repetitie.mjs) en wacht. De test stuurt een signaal (of laat de waakhond of een
// onafgehandelde belofte afgaan) en kijkt of het kind weg is en het opruimen liep.
//   node test/repetitie-signaal.mjs <map> [waakhond|belofte|fout]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Opruimer, start } from '../tools/repetitie-proces.mjs';

const [map, modus] = process.argv.slice(2);
const o = new Opruimer();
o.vangAf({ voorAf: (reden) => writeFileSync(join(map, 'voorAf'), reden), log: () => {} });
const kind = start(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, 'kind', o);
o.voeg('merkteken', () => writeFileSync(join(map, 'opgeruimd'), 'ja'));
if (modus === 'waakhond') o.waakhond(300, () => {});
if (modus === 'belofte') setTimeout(() => { void Promise.reject(new Error('oeps')); }, 100);
if (modus === 'fout') setTimeout(() => { throw new Error('boem'); }, 100);
console.log(JSON.stringify({ kind: kind.p.pid }));
setInterval(() => {}, 1000);
