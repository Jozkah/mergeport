-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "MemberStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "OwnerType" AS ENUM ('USER', 'ORGANIZATION', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "Visibility" AS ENUM ('PUBLIC', 'PRIVATE', 'INTERNAL', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TrackingStatus" AS ENUM ('ACTIVE', 'DISCONNECTED', 'REMOVED');

-- CreateEnum
CREATE TYPE "ConnectionKind" AS ENUM ('USER_AUTH', 'INSTALLATION', 'PUBLIC_TOKEN');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('OK', 'NEEDS_AUTH', 'ORG_APPROVAL_REQUIRED', 'SSO_REQUIRED', 'REVOKED', 'ERROR');

-- CreateEnum
CREATE TYPE "WorkItemType" AS ENUM ('ISSUE', 'PULL_REQUEST');

-- CreateEnum
CREATE TYPE "WorkItemState" AS ENUM ('OPEN', 'CLOSED', 'MERGED');

-- CreateEnum
CREATE TYPE "ChecksState" AS ENUM ('NONE', 'PENDING', 'SUCCESS', 'FAILURE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MergeableState" AS ENUM ('MERGEABLE', 'CONFLICTING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CommentKind" AS ENUM ('ISSUE_COMMENT', 'REVIEW_COMMENT', 'REVIEW', 'EVENT');

-- CreateEnum
CREATE TYPE "ReviewState" AS ENUM ('APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED', 'PENDING');

-- CreateEnum
CREATE TYPE "RuleScope" AS ENUM ('REPOSITORY', 'OWNER', 'PROJECT', 'WORKSPACE');

-- CreateEnum
CREATE TYPE "ApprovalSemantics" AS ENUM ('ANY', 'ALL');

-- CreateEnum
CREATE TYPE "ReviewerKind" AS ENUM ('USER', 'TEAM', 'EXTERNAL_ROLE');

-- CreateEnum
CREATE TYPE "WaitingStatus" AS ENUM ('PENDING', 'SATISFIED', 'CANCELLED', 'STALE');

-- CreateEnum
CREATE TYPE "WaitingSource" AS ENUM ('RULE', 'MANUAL');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "UpstreamEvidence" AS ENUM ('ANCESTRY_EXACT', 'PATCH_EQUIVALENT_POSSIBLE', 'MANUAL_ACK', 'NOT_DETECTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TriageStatus" AS ENUM ('UNTRIAGED', 'WATCHING', 'RELEVANT', 'ADDRESSED', 'IGNORED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "login" TEXT NOT NULL,
    "name" TEXT,
    "avatarUrl" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'MEMBER',
    "status" "MemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "githubLogin" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'MEMBER',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "acceptedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "kind" "ConnectionKind" NOT NULL,
    "installationId" BIGINT,
    "ownerLogin" TEXT,
    "ownerGithubId" BIGINT,
    "encryptedToken" TEXT,
    "grantedScopes" TEXT NOT NULL DEFAULT '',
    "status" "ConnectionStatus" NOT NULL DEFAULT 'OK',
    "statusDetail" TEXT,
    "expiresAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GithubConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubOwner" (
    "id" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "login" TEXT NOT NULL,
    "type" "OwnerType" NOT NULL DEFAULT 'UNKNOWN',
    "avatarUrl" TEXT,
    "synthetic" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "GithubOwner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "description" TEXT,
    "visibility" "Visibility" NOT NULL DEFAULT 'UNKNOWN',
    "isFork" BOOLEAN NOT NULL DEFAULT false,
    "parentGithubId" BIGINT,
    "parentFullName" TEXT,
    "defaultBranch" TEXT,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "permissions" JSONB,
    "trackingStatus" "TrackingStatus" NOT NULL DEFAULT 'ACTIVE',
    "statusDetail" TEXT,
    "connectionId" TEXT,
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "rateLimited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RepoProposal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "proposedById" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "fullName" TEXT NOT NULL,
    "visibility" "Visibility" NOT NULL,
    "ownerType" "OwnerType" NOT NULL,
    "ownerLogin" TEXT NOT NULL,
    "isFork" BOOLEAN NOT NULL DEFAULT false,
    "shareConsent" BOOLEAN NOT NULL DEFAULT false,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RepoProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectRepository" (
    "projectId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,

    CONSTRAINT "ProjectRepository_pkey" PRIMARY KEY ("projectId","repositoryId")
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "projectId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("projectId","memberId")
);

-- CreateTable
CREATE TABLE "RepositoryGrant" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "canManageWork" BOOLEAN NOT NULL DEFAULT false,
    "canReview" BOOLEAN NOT NULL DEFAULT false,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "RepositoryGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkItem" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "number" INTEGER NOT NULL,
    "type" "WorkItemType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "state" "WorkItemState" NOT NULL DEFAULT 'OPEN',
    "draft" BOOLEAN NOT NULL DEFAULT false,
    "authorLogin" TEXT,
    "authorGithubId" BIGINT,
    "authorAvatar" TEXT,
    "labels" JSONB NOT NULL DEFAULT '[]',
    "assignees" JSONB NOT NULL DEFAULT '[]',
    "milestoneNumber" INTEGER,
    "milestoneTitle" TEXT,
    "htmlUrl" TEXT NOT NULL,
    "headSha" TEXT,
    "headRef" TEXT,
    "baseRef" TEXT,
    "mergeable" "MergeableState" NOT NULL DEFAULT 'UNKNOWN',
    "checksState" "ChecksState" NOT NULL DEFAULT 'NONE',
    "additions" INTEGER,
    "deletions" INTEGER,
    "changedFiles" INTEGER,
    "createdAtGh" TIMESTAMP(3) NOT NULL,
    "updatedAtGh" TIMESTAMP(3) NOT NULL,
    "closedAtGh" TIMESTAMP(3),
    "mergedAtGh" TIMESTAMP(3),
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkItemComment" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "kind" "CommentKind" NOT NULL,
    "authorLogin" TEXT,
    "body" TEXT,
    "reviewState" "ReviewState",
    "commitSha" TEXT,
    "path" TEXT,
    "line" INTEGER,
    "threadKey" TEXT,
    "createdAtGh" TIMESTAMP(3) NOT NULL,
    "updatedAtGh" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkItemComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewRequest" (
    "id" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "kind" "ReviewerKind" NOT NULL,
    "reviewerRef" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "ReviewRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Branch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scope" "RuleScope" NOT NULL,
    "repositoryId" TEXT,
    "ownerLogin" TEXT,
    "projectId" TEXT,
    "labels" TEXT[],
    "reviewers" JSONB NOT NULL,
    "semantics" "ApprovalSemantics" NOT NULL DEFAULT 'ANY',
    "reason" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaitingRecord" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "workItemId" TEXT,
    "planningItemId" TEXT,
    "source" "WaitingSource" NOT NULL,
    "ruleId" TEXT,
    "reviewerKind" "ReviewerKind" NOT NULL,
    "reviewerRef" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "WaitingStatus" NOT NULL DEFAULT 'PENDING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "clearedById" TEXT,
    "clearReason" TEXT,

    CONSTRAINT "WaitingRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanningColumn" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "PlanningColumn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanningItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "columnId" TEXT NOT NULL,
    "position" DOUBLE PRECISION NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "workItemId" TEXT,
    "assigneeLogin" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "dueDate" DATE,
    "milestoneId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanningItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanningLink" (
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,

    CONSTRAINT "PlanningLink_pkey" PRIMARY KEY ("fromId","toId")
);

-- CreateTable
CREATE TABLE "DashboardMilestone" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "projectId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "ownerId" TEXT,
    "startDate" DATE,
    "targetDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DashboardMilestone_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MilestoneRepoLink" (
    "milestoneId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "githubMilestoneNumber" INTEGER NOT NULL,

    CONSTRAINT "MilestoneRepoLink_pkey" PRIMARY KEY ("milestoneId","repositoryId")
);

-- CreateTable
CREATE TABLE "ForkMapping" (
    "id" TEXT NOT NULL,
    "forkRepoId" TEXT NOT NULL,
    "upstreamRepoId" TEXT NOT NULL,
    "forkBranch" TEXT NOT NULL,
    "upstreamBranch" TEXT NOT NULL,

    CONSTRAINT "ForkMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ForkComparison" (
    "id" TEXT NOT NULL,
    "mappingId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "aheadBy" INTEGER,
    "behindBy" INTEGER,
    "baseSha" TEXT,
    "headSha" TEXT,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "comparedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ForkComparison_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpstreamPrState" (
    "id" TEXT NOT NULL,
    "mappingId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "mergeSha" TEXT,
    "mergedAtGh" TIMESTAMP(3),
    "evidence" "UpstreamEvidence" NOT NULL DEFAULT 'UNKNOWN',
    "evidenceNote" TEXT,
    "ackedById" TEXT,

    CONSTRAINT "UpstreamPrState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpstreamIssueTriage" (
    "id" TEXT NOT NULL,
    "mappingId" TEXT NOT NULL,
    "issueNumber" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "status" "TriageStatus" NOT NULL DEFAULT 'UNTRIAGED',
    "linkedWorkItemId" TEXT,
    "note" TEXT,
    "decidedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UpstreamIssueTriage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "pairingHash" TEXT,
    "pairingExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceRepoMapping" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,

    CONSTRAINT "DeviceRepoMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorktreeSnapshot" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB NOT NULL,

    CONSTRAINT "WorktreeSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedFilter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "query" TEXT NOT NULL,

    CONSTRAINT "SavedFilter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryId" TEXT,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "href" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "dedupeKey" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lockedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicCacheEntry" (
    "key" TEXT NOT NULL,
    "etag" TEXT,
    "body" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublicCacheEntry_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "RateLimitState" (
    "key" TEXT NOT NULL,
    "remaining" INTEGER NOT NULL,
    "limit" INTEGER NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitState_pkey" PRIMARY KEY ("key")
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
CREATE UNIQUE INDEX "ForkMapping_forkRepoId_upstreamRepoId_forkBranch_upstreamBr_key" ON "ForkMapping"("forkRepoId", "upstreamRepoId", "forkBranch", "upstreamBranch");

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

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubConnection" ADD CONSTRAINT "GithubConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "GithubOwner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "GithubConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepoProposal" ADD CONSTRAINT "RepoProposal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepoProposal" ADD CONSTRAINT "RepoProposal_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRepository" ADD CONSTRAINT "ProjectRepository_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRepository" ADD CONSTRAINT "ProjectRepository_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryGrant" ADD CONSTRAINT "RepositoryGrant_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RepositoryGrant" ADD CONSTRAINT "RepositoryGrant_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItem" ADD CONSTRAINT "WorkItem_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkItemComment" ADD CONSTRAINT "WorkItemComment_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRequest" ADD CONSTRAINT "ReviewRequest_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Branch" ADD CONSTRAINT "Branch_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRule" ADD CONSTRAINT "ReviewRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRule" ADD CONSTRAINT "ReviewRule_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewRule" ADD CONSTRAINT "ReviewRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitingRecord" ADD CONSTRAINT "WaitingRecord_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitingRecord" ADD CONSTRAINT "WaitingRecord_planningItemId_fkey" FOREIGN KEY ("planningItemId") REFERENCES "PlanningItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanningColumn" ADD CONSTRAINT "PlanningColumn_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanningItem" ADD CONSTRAINT "PlanningItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanningItem" ADD CONSTRAINT "PlanningItem_columnId_fkey" FOREIGN KEY ("columnId") REFERENCES "PlanningColumn"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanningItem" ADD CONSTRAINT "PlanningItem_workItemId_fkey" FOREIGN KEY ("workItemId") REFERENCES "WorkItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanningItem" ADD CONSTRAINT "PlanningItem_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "DashboardMilestone"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanningItem" ADD CONSTRAINT "PlanningItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "Member"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanningLink" ADD CONSTRAINT "PlanningLink_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "PlanningItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanningLink" ADD CONSTRAINT "PlanningLink_toId_fkey" FOREIGN KEY ("toId") REFERENCES "PlanningItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardMilestone" ADD CONSTRAINT "DashboardMilestone_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardMilestone" ADD CONSTRAINT "DashboardMilestone_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DashboardMilestone" ADD CONSTRAINT "DashboardMilestone_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneRepoLink" ADD CONSTRAINT "MilestoneRepoLink_milestoneId_fkey" FOREIGN KEY ("milestoneId") REFERENCES "DashboardMilestone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MilestoneRepoLink" ADD CONSTRAINT "MilestoneRepoLink_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForkMapping" ADD CONSTRAINT "ForkMapping_forkRepoId_fkey" FOREIGN KEY ("forkRepoId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForkMapping" ADD CONSTRAINT "ForkMapping_upstreamRepoId_fkey" FOREIGN KEY ("upstreamRepoId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ForkComparison" ADD CONSTRAINT "ForkComparison_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "ForkMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpstreamPrState" ADD CONSTRAINT "UpstreamPrState_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "ForkMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpstreamIssueTriage" ADD CONSTRAINT "UpstreamIssueTriage_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "ForkMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceRepoMapping" ADD CONSTRAINT "DeviceRepoMapping_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorktreeSnapshot" ADD CONSTRAINT "WorktreeSnapshot_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorktreeSnapshot" ADD CONSTRAINT "WorktreeSnapshot_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedFilter" ADD CONSTRAINT "SavedFilter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
