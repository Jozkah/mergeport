-- CreateTable
CREATE TABLE "DiscoveryCache" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "payload" JSONB,
    "fetchedAt" DATETIME,
    "state" TEXT NOT NULL DEFAULT 'EMPTY',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" DATETIME,
    "updatedAt" DATETIME NOT NULL
);
