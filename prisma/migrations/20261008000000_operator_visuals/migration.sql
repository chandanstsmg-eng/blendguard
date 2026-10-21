-- Operator visuals: bottle colour, photo and protective-equipment pictures per
-- ingredient; auto-accept and idle sign-out per station.

-- AlterTable
ALTER TABLE "Ingredient" ADD COLUMN     "colorHex" TEXT,
ADD COLUMN     "photo" BYTEA,
ADD COLUMN     "photoType" TEXT,
ADD COLUMN     "photoUpdatedAt" TIMESTAMP(3),
ADD COLUMN     "ppe" TEXT[];

-- Existing ingredients start with no protective-equipment pictures.
UPDATE "Ingredient" SET "ppe" = ARRAY[]::TEXT[] WHERE "ppe" IS NULL;

-- AlterTable
ALTER TABLE "Station" ADD COLUMN     "autoAccept" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "idleMinutes" INTEGER NOT NULL DEFAULT 10;
