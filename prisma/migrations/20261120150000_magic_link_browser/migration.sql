-- A magic link is bound to the browser that asked for it, and expired links are found by index when they are cleaned up.
ALTER TABLE "MagicLink" ADD COLUMN "browserHash" TEXT;

CREATE INDEX "MagicLink_expiresAt_idx" ON "MagicLink"("expiresAt");
