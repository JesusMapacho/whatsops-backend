// El lenguajito de dentro de `{{...}}` (v10 feature 40): una ruta y, opcionalmente, una
// tubería de funciones. `{{vars.habilidades | unir:", "}}`.
//
// **Tuberías y NO llamadas a método**, y no es cuestión de gusto. `{{x.join(', ')}}` parece
// JavaScript, y en cuanto lo parece el operador espera que `.filter(x => x.activo).length`
// también funcione. Eso ya no es una tabla de funciones: es un evaluador de expresiones con
// parser, precedencia, llamadas anidadas y un sandbox — que **ya existe y se llama
// `code.run`**, con su proceso hijo y su tope de 1 s. Una tubería con catálogo cerrado es una
// búsqueda en un mapa, y se ve distinta de JS justamente para que nadie espere JS.
//
// Este archivo **no importa `contexto.ts`** a propósito: si el parser conociera `valorDe` y
// `contexto.ts` conociera el parser, habría ciclo. Aquí está el lenguaje; los datos los pone
// quien llama (`contexto.ts` en la interpolación, `comparadores.ts` en los nodos de lógica).
// Puro y sin Nest: ver `expresiones.check.ts`.

/** Una función de la tubería, ya parseada. */
export interface Paso {
  nombre: string;
  args: string[];
}

export interface Expresion {
  ruta: string;
  funciones: Paso[];
}

/**
 * Las claves que NO son contexto por mucho que existan en el objeto.
 *
 * Vive aquí y no dentro de `valorDe` porque hay DOS caminos que llegan a un `obj[clave]` con
 * una clave que escribió el operador: la ruta, y el argumento de `campo:`. Cuando el filtro
 * estaba escrito a mano dentro del bucle de `valorDe`, el segundo camino no existía todavía;
 * en cuanto existe, un `campo:"constructor"` reabre el agujero por el que `{{x.constructor}}`
 * llegó a imprimir código fuente en un mensaje a un cliente.
 */
export function claveSegura(clave: string): boolean {
  return clave !== '__proto__' && clave !== 'constructor' && clave !== 'prototype';
}

const RUTA = /^[A-Za-z0-9_.]+$/;
const NOMBRE_FUNCION = /^[a-z_][a-z0-9_]*$/;

/**
 * La gramática completa, con las llaves. Vive aquí y `contexto.ts` la importa, para que haya
 * UN solo sitio donde está escrita en el backend.
 *
 * Solo **delimita** el trozo (`[^{}\n]*`) y deja que `parseExpresion` decida si vale, en vez
 * de intentar describir la gramática dos veces. Así la regex no puede quedarse más permisiva
 * ni más estricta que el parser, que es exactamente el desajuste que haría que el editor
 * pintara como variable algo que el motor no va a sustituir. Lo que no parsea se queda
 * **literal**, igual que antes se quedaba lo que no casaba.
 */
export const LLAVES = /\{\{([^{}\n]*)\}\}/g;

/**
 * El catálogo. **Código versionado y no filas por tenant**, mismo argumento que `catalog.ts`:
 * si cada negocio tuviera su copia, dos acabarían con versiones distintas de `unir` y no
 * habría forma de arreglar un bug en el de todos.
 *
 * `aplicar` **nunca lanza**: recibe lo que sea y, si no sabe qué hacer con él, devuelve el
 * valor tal cual. Un filtro mal escrito no puede parar un run a mitad del grafo — es la misma
 * doctrina que `valorDe`, que devuelve `undefined` en vez de reventar.
 */
export interface Funcion {
  ayuda: string;
  /** Si lleva argumento, el editor deja el caret DENTRO de las comillas al completarla. */
  arg?: boolean;
  aplicar(valor: unknown, args: string[]): unknown;
}

const lista = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);
const texto = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
const vacio = (v: unknown): boolean => v === undefined || v === null || v === '';

