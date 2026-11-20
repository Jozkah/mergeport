-- Daily digest: one stored digest per person and reported day. Personal and local, never synchronised.
CREATE TABLE "DailyDigest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "generatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readAt" DATETIME
);

CREATE UNIQUE INDEX "DailyDigest_userId_day_key" ON "DailyDigest"("userId", "day");
