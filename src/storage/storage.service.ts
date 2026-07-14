import { Readable } from 'node:stream';

// Contrato de almacenamiento de objetos + token de DI (clase abstracta = ambos en Nest).
// Implementación actual: LocalDiskStorage. Cambiar a S3 = nueva clase + cambiar useClass
// en storage.module.ts; ningún llamador cambia.
export abstract class StorageService {
  // Guarda el binario y devuelve una `key` opaca.
  abstract put(buffer: Buffer, mime: string, filename?: string): Promise<string>;
  // URL temporal y firmada para servir la key (nunca se expone la key cruda ni un bucket público).
  abstract signedUrl(key: string): string;
  // Valida la firma de una URL (usado por el endpoint que sirve el archivo).
  abstract verify(key: string, exp: string, sig: string): boolean;
  // Stream para servir el archivo por la key.
  abstract getStream(key: string): Promise<{ stream: Readable; mime: string; size: number }>;
}