export const FUNCIONES: Record<string, Funcion> = {
  unir: {
    arg: true,
    ayuda: 'Une una lista con el separador que le des: unir:", "',
    aplicar: (v, [sep = ', ']) => {
      const l = lista(v);
      // `String(x)` y no `JSON.stringify`: el objetivo es que NO salgan comillas ni corchetes.
      return l ? l.map((x) => (vacio(x) ? '' : String(x))).join(sep) : v;
    },
  },
  mayus: {
    ayuda: 'TODO EN MAYÚSCULAS',
    aplicar: (v) => texto(v)?.toUpperCase() ?? v,
  },
  minus: {
    ayuda: 'todo en minúsculas',
    aplicar: (v) => texto(v)?.toLowerCase() ?? v,
  },
  capitalizar: {
    ayuda: 'La primera letra en mayúscula',
    aplicar: (v) => {
      const t = texto(v);
      return t ? t.charAt(0).toUpperCase() + t.slice(1) : v;
    },
  },
  recortar: {
    ayuda: 'Quita los espacios de los extremos',
    aplicar: (v) => texto(v)?.trim() ?? v,
  },
  cortar: {
    arg: true,
    ayuda: 'Corta a N caracteres y añade …: cortar:80',
    aplicar: (v, [n]) => {
      const t = texto(v);
      const max = Number(n);
      if (t === null || !Number.isFinite(max) || max < 1) return v;
      return t.length <= max ? t : t.slice(0, max) + '…';
    },
  },
  reemplazar: {
    arg: true,
    ayuda: 'Cambia un texto por otro, literal: reemplazar:"a":"b"',
    aplicar: (v, [de, a = '']) => {
      const t = texto(v);
      // `split`/`join` y no `replace`: sustituye TODAS y trata `de` como literal, sin que un
      // `$&` del operador se convierta en un grupo de reemplazo.
      return t !== null && de ? t.split(de).join(a) : v;
    },
  },
  por_defecto: {
    arg: true,
    ayuda: 'Si no hay valor, usa este: por_defecto:"amigo"',
    aplicar: (v, [alt = '']) => (vacio(v) ? alt : v),
  },
  cuenta: {
    ayuda: 'Cuántos elementos tiene la lista',
    aplicar: (v) => lista(v)?.length ?? v,
  },
  primero: {
    ayuda: 'El primer elemento de la lista',
    aplicar: (v) => {
      const l = lista(v);
      return l ? (l.length ? l[0] : null) : v;
    },
  },
  ultimo: {
    ayuda: 'El último elemento de la lista',
    aplicar: (v) => {
      const l = lista(v);
      return l ? (l.length ? l[l.length - 1] : null) : v;
    },
  },
  campo: {
    arg: true,
    ayuda: 'Saca una clave de cada objeto de la lista: campo:"nombre"',
    aplicar: (v, [clave]) => {
      // La que evita el `[object Object]` cuando una API devuelve objetos:
      // `abilities | campo:"ability" | campo:"name" | unir:", "`.
      if (!clave || !claveSegura(clave)) return undefined;
      const uno = (x: unknown) =>
        x && typeof x === 'object' ? (x as Record<string, unknown>)[clave] : undefined;
      const l = lista(v);
      return l ? l.map(uno) : uno(v);
    },
  },
};

/**
 * Parsea lo de DENTRO de las llaves. `null` = no es una expresión nuestra, y entonces quien
 * llama debe dejar el texto en paz (que es lo que hace `String.replace` con lo que no casa).
 *
 * Deliberadamente pobre: una ruta, y funciones con literales. Sin rutas como argumento, sin
 * funciones anidadas, sin operadores. Cada cosa que se añada aquí acerca esto a ser un
 * lenguaje, y para eso está `code.run`.
 */
export function parseExpresion(dentro: string): Expresion | null {
  const partes = partir(dentro, '|');
  if (!partes) return null;
  const ruta = partes[0].trim();
  if (!RUTA.test(ruta)) return null;

  const funciones: Paso[] = [];
  for (const cruda of partes.slice(1)) {
    const trozos = partir(cruda, ':');
    if (!trozos) return null;
    const nombre = trozos[0].trim();
    if (!NOMBRE_FUNCION.test(nombre)) return null;
    const args: string[] = [];
    for (const a of trozos.slice(1)) {
      const arg = literal(a.trim());
      if (arg === null) return null;
      args.push(arg);
    }
    funciones.push({ nombre, args });
  }
  return { ruta, funciones };
}

