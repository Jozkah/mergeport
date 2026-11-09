-- GitHub logins are case-insensitive: store assignee logins in one canonical (lower-case) spelling so lookups match.
UPDATE "PlanningItem" SET "assigneeLogin" = lower("assigneeLogin") WHERE "assigneeLogin" IS NOT NULL;
UPDATE "PlanningItem" SET "assignedByLogin" = lower("assignedByLogin") WHERE "assignedByLogin" IS NOT NULL;
