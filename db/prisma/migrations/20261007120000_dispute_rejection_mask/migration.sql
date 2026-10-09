-- AlterTable: ret oyu (ADR 0028). Var olan satırlar 0 alır: alan gelmeden açılmış job'ların dolgusu da 0'dır.
-- Indexer'ın uzlaştırması (`checkDisputes`) değeri zincirdeki job'lardan düzeltir.
ALTER TABLE "disputes" ADD COLUMN     "rejection_mask" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "disputes" ADD CONSTRAINT "disputes_rejection_mask_u8" CHECK ("rejection_mask" >= 0 AND "rejection_mask" <= 255);
