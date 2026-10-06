-- BE-22: uyuşmazlık araçları. Dispute aynasına oy sayımı ve kapanış alanları, kanıt kaydı, arbitrator webhook
-- abonelikleri ve bildirim outbox'ı; `disputes:write` API anahtarı kapsamı.

-- CreateEnum
CREATE TYPE "EvidenceRole" AS ENUM ('institution', 'agent', 'arbitrator');

-- CreateEnum
CREATE TYPE "ArbitrationEvent" AS ENUM ('dispute.raised', 'dispute.escalated', 'dispute.vote', 'dispute.decided', 'dispute.deadline');

-- CreateEnum
CREATE TYPE "DeliveryState" AS ENUM ('pending', 'delivered', 'failed');

-- AlterEnum
ALTER TYPE "ApiKeyScope" ADD VALUE 'disputes:write';

-- AlterTable: var olan satırlar geçici 0 değeriyle eklenir, varsayılan sonra kaldırılır (şemada varsayılan
-- yoktur; ayna değerleri yalnızca hesaptan yazılır). Indexer'ın uzlaştırması (`checkDisputes`) eksik değerleri
-- zincirdeki job'lardan düzeltir.
ALTER TABLE "disputes" ADD COLUMN     "approval_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "approval_mask" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "arbitrator_set_version" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "closed_at" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "decided_at" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "disputes" ALTER COLUMN "approval_count" DROP DEFAULT,
ALTER COLUMN "approval_mask" DROP DEFAULT,
ALTER COLUMN "arbitrator_set_version" DROP DEFAULT,
ALTER COLUMN "closed_at" DROP DEFAULT,
ALTER COLUMN "decided_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "dispute_evidence" (
    "id" UUID NOT NULL,
    "job" VARCHAR(44) NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "content_type" VARCHAR(120) NOT NULL,
    "byte_size" BIGINT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "role" "EvidenceRole" NOT NULL,
    "uploaded_by" VARCHAR(44) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "arbitration_webhooks" (
    "id" UUID NOT NULL,
    "wallet" VARCHAR(44) NOT NULL,
    "url" VARCHAR(512) NOT NULL,
    "events" "ArbitrationEvent"[],
    "secret" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "arbitration_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_outbox" (
    "id" UUID NOT NULL,
    "webhook_id" UUID NOT NULL,
    "event_key" TEXT NOT NULL,
    "type" "ArbitrationEvent" NOT NULL,
    "job" VARCHAR(44) NOT NULL,
    "payload" JSONB NOT NULL,
    "state" "DeliveryState" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "locked_until" TIMESTAMPTZ(3),
    "last_status" INTEGER,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "delivered_at" TIMESTAMPTZ(3),

    CONSTRAINT "notification_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_cursors" (
    "name" TEXT NOT NULL,
    "last_event_id" BIGINT NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_cursors_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE INDEX "dispute_evidence_job_created_at_idx" ON "dispute_evidence"("job", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_evidence_job_content_hash_key" ON "dispute_evidence"("job", "content_hash");

-- CreateIndex
CREATE UNIQUE INDEX "arbitration_webhooks_wallet_url_key" ON "arbitration_webhooks"("wallet", "url");

-- CreateIndex
CREATE INDEX "notification_outbox_state_next_attempt_at_idx" ON "notification_outbox"("state", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_outbox_webhook_id_event_key_key" ON "notification_outbox"("webhook_id", "event_key");

-- CreateIndex
CREATE INDEX "disputes_job_status_deadline_idx" ON "disputes"("job_status", "deadline");

-- AddForeignKey
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "arbitration_webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Biçim kısıtları: scripts/check-constraints.mjs çıktısı (Prisma şeması CHECK ifade edemez).
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_content_hash_hex32" CHECK ("content_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_uploaded_by_address" CHECK ("uploaded_by" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "arbitration_webhooks" ADD CONSTRAINT "arbitration_webhooks_wallet_address" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');

-- Aralıklar: oy sayımı u8 bit maskesi ve en fazla 7 arbitrator; set sürümü u32; sayaçlar ve boyut negatif değil.
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_approval_mask_u8" CHECK ("approval_mask" >= 0 AND "approval_mask" <= 255);
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_approval_count_u8" CHECK ("approval_count" >= 0 AND "approval_count" <= 255);
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_arbitrator_set_version_u32" CHECK ("arbitrator_set_version" >= 0 AND "arbitrator_set_version" <= 4294967295);
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_byte_size_nonnegative" CHECK ("byte_size" >= 0);
ALTER TABLE "arbitration_webhooks" ADD CONSTRAINT "arbitration_webhooks_events_nonempty" CHECK (cardinality("events") > 0);
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_attempts_nonnegative" CHECK ("attempts" >= 0);
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_last_status_http" CHECK ("last_status" IS NULL OR ("last_status" >= 100 AND "last_status" <= 599));
