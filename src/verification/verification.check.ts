// Check de VerificationService. Correr: npx ts-node src/verification/verification.check.ts
import * as assert from 'node:assert';
import { VerificationService } from './verification.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CodeSender } from './code-sender';

// Prisma fake en memoria para verificationCode.
function fakePrisma() {
  const rows: any[] = [];
  let seq = 0;
  return {
    _rows: rows,
    verificationCode: {
      async findMany({ where }: any) {
        return rows
          .filter((r) => r.userId === where.userId && r.purpose === where.purpose)
          .filter((r) => (where.createdAt?.gt ? r.createdAt > where.createdAt.gt : true))
          .sort((a, b) => b.createdAt - a.createdAt);
      },
      async create({ data }: any) {
        const row = { id: `c${seq++}`, attempts: 0, consumedAt: null, createdAt: new Date(), ...data };
        rows.push(row);
        return row;
      },
      async findFirst({ where }: any) {
        return (
          rows
            .filter((r) => r.userId === where.userId && r.purpose === where.purpose)
            .filter((r) => r.consumedAt === null)
            .filter((r) => r.expiresAt > where.expiresAt.gt)
            .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
        );
      },
      async update({ where, data }: any) {
        const r = rows.find((x) => x.id === where.id);
        if (data.attempts?.increment) r.attempts += data.attempts.increment;
        if (data.consumedAt) r.consumedAt = data.consumedAt;
        return r;
      },
    },
  } as unknown as PrismaService & { _rows: any[] };
}

const noopSender: CodeSender = { async send() {} };

async function run() {
  process.env.AUTH_DEV_ECHO_CODES = 'true'; // para conocer el código en el test

  const prisma = fakePrisma() as any;
  const svc = new VerificationService(prisma, noopSender);

  const { devCode } = await svc.requestCode('u1', 'email_verify', 'email', 'a@b.com');
  assert.ok(/^\d{6}$/.test(devCode!), 'código de 6 dígitos');

  // Código equivocado → rechaza y suma intento.
  await assert.rejects(() => svc.verifyCode('u1', 'email_verify', '000000') as any);
  // (a menos que 000000 fuera el real; improbable, pero el store lo refleja)

  // Código correcto → true y consume.
  const ok = await svc.verifyCode('u1', 'email_verify', devCode!);
  assert.strictEqual(ok, true, 'verifica con el código real');
  // Ya consumido → segundo intento con el mismo código falla.
  await assert.rejects(() => svc.verifyCode('u1', 'email_verify', devCode!) as any);

  // Expirado → rechaza.
  const r2 = await svc.requestCode('u1', 'phone_verify', 'sms', '+5215555555555');
  const row = prisma._rows.find((x: any) => x.purpose === 'phone_verify');
  row.expiresAt = new Date(Date.now() - 1000);
  await assert.rejects(() => svc.verifyCode('u1', 'phone_verify', r2.devCode!) as any);

  // Rate-limit: segundo envío inmediato del mismo propósito → 429.
  await assert.rejects(() => svc.requestCode('u1', 'phone_verify', 'sms', '+5215555555555') as any, /momento/);

  console.log('verification.check OK');
}

run();
