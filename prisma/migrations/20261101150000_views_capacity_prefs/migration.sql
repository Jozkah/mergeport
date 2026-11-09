-- Saved views can be shared. A shared view is only its definition (page, name, query string): results are recomputed for each viewer.
ALTER TABLE "SavedFilter" ADD COLUMN "shared" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SavedFilter" ADD COLUMN "ownerLogin" TEXT;

-- Reviewer availability and configured backups (shared team configuration, synchronised).
CREATE TABLE "ReviewerAvailability" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "unavailableFrom" DATETIME,
    "unavailableUntil" DATETIME,
    "backupLogin" TEXT,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ReviewerAvailability_workspaceId_login_key" ON "ReviewerAvailability"("workspaceId", "login");

-- Personal notification preferences. Never synchronised.
CREATE TABLE "NotificationPref" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "prefs" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
