// Check de verifySignature. Correr: npx ts-node src/webhook/signature.check.ts
import * as assert from 'node:assert';
import { createHmac } from 'node:crypto';
import { verifySignature } from './signature';

const secret = 'app-secret';
const body = Buffer.from(JSON.stringify({ entry: [{ id: '1' }] }));
const good = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

assert.strictEqual(verifySignature(body, good, secret), true); // firma correcta
assert.strictEqual(verifySignature(body, good, 'otro-secreto'), false); // secreto distinto
assert.strictEqual(verifySignature(Buffer.from('x'), good, secret), false); // body alterado
assert.strictEqual(verifySignature(body, 'sha256=zzzz', secret), false); // hex inválido
assert.strictEqual(verifySignature(body, undefined, secret), false); // sin header
assert.strictEqual(verifySignature(body, good.slice('sha256='.length), secret), false); // sin prefijo

console.log('signature.check OK');
