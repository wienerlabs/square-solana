-- CCTP relayer (BE-26): `cctp_transfers` CCTP V2'ye göre. V2'de nonce 32 bayttır ve Circle attestation'ı imzalarken
-- atar; burn kaydedildiğinde nonce, mesaj ve tutar henüz yoktur. Kaydı kurum yapar (job'un `institution`'ı), relayer
-- ardışık denemeleri ve bir sonraki bakışı tutar. Tabloya bu migration'dan önce yazan kod yoktu; satır varsa
-- migration durur.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "cctp_transfers") THEN
    RAISE EXCEPTION 'cctp_transfers: CCTP V1 biçiminde satır var; V2 biçimine taşınmadan bu migration uygulanamaz';
  END IF;
END $$;

ALTER TABLE "cctp_transfers" DROP CONSTRAINT "cctp_transfers_nonce_u64";
ALTER TABLE "cctp_transfers" DROP CONSTRAINT "cctp_transfers_message_hash_hex32";

-- DropIndex
DROP INDEX "cctp_transfers_status_idx";

-- DropIndex
DROP INDEX "cctp_transfers_message_hash_key";

-- AlterTable
ALTER TABLE "cctp_transfers" DROP COLUMN "message_hash",
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "attested_at" TIMESTAMPTZ(3),
ADD COLUMN     "fee_executed" DECIMAL(20,0),
ADD COLUMN     "institution" VARCHAR(44) NOT NULL,
ADD COLUMN     "message" TEXT,
ADD COLUMN     "next_attempt_at" TIMESTAMPTZ(3),
ALTER COLUMN "nonce" DROP NOT NULL,
ALTER COLUMN "nonce" SET DATA TYPE CHAR(64) USING NULL,
ALTER COLUMN "source_tx_hash" SET DATA TYPE VARCHAR(66),
ALTER COLUMN "amount" DROP NOT NULL,
ALTER COLUMN "job" SET NOT NULL;

-- CreateIndex
CREATE INDEX "cctp_transfers_status_next_attempt_at_idx" ON "cctp_transfers"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "cctp_transfers_institution_idx" ON "cctp_transfers"("institution");

-- CreateIndex
CREATE UNIQUE INDEX "cctp_transfers_source_domain_source_tx_hash_key" ON "cctp_transfers"("source_domain", "source_tx_hash");

-- Biçim kısıtları (scripts/check-constraints.mjs).
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_institution_address" CHECK ("institution" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_nonce_hex32" CHECK ("nonce" ~ '^[0-9a-f]{64}$');
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_fee_executed_u64" CHECK ("fee_executed" >= 0 AND "fee_executed" <= 18446744073709551615);

-- Kaynak tx'i EVM tx hash'i; mesaj ve attestation küçük harf hex.
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_source_tx_hash_evm" CHECK ("source_tx_hash" ~ '^0x[0-9a-f]{64}$');
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_message_hex" CHECK ("message" ~ '^([0-9a-f]{2})+$');
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_attestation_hex" CHECK ("attestation" ~ '^([0-9a-f]{2})+$');
-- Attestation'ın alanları birlikte gelir; imzalanmış, teslim edilmiş ve fonlanmış transferde doludur.
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_attested_fields" CHECK (
  (("nonce" IS NULL) = ("message" IS NULL) AND ("message" IS NULL) = ("attestation" IS NULL)
    AND ("attestation" IS NULL) = ("amount" IS NULL) AND ("amount" IS NULL) = ("fee_executed" IS NULL)
    AND ("fee_executed" IS NULL) = ("attested_at" IS NULL))
  AND ("status" NOT IN ('attested', 'received', 'funded') OR "nonce" IS NOT NULL)
);
ALTER TABLE "cctp_transfers" ADD CONSTRAINT "cctp_transfers_attempts_nonnegative" CHECK ("attempts" >= 0);
