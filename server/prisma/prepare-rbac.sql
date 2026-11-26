-- Safe pre-step for the RBAC schema update.
-- Converts the existing enum-backed User.role column to TEXT in place,
-- preserving every user's current role value.
-- Run this BEFORE `npm run db:push`.

BEGIN;

ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE "User"
  ALTER COLUMN "role" TYPE TEXT
  USING "role"::TEXT;

ALTER TABLE "User"
  ALTER COLUMN "role" SET DEFAULT 'RECEPTIONIST';

COMMIT;
