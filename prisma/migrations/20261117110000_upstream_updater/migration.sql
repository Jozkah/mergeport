-- Upstream auto-updater. Both tables are local to this computer: `verifyCommand` is run here, so it is never synced, shared or restored from a backup.
-- CreateTable
CREATE TABLE "UpstreamUpdateConfig" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mappingId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "verifyCommand" TEXT,
    "promote" TEXT NOT NULL DEFAULT 'pr',
    "timeoutSec" INTEGER NOT NULL DEFAULT 1200,
    "branchName" TEXT NOT NULL DEFAULT 'mergeport/upstream-sync',
    "lastRunAt" DATETIME,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UpstreamUpdateConfig_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "ForkMapping" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UpstreamUpdateRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mappingId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "state" TEXT NOT NULL DEFAULT 'running',
    "trigger" TEXT NOT NULL DEFAULT 'auto',
    "upstreamSha" TEXT,
    "forkSha" TEXT,
    "triedShas" JSONB NOT NULL,
    "prUrl" TEXT,
    "filesConflicted" JSONB,
    "commits" JSONB NOT NULL,
    "logTail" TEXT NOT NULL DEFAULT '',
    "error" TEXT,
    CONSTRAINT "UpstreamUpdateRun_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "ForkMapping" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamUpdateConfig_mappingId_key" ON "UpstreamUpdateConfig"("mappingId");

-- CreateIndex
CREATE INDEX "UpstreamUpdateRun_mappingId_startedAt_idx" ON "UpstreamUpdateRun"("mappingId", "startedAt");
