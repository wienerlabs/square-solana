-- Travel Rule saklaması (BE-23, ADR 0017). travel_rule_records init'te taslak olarak açılmıştı ve hiçbir servis
-- yazmıyordu; boş tabloya varsayılansız NOT NULL sütunlar eklenir. kms_key_id yerine ana anahtar halkasının key_id'si.

-- CreateEnum
CREATE TYPE "TravelRuleAccessAction" AS ENUM ('store', 'read', 'grant', 'revoke', 'purge');

-- AlterTable
ALTER TABLE "travel_rule_records" DROP COLUMN "kms_key_id",
ADD COLUMN     "key_id" VARCHAR(32),
ADD COLUMN     "purged_at" TIMESTAMPTZ(3),
ADD COLUMN     "record_digest" CHAR(64) NOT NULL,
ADD COLUMN     "retain_until" TIMESTAMPTZ(3) NOT NULL,
ADD COLUMN     "stored_at" TIMESTAMPTZ(3) NOT NULL,
ADD COLUMN     "stored_by" VARCHAR(44) NOT NULL,
ALTER COLUMN "ciphertext" DROP NOT NULL,
ALTER COLUMN "algorithm" DROP NOT NULL,
ALTER COLUMN "iv" DROP NOT NULL,
ALTER COLUMN "wrapped_key" DROP NOT NULL;

-- CreateTable
CREATE TABLE "travel_rule_grants" (
    "job" VARCHAR(44) NOT NULL,
    "grantee" VARCHAR(44) NOT NULL,
    "purpose" VARCHAR(200) NOT NULL,
    "granted_by" VARCHAR(44) NOT NULL,
    "granted_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    CONSTRAINT "travel_rule_grants_pkey" PRIMARY KEY ("job","grantee")
);

-- CreateTable
CREATE TABLE "travel_rule_accesses" (
    "id" UUID NOT NULL,
    "job" VARCHAR(44) NOT NULL,
    "action" "TravelRuleAccessAction" NOT NULL,
    "actor" VARCHAR(44),
    "grantee" VARCHAR(44),
    "request_id" UUID,
    "at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "travel_rule_accesses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "travel_rule_accesses_job_at_idx" ON "travel_rule_accesses"("job", "at");

-- CreateIndex
CREATE INDEX "travel_rule_records_retain_until_idx" ON "travel_rule_records"("retain_until");

-- CreateIndex
CREATE INDEX "travel_rule_records_key_id_idx" ON "travel_rule_records"("key_id");


-- Biçim kısıtları: scripts/check-constraints.mjs çıktısı (Prisma şeması CHECK ifade edemez).
ALTER TABLE "travel_rule_records" ADD CONSTRAINT "travel_rule_records_record_digest_hex32" CHECK ("record_digest" ~ '^[0-9a-f]{64}$');
ALTER TABLE "travel_rule_records" ADD CONSTRAINT "travel_rule_records_stored_by_address" CHECK ("stored_by" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "travel_rule_grants" ADD CONSTRAINT "travel_rule_grants_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "travel_rule_grants" ADD CONSTRAINT "travel_rule_grants_grantee_address" CHECK ("grantee" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "travel_rule_grants" ADD CONSTRAINT "travel_rule_grants_granted_by_address" CHECK ("granted_by" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "travel_rule_accesses" ADD CONSTRAINT "travel_rule_accesses_job_address" CHECK ("job" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "travel_rule_accesses" ADD CONSTRAINT "travel_rule_accesses_actor_address" CHECK ("actor" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');
ALTER TABLE "travel_rule_accesses" ADD CONSTRAINT "travel_rule_accesses_grantee_address" CHECK ("grantee" ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$');

-- Silinen kaydın şifreli alanlarının hepsi null, silinmemişin hepsi dolu.
ALTER TABLE "travel_rule_records" ADD CONSTRAINT "travel_rule_records_purged_fields" CHECK (("purged_at" IS NULL AND "ciphertext" IS NOT NULL AND "algorithm" IS NOT NULL AND "iv" IS NOT NULL AND "key_id" IS NOT NULL AND "wrapped_key" IS NOT NULL) OR ("purged_at" IS NOT NULL AND "ciphertext" IS NULL AND "algorithm" IS NULL AND "iv" IS NULL AND "key_id" IS NULL AND "wrapped_key" IS NULL));
ALTER TABLE "travel_rule_grants" ADD CONSTRAINT "travel_rule_grants_expires_after_grant" CHECK ("expires_at" > "granted_at");
