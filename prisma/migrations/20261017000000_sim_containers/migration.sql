-- Training simulator: one weight per mixing container (1–3) instead of a single
-- shared vessel, so choosing container 2 after container 1 no longer looks like
-- the container changed weight.

-- AlterTable
ALTER TABLE "Station" ADD COLUMN     "simContainer" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "simContentsMg" INTEGER[] DEFAULT ARRAY[]::INTEGER[];
