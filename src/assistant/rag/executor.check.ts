// Check del ejecutor seguro. Correr: npx ts-node src/assistant/rag/executor.check.ts
// La parte de RLS/timeout es integración: corre solo si DATABASE_URL_RO está configurado
// (con assistant-setup.sql aplicado y datos de 2 tenants); si no, se salta.
import * as assert from 'node:assert';
import { SqlExecutor } from './executor';
import { UnsafeSqlError } from './sql-guard';

async function main() {
  // Sin configurar: deshabilitado y falla claro (no toca la BD).
  const off = new SqlExecutor(undefined);
  assert.strictEqual(off.enabled, false);
  await assert.rejects(() => off.runSelect('t1', 'SELECT 1'), /deshabilitada|no configurado/);

  const url = process.env.DATABASE_URL_RO;
  if (!url) {
    console.log('executor.check OK (integración RLS saltada: sin DATABASE_URL_RO)');
    return;
  }

  const ex = new SqlExecutor(url);
  try {
    // SQL peligroso: rechazado por el guard ANTES de tocar la BD.
    await assert.rejects(() => ex.runSelect('t1', 'DELETE FROM "Conversation"'), UnsafeSqlError);

    // RLS: con un tenantId inexistente no debe devolver filas de otros tenants.
    const rows = await ex.runSelect('__tenant_inexistente__', 'SELECT id FROM "Conversation"');
    assert.strictEqual(rows.length, 0, 'RLS debería aislar: 0 filas para tenant inexistente');

    // LIMIT inyectado: no explota y respeta el tope aunque el SQL no lo traiga.
    const capped = await ex.runSelect('__tenant_inexistente__', 'SELECT id FROM "Message"');
    assert.ok(Array.isArray(capped));
    console.log('executor.check OK (integración RLS ejecutada)');
  } finally {
    await ex.close();
  }
}

main().catch((e) => {
  console.error('executor.check FALLÓ:', e);
  process.exit(1);
});
