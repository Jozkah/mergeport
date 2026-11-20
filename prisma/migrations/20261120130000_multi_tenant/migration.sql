-- Multi-tenant data layer (see docs/tenancy.md).
-- Every ROOT model carries a workspaceId with a foreign key to Workspace (ON DELETE CASCADE) and an index.
-- A database that already holds one workspace keeps working: every existing row is backfilled to the OLDEST workspace.
-- An empty database passes through unchanged (no rows to backfill, no workspace needed).
-- Rows that cannot be attached to any workspace (rows exist but no Workspace row does) are removed: they were unreachable.

-- ---------------------------------------------------------------------------------------------------------------------
-- Existing workspaceId columns that never had a foreign key: drop unreachable rows, then add the constraint.
-- ---------------------------------------------------------------------------------------------------------------------
DELETE FROM "WaitingRecord" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");
DELETE FROM "ReviewerAvailability" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");
DELETE FROM "LabelMap" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");
DELETE FROM "UpstreamSubscription" WHERE "workspaceId" NOT IN (SELECT "id" FROM "Workspace");

ALTER TABLE "WaitingRecord" ADD CONSTRAINT "WaitingRecord_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReviewerAvailability" ADD CONSTRAINT "ReviewerAvailability_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LabelMap" ADD CONSTRAINT "LabelMap_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UpstreamSubscription" ADD CONSTRAINT "UpstreamSubscription_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "UpstreamSubscription_workspaceId_idx" ON "UpstreamSubscription"("workspaceId");
CREATE INDEX "DashboardMilestone_workspaceId_idx" ON "DashboardMilestone"("workspaceId");
CREATE INDEX "Notification_workspaceId_userId_idx" ON "Notification"("workspaceId", "userId");

-- ---------------------------------------------------------------------------------------------------------------------
-- New workspaceId columns: add nullable, backfill to the oldest workspace, drop what cannot be attached, make NOT NULL.
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE "Space" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "AiSuggestion" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "AiPendingAction" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "DailyDigest" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "GitCache" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "DiscoveryCache" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "TeamConfig" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "HubSession" ADD COLUMN "workspaceId" TEXT;
ALTER TABLE "AiSettings" ADD COLUMN "workspaceId" TEXT;

UPDATE "Space" SET "workspaceId" = (SELECT "id" FROM "Workspace" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1);
UPDATE "AiSuggestion" SET "workspaceId" = (SELECT "id" FROM "Workspace" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1);
UPDATE "AiPendingAction" SET "workspaceId" = (SELECT "id" FROM "Workspace" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1);
UPDATE "DailyDigest" SET "workspaceId" = (SELECT "id" FROM "Workspace" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1);
UPDATE "GitCache" SET "workspaceId" = (SELECT "id" FROM "Workspace" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1);
UPDATE "DiscoveryCache" SET "workspaceId" = (SELECT "id" FROM "Workspace" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1);
UPDATE "TeamConfig" SET "workspaceId" = (SELECT "id" FROM "Workspace" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1);
UPDATE "HubSession" SET "workspaceId" = (SELECT "id" FROM "Workspace" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1);
UPDATE "AiSettings" SET "workspaceId" = (SELECT "id" FROM "Workspace" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1);

DELETE FROM "Space" WHERE "workspaceId" IS NULL;
DELETE FROM "AiSuggestion" WHERE "workspaceId" IS NULL;
DELETE FROM "AiPendingAction" WHERE "workspaceId" IS NULL;
DELETE FROM "DailyDigest" WHERE "workspaceId" IS NULL;
DELETE FROM "GitCache" WHERE "workspaceId" IS NULL;
DELETE FROM "DiscoveryCache" WHERE "workspaceId" IS NULL;
DELETE FROM "TeamConfig" WHERE "workspaceId" IS NULL;
DELETE FROM "HubSession" WHERE "workspaceId" IS NULL;
DELETE FROM "AiSettings" WHERE "workspaceId" IS NULL;

