// Check de media.util (sin BD ni red). Correr: npx ts-node src/messaging/media.util.check.ts
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import {
  buildMediaPayload,
  kindForMime,
  signMedia,
  validateMedia,
  verifyMedia,
  withMediaUrl,
} from './media.util';

// kindForMime
assert.equal(kindForMime('image/jpeg'), 'image');
assert.equal(kindForMime('image/webp'), 'sticker');
assert.equal(kindForMime('audio/ogg'), 'audio');
assert.equal(kindForMime('video/mp4'), 'video');
assert.equal(kindForMime('application/pdf'), 'document');

// validateMedia: acepta lo válido, rechaza MIME y tamaño
assert.equal(validateMedia('image/png', 1024), 'image');
assert.equal(validateMedia('application/pdf', 1024), 'document'); // document acepta cualquier MIME
assert.throws(() => validateMedia('image/gif', 1024), /MIME no permitido/);
assert.throws(() => validateMedia('image/png', 6 * 1024 * 1024), /demasiado grande/);

// buildMediaPayload: caption solo donde aplica; filename solo en document
const img = buildMediaPayload('521999', 'image', 'MID', { caption: 'hola' }) as any;
assert.equal(img.type, 'image');
assert.equal(img.image.id, 'MID');
assert.equal(img.image.caption, 'hola');
const stk = buildMediaPayload('521999', 'sticker', 'MID', { caption: 'no' }) as any;
assert.equal(stk.sticker.caption, undefined); // sticker no lleva caption
const doc = buildMediaPayload('521999', 'document', 'MID', { filename: 'x.pdf', caption: 'c' }) as any;
assert.equal(doc.document.filename, 'x.pdf');
assert.equal(doc.document.caption, 'c');

// Firma de URL: roundtrip válido; firma alterada y exp vencido rechazados
const secret = randomBytes(32);
const key = '11111111-1111-1111-1111-111111111111';
const exp = String(Date.now() + 60_000);
const sig = signMedia(key, exp, secret);
assert.equal(verifyMedia(key, exp, sig, secret), true);
assert.equal(verifyMedia(key, exp, sig.replace(/.$/, '0'), secret), false, 'firma alterada');
assert.equal(verifyMedia(key, String(Date.now() - 1), signMedia(key, String(Date.now() - 1), secret), secret), false, 'exp vencido');
assert.equal(verifyMedia(key, exp, signMedia(key, exp, randomBytes(32)), secret), false, 'otro secreto');

// withMediaUrl: añade mediaUrl si hay mediaKey; no toca lo demás
const withKey = withMediaUrl({ id: '1', payload: { mediaKey: 'abc' } }, (k) => `/media/${k}`) as any;
assert.equal(withKey.payload.mediaUrl, '/media/abc');
const noKey = withMediaUrl({ id: '2', payload: { text: { body: 'hi' } } }, () => 'X') as any;
assert.equal(noKey.payload.mediaUrl, undefined);

console.log('media.util.check OK');
