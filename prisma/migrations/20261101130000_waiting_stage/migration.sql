-- Which stage of the hand-off a waiting rule or manual waiting record describes. Empty means "infer from who is waited on".
ALTER TABLE "WaitingRule" ADD COLUMN "stage" TEXT NOT NULL DEFAULT '';
ALTER TABLE "WaitingRecord" ADD COLUMN "stage" TEXT NOT NULL DEFAULT '';
