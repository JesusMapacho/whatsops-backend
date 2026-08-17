// Check de los disparadores (v3 feature 18). Correr: npx ts-node src/automations/triggers.check.ts
import * as assert from 'node:assert';
import { disparaConEntrante, patronCron } from './triggers';

const entrante = (texto: string, esGrupo = false) => ({ texto, esGrupo });

// --- message.inbound: cualquier entrante ---
assert.ok(disparaConEntrante({ type: 'message.inbound' }, entrante('hola')));
assert.ok(disparaConEntrante({ type: 'message.inbound' }, entrante('')), 'un entrante sin texto sigue siendo un entrante');

// --- message.keyword ---
const kw = { type: 'message.keyword', config: { palabras: ['precio', 'catálogo'] } };
assert.ok(disparaConEntrante(kw, entrante('hola, quiero PRECIO')), 'no exige el mensaje exacto');
assert.ok(disparaConEntrante(kw, entrante('mandame el catalogo')), 'ignora acentos');
assert.ok(!disparaConEntrante(kw, entrante('buenos dias')));
assert.ok(!disparaConEntrante({ type: 'message.keyword', config: { palabras: [] } }, entrante('precio')), 'sin palabras no dispara');
assert.ok(!disparaConEntrante({ type: 'message.keyword' }, entrante('precio')), 'config ausente no dispara');
// Una palabra vacía en la lista haría `includes('')` → true con CUALQUIER mensaje.
assert.ok(!disparaConEntrante({ type: 'message.keyword', config: { palabras: ['  '] } }, entrante('lo que sea')));

// --- los grupos quedan fuera de todo ---
assert.ok(!disparaConEntrante({ type: 'message.inbound' }, entrante('hola', true)));
assert.ok(!disparaConEntrante(kw, entrante('precio', true)));

// --- los que no los dispara un mensaje ---
assert.ok(!disparaConEntrante({ type: 'manual' }, entrante('hola')));
assert.ok(!disparaConEntrante({ type: 'schedule.cron', config: { patron: '* * * * *' } }, entrante('hola')));
assert.ok(!disparaConEntrante({ type: 'inventado' }, entrante('hola')));
assert.ok(!disparaConEntrante(null, entrante('hola')), 'trigger corrupto no dispara');

// --- cron ---
assert.strictEqual(patronCron({ type: 'schedule.cron', config: { patron: '0 9 * * 1' } }), '0 9 * * 1');
assert.strictEqual(patronCron({ type: 'schedule.cron', config: {} }), null);
assert.strictEqual(patronCron({ type: 'message.inbound' }), null);

console.log('triggers.check OK');
