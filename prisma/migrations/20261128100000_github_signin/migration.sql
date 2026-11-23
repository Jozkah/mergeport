-- "Sign in with GitHub": single-use state of a sign-in that has no person or workspace yet (docs/github-app.md). Hashes only.
CREATE TABLE "GithubSigninState" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "nonceHash" TEXT NOT NULL,
    "next" TEXT NOT NULL DEFAULT '/',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "GithubSigninState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GithubSigninState_stateHash_key" ON "GithubSigninState"("stateHash");

CREATE INDEX "GithubSigninState_expiresAt_idx" ON "GithubSigninState"("expiresAt");
