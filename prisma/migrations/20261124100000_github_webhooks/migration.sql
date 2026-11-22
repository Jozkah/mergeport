-- GitHub App webhooks (docs/github-app.md): when the last verified delivery for an installation was accepted.
ALTER TABLE "GithubInstallation" ADD COLUMN "lastWebhookAt" TIMESTAMP(3);
