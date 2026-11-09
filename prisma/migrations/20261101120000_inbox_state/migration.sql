-- Personal inbox state. Local to this computer and profile: it is never synchronised or shared.
CREATE TABLE "InboxState" (
    "userId" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "readVersion" TEXT,
    "doneVersion" TEXT,
    "snoozeUntil" DATETIME,
    "snoozeVersion" TEXT,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("userId", "subjectType", "subjectId")
);
