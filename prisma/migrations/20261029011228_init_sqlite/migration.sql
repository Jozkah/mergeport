-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "githubId" BIGINT NOT NULL,
    "login" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    CONSTRAINT "Member_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "revokedAt" DATETIME,
    "createdById" TEXT NOT NULL,
    "acceptedByUserId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Invitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GithubConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "installationId" BIGINT,
    "ownerLogin" TEXT,
    "ownerGithubId" BIGINT,
    "encryptedToken" TEXT,
    "encryptedRefreshToken" TEXT,
    "grantedScopes" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'OK',
    "statusDetail" TEXT,
    "expiresAt" DATETIME,
    "lastCheckedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GithubConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "GithubOwner" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "githubId" BIGINT NOT NULL,
    "login" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "avatarUrl" TEXT,
    "synthetic" BOOLEAN NOT NULL DEFAULT false
);

-- CreateTable
CREATE TABLE "Repository" (
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
    "connectionId" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" DATETIME,
    "syncError" TEXT,
    "rateLimited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Repository_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Repository_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "GithubOwner" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Repository_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "GithubConnection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RepoProposal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "proposedById" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "fullName" TEXT NOT NULL,
    "visibility" TEXT NOT NULL,
    "ownerType" TEXT NOT NULL,
    "ownerLogin" TEXT NOT NULL,
    "isFork" BOOLEAN NOT NULL DEFAULT false,
    "shareConsent" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RepoProposal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RepoProposal_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "Member" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectRepository" (
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,

    PRIMARY KEY ("projectId", "repositoryId"),
    CONSTRAINT "ProjectRepository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectRepository_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "projectId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,

    PRIMARY KEY ("projectId", "memberId"),
    CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectMember_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RepositoryGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memberId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "canManageWork" BOOLEAN NOT NULL DEFAULT false,
    "canReview" BOOLEAN NOT NULL DEFAULT false,
    "grantedById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" DATETIME,
    CONSTRAINT "RepositoryGrant_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RepositoryGrant_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "number" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "authorLogin" TEXT,
    "authorGithubId" BIGINT,
    "authorAvatar" TEXT,
    "labels" JSONB NOT NULL DEFAULT [],
    "assignees" JSONB NOT NULL DEFAULT [],
    "labelNames" TEXT NOT NULL DEFAULT '',
    "assigneeLogins" TEXT NOT NULL DEFAULT '',
    "milestoneNumber" INTEGER,
    "milestoneTitle" TEXT,
    "htmlUrl" TEXT NOT NULL,
    "headSha" TEXT,
    "headRef" TEXT,
    "baseRef" TEXT,
    "mergeable" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "checksState" TEXT NOT NULL DEFAULT 'NONE',
    "additions" INTEGER,
    "deletions" INTEGER,
    "changedFiles" INTEGER,
    "createdAtGh" DATETIME NOT NULL,
    "updatedAtGh" DATETIME NOT NULL,
    "closedAtGh" DATETIME,
    "mergedAtGh" DATETIME,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkItem_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkItemComment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "kind" TEXT NOT NULL,
    "authorLogin" TEXT,
    "body" TEXT,
    "reviewState" TEXT,
    "commitSha" TEXT,
    "path" TEXT,
    "line" INTEGER,
    "threadKey" TEXT,
    "createdAtGh" DATETIME NOT NULL,
    "updatedAtGh" DATETIME NOT NULL,
    CONSTRAINT "WorkItemComment_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReviewRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workItemId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reviewerRef" TEXT NOT NULL,
    "requestedAt" DATETIME NOT NULL,
    "removedAt" DATETIME,
    CONSTRAINT "ReviewRequest_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Branch_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReviewRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "repositoryId" TEXT,
    "ownerLogin" TEXT,
    "projectId" TEXT,
    "labels" JSONB NOT NULL DEFAULT [],
    "reviewers" JSONB NOT NULL,
    "semantics" TEXT NOT NULL DEFAULT 'ANY',
    "reason" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReviewRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReviewRule_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReviewRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WaitingRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "workItemId" TEXT,
    "planningItemId" TEXT,
    "source" TEXT NOT NULL,
    "ruleId" TEXT,
    "reviewerKind" TEXT NOT NULL,
    "reviewerRef" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" DATETIME,
    "clearedById" TEXT,
    "clearReason" TEXT,
    CONSTRAINT "WaitingRecord_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WaitingRecord_planningItemId_fkey" FOREIGN KEY ("planningItemId") REFERENCES "PlanningItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlanningColumn" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    CONSTRAINT "PlanningColumn_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlanningItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "columnId" TEXT NOT NULL,
    "position" REAL NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "workItemId" TEXT,
    "assigneeLogin" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "dueDate" DATETIME,
    "milestoneId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlanningItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlanningItem_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "PlanningColumn" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "PlanningItem_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PlanningItem_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "DashboardMilestone" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "PlanningItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlanningLink" (
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,

    PRIMARY KEY ("fromId", "toId"),
    CONSTRAINT "PlanningLink_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "PlanningItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlanningLink_toId_fkey" FOREIGN KEY ("toId") REFERENCES "PlanningItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DashboardMilestone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT,
    "startDate" DATETIME,
    "targetDate" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DashboardMilestone_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DashboardMilestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "DashboardMilestone_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Member" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MilestoneRepoLink" (
    "milestoneId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "githubMilestoneNumber" INTEGER NOT NULL,

    PRIMARY KEY ("milestoneId", "repositoryId"),
    CONSTRAINT "MilestoneRepoLink_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "DashboardMilestone" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MilestoneRepoLink_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ForkMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "forkRepoId" TEXT NOT NULL,
    "upstreamRepoId" TEXT NOT NULL,
    "forkBranch" TEXT NOT NULL,
    "upstreamBranch" TEXT NOT NULL,
    CONSTRAINT "ForkMapping_forkRepoId_fkey" FOREIGN KEY ("forkRepoId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ForkMapping_upstreamRepoId_fkey" FOREIGN KEY ("upstreamRepoId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ForkComparison" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mappingId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "aheadBy" INTEGER,
    "behindBy" INTEGER,
    "baseSha" TEXT,
    "headSha" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "comparedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ForkComparison_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "ForkMapping" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UpstreamPrState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mappingId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "mergeSha" TEXT,
    "mergedAtGh" DATETIME,
    "evidence" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "evidenceNote" TEXT,
    "ackedById" TEXT,
    CONSTRAINT "UpstreamPrState_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "ForkMapping" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UpstreamIssueTriage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mappingId" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'UNTRIAGED',
    "linkedWorkItemId" TEXT,
    "note" TEXT,
    "decidedById" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UpstreamIssueTriage_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "ForkMapping" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "pairingHash" TEXT,
    "pairingExpiresAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME,
    "revokedAt" DATETIME,
    CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DeviceRepoMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    CONSTRAINT "DeviceRepoMapping_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "DeviceRepoMapping_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorktreeSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "deviceId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "capturedAt" DATETIME NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB NOT NULL,
    CONSTRAINT "WorktreeSnapshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "WorktreeSnapshot_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SavedFilter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    CONSTRAINT "SavedFilter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "href" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME,
    CONSTRAINT "Notification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "meta" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "intervalMs" INTEGER,
    "dirty" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lockedAt" DATETIME,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "event" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" DATETIME
);

-- CreateTable
CREATE TABLE "PublicCacheEntry" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "etag" TEXT,
    "body" JSONB NOT NULL,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RateLimitState" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "remaining" INTEGER NOT NULL,
    "limit" INTEGER NOT NULL,
    "resetAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "User_githubId_key" ON "User"("githubId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Member_workspaceId_userId_key" ON "Member"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_workspaceId_idx" ON "Invitation"("workspaceId");

-- CreateIndex
CREATE INDEX "GithubConnection_userId_idx" ON "GithubConnection"("userId");

-- CreateIndex
CREATE INDEX "GithubConnection_installationId_idx" ON "GithubConnection"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "GithubOwner_githubId_key" ON "GithubOwner"("githubId");

-- CreateIndex
CREATE INDEX "Repository_workspaceId_trackingStatus_idx" ON "Repository"("workspaceId", "trackingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_workspaceId_githubId_key" ON "Repository"("workspaceId", "githubId");

-- CreateIndex
CREATE INDEX "RepoProposal_workspaceId_status_idx" ON "RepoProposal"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Project_workspaceId_slug_key" ON "Project"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "RepositoryGrant_repositoryId_idx" ON "RepositoryGrant"("repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "RepositoryGrant_memberId_repositoryId_key" ON "RepositoryGrant"("memberId", "repositoryId");

-- CreateIndex
CREATE INDEX "WorkItem_repositoryId_state_type_idx" ON "WorkItem"("repositoryId", "state", "type");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItem_repositoryId_number_key" ON "WorkItem"("repositoryId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItem_repositoryId_githubId_key" ON "WorkItem"("repositoryId", "githubId");

-- CreateIndex
CREATE INDEX "WorkItemComment_workItemId_createdAtGh_idx" ON "WorkItemComment"("workItemId", "createdAtGh");

-- CreateIndex
CREATE UNIQUE INDEX "WorkItemComment_workItemId_kind_githubId_key" ON "WorkItemComment"("workItemId", "kind", "githubId");

-- CreateIndex
CREATE INDEX "ReviewRequest_workItemId_idx" ON "ReviewRequest"("workItemId");

-- CreateIndex
CREATE UNIQUE INDEX "Branch_repositoryId_name_key" ON "Branch"("repositoryId", "name");

-- CreateIndex
CREATE INDEX "ReviewRule_workspaceId_scope_idx" ON "ReviewRule"("workspaceId", "scope");

-- CreateIndex
CREATE INDEX "WaitingRecord_workspaceId_status_idx" ON "WaitingRecord"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "WaitingRecord_workItemId_idx" ON "WaitingRecord"("workItemId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanningColumn_projectId_key_key" ON "PlanningColumn"("projectId", "key");

-- CreateIndex
CREATE INDEX "PlanningItem_projectId_columnId_idx" ON "PlanningItem"("projectId", "columnId");

-- CreateIndex
CREATE UNIQUE INDEX "ForkMapping_forkRepoId_upstreamRepoId_forkBranch_upstreamBranch_key" ON "ForkMapping"("forkRepoId", "upstreamRepoId", "forkBranch", "upstreamBranch");

-- CreateIndex
CREATE INDEX "ForkComparison_mappingId_comparedAt_idx" ON "ForkComparison"("mappingId", "comparedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamPrState_mappingId_number_key" ON "UpstreamPrState"("mappingId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamIssueTriage_mappingId_issueNumber_key" ON "UpstreamIssueTriage"("mappingId", "issueNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Device_pairingHash_key" ON "Device"("pairingHash");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceRepoMapping_deviceId_repositoryId_key" ON "DeviceRepoMapping"("deviceId", "repositoryId");

-- CreateIndex
CREATE UNIQUE INDEX "WorktreeSnapshot_deviceId_repositoryId_key" ON "WorktreeSnapshot"("deviceId", "repositoryId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Job_dedupeKey_key" ON "Job"("dedupeKey");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");
