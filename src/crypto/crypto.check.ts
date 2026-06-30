// Check mínimo del cifrado AES-256-GCM. Correr: npx ts-node src/crypto/crypto.check.ts
import * as assert from 'node:assert';
import { ConfigService } from '@nestjs/config';
import { CryptoService } from './crypto.service';

const KEY = '0'.repeat(64); // 32 bytes
const svc = new CryptoService({ get: () => KEY } as unknown as ConfigService);

const secret = 'EAAB-token-secreto-123';
const blob = svc.encrypt(secret);

assert.notStrictEqual(blob, secret, 'el blob no debe ser texto plano');
assert.ok(!blob.includes(secret), 'el plaintext no debe aparecer en el blob');
assert.strictEqual(svc.decrypt(blob), secret, 'decrypt debe recuperar el original');
assert.notStrictEqual(svc.encrypt(secret), blob, 'IV aleatorio: blobs distintos');

// Manipular el ciphertext debe fallar (GCM autenticado).
const tampered = blob.slice(0, -2) + (blob.endsWith('00') ? '11' : '00');
assert.throws(() => svc.decrypt(tampered), 'GCM debe rechazar datos manipulados');

console.log('crypto.check OK');
