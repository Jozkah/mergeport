-- Phase 4: review threads and drafts, viewed-file state, scoped labels, upstream subscriptions, backport records, branch links.
-- All additive.

ALTER TABLE "WorkItemComment" ADD COLUMN "threadResolved" BOOLEAN;
ALTER TABLE "PlanningItem" ADD COLUMN "branchRef" TEXT;

-- Personal: a pending review being assembled on this computer, and which files a person has viewed (by content signature).
CREATE TABLE "ReviewDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'RIGHT',
    "body" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ReviewDraft_userId_workItemId_idx" ON "ReviewDraft"("userId", "workItemId");

CREATE TABLE "ViewedFile" (
    "userId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sig" TEXT NOT NULL,
    "viewedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("userId", "workItemId", "path")
);

-- Shared team configuration (synchronised).
CREATE TABLE "LabelMap" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "concept" TEXT NOT NULL,
    "spelling" TEXT NOT NULL,
    "repoKey" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "LabelMap_workspaceId_spelling_repoKey_key" ON "LabelMap"("workspaceId", "spelling", "repoKey");

CREATE TABLE "UpstreamSubscription" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "mappingId" TEXT,
    "name" TEXT NOT NULL,
    "criteria" JSONB NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "BackportRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mappingId" TEXT NOT NULL,
    "upstreamNumber" INTEGER NOT NULL,
    "targetBranch" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'planned',
    "evidence" TEXT NOT NULL DEFAULT 'unknown',
    "localSha" TEXT,
    "note" TEXT,
    "byLogin" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BackportRecord_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "ForkMapping" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "BackportRecord_mappingId_upstreamNumber_targetBranch_key" ON "BackportRecord"("mappingId", "upstreamNumber", "targetBranch");
