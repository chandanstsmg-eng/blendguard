-- One staff role: the scientist (role SUPERVISOR) now also does the set-up the
-- administrator used to do. Existing administrator accounts become scientists.
-- The audit trail stores the role as text, so past events keep saying ADMIN.

UPDATE "User" SET "role" = 'SUPERVISOR' WHERE "role" = 'ADMIN';

ALTER TYPE "Role" RENAME TO "Role_old";
CREATE TYPE "Role" AS ENUM ('OPERATOR', 'SUPERVISOR');
ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role" USING ("role"::text::"Role");
DROP TYPE "Role_old";
