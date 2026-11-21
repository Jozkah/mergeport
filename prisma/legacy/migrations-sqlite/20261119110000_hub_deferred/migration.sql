-- Hub entities that could not be applied yet no longer hold the space's cursor: they are kept here and retried a bounded number of times.
ALTER TABLE "Space" ADD COLUMN "hubDeferred" JSONB;
