/*
  Warnings:

  - You are about to drop the `GithubConnection` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Invitation` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `RepoProposal` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WebhookDelivery` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `pairingExpiresAt` on the `Device` table. All the data in the column will be lost.
  - You are about to drop the column `pairingHash` on the `Device` table. All the data in the column will be lost.
  - You are about to drop the column `revokedAt` on the `Device` table. All the data in the column will be lost.
  - You are about to drop the column `tokenHash` on the `Device` table. All the data in the column will be lost.
  - You are about to drop the column `connectionId` on the `Repository` table. All the data in the column will be lost.
  - You are about to drop the column `shared` on the `WorktreeSnapshot` table. All the data in the column will be lost.

*/
-- DropIndex
DROP INDEX "GithubConnection_installationId_idx";

-- DropIndex
DROP INDEX "GithubConnection_userId_idx";

-- DropIndex
DROP INDEX "Invitation_workspaceId_idx";

-- DropIndex
DROP INDEX "Invitation_tokenHash_key";

-- DropIndex
DROP INDEX "RepoProposal_workspaceId_status_idx";

-- AlterTable
ALTER TABLE "DeviceRepoMapping" ADD COLUMN "rootPath" TEXT;

-- AlterTable
ALTER TABLE "PlanningItem" ADD COLUMN "workNumber" INTEGER;
ALTER TABLE "PlanningItem" ADD COLUMN "workRepoGithubId" BIGINT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "spaceId" TEXT;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "GithubConnection";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "Invitation";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "RepoProposal";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "WebhookDelivery";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "Space" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "remoteId" TEXT NOT NULL,
    "teamRemoteId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "repoGithubId" BIGINT,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "canWrite" BOOLEAN NOT NULL DEFAULT false,
    "canAdmin" BOOLEAN NOT NULL DEFAULT false,
    "access" TEXT NOT NULL DEFAULT 'OK',
    "headSha" TEXT,
    "etag" TEXT,
    "lastPolledAt" DATETIME,
    "lastChangedAt" DATETIME,
    "pollIntervalMs" INTEGER NOT NULL DEFAULT 30000,
    "unchangedPolls" INTEGER NOT NULL DEFAULT 0,
    "nextPollAt" DATETIME,
    "lastError" TEXT,
    "rateLimitedUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "SyncEntity" (
    "spaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "remoteSha" TEXT,
    "baseVersion" INTEGER NOT NULL DEFAULT 0,
    "baseData" JSONB,
    "meta" JSONB,
    "deleted" BOOLEAN NOT NULL DEFAULT false,

    PRIMARY KEY ("spaceId", "type", "entityId"),
    CONSTRAINT "SyncEntity_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OutboxOp" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "spaceId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "data" JSONB,
    "baseVersion" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OutboxOp_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SyncConflict" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "spaceId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "base" JSONB NOT NULL,
    "local" JSONB NOT NULL,
    "remote" JSONB NOT NULL,
    "remoteVersion" INTEGER NOT NULL,
    "opId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "SyncConflict_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'team',
    "mode" TEXT NOT NULL DEFAULT 'PERSONAL',
    "teamRemoteId" TEXT,
    "name" TEXT,
    "ownerLogin" TEXT,
    "commonSpaceId" TEXT,
    "pollSeconds" INTEGER NOT NULL DEFAULT 30,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME,
    CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Device" ("createdAt", "id", "lastSeenAt", "name", "userId") SELECT "createdAt", "id", "lastSeenAt", "name", "userId" FROM "Device";
DROP TABLE "Device";
ALTER TABLE "new_Device" RENAME TO "Device";
CREATE TABLE "new_Repository" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "description" TEXT,
    "visibility" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "isFork" BOOLEAN NOT NULL DEFAULT false,
    "parentGithubId" BIGINT,
    "parentFullName" TEXT,
    "defaultBranch" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB,
    "trackingStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "statusDetail" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "spaceId" TEXT,
    "lastSyncedAt" DATETIME,
    "syncError" TEXT,
    "rateLimited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Repository_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Repository_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "GithubOwner" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Repository" ("archived", "createdAt", "defaultBranch", "description", "fullName", "githubId", "htmlUrl", "id", "isDemo", "isFork", "lastSyncedAt", "name", "ownerId", "parentFullName", "parentGithubId", "permissions", "rateLimited", "statusDetail", "syncError", "trackingStatus", "visibility", "workspaceId") SELECT "archived", "createdAt", "defaultBranch", "description", "fullName", "githubId", "htmlUrl", "id", "isDemo", "isFork", "lastSyncedAt", "name", "ownerId", "parentFullName", "parentGithubId", "permissions", "rateLimited", "statusDetail", "syncError", "trackingStatus", "visibility", "workspaceId" FROM "Repository";
DROP TABLE "Repository";
ALTER TABLE "new_Repository" RENAME TO "Repository";
CREATE INDEX "Repository_workspaceId_trackingStatus_idx" ON "Repository"("workspaceId", "trackingStatus");
CREATE UNIQUE INDEX "Repository_workspaceId_githubId_key" ON "Repository"("workspaceId", "githubId");
CREATE TABLE "new_WorktreeSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL,
    "data" JSONB NOT NULL,
    CONSTRAINT "WorktreeSnapshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorktreeSnapshot_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WorktreeSnapshot" ("capturedAt", "data", "deviceId", "id", "repositoryId") SELECT "capturedAt", "data", "deviceId", "id", "repositoryId" FROM "WorktreeSnapshot";
DROP TABLE "WorktreeSnapshot";
ALTER TABLE "new_WorktreeSnapshot" RENAME TO "WorktreeSnapshot";
CREATE UNIQUE INDEX "WorktreeSnapshot_deviceId_repositoryId_key" ON "WorktreeSnapshot"("deviceId", "repositoryId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Space_repoOwner_repoName_key" ON "Space"("repoOwner", "repoName");

-- CreateIndex
CREATE INDEX "OutboxOp_spaceId_status_idx" ON "OutboxOp"("spaceId", "status");

-- CreateIndex
CREATE INDEX "SyncConflict_spaceId_status_idx" ON "SyncConflict"("spaceId", "status");
