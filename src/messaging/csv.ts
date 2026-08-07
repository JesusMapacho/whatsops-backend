// Lector del CSV de destinatarios de un envío masivo. Puro (ver csv.check.ts).
//
// No se añade una dependencia porque el formato que aceptamos cabe en un escáner:
// primera columna el teléfono, el resto los valores de las variables, en orden.
//
// Dos detalles que NO son opcionales en un producto en español, y que sin ellos la
// feature "no funciona" el primer día:
//   · Excel escribe un BOM al principio de todo CSV que exporta. Sin quitarlo, el
//     primer teléfono llega como "﻿52871…" y no parsea.
//   · Excel en es-ES/es-MX exporta separando por PUNTO Y COMA, no por coma (usa la
//     coma como separador decimal). Sin detectarlo, la fila entera entra como una
//     sola celda gigante.
import { parsePhone } from './contact-resolve';

export interface CsvRow {
  // Línea del archivo ORIGINAL (1-based). Es lo que permite al operador arreglar
  // su archivo: "la 47 está mal" es accionable, "una fila está mal" no.
  line: number;
  cells: string[];
}

// Separador del archivo, por la primera línea. Gana el que más aparece.
// ponytail: cuenta en crudo, así que una coma dentro de comillas en la cabecera
// puede desempatar mal. Upgrade si aparece: probar los dos y quedarse con el que
// dé más celdas en más filas.
function detectSep(text: string): string {
  const first = text.split('\n', 1)[0] ?? '';
  const count = (c: string) => first.split(c).length - 1;
  const semi = count(';');
  const tab = count('\t');
  const comma = count(',');
  if (semi >= comma && semi >= tab) return semi ? ';' : ',';
  if (tab >= comma) return tab ? '\t' : ',';
  return ',';
}

export function parseCsv(text: string, sep?: string): CsvRow[] {
  const clean = text.replace(/^﻿/, '');
  const s = sep ?? detectSep(clean);
  const rows: CsvRow[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let rowLine = 1;

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (quoted) {
      // "" dentro de comillas es una comilla literal (RFC 4180).
      if (ch === '"' && clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
    } else if (ch === s) {
      cells.push(cell);
      cell = '';
    } else if (ch === '\r') {
      // CRLF de Excel: el \n de después cierra la fila.
    } else if (ch === '\n') {
      cells.push(cell);
      rows.push({ line: rowLine, cells });
      cells = [];
      cell = '';
      line++;
      rowLine = line;
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  rows.push({ line: rowLine, cells });
  return rows;
}

export interface Recipient {
  phone: string;
  // Valores de las variables de la plantilla, en el orden de `Template.params`.
  // Se resuelven AQUÍ, en la subida, para que el worker no necesite el CSV: así no
  // hay que guardarlo (es PII de gente que todavía no es cliente) y el job sigue
  // pesando ~30 bytes.
  vars: string[];
  line: number;
}

export interface Rejected {
  line: number;
  raw: string;
  reason: string;
}

export interface ParsedRecipients {
  recipients: Recipient[];
  rejected: Rejected[];
  // Repetidos que colapsaron. No son un error del archivo (exportar dos veces al
  // mismo cliente es normal), pero el operador tiene que ver por qué el recuento
  // no cuadra con las filas que subió.
  duplicates: number;
}

export function parseRecipients(text: string, sep?: string): ParsedRecipients {
  const rows = parseCsv(text, sep);
  const recipients: Recipient[] = [];
  const rejected: Rejected[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let first = true;

  for (const row of rows) {
    const cells = row.cells.map((c) => c.trim());
    if (cells.every((c) => !c)) continue; // línea en blanco: ni error ni destinatario
    const phone = parsePhone(cells[0]);

    // Cabecera: si la PRIMERA fila con contenido no es un teléfono, se ignora. Casi
    // todo CSV exportado trae encabezados, y rechazarlos como "número inválido"
    // haría que el operador crea que su archivo está roto.
    if (first && !phone.ok) {
      first = false;
      continue;
    }
    first = false;

    if (!phone.ok) {
      rejected.push({ line: row.line, raw: cells[0], reason: phone.reason });
      continue;
    }
    if (seen.has(phone.digits)) {
      duplicates++;
      continue;
    }
    seen.add(phone.digits);
    // Se tiran las columnas vacías del FINAL: Excel deja separadores de sobra y, sin
    // esto, un `52871;Ana;` pediría dos valores a una plantilla que solo tiene uno.
    // Las vacías de en medio se conservan: ahí sí falta un dato y hay que verlo.
    const vars = cells.slice(1);
    while (vars.length && !vars[vars.length - 1]) vars.pop();
    recipients.push({ phone: phone.digits, vars, line: row.line });
  }
  return { recipients, rejected, duplicates };
}
