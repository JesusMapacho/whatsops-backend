// Compila CMRFRONTEND (build de producción) y copia el resultado a `public/`, de donde
// `main.ts` lo sirve. Node puro (fs.cpSync) y no `cp -r`/`xcopy`: corre igual en Windows,
// macOS y Linux sin depender del shell de quien lo ejecute.
//
// Uso: npm run sync:frontend   (desde CMRBACKEND, con CMRFRONTEND clonado como hermano)
'use strict';

const { execSync } = require('node:child_process');
const { cpSync, existsSync, rmSync } = require('node:fs');
const path = require('node:path');

const FRONTEND_DIR = path.join(__dirname, '..', '..', 'CMRFRONTEND');
const FRONTEND_BUILD = path.join(FRONTEND_DIR, 'dist', 'whatsops', 'browser');
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

if (!existsSync(FRONTEND_DIR)) {
  console.error(
    `No se encontró ${FRONTEND_DIR}. Este script asume que CMRBACKEND y CMRFRONTEND están ` +
      'clonados como hermanos (mismo directorio padre).',
  );
  process.exit(1);
}

console.log(`Compilando el frontend en ${FRONTEND_DIR}...`);
execSync('npm run build', { cwd: FRONTEND_DIR, stdio: 'inherit' });

if (!existsSync(FRONTEND_BUILD)) {
  console.error(
    `El build terminó pero no existe ${FRONTEND_BUILD}. ¿Cambió el outputPath en angular.json?`,
  );
  process.exit(1);
}

rmSync(PUBLIC_DIR, { recursive: true, force: true });
cpSync(FRONTEND_BUILD, PUBLIC_DIR, { recursive: true });
console.log(`Frontend copiado a ${PUBLIC_DIR}.`);
