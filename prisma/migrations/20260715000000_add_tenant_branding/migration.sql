-- AlterTable: branding white-label del tenant (v2 feature 16)
ALTER TABLE "Tenant" ADD COLUMN     "accentColor" TEXT,
ADD COLUMN     "logoKey" TEXT;
