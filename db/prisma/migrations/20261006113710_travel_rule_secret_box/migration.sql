-- Travel Rule şifrelemesi `@squaresdk/solana-hardening`'in SecretBox biçimine geçti (BE-23, ADR 0017):
-- şifreli kayıt ve sarılmış anahtar `sq1.<anahtar>.<iv>.<veri>` metnidir; IV ve algoritma bu biçimin içindedir.
-- Eski biçimdeki şifreli satır yeni biçime çevrilemez: varsa migration durur (silinmiş satırlar etkilenmez).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "travel_rule_records" WHERE "purged_at" IS NULL) THEN
    RAISE EXCEPTION 'travel_rule_records: eski biçimde şifreli satır var; SecretBox biçimine geçiş için önce taşınmalı';
  END IF;
END $$;

ALTER TABLE "travel_rule_records" DROP CONSTRAINT "travel_rule_records_purged_fields";

-- AlterTable
ALTER TABLE "travel_rule_records" DROP COLUMN "algorithm",
DROP COLUMN "iv",
ALTER COLUMN "ciphertext" SET DATA TYPE TEXT USING NULL,
ALTER COLUMN "wrapped_key" SET DATA TYPE TEXT USING NULL;

-- Silinen kaydın şifreli alanlarının hepsi null, silinmemişin hepsi dolu.
ALTER TABLE "travel_rule_records" ADD CONSTRAINT "travel_rule_records_purged_fields" CHECK (("purged_at" IS NULL AND "ciphertext" IS NOT NULL AND "key_id" IS NOT NULL AND "wrapped_key" IS NOT NULL) OR ("purged_at" IS NOT NULL AND "ciphertext" IS NULL AND "key_id" IS NULL AND "wrapped_key" IS NULL));
