-- When a verified webhook last named a repository (docs/github-app.md, "Maintenance and pacing").
ALTER TABLE "Repository" ADD COLUMN "lastEventAt" TIMESTAMP(3);
