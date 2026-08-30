-- CreateTable
CREATE TABLE "HookRateWindow" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HookRateWindow_pkey" PRIMARY KEY ("key")
);
