// Check del catálogo de nodos (v3 feature 17). Correr: npx ts-node src/automations/catalog.check.ts
import * as assert from 'node:assert';
import { GUARDAR_COMO, NODE_TYPES, catalogoPublico, interpolarConfig, modoRutas, nodeType, schemaDe, validarConfig, validarTrigger } from './catalog';
import { TRIGGERS } from './triggers';

// --- forma del catálogo ---
const keys = NODE_TYPES.map((t) => t.key);
assert.strictEqual(new Set(keys).size, keys.length, 'las keys son únicas');
for (const t of NODE_TYPES) {
  assert.ok(t.label && t.descripcion, `${t.key} tiene label y descripción`);
  assert.ok(['trigger', 'accion', 'logica'].includes(t.category), `${t.key} tiene categoría válida`);
  assert.ok(t.configSchema && typeof t.configSchema === 'object', `${t.key} declara configSchema`);
  // Un trigger no se ejecuta; una acción o lógica sin handler sería un nodo que no hace nada.
  if (t.category === 'trigger') assert.ok(!t.handler, `${t.key} es trigger y no lleva handler`);
  else assert.ok(typeof t.handler === 'function', `${t.key} tiene handler`);
  for (const [campo, def] of Object.entries(t.configSchema)) {
    if (def.tipo === 'opcion') {
      assert.ok(def.opciones?.length, `${t.key}.${campo} de tipo opción declara sus opciones`);
    }
  }
}

// Todo trigger del motor está en el catálogo, y al revés: si divergen, el editor ofrece
// disparadores que nadie escucha (o al contrario).
for (const key of TRIGGERS) {
  assert.strictEqual(nodeType(key)?.category, 'trigger', `${key} está en el catálogo como trigger`);
}
assert.strictEqual(
  NODE_TYPES.filter((t) => t.category === 'trigger').length,
  TRIGGERS.length,
  'no hay triggers en el catálogo que el motor no conozca',
);

// Los nodos que la spec 17 nombra explícitamente, incluido el que sustituye a la vieja 13.
for (const key of ['message.send', 'handoff.human', 'deal.create', 'deal.moveStage', 'deal.setStatus', 'task.create', 'http.request']) {
  assert.ok(nodeType(key), `existe el node type ${key}`);
}

// --- catálogo público: sin handler y serializable (va al navegador) ---
const publico = catalogoPublico();
assert.ok(!publico.some((t: any) => 'handler' in t), 'el catálogo público no lleva handlers');
assert.doesNotThrow(() => JSON.stringify(publico));

// --- validarConfig ---
assert.deepStrictEqual(validarConfig('message.send', { texto: 'hola' }), { texto: 'hola' });
assert.throws(() => validarConfig('message.send', {}), /falta/i, 'campo requerido ausente');
assert.throws(() => validarConfig('message.send', { texto: 42 }), /texto/i, 'tipo equivocado');
assert.throws(() => validarConfig('inventado.nodo', {}), /desconocido/i);
// Lo que no está en el schema se descarta: así un editor viejo no mete basura en la columna.
assert.deepStrictEqual(validarConfig('message.send', { texto: 'hola', colado: 'x' }), { texto: 'hola' });
// Opciones.
assert.deepStrictEqual(validarConfig('conversation.setStatus', { status: 'closed' }), { status: 'closed' });
assert.throws(() => validarConfig('conversation.setStatus', { status: 'archivado' }), /tiene que ser uno de/);
// Números y booleanos llegan como texto desde un formulario.
assert.deepStrictEqual(validarConfig('wait.delay', { minutos: '15' }), { minutos: 15 });
assert.throws(() => validarConfig('wait.delay', { minutos: 'quince' }), /número/);
assert.deepStrictEqual(validarConfig('deal.create', { sinDueno: 'true' }), { sinDueno: true });
// Los opcionales vacíos no se guardan como '' (que luego se lee como «hay valor»).
assert.deepStrictEqual(validarConfig('conversation.assign', { userId: '' }), {});

