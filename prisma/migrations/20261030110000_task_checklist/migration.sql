-- CreateTable
CREATE TABLE "TaskCheckItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "itemId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "position" REAL NOT NULL,
    "doneByLogin" TEXT,
    "doneAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskCheckItem_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "PlanningItem" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "TaskCheckItem_itemId_position_idx" ON "TaskCheckItem"("itemId", "position");
