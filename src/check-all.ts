// Corre TODOS los *.check.ts del repo. Correr: npx ts-node src/check-all.ts
//
// Existe porque con casi treinta archivos de check, "córrelos todos" deja de ser
// algo que alguien haga a mano — y un check que no se corre es un comentario.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

function checks(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return checks(full);
    return e.name.endsWith('.check.ts') ? [full] : [];
  });
}

const TS_NODE = require.resolve('ts-node/dist/bin.js');
const files = checks(__dirname).sort();
const failed: string[] = [];

for (const f of files) {
  try {
    // Cada check en su propio proceso: son scripts sueltos con asserts al nivel del
    // módulo, y uno que lanza no debe impedir que corran los demás.
    //
    // Sin `shell: true` y sin `npx`: la ruta del repo lleva un espacio y el shell la
    // partía en dos ("Cannot find module './Angel'").
    execFileSync(process.execPath, [TS_NODE, f], { stdio: 'inherit' });
  } catch {
    failed.push(f);
  }
}

console.log(`\n${files.length - failed.length}/${files.length} checks OK`);
if (failed.length) {
  console.error(`Fallaron:\n${failed.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}
