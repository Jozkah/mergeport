-- AI autopilot: daily background review and the suggestions it leaves. Local, never synchronised.
ALTER TABLE "AiSettings" ADD COLUMN "autopilot" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "AiSettings" ADD COLUMN "lastRunAt" DATETIME;
ALTER TABLE "AiSettings" ADD COLUMN "lastRunDay" TEXT;
ALTER TABLE "AiSettings" ADD COLUMN "lastSummary" TEXT;

CREATE TABLE "AiSuggestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'NEW',
    "taskId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" DATETIME
);

CREATE INDEX "AiSuggestion_state_createdAt_idx" ON "AiSuggestion"("state", "createdAt");
CREATE INDEX "AiSuggestion_sourceKey_idx" ON "AiSuggestion"("sourceKey");
