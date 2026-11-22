-- Review fixes for the per-person GitHub link: truncation markers on the token row, and a visibility fingerprint on stored digests.

-- AlterTable
ALTER TABLE "GithubUserToken" ADD COLUMN "accessTruncated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "accessRepoCount" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "DailyDigest" ADD COLUMN "visibilityKey" TEXT;
