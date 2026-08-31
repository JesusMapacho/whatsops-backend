-- CreateTable
CREATE TABLE "PosLink" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "posTenantId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PosLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SsoExchangeToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SsoExchangeToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PosLink_tenantId_key" ON "PosLink"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "PosLink_posTenantId_key" ON "PosLink"("posTenantId");

-- CreateIndex
CREATE INDEX "PosLink_posTenantId_idx" ON "PosLink"("posTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "SsoExchangeToken_tokenHash_key" ON "SsoExchangeToken"("tokenHash");

-- CreateIndex
CREATE INDEX "SsoExchangeToken_userId_idx" ON "SsoExchangeToken"("userId");

-- AddForeignKey
ALTER TABLE "PosLink" ADD CONSTRAINT "PosLink_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SsoExchangeToken" ADD CONSTRAINT "SsoExchangeToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
