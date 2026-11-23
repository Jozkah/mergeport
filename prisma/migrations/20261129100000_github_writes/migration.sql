-- Per-workspace switch for opt-in GitHub writes made as the acting person (docs/github-app.md). Off by default.
ALTER TABLE "Workspace" ADD COLUMN "githubWritesEnabled" BOOLEAN NOT NULL DEFAULT false;
