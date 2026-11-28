-- Members of the GitHub organization behind a connected installation join the workspace on GitHub sign-in (docs/roles.md). On by default.
ALTER TABLE "Workspace" ADD COLUMN "githubOrgAutoJoin" BOOLEAN NOT NULL DEFAULT true;