// --- validarTrigger ---
assert.deepStrictEqual(validarTrigger({ type: 'message.keyword', config: { palabras: ['precio'] } }), {
  type: 'message.keyword',
  config: { palabras: ['precio'] },
});
assert.throws(() => validarTrigger({ type: 'nope' }), /Disparador desconocido/);
assert.throws(() => validarTrigger({ type: 'message.keyword', config: {} }), /falta/i);
assert.deepStrictEqual(validarTrigger({ type: 'manual' }), { type: 'manual', config: {} });

// --- schemaDe: «Guardar el resultado como» donde hay algo que nombrar ---
for (const t of NODE_TYPES) {
  const tiene = 'guardarComo' in schemaDe(t);
  const deberia = t.category !== 'logica' && !t.sinSalida;
  assert.strictEqual(tiene, deberia, `${t.key}: guardarComo donde hay salida que nombrar`);
}
// Los triggers SÍ lo llevan: su salida es la carga del disparo (`contexto.disparador`).
assert.ok('guardarComo' in schemaDe(nodeType('message.keyword')!), 'un disparador puede nombrar su carga');
// La lógica solo produce la rama, y `wait.reply` escribe su paso antes de esperar.
assert.strictEqual(schemaDe(nodeType('logic.condition')!), nodeType('logic.condition')!.configSchema);
assert.ok(!('guardarComo' in schemaDe(nodeType('wait.reply')!)), 'wait.reply guardaría siempre null');
// `var.set` declara el suyo y gana: ahí el nombre es obligatorio y se llama distinto.
assert.strictEqual(schemaDe(nodeType('var.set')!).guardarComo.requerido, true);
assert.strictEqual(schemaDe(nodeType('var.set')!).guardarComo.label, 'Nombre de la variable');
// Y el editor lo recibe, que es lo que hace que el panel lo pinte sin saber que existe.
assert.ok('guardarComo' in catalogoPublico().find((t) => t.key === 'http.request')!.configSchema);

// --- el nombre de la variable se valida al guardar ---
assert.deepStrictEqual(validarConfig('http.request', { url: 'https://x.mx', guardarComo: 'cotiza' }), {
  url: 'https://x.mx',
  guardarComo: 'cotiza',
});
// Un nombre con punto o con espacio se guardaría igual y luego NO resolvería, en silencio.
assert.throws(() => validarConfig('http.request', { url: 'https://x.mx', guardarComo: 'a.b' }), /nombre de variable/i);
assert.throws(() => validarConfig('http.request', { url: 'https://x.mx', guardarComo: 'mi total' }), /nombre de variable/i);
assert.deepStrictEqual(validarConfig('http.request', { url: 'https://x.mx' }), { url: 'https://x.mx' }, 'es opcional');
assert.throws(() => validarConfig('var.set', { valor: '12' }), /falta/i, 'en var.set es obligatorio');

// El código es un campo de texto más de cara a la validación.
assert.deepStrictEqual(validarConfig('code.run', { codigo: 'return 1' }), { codigo: 'return 1' });
assert.throws(() => validarConfig('code.run', {}), /falta/i);

// --- interpolarConfig: TODA cadena, con dos excepciones declaradas ---
const CTX = { vars: { total: '1840' }, ajustes: { minimo: '500' }, nodos: {} };
const conf = (key: string, c: Record<string, unknown>) => interpolarConfig(nodeType(key)!, c, CTX);

