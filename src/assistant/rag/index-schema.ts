// (Re)indexa el esquema documentado en pgvector. Idempotente.
// Correr (requiere env de LLM/EMBEDDINGS + DATABASE_URL + assistant-setup.sql aplicado):
//   npx ts-node src/assistant/rag/index-schema.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../app.module';
import { BranchBService } from './branch-b.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn', 'log'],
  });
  try {
    const n = await app.get(BranchBService).indexSchema();
    console.log(`Esquema indexado: ${n} tablas.`);
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error('index-schema FALLÓ:', e);
  process.exit(1);
});
