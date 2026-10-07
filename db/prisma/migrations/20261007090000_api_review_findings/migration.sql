-- AlterEnum
ALTER TYPE "ApiKeyScope" ADD VALUE 'disputes:read';

-- DropIndex
DROP INDEX "x402_payments_network_fingerprint_key";

-- DropIndex
DROP INDEX "x402_payments_network_transaction_key";

-- AlterTable
ALTER TABLE "disputes" ALTER COLUMN "approval_count" SET DEFAULT 0,
ALTER COLUMN "approval_mask" SET DEFAULT 0,
ALTER COLUMN "arbitrator_set_version" SET DEFAULT 0,
ALTER COLUMN "closed_at" SET DEFAULT 0,
ALTER COLUMN "decided_at" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "x402_payments" ADD COLUMN     "wallet" VARCHAR(44);
UPDATE "x402_payments" AS "payment" SET "wallet" = "endpoint"."wallet" FROM "x402_endpoints" AS "endpoint" WHERE "endpoint"."id" = "payment"."endpoint_id";
ALTER TABLE "x402_payments" ALTER COLUMN "wallet" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "x402_payments_wallet_network_fingerprint_key" ON "x402_payments"("wallet", "network", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "x402_payments_wallet_network_transaction_key" ON "x402_payments"("wallet", "network", "transaction");

ALTER TABLE "x402_payments" ADD CONSTRAINT "x402_payments_wallet_address" CHECK ("wallet" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
