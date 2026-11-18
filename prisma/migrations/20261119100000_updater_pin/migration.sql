-- Upstream auto-updater: pin what the person approved (fork and upstream repository ids, full names and branches) when they save the
-- settings. A run refuses to start when the live mapping no longer matches, so a teammate's shared edit cannot point it elsewhere.
ALTER TABLE "UpstreamUpdateConfig" ADD COLUMN "pinForkGithubId" BIGINT;
ALTER TABLE "UpstreamUpdateConfig" ADD COLUMN "pinUpstreamGithubId" BIGINT;
ALTER TABLE "UpstreamUpdateConfig" ADD COLUMN "pinForkFullName" TEXT;
ALTER TABLE "UpstreamUpdateConfig" ADD COLUMN "pinUpstreamFullName" TEXT;
ALTER TABLE "UpstreamUpdateConfig" ADD COLUMN "pinForkBranch" TEXT;
ALTER TABLE "UpstreamUpdateConfig" ADD COLUMN "pinUpstreamBranch" TEXT;

-- Existing configs keep working: they are pinned to their mapping as it stands now.
UPDATE "UpstreamUpdateConfig" SET
    "pinForkGithubId" = (SELECT r."githubId" FROM "ForkMapping" m JOIN "Repository" r ON r."id" = m."forkRepoId" WHERE m."id" = "UpstreamUpdateConfig"."mappingId"),
    "pinUpstreamGithubId" = (SELECT r."githubId" FROM "ForkMapping" m JOIN "Repository" r ON r."id" = m."upstreamRepoId" WHERE m."id" = "UpstreamUpdateConfig"."mappingId"),
    "pinForkFullName" = (SELECT r."fullName" FROM "ForkMapping" m JOIN "Repository" r ON r."id" = m."forkRepoId" WHERE m."id" = "UpstreamUpdateConfig"."mappingId"),
    "pinUpstreamFullName" = (SELECT r."fullName" FROM "ForkMapping" m JOIN "Repository" r ON r."id" = m."upstreamRepoId" WHERE m."id" = "UpstreamUpdateConfig"."mappingId"),
    "pinForkBranch" = (SELECT m."forkBranch" FROM "ForkMapping" m WHERE m."id" = "UpstreamUpdateConfig"."mappingId"),
    "pinUpstreamBranch" = (SELECT m."upstreamBranch" FROM "ForkMapping" m WHERE m."id" = "UpstreamUpdateConfig"."mappingId");
