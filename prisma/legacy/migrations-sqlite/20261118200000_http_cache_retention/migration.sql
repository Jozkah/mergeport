-- ETag cache retention. `bytes` is the stored body size (backfilled from the existing text once), and the covering index lets the pruner
-- delete by age and sum / evict by size without touching the large `body` column.
ALTER TABLE "PublicCacheEntry" ADD COLUMN "bytes" INTEGER NOT NULL DEFAULT 0;
UPDATE "PublicCacheEntry" SET "bytes" = length(CAST("body" AS BLOB));

-- CreateIndex
CREATE INDEX "PublicCacheEntry_fetchedAt_bytes_idx" ON "PublicCacheEntry"("fetchedAt", "bytes");
