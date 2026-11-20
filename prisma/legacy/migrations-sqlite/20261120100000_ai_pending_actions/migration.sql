-- Requests from AI apps to act on GitHub. Nothing is sent until a person approves. Local, never synchronised.
CREATE TABLE "AiPendingAction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "result" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" DATETIME
);

CREATE INDEX "AiPendingAction_state_createdAt_idx" ON "AiPendingAction"("state", "createdAt");
