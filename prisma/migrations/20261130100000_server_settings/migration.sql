-- Outgoing email moves from SMTP_URL / MAIL_FROM to Settings > Email, changed only by a server administrator (docs/deploy.md).
ALTER TABLE "User" ADD COLUMN "isServerAdmin" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "ServerSettings" (
    "id" TEXT NOT NULL DEFAULT 'server',
    "smtpHost" TEXT,
    "smtpPort" INTEGER NOT NULL DEFAULT 587,
    "smtpSecurity" TEXT NOT NULL DEFAULT 'starttls',
    "smtpUsername" TEXT,
    "smtpPasswordEnc" TEXT,
    "mailFrom" TEXT,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServerSettings_pkey" PRIMARY KEY ("id")
);

-- The single-use setup link that creates the first server administrator. Hash only.
CREATE TABLE "SetupToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SetupToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SetupToken_tokenHash_key" ON "SetupToken"("tokenHash");
