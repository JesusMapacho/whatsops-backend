import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { StorageService } from './storage.service';
import { signMedia, verifyMedia } from '../messaging/media.util';

// ponytail: storage en disco local. Techo: no escala multi-instancia; al mover a
// S3 se implementa otra StorageService y se cambia el useClass. La key es un UUID
// (opaca) + un sidecar .json con {mime, filename}. Sirve cualquier MIME sin mapa de extensiones.
const URL_TTL_MS = 60 * 60 * 1000; // 1 h
const KEY_RE = /^[0-9a-f-]{36}$/; // solo UUIDs: evita path traversal

@Injectable()
export class LocalDiskStorage extends StorageService {
  private readonly dir: string;
  private readonly secret: Buffer;

  constructor(config: ConfigService) {
    super();
    this.dir = resolve(config.get<string>('STORAGE_DIR') ?? join(process.cwd(), 'storage'));
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
    // Secreto de firma derivado de ENCRYPTION_KEY (ya validada como 32 bytes hex).
    this.secret = Buffer.from(config.get<string>('ENCRYPTION_KEY') ?? '', 'hex');
  }

  async put(buffer: Buffer, mime: string, filename?: string): Promise<string> {
    const key = randomUUID();
    await writeFile(this.path(key), buffer);
    await writeFile(this.path(`${key}.json`), JSON.stringify({ mime, filename: filename ?? null }));
    return key;
  }

  signedUrl(key: string): string {
    const exp = String(Date.now() + URL_TTL_MS);
    const sig = signMedia(key, exp, this.secret);
    return `/media/${key}?exp=${exp}&sig=${sig}`;
  }

  verify(key: string, exp: string, sig: string): boolean {
    return KEY_RE.test(key) && verifyMedia(key, exp, sig, this.secret);
  }

  async getStream(key: string) {
    if (!KEY_RE.test(key)) throw new NotFoundException('Media no encontrado');
    const file = this.path(key);
    if (!existsSync(file)) throw new NotFoundException('Media no encontrado');
    let mime = 'application/octet-stream';
    try {
      mime = JSON.parse(await readFile(this.path(`${key}.json`), 'utf8')).mime ?? mime;
    } catch {
      // sidecar ausente/corrupto: se sirve como binario genérico
    }
    return { stream: createReadStream(file), mime, size: statSync(file).size };
  }

  private path(name: string): string {
    return join(this.dir, name);
  }
}
