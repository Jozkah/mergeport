-- CreateTable
CREATE TABLE "GitCache" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "payload" JSONB NOT NULL,
    "bytes" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "accessedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "GitCache_accessedAt_idx" ON "GitCache"("accessedAt");
