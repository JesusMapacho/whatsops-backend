// Parámetros de una plantilla de Meta: derivarlos de sus `components` y reconstruir
// el cuerpo de envío a partir de los valores que teclea el operador.
//
// Puro (ver template-params.check.ts). Equivocarse aquí es un error 132xxx POR
// DESTINATARIO, o sea un envío entero perdido, así que cada forma rara de Meta que
// no sepamos rellenar se declara NO SOPORTADA en vez de intentarlo a medias.

export interface TemplateParam {
  component: 'header' | 'body' | 'button';
  // Posición dentro de su componente, 1-based.
  index: number;
  // Nombre cuando la plantilla usa parámetros con nombre (`{{nombre}}`).
  name?: string;
  // Posición del botón dentro de la plantilla (solo para component 'button').
  buttonIndex?: number;
}

// `{{1}}` o `{{nombre}}`.
const VAR = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function varsOf(text: unknown): string[] {
  if (typeof text !== 'string') return [];
  return [...text.matchAll(VAR)].map((m) => m[1]);
}

function isNamed(tokens: string[]): boolean {
  return tokens.some((t) => !/^\d+$/.test(t));
}

// Cuántos parámetros posicionales hay: el MÁXIMO de `{{n}}`, no cuántas veces
// aparece. Una plantilla que usa `{{1}}` dos veces tiene UN parámetro.
function positionalCount(tokens: string[]): number {
  const nums = tokens.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return nums.length ? Math.max(...nums) : 0;
}

function componentsOf(components: unknown): any[] {
  return Array.isArray(components) ? components : [];
}

function find(components: unknown, type: string): any | undefined {
  return componentsOf(components).find(
    (c) => typeof c?.type === 'string' && c.type.toUpperCase() === type,
  );
}

// Motivo por el que esta plantilla NO se puede usar todavía, o null si sí.
//
// Devolver el motivo es la diferencia entre "esta plantilla lleva un adjunto, elige
// otra" y 500 errores 132xxx en un envío masivo.
export function unsupportedTemplateReason(components: unknown): string | null {
  const header = find(components, 'HEADER');
  const format = typeof header?.format === 'string' ? header.format.toUpperCase() : 'TEXT';
  if (header && format !== 'TEXT') {
    // Una cabecera multimedia exige una URL pública por destinatario: es otro
    // subsistema, no un campo más en el formulario.
    return `Esta plantilla lleva una cabecera de tipo ${format.toLowerCase()} y todavía no se puede enviar desde aquí.`;
  }

  const buttons = find(components, 'BUTTONS')?.buttons;
  for (const b of Array.isArray(buttons) ? buttons : []) {
    const t = typeof b?.type === 'string' ? b.type.toUpperCase() : '';
    // QUICK_REPLY y PHONE_NUMBER no llevan parámetros; URL puede llevar uno.
    if (t && !['QUICK_REPLY', 'PHONE_NUMBER', 'URL'].includes(t)) {
      return `Esta plantilla usa un botón de tipo ${t} que todavía no se puede rellenar desde aquí.`;
    }
  }

  // Huecos en la numeración: mandar un vacío por el que falta produce un mensaje
  // roto a un desconocido, así que mejor no dejar usarla.
  for (const c of componentsOf(components)) {
    const tokens = varsOf(c?.text);
    if (isNamed(tokens)) continue; // los nombrados no numeran
    const nums = tokens.map(Number).filter((n) => Number.isInteger(n));
    const max = positionalCount(tokens);
    for (let i = 1; i <= max; i++) {
      if (!nums.includes(i)) {
        return `Esta plantilla tiene un hueco en sus variables (falta {{${i}}}). Corrígela en Meta.`;
      }
    }
  }

  // Mezclar numerados y nombrados en la misma plantilla no lo soporta ni Meta.
  const all = componentsOf(components).flatMap((c) => varsOf(c?.text));
  if (all.length && isNamed(all) && all.some((t) => /^\d+$/.test(t))) {
    return 'Esta plantilla mezcla variables numeradas y con nombre.';
  }

  return null;
}

// Lista de parámetros EN EL ORDEN en que se le piden al operador: cabecera, cuerpo y
// botones. Ese orden es el contrato con la UI y con `buildTemplateComponents`.
export function templateParams(components: unknown): TemplateParam[] {
  const out: TemplateParam[] = [];

  const push = (component: TemplateParam['component'], text: unknown, buttonIndex?: number) => {
    const tokens = varsOf(text);
    if (!tokens.length) return;
    if (isNamed(tokens)) {
      // Nombrados: uno por nombre distinto, en orden de aparición.
      const seen = new Set<string>();
      for (const name of tokens) {
        if (seen.has(name)) continue;
        seen.add(name);
        out.push({ component, index: seen.size, name });
      }
      return;
    }
    const n = positionalCount(tokens);
    for (let i = 1; i <= n; i++) {
      out.push({ component, index: i, ...(buttonIndex !== undefined ? { buttonIndex } : {}) });
    }
  };

  const header = find(components, 'HEADER');
  const format = typeof header?.format === 'string' ? header.format.toUpperCase() : 'TEXT';
  if (header && format === 'TEXT') push('header', header.text);

  push('body', find(components, 'BODY')?.text);

  const buttons = find(components, 'BUTTONS')?.buttons;
  (Array.isArray(buttons) ? buttons : []).forEach((b: any, i: number) => {
    if (typeof b?.type === 'string' && b.type.toUpperCase() === 'URL') push('button', b.url, i);
  });

  return out;
}

// Valores del operador → array `components` de la Cloud API.
export function buildTemplateComponents(params: TemplateParam[], values: string[]): unknown[] {
  if (params.length !== values.length) {
    // Lanzar y no rellenar con vacíos: un array corto se convierte en un 132xxx por
    // destinatario, y en un masivo eso es el envío entero.
    throw new Error(
      `La plantilla necesita ${params.length} valores y se recibieron ${values.length}.`,
    );
  }
  if (!params.length) return [];

  const param = (p: TemplateParam, v: string) =>
    p.name ? { type: 'text', parameter_name: p.name, text: v } : { type: 'text', text: v };

  const out: any[] = [];
  const group = (component: TemplateParam['component']) =>
    params.map((p, i) => ({ p, v: values[i] })).filter((x) => x.p.component === component);

  const header = group('header');
  if (header.length) {
    out.push({ type: 'header', parameters: header.map((x) => param(x.p, x.v)) });
  }
  const body = group('body');
  if (body.length) {
    out.push({ type: 'body', parameters: body.map((x) => param(x.p, x.v)) });
  }
  for (const { p, v } of group('button')) {
    out.push({
      type: 'button',
      sub_type: 'url',
      // `index` va como STRING en la Cloud API, no como número. Mandarlo numérico es
      // el fallo clásico y devuelve 132xxx.
      index: String(p.buttonIndex ?? 0),
      parameters: [{ type: 'text', text: v }],
    });
  }
  return out;
}
