-- Numeric GitHub ids next to the login strings, so a renamed or re-used login never changes whose queue an item is in.
-- All nullable / empty by default: rows written before this keep matching on login until the next sync stores the ids.
ALTER TABLE "WorkItem" ADD COLUMN "assigneeIds" TEXT NOT NULL DEFAULT '';
ALTER TABLE "WorkItemComment" ADD COLUMN "authorGithubId" BIGINT;
ALTER TABLE "ReviewRequest" ADD COLUMN "reviewerGithubId" BIGINT;
