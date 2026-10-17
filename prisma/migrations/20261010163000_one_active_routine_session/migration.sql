-- A user may have many completed sessions,
-- but only ONE session currently in progress.
--
-- This is a partial unique index.
--
-- The condition means uniqueness applies only
-- when the session status is IN_PROGRESS.

CREATE UNIQUE INDEX
  "RoutineSession_one_active_per_user"
ON "RoutineSession" ("userId")
WHERE "status" = 'IN_PROGRESS';