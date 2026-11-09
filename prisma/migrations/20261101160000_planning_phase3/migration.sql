-- Phase 3 planning: named boards, epics, iterations, link kinds, release state, automation policy and recorded history.
-- All additive. Existing cards, columns and links keep working unchanged.

ALTER TABLE "PlanningItem" ADD COLUMN "epicId" TEXT;
ALTER TABLE "PlanningItem" ADD COLUMN "iterationId" TEXT;
CREATE INDEX "PlanningItem_epicId_idx" ON "PlanningItem"("epicId");
CREATE INDEX "PlanningItem_iterationId_idx" ON "PlanningItem"("iterationId");

ALTER TABLE "PlanningLink" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'blocks';

ALTER TABLE "DashboardMilestone" ADD COLUMN "releaseTag" TEXT;
ALTER TABLE "DashboardMilestone" ADD COLUMN "releaseUrl" TEXT;
ALTER TABLE "DashboardMilestone" ADD COLUMN "shippedAt" DATETIME;

ALTER TABLE "Project" ADD COLUMN "automation" TEXT NOT NULL DEFAULT 'off';

CREATE TABLE "PlanBoard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template" TEXT NOT NULL DEFAULT '',
    "columns" JSONB NOT NULL,
    "groupBy" TEXT NOT NULL DEFAULT 'none',
    "density" TEXT NOT NULL DEFAULT 'comfortable',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanBoard_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PlanBoard_projectId_idx" ON "PlanBoard"("projectId");

CREATE TABLE "Epic" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerLogin" TEXT,
    "startDate" DATETIME,
    "targetDate" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "decisions" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Epic_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Epic_projectId_idx" ON "Epic"("projectId");

CREATE TABLE "Iteration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATETIME NOT NULL,
    "endDate" DATETIME NOT NULL,
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Iteration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Iteration_projectId_idx" ON "Iteration"("projectId");

-- Append-only history of planning events. Analytics read only this, so nothing before the first recorded event is ever invented.
CREATE TABLE "PlanEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromKey" TEXT,
    "toKey" TEXT,
    "refId" TEXT,
    "actorLogin" TEXT,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PlanEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "PlanEvent_projectId_at_idx" ON "PlanEvent"("projectId", "at");
CREATE INDEX "PlanEvent_itemId_idx" ON "PlanEvent"("itemId");
