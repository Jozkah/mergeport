-- Upstream auto-updater, "warn about releases only" mode. All additive; existing rows keep mode 'merge' and behave exactly as before.
-- The release cursor lives on the (local-only) config: what was the newest release at baseline or at the last warning, and the ETag of the
-- list, so an unchanged list answers 304 and costs no rate limit.
ALTER TABLE "UpstreamUpdateConfig" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'merge';
ALTER TABLE "UpstreamUpdateConfig" ADD COLUMN "includePrereleases" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UpstreamUpdateConfig" ADD COLUMN "releasesBaselined" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UpstreamUpdateConfig" ADD COLUMN "lastReleaseId" TEXT;
ALTER TABLE "UpstreamUpdateConfig" ADD COLUMN "lastReleaseTag" TEXT;
ALTER TABLE "UpstreamUpdateConfig" ADD COLUMN "lastReleaseAt" DATETIME;
ALTER TABLE "UpstreamUpdateConfig" ADD COLUMN "releasesEtag" TEXT;
ALTER TABLE "UpstreamUpdateConfig" ADD COLUMN "releasesCheckedAt" DATETIME;

-- A `release-found` run is one warning about one upstream release.
ALTER TABLE "UpstreamUpdateRun" ADD COLUMN "releaseId" TEXT;
ALTER TABLE "UpstreamUpdateRun" ADD COLUMN "release" JSONB;
ALTER TABLE "UpstreamUpdateRun" ADD COLUMN "seenAt" DATETIME;

-- CreateIndex
CREATE INDEX "UpstreamUpdateRun_mappingId_releaseId_idx" ON "UpstreamUpdateRun"("mappingId", "releaseId");
