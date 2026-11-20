-- Per-profile settings of the repository auto-sync watcher. watchSeconds NULL means "not set": the environment default applies.
ALTER TABLE "TeamConfig" ADD COLUMN "watchSeconds" INTEGER;
ALTER TABLE "TeamConfig" ADD COLUMN "watchEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "TeamConfig" ADD COLUMN "watchMaxRepos" INTEGER;
