-- When a Windows toast was shown for a notification. Rows that already exist count as handled, so the first start after this does not pop a flood of old ones.
ALTER TABLE "Notification" ADD COLUMN "toastedAt" DATETIME;
UPDATE "Notification" SET "toastedAt" = CURRENT_TIMESTAMP;
