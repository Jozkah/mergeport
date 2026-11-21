-- Entities that could not be applied yet (their source item is not synchronised here). A pull that finds the head unchanged retries while this is above zero.
ALTER TABLE "Space" ADD COLUMN "deferredCount" INTEGER NOT NULL DEFAULT 0;
