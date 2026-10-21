-- Container choice per ingredient (Container 1, 2 or 3), and the uploaded
-- production instruction a formula revision was created from.

-- AlterTable
ALTER TABLE "BatchStep" ADD COLUMN     "containerNo" INTEGER;

ALTER TABLE "BatchStep" ADD CONSTRAINT "BatchStep_containerNo_range" CHECK ("containerNo" IS NULL OR "containerNo" BETWEEN 1 AND 3);

-- AlterTable
ALTER TABLE "Formula" ADD COLUMN     "importedById" TEXT,
ADD COLUMN     "sourceFile" TEXT,
ADD COLUMN     "sourceFileName" TEXT;

-- The container is recorded when the scale is set to zero and can never change afterwards.
CREATE OR REPLACE FUNCTION bg_step_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'BlendGuard: batch steps cannot be deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."containerNo" IS NOT NULL AND NEW."containerNo" IS DISTINCT FROM OLD."containerNo" THEN
    RAISE EXCEPTION 'BlendGuard: the container for an ingredient cannot be changed once recorded' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."acceptedNetMg" IS NOT NULL AND (
       NEW."acceptedNetMg" IS DISTINCT FROM OLD."acceptedNetMg"
    OR NEW."acceptedGrossMg" IS DISTINCT FROM OLD."acceptedGrossMg"
    OR NEW."acceptedAt" IS DISTINCT FROM OLD."acceptedAt"
    OR NEW."tareGrossMg" IS DISTINCT FROM OLD."tareGrossMg"
    OR NEW."lotId" IS DISTINCT FROM OLD."lotId"
    OR NEW."targetMg" IS DISTINCT FROM OLD."targetMg") THEN
    RAISE EXCEPTION 'BlendGuard: an accepted ingredient measurement cannot be changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
