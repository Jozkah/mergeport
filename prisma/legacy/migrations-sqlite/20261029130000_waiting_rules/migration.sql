-- CreateTable
CREATE TABLE "WaitingRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "repositoryId" TEXT,
    "ownerLogin" TEXT,
    "projectId" TEXT,
    "itemType" TEXT NOT NULL DEFAULT 'PULL_REQUEST',
    "labels" JSONB NOT NULL DEFAULT '[]',
    "authors" JSONB NOT NULL DEFAULT '[]',
    "includeDrafts" BOOLEAN NOT NULL DEFAULT false,
    "waitingOn" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WaitingRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WaitingRule_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WaitingRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "WaitingRule_workspaceId_scope_idx" ON "WaitingRule"("workspaceId", "scope");
