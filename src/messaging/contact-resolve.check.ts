// Check de la resolución de identidad del contacto (parte pura).
// Correr: npx ts-node src/messaging/contact-resolve.check.ts
import * as assert from 'node:assert';
import {
  canonicalWaId,
  coldWaId,
  isCanonicalWaId,
  parsePhone,
  preferWaId,
} from './contact-resolve';
import { channelAdapter } from './channels';
import { isWithinWindow } from './messaging.util';

// --- parsePhone ---
const ok = (r: ReturnType<typeof parsePhone>) => (r.ok ? r.digits : `ERROR: ${r.reason}`);
assert.strictEqual(ok(parsePhone('+52 1 871 517 2350')), '5218715172350');
assert.strictEqual(ok(parsePhone('5218715172350')), '5218715172350');
assert.strictEqual(ok(parsePhone('(871) 517-2350 ')), '8715172350');
// Demasiado corto / largo / con 0 inicial / basura.
assert.ok(!parsePhone('871').ok);
assert.ok(!parsePhone('1234567890123456').ok);
assert.ok(!parsePhone('0871517235').ok, 'el 0 nacional no vale en formato internacional');
assert.ok(!parsePhone('abc').ok);
assert.ok(!parsePhone('').ok);
assert.ok(!parsePhone(undefined).ok);
assert.ok(!parsePhone(null).ok);
assert.ok(!parsePhone(5218715172350 as any).ok, 'solo string');

// --- isCanonicalWaId ---
// Un '@lid' identifica a la persona pero no sirve para enviar ni para el historial.
assert.strictEqual(isCanonicalWaId('waha', '175647100039313@lid'), false);
assert.strictEqual(isCanonicalWaId('waha', '5218715172350@c.us'), true);
assert.strictEqual(isCanonicalWaId('waha', '12345-160@g.us'), true, 'un grupo ya es definitivo');
// En los canales de Meta el id que llega siempre es el bueno.
assert.strictEqual(isCanonicalWaId('whatsapp', 'cualquier-cosa'), true);
assert.strictEqual(isCanonicalWaId('messenger', 'PSID9'), true);

// --- preferWaId: DEBE ser simétrico ---
const LID = '175647100039313@lid';
const CUS = '5218715172350@c.us';
assert.strictEqual(preferWaId('waha', LID, CUS), CUS);
assert.strictEqual(preferWaId('waha', CUS, LID), CUS, 'el orden de los argumentos no puede importar');
// Empate → el primero, para no re-clavijar en bucle en cada mensaje.
assert.strictEqual(preferWaId('waha', CUS, '999@c.us'), CUS);
assert.strictEqual(preferWaId('waha', LID, '999@lid'), LID);

// --- coldWaId: el formato correcto por canal ---
assert.strictEqual(coldWaId('waha', '5218715172350'), '5218715172350@c.us');
// A Graph se le manda el número a secas; mandarle '@c.us' es un error 100.
assert.strictEqual(coldWaId('whatsapp', '5218715172350'), '5218715172350');
// De un teléfono NO se puede derivar un PSID/IGSID: tiene que fallar, no inventar.
assert.throws(() => coldWaId('messenger', '5218715172350'));
assert.throws(() => coldWaId('instagram', '5218715172350'));

// --- canonicalWaId: el id que devuelve el proveedor manda sobre el que construimos ---
// En México/Argentina el wa_id de Meta NO es lo que marcaste: '+52 1 871…' → '52871…'.
assert.strictEqual(canonicalWaId({ contacts: [{ wa_id: '528715172350' }] }), '528715172350');
assert.strictEqual(canonicalWaId({}), null);
assert.strictEqual(canonicalWaId({ contacts: [] }), null);
assert.strictEqual(canonicalWaId({ contacts: [{}] }), null);
assert.strictEqual(canonicalWaId(null), null);

// --- El invariante que sostiene todo el diseño en frío ---
// Una conversación creada en frío tiene lastInboundAt NULL, y ese null es lo ÚNICO
// que obliga a Cloud API a usar plantilla. Si alguien lo rellena "para que la UI se
// vea ordenada", se desbloquea el texto libre a desconocidos → 131047 en serie.
assert.strictEqual(isWithinWindow(null), false, 'una conversación en frío está fuera de la ventana');
assert.ok(
  channelAdapter('whatsapp').enforcesWindow,
  'si whatsapp dejara de exigir ventana, el texto en frío saldría sin plantilla',
);
assert.ok(channelAdapter('messenger').enforcesWindow);
// Y en WAHA no hay ventana: ahí el freno tiene que ser el cupo en frío, no la ventana.
assert.strictEqual(channelAdapter('waha').enforcesWindow, false);

console.log('contact-resolve.check OK');