// El caso que motivó el cambio: el `valor` de «Si… entonces» NO se interpolaba, así que
// comparaba contra el literal «{{ajustes.minimo}}» y se iba SIEMPRE por la rama falsa.
assert.deepStrictEqual(
  conf('logic.condition', { campo: 'vars.total', operador: 'gt', valor: '{{ajustes.minimo}}' }),
  { campo: 'vars.total', operador: 'gt', valor: '500' },
);
assert.strictEqual((conf('message.send', { texto: 'Son {{vars.total}}' }) as any).texto, 'Son 1840');
// Dentro de un `json` también: si no, los `casos` de «Según el valor» serían el último hueco.
assert.deepStrictEqual(
  (conf('logic.switch', { campo: 'x', casos: [{ rama: 'vip', operador: 'eq', valor: '{{vars.total}}' }] }) as any).casos,
  [{ rama: 'vip', operador: 'eq', valor: '1840' }],
);
// Lo que NO se toca.
assert.strictEqual((conf('wait.delay', { minutos: 15 }) as any).minutos, 15, 'un number se queda igual');
assert.strictEqual(
  (conf('code.run', { codigo: 'return "{{vars.total}}"' }) as any).codigo,
  'return "{{vars.total}}"',
  'el código NO se interpola: si no, el texto de un cliente entraría dentro del programa',
);
assert.strictEqual(
  (conf('var.set', { guardarComo: 'total', valor: '{{vars.total}}' }) as any).guardarComo,
  'total',
  'guardarComo es un nombre, no una plantilla',
);

// --- modoRutas: qué sintaxis sugiere el editor en cada campo ---
assert.strictEqual(modoRutas(nodeType('message.send')!.configSchema.texto), 'llaves');
assert.strictEqual(modoRutas(nodeType('code.run')!.configSchema.codigo), 'ctx');
// El «Campo» de los nodos de lógica es una ruta CRUDA: sugerir `{{}}` ahí enseñaría a
// escribir algo que `valorDe` no resuelve.
for (const k of ['logic.condition', 'logic.switch', 'logic.filter']) {
  assert.strictEqual(modoRutas(nodeType(k)!.configSchema.campo), 'ruta', k);
}
assert.strictEqual(modoRutas(GUARDAR_COMO), null, 'en un nombre no se sugieren rutas');
assert.strictEqual(modoRutas(nodeType('wait.delay')!.configSchema.minutos), null, 'un number no lleva rutas');
assert.strictEqual(modoRutas(nodeType('logic.condition')!.configSchema.operador), null, 'un desplegable tampoco');

// --- el flag `espera` no se puede olvidar (43) --------------------------------------------
// Las guardas ESTÁTICAS de la 43 —el desplegable de `/llamables` y la activación— preguntan por
// `tipo.espera` para saber si un flujo se puede llamar. La guarda de EJECUCIÓN pregunta por
// `salida.esperar`, por estructura. Si los dos dejan de coincidir, un sub-flujo que espera pasa
// las dos primeras puertas y muere en la tercera, en producción, a mitad de una conversación.
//
// Lo que esto atrapa es el olvido: alguien añade un nodo que aparca el run y no declara el flag.
{
  const dobles = require('./simulacion').dobles as (r: unknown[], f: null) => unknown;
  const ctxMinimo = { mensaje: { texto: 'x' }, contacto: { id: 'c' }, conversacion: { id: 'v' }, nodos: {}, vars: {}, ajustes: {} };
  const ej = { tenantId: 't', actorUserId: 'u', conversationId: 'v', nodeId: 'n', contexto: ctxMinimo, servicios: dobles([], null) };

  Promise.all(
    NODE_TYPES.filter((t) => t.handler).map(async (t) => {
      let salida: { esperar?: unknown } | null = null;
      try {
        salida = await t.handler!(interpolarConfig(t, {}, ctxMinimo as never), ej as never);
      } catch {
        // Un handler que necesita config de verdad no se puede juzgar con la vacía. Los dos que
        // esperan hoy —`wait.delay` y `wait.reply`— tienen valores por defecto, así que sí se
        // juzgan; el día que uno espere y además exija configuración, este check deja de verlo.
        // ponytail: techo conocido. Camino: darle a cada tipo una config de ejemplo en el
        // catálogo, que además serviría para la biblioteca de recetas.
        return;
      }
      assert.strictEqual(
        !!salida?.esperar,
        !!t.espera,
        `${t.key}: el flag \`espera\` y lo que devuelve el handler no coinciden`,
      );
    }),
  ).then(
    () => console.log('catalog.check OK'),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}