/**
 * Parte por un separador **respetando las comillas**, para que `reemplazar:"a:b":"c"` no se
 * parta por el `:` de dentro del literal. `null` si una comilla se queda sin cerrar.
 */
function partir(s: string, sep: string): string[] | null {
  const out: string[] = [];
  let actual = '';
  let dentroDeComillas = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') {
      dentroDeComillas = !dentroDeComillas;
      actual += c;
    } else if (c === sep && !dentroDeComillas) {
      out.push(actual);
      actual = '';
    } else {
      actual += c;
    }
  }
  if (dentroDeComillas) return null;
  out.push(actual);
  return out;
}

/** Un argumento: texto entre comillas dobles, o un número. Nada más. */
function literal(s: string): string | null {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (/^-?\d+(\.\d+)?$/.test(s)) return s;
  return null;
}

/**
 * Pasa el valor por la tubería. **Nunca lanza.** Una función que no existe devuelve el valor
 * SIN transformar y no vacío: el operador se equivocó escribiendo el filtro, no eligiendo el
 * dato, y borrarle el dato sería castigarle dos veces.
 */
export function aplicar(valor: unknown, funciones: Paso[]): unknown {
  let v = valor;
  for (const paso of funciones) {
    const f = FUNCIONES[paso.nombre];
    if (!f) continue;
    try {
      v = f.aplicar(v, paso.args);
    } catch {
      // Ninguna de las de arriba debería lanzar, pero esto es texto que va hacia un cliente:
      // el día que una lo haga, el run sigue y el valor pasa sin transformar.
    }
  }
  return v;
}

/**
 * El catálogo para el editor. Va por la API con los tipos de nodo y NO copiado a mano en el
 * frontend: la regex ya está duplicada a propósito y con eso basta. Así una función nueva
 * aparece en el autocompletado y se pinta como función sin tocar la pantalla — igual que un
 * tipo de nodo nuevo aparece configurable solo.
 */
export function catalogoDeFunciones(): { nombre: string; ayuda: string }[] {
  return Object.entries(FUNCIONES)
    .map(([nombre, f]) => ({ nombre, ayuda: f.ayuda, arg: f.arg === true }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

/**
 * Las funciones inexistentes que hay escritas en un texto. Se enseña **al activar**, no en
 * ejecución: un filtro mal escrito es un error de configuración, y el sitio donde se dice un
 * error de configuración es la pantalla donde se configura.
 */
export function funcionesDesconocidas(texto: string): string[] {
  const malas = new Set<string>();
  const revisar = (dentro: string) => {
    const e = parseExpresion(dentro);
    if (!e) return;
    for (const f of e.funciones) if (!FUNCIONES[f.nombre]) malas.add(f.nombre);
  };
  for (const m of texto.matchAll(LLAVES)) revisar(m[1]);
  // Y el texto entero como expresión pelada, que es la forma del «Campo» de los nodos de
  // lógica. No hay falsos positivos: una frase normal no pasa `RUTA` (el espacio la tumba).
  revisar(texto);
  return [...malas];
}

/**
 * Las funciones inexistentes de un grafo entero, con el nodo donde están. Recorre la config
 * como `interpolarConfig`: strings, arrays y objetos anidados, para pillar también los `casos`
 * de un `logic.switch` metidos en un campo `json`.
 */
export function problemasDeFunciones(nodos: { type: string; config: unknown }[]): string[] {
  const conocidas = nombresConocidos();
  const problemas: string[] = [];
  for (const nodo of nodos) {
    const malas = new Set<string>();
    hondo(nodo.config, (s) => funcionesDesconocidas(s).forEach((f) => malas.add(f)));
    for (const f of malas) {
      problemas.push(
        `El nodo «${nodo.type}» usa una función que no existe: «${f}». Las que hay: ${conocidas}.`,
      );
    }
  }
  return problemas;
}

function nombresConocidos(): string {
  return Object.keys(FUNCIONES).sort().join(', ');
}

function hondo(v: unknown, cada: (s: string) => void): void {
  if (typeof v === 'string') return cada(v);
  if (Array.isArray(v)) return void v.forEach((x) => hondo(x, cada));
  if (v && typeof v === 'object') return void Object.values(v as Record<string, unknown>).forEach((x) => hondo(x, cada));
}
