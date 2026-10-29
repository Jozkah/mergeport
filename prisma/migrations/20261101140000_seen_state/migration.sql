-- What a person last looked at on a pull request or issue. Local to this computer and profile; never synchronised.
CREATE TABLE "SeenState" (
    "userId" TEXT NOT NULL,
    "workItemId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "seenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("userId", "workItemId")
);
