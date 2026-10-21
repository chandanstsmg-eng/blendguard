-- Process orders uploaded as PDF: header details, the original PDF, per-line
-- storage location / batch / unit, and the "goes for lab test" tick.

-- AlterTable
ALTER TABLE "Formula" ADD COLUMN     "sourcePdf" BYTEA,
ADD COLUMN     "processOrder" JSONB;

-- AlterTable
ALTER TABLE "FormulaLine" ADD COLUMN     "storageLocation" TEXT,
ADD COLUMN     "sourceBatch" TEXT,
ADD COLUMN     "uom" TEXT,
ADD COLUMN     "labTest" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Batch" ADD COLUMN     "processOrder" JSONB;

-- AlterTable
ALTER TABLE "BatchStep" ADD COLUMN     "storageLocation" TEXT,
ADD COLUMN     "sourceBatch" TEXT,
ADD COLUMN     "uom" TEXT;
