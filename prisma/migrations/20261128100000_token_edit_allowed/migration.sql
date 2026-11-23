-- Editing, moving and completing tasks over MCP needs its own consent (docs/mcp.md). Existing tokens and grants stay at create and comment (false).
ALTER TABLE "ApiToken" ADD COLUMN "editAllowed" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "OAuthGrant" ADD COLUMN "editAllowed" BOOLEAN NOT NULL DEFAULT false;
