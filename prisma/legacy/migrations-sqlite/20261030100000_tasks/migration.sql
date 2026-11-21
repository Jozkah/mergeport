-- AlterTable
ALTER TABLE "PlanningItem" ADD COLUMN "assignedByLogin" TEXT;
ALTER TABLE "PlanningItem" ADD COLUMN "authorLogin" TEXT;
ALTER TABLE "PlanningItem" ADD COLUMN "labels" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "TaskComment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "authorLogin" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'COMMENT',
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" DATETIME,
    CONSTRAINT "TaskComment_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PlanningItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TaskComment_itemId_createdAt_idx" ON "TaskComment"("itemId", "createdAt");
CREATE INDEX "PlanningItem_assigneeLogin_idx" ON "PlanningItem"("assigneeLogin");
