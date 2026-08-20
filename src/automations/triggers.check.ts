// Check de los disparadores (v3 feature 18). Correr: npx ts-node src/automations/triggers.check.ts
import * as assert from 'node:assert';
import { evaluarEntrante, patronCron } from './triggers';

// Azúcar para los casos donde solo importa el sí/no.
const dispara = (raw: unknown, ev: { texto: string; esGrupo: boolean }) => evaluarEntrante(raw, ev).dispara;

const entrante = (texto: string, esGrupo = false) => ({ texto, esGrupo });

// --- message.inbound: cualquier entrante ---
assert.ok(dispara({ type: 'message.inbound' }, entrante('hola')));
assert.ok(dispara({ type: 'message.inbound' }, entrante('')), 'un entrante sin texto sigue siendo un entrante');

// --- message.keyword ---
const kw = { type: 'message.keyword', config: { palabras: ['precio', 'catálogo'] } };
assert.ok(dispara(kw, entrante('hola, quiero PRECIO')), 'no exige el mensaje exacto');
assert.ok(dispara(kw, entrante('mandame el catalogo')), 'ignora acentos');
assert.ok(!dispara(kw, entrante('buenos dias')));
assert.ok(!dispara({ type: 'message.keyword', config: { palabras: [] } }, entrante('precio')), 'sin palabras no dispara');
assert.ok(!dispara({ type: 'message.keyword' }, entrante('precio')), 'config ausente no dispara');
// Una palabra vacía en la lista haría `includes('')` → true con CUALQUIER mensaje.
assert.ok(!dispara({ type: 'message.keyword', config: { palabras: ['  '] } }, entrante('lo que sea')));

// --- los grupos quedan fuera de todo ---
assert.ok(!dispara({ type: 'message.inbound' }, entrante('hola', true)));
assert.ok(!dispara(kw, entrante('precio', true)));

// --- la palabra que hizo match viaja al contexto ---
// Sin esto, un nodo posterior que quiera saber cuál coincidió tiene que reimplementar la
// normalización de acentos, que es privada del módulo.
assert.strictEqual(evaluarEntrante(kw, entrante('hola, quiero PRECIO')).palabra, 'precio');
assert.strictEqual(evaluarEntrante(kw, entrante('mandame el catalogo')).palabra, 'catálogo',
  'devuelve la palabra COMO SE CONFIGURÓ, no como la escribió el cliente');
assert.strictEqual(evaluarEntrante(kw, entrante('buenos dias')).palabra, null);
assert.strictEqual(evaluarEntrante({ type: 'message.inbound' }, entrante('hola')).palabra, null,
  'sin palabras que casar, no hay palabra');
// Con varias, la primera de la lista que aparezca — determinista, no la más larga ni la
// primera del texto: el operador ve el mismo orden que escribió.
assert.strictEqual(
  evaluarEntrante({ type: 'message.keyword', config: { palabras: ['precio', 'catálogo'] } },
    entrante('quiero el catalogo y el precio')).palabra,
  'precio',
);

// --- los que no los dispara un mensaje ---
assert.ok(!dispara({ type: 'manual' }, entrante('hola')));
// `webhook.received` YA NO dispara con un entrante: tiene su propia URL pública. Antes era
// un duplicado exacto de `message.inbound` que además no traía el evento a ningún sitio.
assert.ok(!dispara({ type: 'webhook.received' }, entrante('hola')));
assert.ok(!dispara({ type: 'schedule.cron', config: { patron: '* * * * *' } }, entrante('hola')));
assert.ok(!dispara({ type: 'inventado' }, entrante('hola')));
assert.ok(!dispara(null, entrante('hola')), 'trigger corrupto no dispara');

// --- cron ---
assert.strictEqual(patronCron({ type: 'schedule.cron', config: { patron: '0 9 * * 1' } }), '0 9 * * 1');
assert.strictEqual(patronCron({ type: 'schedule.cron', config: {} }), null);
assert.strictEqual(patronCron({ type: 'message.inbound' }), null);

console.log('triggers.check OK');
