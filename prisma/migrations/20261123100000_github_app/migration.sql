-- GitHub App foundation (docs/github-app.md). Four new tables and Repository.installationId.
-- GithubInstallation, GithubDelivery and GithubAppState are GLOBAL; WorkspaceInstallation is ROOT (workspaceId, cascading foreign key, index that starts with it).

-- CreateEnum
CREATE TYPE "InstallationAccountType" AS ENUM ('USER', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "InstallationRepositorySelection" AS ENUM ('ALL', 'SELECTED');

-- AlterTable
ALTER TABLE "Repository" ADD COLUMN "installationId" BIGINT;

-- CreateTable
CREATE TABLE "GithubInstallation" (
    "installationId" BIGINT NOT NULL,
    "accountGithubId" BIGINT NOT NULL,
    "accountLogin" TEXT NOT NULL,
    "accountType" "InstallationAccountType" NOT NULL,
    "repositorySelection" "InstallationRepositorySelection" NOT NULL DEFAULT 'SELECTED',
    "suspendedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubInstallation_pkey" PRIMARY KEY ("installationId")
);

-- CreateTable
CREATE TABLE "WorkspaceInstallation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "connectedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkspaceInstallation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubDelivery" (
    "deliveryId" TEXT NOT NULL,
    "installationId" BIGINT,
    "event" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GithubDelivery_pkey" PRIMARY KEY ("deliveryId")
);

-- CreateTable
CREATE TABLE "GithubAppState" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "nonceHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "GithubAppState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Repository_installationId_idx" ON "Repository"("installationId");

-- CreateIndex
CREATE INDEX "GithubInstallation_accountGithubId_idx" ON "GithubInstallation"("accountGithubId");

-- CreateIndex
CREATE INDEX "WorkspaceInstallation_workspaceId_idx" ON "WorkspaceInstallation"("workspaceId");

-- CreateIndex
CREATE INDEX "WorkspaceInstallation_installationId_idx" ON "WorkspaceInstallation"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceInstallation_workspaceId_installationId_key" ON "WorkspaceInstallation"("workspaceId", "installationId");

-- CreateIndex
CREATE INDEX "GithubDelivery_receivedAt_idx" ON "GithubDelivery"("receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "GithubAppState_stateHash_key" ON "GithubAppState"("stateHash");

-- CreateIndex
CREATE INDEX "GithubAppState_expiresAt_idx" ON "GithubAppState"("expiresAt");

-- AddForeignKey
ALTER TABLE "WorkspaceInstallation" ADD CONSTRAINT "WorkspaceInstallation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInstallation" ADD CONSTRAINT "WorkspaceInstallation_installationId_fkey" FOREIGN KEY ("installationId") REFERENCES "GithubInstallation"("installationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceInstallation" ADD CONSTRAINT "WorkspaceInstallation_connectedByUserId_fkey" FOREIGN KEY ("connectedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