ALTER TABLE "Space" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "AiSuggestion" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "AiPendingAction" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "DailyDigest" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "GitCache" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "DiscoveryCache" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "TeamConfig" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "HubSession" ALTER COLUMN "workspaceId" SET NOT NULL;
ALTER TABLE "AiSettings" ALTER COLUMN "workspaceId" SET NOT NULL;

-- Job: nullable on purpose. The three schedulers (reconcile.all, digest.daily, ai.autopilot) are system-wide and fan out over all
-- workspaces, so they stay NULL; every other existing job belongs to the one workspace there was: the oldest.
ALTER TABLE "Job" ADD COLUMN "workspaceId" TEXT;
UPDATE "Job" SET "workspaceId" = (SELECT "id" FROM "Workspace" ORDER BY "createdAt" ASC, "id" ASC LIMIT 1)
  WHERE "type" NOT IN ('reconcile.all', 'digest.daily', 'ai.autopilot');

-- ---------------------------------------------------------------------------------------------------------------------
-- Fixed-id singletons become one row per workspace: the id is a plain cuid, workspaceId is unique.
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE "TeamConfig" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "HubSession" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "AiSettings" ALTER COLUMN "id" DROP DEFAULT;

CREATE UNIQUE INDEX "TeamConfig_workspaceId_key" ON "TeamConfig"("workspaceId");
CREATE UNIQUE INDEX "HubSession_workspaceId_key" ON "HubSession"("workspaceId");
CREATE UNIQUE INDEX "AiSettings_workspaceId_key" ON "AiSettings"("workspaceId");

-- ---------------------------------------------------------------------------------------------------------------------
-- Caches keyed per workspace: the key is no longer unique on its own.
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE "GitCache" DROP CONSTRAINT "GitCache_pkey";
ALTER TABLE "GitCache" ADD CONSTRAINT "GitCache_pkey" PRIMARY KEY ("workspaceId", "key");
ALTER TABLE "DiscoveryCache" DROP CONSTRAINT "DiscoveryCache_pkey";
ALTER TABLE "DiscoveryCache" ADD CONSTRAINT "DiscoveryCache_pkey" PRIMARY KEY ("workspaceId", "key");

-- ---------------------------------------------------------------------------------------------------------------------
-- Uniques and indexes that now start with the workspace.
-- ---------------------------------------------------------------------------------------------------------------------
DROP INDEX "Space_backend_repoOwner_repoName_hubSpaceId_key";
CREATE UNIQUE INDEX "Space_workspaceId_backend_repoOwner_repoName_hubSpaceId_key" ON "Space"("workspaceId", "backend", "repoOwner", "repoName", "hubSpaceId");

DROP INDEX "DailyDigest_userId_day_key";
CREATE UNIQUE INDEX "DailyDigest_workspaceId_userId_day_key" ON "DailyDigest"("workspaceId", "userId", "day");

DROP INDEX "AiSuggestion_state_createdAt_idx";
CREATE INDEX "AiSuggestion_workspaceId_state_createdAt_idx" ON "AiSuggestion"("workspaceId", "state", "createdAt");
DROP INDEX "AiPendingAction_state_createdAt_idx";
CREATE INDEX "AiPendingAction_workspaceId_state_createdAt_idx" ON "AiPendingAction"("workspaceId", "state", "createdAt");

CREATE INDEX "Job_workspaceId_idx" ON "Job"("workspaceId");

-- ---------------------------------------------------------------------------------------------------------------------
-- Foreign keys of the new columns (ON DELETE CASCADE: deleting a workspace deletes everything it owns).
-- ---------------------------------------------------------------------------------------------------------------------
ALTER TABLE "Space" ADD CONSTRAINT "Space_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiSuggestion" ADD CONSTRAINT "AiSuggestion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiPendingAction" ADD CONSTRAINT "AiPendingAction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DailyDigest" ADD CONSTRAINT "DailyDigest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GitCache" ADD CONSTRAINT "GitCache_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DiscoveryCache" ADD CONSTRAINT "DiscoveryCache_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TeamConfig" ADD CONSTRAINT "TeamConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HubSession" ADD CONSTRAINT "HubSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AiSettings" ADD CONSTRAINT "AiSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Job" ADD CONSTRAINT "Job_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
