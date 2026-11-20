-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

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
CREATE TYPE "UpstreamEvidence" AS ENUM ('ANCESTRY_EXACT', 'PATCH_EQUIVALENT_POSSIBLE', 'MANUAL_ACK', 'NOT_DETECTED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "TriageStatus" AS ENUM ('UNTRIAGED', 'WATCHING', 'RELEVANT', 'ADDRESSED', 'IGNORED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "SpaceKind" AS ENUM ('COMMON', 'RESTRICTED');

-- CreateEnum
CREATE TYPE "SpaceAccess" AS ENUM ('OK', 'REVOKED', 'NO_ACCESS', 'SCHEMA_NEWER');

-- CreateEnum
CREATE TYPE "OpKind" AS ENUM ('UPSERT', 'DELETE');

-- CreateEnum
CREATE TYPE "OpStatus" AS ENUM ('PENDING', 'SENT', 'CONFLICT', 'QUARANTINED', 'FAILED');

-- CreateEnum
CREATE TYPE "TeamMode" AS ENUM ('PERSONAL', 'TEAM');

-- CreateEnum
CREATE TYPE "SpaceBackend" AS ENUM ('GITHUB', 'HUB');

-- CreateEnum
CREATE TYPE "TeamBackend" AS ENUM ('GITHUB', 'HUB');

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
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "spaceId" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "rateLimited" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "spaceId" TEXT,
    "automation" TEXT NOT NULL DEFAULT 'off',
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
    "labelNames" TEXT NOT NULL DEFAULT '',
    "assigneeLogins" TEXT NOT NULL DEFAULT '',
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
    "threadResolved" BOOLEAN,
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
CREATE TABLE "WaitingRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scope" "RuleScope" NOT NULL,
    "repositoryId" TEXT,
    "ownerLogin" TEXT,
    "projectId" TEXT,
    "itemType" TEXT NOT NULL DEFAULT 'PULL_REQUEST',
    "labels" JSONB NOT NULL DEFAULT '[]',
    "authors" JSONB NOT NULL DEFAULT '[]',
    "includeDrafts" BOOLEAN NOT NULL DEFAULT false,
    "waitingOn" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scope" "RuleScope" NOT NULL,
    "repositoryId" TEXT,
    "ownerLogin" TEXT,
    "projectId" TEXT,
    "labels" JSONB NOT NULL DEFAULT '[]',
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
    "stage" TEXT NOT NULL DEFAULT '',
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
    "workRepoGithubId" BIGINT,
    "workNumber" INTEGER,
    "assigneeLogin" TEXT,
    "assignedByLogin" TEXT,
    "authorLogin" TEXT,
    "labels" JSONB NOT NULL DEFAULT '[]',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3),
    "milestoneId" TEXT,
    "epicId" TEXT,
    "iterationId" TEXT,
    "branchRef" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanningItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GitCache" (
    "key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "bytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accessedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GitCache_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "TaskCheckItem" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "position" DOUBLE PRECISION NOT NULL,
    "doneByLogin" TEXT,
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskCheckItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskComment" (
    "id" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "authorLogin" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'COMMENT',
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),

    CONSTRAINT "TaskComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanningLink" (
    "fromId" TEXT NOT NULL,
    "toId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'blocks',

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
    "startDate" TIMESTAMP(3),
    "targetDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "releaseTag" TEXT,
    "releaseUrl" TEXT,
    "shippedAt" TIMESTAMP(3),
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
CREATE TABLE "UpstreamUpdateConfig" (
    "id" TEXT NOT NULL,
    "mappingId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "verifyCommand" TEXT,
    "promote" TEXT NOT NULL DEFAULT 'pr',
    "timeoutSec" INTEGER NOT NULL DEFAULT 1200,
    "branchName" TEXT NOT NULL DEFAULT 'mergeport/upstream-sync',
    "lastRunAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mode" TEXT NOT NULL DEFAULT 'merge',
    "includePrereleases" BOOLEAN NOT NULL DEFAULT false,
    "releasesBaselined" BOOLEAN NOT NULL DEFAULT false,
    "lastReleaseId" TEXT,
    "lastReleaseTag" TEXT,
    "lastReleaseAt" TIMESTAMP(3),
    "releasesEtag" TEXT,
    "releasesCheckedAt" TIMESTAMP(3),
    "pinForkGithubId" BIGINT,
    "pinUpstreamGithubId" BIGINT,
    "pinForkFullName" TEXT,
    "pinUpstreamFullName" TEXT,
    "pinForkBranch" TEXT,
    "pinUpstreamBranch" TEXT,

    CONSTRAINT "UpstreamUpdateConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpstreamUpdateRun" (
    "id" TEXT NOT NULL,
    "mappingId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
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
    "releaseId" TEXT,
    "release" JSONB,
    "seenAt" TIMESTAMP(3),

    CONSTRAINT "UpstreamUpdateRun_pkey" PRIMARY KEY ("id")
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3),

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceRepoMapping" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "rootPath" TEXT,

    CONSTRAINT "DeviceRepoMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorktreeSnapshot" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
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
    "shared" BOOLEAN NOT NULL DEFAULT false,
    "ownerLogin" TEXT,

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
    "toastedAt" TIMESTAMP(3),

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
    "intervalMs" INTEGER,
    "dirty" BOOLEAN NOT NULL DEFAULT false,
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
CREATE TABLE "PublicCacheEntry" (
    "key" TEXT NOT NULL,
    "etag" TEXT,
    "body" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bytes" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PublicCacheEntry_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "DiscoveryCache" (
    "key" TEXT NOT NULL,
    "payload" JSONB,
    "fetchedAt" TIMESTAMP(3),
    "state" TEXT NOT NULL DEFAULT 'EMPTY',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiscoveryCache_pkey" PRIMARY KEY ("key")
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

-- CreateTable
CREATE TABLE "Space" (
    "id" TEXT NOT NULL,
    "remoteId" TEXT NOT NULL,
    "teamRemoteId" TEXT NOT NULL,
    "kind" "SpaceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "repoOwner" TEXT NOT NULL,
    "repoName" TEXT NOT NULL,
    "repoGithubId" BIGINT,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "canWrite" BOOLEAN NOT NULL DEFAULT false,
    "canAdmin" BOOLEAN NOT NULL DEFAULT false,
    "access" "SpaceAccess" NOT NULL DEFAULT 'OK',
    "headSha" TEXT,
    "etag" TEXT,
    "lastPolledAt" TIMESTAMP(3),
    "lastChangedAt" TIMESTAMP(3),
    "pollIntervalMs" INTEGER NOT NULL DEFAULT 30000,
    "unchangedPolls" INTEGER NOT NULL DEFAULT 0,
    "nextPollAt" TIMESTAMP(3),
    "lastError" TEXT,
    "rateLimitedUntil" TIMESTAMP(3),
    "deferredCount" INTEGER NOT NULL DEFAULT 0,
    "lastPushedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "backend" "SpaceBackend" NOT NULL DEFAULT 'GITHUB',
    "hubSpaceId" TEXT NOT NULL DEFAULT '',
    "hubCursor" BIGINT NOT NULL DEFAULT 0,
    "hubCursorOp" TEXT NOT NULL DEFAULT '',
    "hubEpoch" TEXT NOT NULL DEFAULT '',
    "hubDeferred" JSONB,

    CONSTRAINT "Space_pkey" PRIMARY KEY ("id")
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

    CONSTRAINT "SyncEntity_pkey" PRIMARY KEY ("spaceId","type","entityId")
);

-- CreateTable
CREATE TABLE "OutboxOp" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" "OpKind" NOT NULL,
    "data" JSONB,
    "baseVersion" INTEGER NOT NULL DEFAULT 0,
    "status" "OpStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboxOp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncConflict" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "SyncConflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubRestore" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolledBack" INTEGER NOT NULL,
    "kept" INTEGER NOT NULL,
    "detail" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',

    CONSTRAINT "HubRestore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamConfig" (
    "id" TEXT NOT NULL DEFAULT 'team',
    "mode" "TeamMode" NOT NULL DEFAULT 'PERSONAL',
    "teamRemoteId" TEXT,
    "name" TEXT,
    "ownerLogin" TEXT,
    "commonSpaceId" TEXT,
    "pollSeconds" INTEGER NOT NULL DEFAULT 30,
    "watchSeconds" INTEGER,
    "watchEnabled" BOOLEAN NOT NULL DEFAULT true,
    "watchMaxRepos" INTEGER,
    "backend" "TeamBackend" NOT NULL DEFAULT 'GITHUB',
    "hubOrigin" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TeamConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HubSession" (
    "id" TEXT NOT NULL DEFAULT 'session',
    "origin" TEXT NOT NULL,
    "cipher" TEXT NOT NULL,
    "githubId" BIGINT NOT NULL,
    "login" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HubSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InboxState" (
    "userId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "readVersion" TEXT,
    "doneVersion" TEXT,
    "snoozeUntil" TIMESTAMP(3),
    "snoozeVersion" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboxState_pkey" PRIMARY KEY ("userId","subjectType","subjectId")
);

-- CreateTable
CREATE TABLE "SeenState" (
    "userId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SeenState_pkey" PRIMARY KEY ("userId","workItemId")
);

-- CreateTable
CREATE TABLE "ReviewerAvailability" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "unavailableFrom" TIMESTAMP(3),
    "unavailableUntil" TIMESTAMP(3),
    "backupLogin" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewerAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPref" (
    "userId" TEXT NOT NULL,
    "prefs" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationPref_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "PlanBoard" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "template" TEXT NOT NULL DEFAULT '',
    "columns" JSONB NOT NULL,
    "groupBy" TEXT NOT NULL DEFAULT 'none',
    "density" TEXT NOT NULL DEFAULT 'comfortable',
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanBoard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Epic" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "ownerLogin" TEXT,
    "startDate" TIMESTAMP(3),
    "targetDate" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "decisions" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Epic_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Iteration" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Iteration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlanEvent" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "fromKey" TEXT,
    "toKey" TEXT,
    "refId" TEXT,
    "actorLogin" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlanEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "line" INTEGER NOT NULL,
    "side" TEXT NOT NULL DEFAULT 'RIGHT',
    "body" TEXT NOT NULL,
    "commitSha" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ViewedFile" (
    "userId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sig" TEXT NOT NULL,
    "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ViewedFile_pkey" PRIMARY KEY ("userId","workItemId","path")
);

-- CreateTable
CREATE TABLE "LabelMap" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "concept" TEXT NOT NULL,
    "spelling" TEXT NOT NULL,
    "repoKey" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabelMap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UpstreamSubscription" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "mappingId" TEXT,
    "name" TEXT NOT NULL,
    "criteria" JSONB NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UpstreamSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackportRecord" (
    "id" TEXT NOT NULL,
    "mappingId" TEXT NOT NULL,
    "upstreamNumber" INTEGER NOT NULL,
    "targetBranch" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'planned',
    "evidence" TEXT NOT NULL DEFAULT 'unknown',
    "localSha" TEXT,
    "note" TEXT,
    "byLogin" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackportRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyDigest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" TIMESTAMP(3),

    CONSTRAINT "DailyDigest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSettings" (
    "id" TEXT NOT NULL DEFAULT 'ai',
    "baseUrl" TEXT NOT NULL,
    "cipher" TEXT,
    "model" TEXT,
    "lastModel" TEXT,
    "autopilot" TEXT NOT NULL DEFAULT 'off',
    "lastRunAt" TIMESTAMP(3),
    "lastRunDay" TEXT,
    "lastSummary" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiSuggestion" (
    "id" TEXT NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'NEW',
    "taskId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "AiSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiPendingAction" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "AiPendingAction_pkey" PRIMARY KEY ("id")
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
CREATE UNIQUE INDEX "GithubOwner_githubId_key" ON "GithubOwner"("githubId");

-- CreateIndex
CREATE INDEX "Repository_workspaceId_trackingStatus_idx" ON "Repository"("workspaceId", "trackingStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_workspaceId_githubId_key" ON "Repository"("workspaceId", "githubId");

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
CREATE INDEX "WaitingRule_workspaceId_scope_idx" ON "WaitingRule"("workspaceId", "scope");

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
CREATE INDEX "PlanningItem_assigneeLogin_idx" ON "PlanningItem"("assigneeLogin");

-- CreateIndex
CREATE INDEX "PlanningItem_epicId_idx" ON "PlanningItem"("epicId");

-- CreateIndex
CREATE INDEX "PlanningItem_iterationId_idx" ON "PlanningItem"("iterationId");

-- CreateIndex
CREATE INDEX "GitCache_accessedAt_idx" ON "GitCache"("accessedAt");

-- CreateIndex
CREATE INDEX "TaskCheckItem_itemId_position_idx" ON "TaskCheckItem"("itemId", "position");

-- CreateIndex
CREATE INDEX "TaskComment_itemId_createdAt_idx" ON "TaskComment"("itemId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ForkMapping_forkRepoId_upstreamRepoId_forkBranch_upstreamBr_key" ON "ForkMapping"("forkRepoId", "upstreamRepoId", "forkBranch", "upstreamBranch");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamUpdateConfig_mappingId_key" ON "UpstreamUpdateConfig"("mappingId");

-- CreateIndex
CREATE INDEX "UpstreamUpdateRun_mappingId_startedAt_idx" ON "UpstreamUpdateRun"("mappingId", "startedAt");

-- CreateIndex
CREATE INDEX "UpstreamUpdateRun_mappingId_releaseId_idx" ON "UpstreamUpdateRun"("mappingId", "releaseId");

-- CreateIndex
CREATE INDEX "ForkComparison_mappingId_comparedAt_idx" ON "ForkComparison"("mappingId", "comparedAt");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamPrState_mappingId_number_key" ON "UpstreamPrState"("mappingId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "UpstreamIssueTriage_mappingId_issueNumber_key" ON "UpstreamIssueTriage"("mappingId", "issueNumber");

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

-- CreateIndex
CREATE INDEX "PublicCacheEntry_fetchedAt_bytes_idx" ON "PublicCacheEntry"("fetchedAt", "bytes");

-- CreateIndex
CREATE UNIQUE INDEX "Space_backend_repoOwner_repoName_hubSpaceId_key" ON "Space"("backend", "repoOwner", "repoName", "hubSpaceId");

-- CreateIndex
CREATE INDEX "OutboxOp_spaceId_status_idx" ON "OutboxOp"("spaceId", "status");

-- CreateIndex
CREATE INDEX "SyncConflict_spaceId_status_idx" ON "SyncConflict"("spaceId", "status");

-- CreateIndex
CREATE INDEX "HubRestore_spaceId_status_idx" ON "HubRestore"("spaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReviewerAvailability_workspaceId_login_key" ON "ReviewerAvailability"("workspaceId", "login");

-- CreateIndex
CREATE INDEX "PlanBoard_projectId_idx" ON "PlanBoard"("projectId");

-- CreateIndex
CREATE INDEX "Epic_projectId_idx" ON "Epic"("projectId");

-- CreateIndex
CREATE INDEX "Iteration_projectId_idx" ON "Iteration"("projectId");

-- CreateIndex
CREATE INDEX "PlanEvent_projectId_at_idx" ON "PlanEvent"("projectId", "at");

-- CreateIndex
CREATE INDEX "PlanEvent_itemId_idx" ON "PlanEvent"("itemId");

-- CreateIndex
CREATE INDEX "ReviewDraft_userId_workItemId_idx" ON "ReviewDraft"("userId", "workItemId");

-- CreateIndex
CREATE UNIQUE INDEX "LabelMap_workspaceId_spelling_repoKey_key" ON "LabelMap"("workspaceId", "spelling", "repoKey");

-- CreateIndex
CREATE UNIQUE INDEX "BackportRecord_mappingId_upstreamNumber_targetBranch_key" ON "BackportRecord"("mappingId", "upstreamNumber", "targetBranch");

-- CreateIndex
CREATE UNIQUE INDEX "DailyDigest_userId_day_key" ON "DailyDigest"("userId", "day");

-- CreateIndex
CREATE INDEX "AiSuggestion_state_createdAt_idx" ON "AiSuggestion"("state", "createdAt");

-- CreateIndex
CREATE INDEX "AiSuggestion_sourceKey_idx" ON "AiSuggestion"("sourceKey");

-- CreateIndex
CREATE INDEX "AiPendingAction_state_createdAt_idx" ON "AiPendingAction"("state", "createdAt");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Member" ADD CONSTRAINT "Member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Repository" ADD CONSTRAINT "Repository_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "GithubOwner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

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
ALTER TABLE "WaitingRule" ADD CONSTRAINT "WaitingRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitingRule" ADD CONSTRAINT "WaitingRule_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WaitingRule" ADD CONSTRAINT "WaitingRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "TaskCheckItem" ADD CONSTRAINT "TaskCheckItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PlanningItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskComment" ADD CONSTRAINT "TaskComment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PlanningItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "UpstreamUpdateConfig" ADD CONSTRAINT "UpstreamUpdateConfig_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "ForkMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UpstreamUpdateRun" ADD CONSTRAINT "UpstreamUpdateRun_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "ForkMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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
ALTER TABLE "DeviceRepoMapping" ADD CONSTRAINT "DeviceRepoMapping_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository"("id") ON DELETE CASCADE ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "SyncEntity" ADD CONSTRAINT "SyncEntity_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboxOp" ADD CONSTRAINT "OutboxOp_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncConflict" ADD CONSTRAINT "SyncConflict_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HubRestore" ADD CONSTRAINT "HubRestore_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "Space"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanBoard" ADD CONSTRAINT "PlanBoard_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Epic" ADD CONSTRAINT "Epic_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Iteration" ADD CONSTRAINT "Iteration_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanEvent" ADD CONSTRAINT "PlanEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackportRecord" ADD CONSTRAINT "BackportRecord_mappingId_fkey" FOREIGN KEY ("mappingId") REFERENCES "ForkMapping"("id") ON DELETE CASCADE ON UPDATE CASCADE;

