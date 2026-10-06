-- CreateEnum
CREATE TYPE "IdempotencyState" AS ENUM ('in_progress', 'completed');

-- CreateTable
CREATE TABLE "rate_limit_windows" (
    "key" TEXT NOT NULL,
    "window_start" TIMESTAMPTZ(3) NOT NULL,
    "count" INTEGER NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "rate_limit_windows_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "state" "IdempotencyState" NOT NULL,
    "status" INTEGER,
    "body" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("scope","key")
);

-- CreateTable
CREATE TABLE "replay_guards" (
    "scope" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "replay_guards_pkey" PRIMARY KEY ("scope","id")
);

-- CreateIndex
CREATE INDEX "rate_limit_windows_expires_at_idx" ON "rate_limit_windows"("expires_at");

-- CreateIndex
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

-- CreateIndex
CREATE INDEX "replay_guards_expires_at_idx" ON "replay_guards"("expires_at");

-- Biçim kısıtları: scripts/check-constraints.mjs çıktısı (Prisma şeması CHECK ifade edemez).
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_request_hash_hex32" CHECK ("request_hash" ~ '^[0-9a-f]{64}$');

-- Sayaç ve yanıt durumu aralıkları.
ALTER TABLE "rate_limit_windows" ADD CONSTRAINT "rate_limit_windows_count_positive" CHECK ("count" > 0);
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_status_http" CHECK ("status" IS NULL OR ("status" >= 100 AND "status" <= 599));
-- Tamamlanmış kayıtta yanıt vardır, süren kayıtta yoktur.
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_state_response" CHECK (("state" = 'completed') = ("status" IS NOT NULL));
