-- When this computer last published to the space, so the Sync page can say what teammates have not had a chance to poll yet.
ALTER TABLE "Space" ADD COLUMN "lastPushedAt" DATETIME;
