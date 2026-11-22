-- Per-person GitHub link (docs/github-app.md, "Linking your GitHub account"). Two new GLOBAL tables keyed by user and User.githubLogin.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "githubLogin" TEXT;

-- CreateTable
CREATE TABLE "GithubUserToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessEnc" TEXT,
    "refreshEnc" TEXT,
    "accessExpiresAt" TIMESTAMP(3),
    "refreshExpiresAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'OK',
    "accessCheckedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubUserToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GithubRepoAccess" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "repositoryGithubId" BIGINT NOT NULL,
    "installationId" BIGINT NOT NULL,
    "permission" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GithubRepoAccess_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GithubUserToken_userId_key" ON "GithubUserToken"("userId");

-- CreateIndex
CREATE INDEX "GithubRepoAccess_userId_checkedAt_idx" ON "GithubRepoAccess"("userId", "checkedAt");

-- CreateIndex
CREATE INDEX "GithubRepoAccess_installationId_idx" ON "GithubRepoAccess"("installationId");

-- CreateIndex
CREATE UNIQUE INDEX "GithubRepoAccess_userId_repositoryGithubId_key" ON "GithubRepoAccess"("userId", "repositoryGithubId");

-- AddForeignKey
ALTER TABLE "GithubUserToken" ADD CONSTRAINT "GithubUserToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GithubRepoAccess" ADD CONSTRAINT "GithubRepoAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
