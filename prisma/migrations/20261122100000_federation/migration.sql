-- Federation: a user links another Mergeport instance and sees its data read-only. See docs/federation.md.
-- Five new ROOT tables (each carries workspaceId, a cascading foreign key to Workspace and an index that starts with it).

-- CreateTable
CREATE TABLE "FederationPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "outboundMode" TEXT NOT NULL DEFAULT 'off',
    "inboundMode" TEXT NOT NULL DEFAULT 'off',
    "allowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "whoCanLink" TEXT NOT NULL DEFAULT 'ADMIN',
    "maxLinksPerUser" INTEGER NOT NULL DEFAULT 5,
    "maxPeers" INTEGER NOT NULL DEFAULT 5,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedByUserId" TEXT,

    CONSTRAINT "FederationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederationLink" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "peerOrigin" TEXT NOT NULL,
    "tokenEnc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "stateHash" TEXT,
    "verifierEnc" TEXT,
    "pendingExpiresAt" TIMESTAMP(3),
    "peerWorkspaceName" TEXT,
    "peerRole" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "FederationLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederationGrant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientOrigin" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'read',
    "codeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "codeUsedAt" TIMESTAMP(3),
    "codeChallenge" TEXT,
    "redirectUri" TEXT,
    "tokenHash" TEXT,
    "expiresAt" TIMESTAMP(3),
    "absoluteExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "FederationGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederationCache" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "linkId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "etag" TEXT,
    "bodyJson" JSONB NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FederationCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FederationEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "kind" TEXT NOT NULL,
    "peerOrigin" TEXT,
    "linkId" TEXT,
    "grantId" TEXT,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FederationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FederationPolicy_workspaceId_key" ON "FederationPolicy"("workspaceId");
CREATE UNIQUE INDEX "FederationLink_stateHash_key" ON "FederationLink"("stateHash");
CREATE INDEX "FederationLink_workspaceId_userId_idx" ON "FederationLink"("workspaceId", "userId");
CREATE UNIQUE INDEX "FederationGrant_codeHash_key" ON "FederationGrant"("codeHash");
CREATE UNIQUE INDEX "FederationGrant_tokenHash_key" ON "FederationGrant"("tokenHash");
CREATE INDEX "FederationGrant_workspaceId_userId_idx" ON "FederationGrant"("workspaceId", "userId");
CREATE INDEX "FederationGrant_workspaceId_clientOrigin_idx" ON "FederationGrant"("workspaceId", "clientOrigin");
CREATE UNIQUE INDEX "FederationCache_workspaceId_linkId_key_key" ON "FederationCache"("workspaceId", "linkId", "key");
CREATE INDEX "FederationEvent_workspaceId_createdAt_idx" ON "FederationEvent"("workspaceId", "createdAt");

-- One live (PENDING or ACTIVE) link per person, workspace and peer. Restarting a link replaces the pending one in the service.
CREATE UNIQUE INDEX "FederationLink_live_key" ON "FederationLink"("workspaceId", "userId", "peerOrigin") WHERE "status" IN ('PENDING', 'ACTIVE');

-- AddForeignKey
ALTER TABLE "FederationPolicy" ADD CONSTRAINT "FederationPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FederationLink" ADD CONSTRAINT "FederationLink_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FederationLink" ADD CONSTRAINT "FederationLink_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FederationGrant" ADD CONSTRAINT "FederationGrant_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FederationGrant" ADD CONSTRAINT "FederationGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FederationCache" ADD CONSTRAINT "FederationCache_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FederationCache" ADD CONSTRAINT "FederationCache_linkId_fkey" FOREIGN KEY ("linkId") REFERENCES "FederationLink"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FederationEvent" ADD CONSTRAINT "FederationEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
