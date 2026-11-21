-- AI endpoint for drafting tasks: one local row per profile, never synchronised. The key is stored encrypted.
CREATE TABLE "AiSettings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'ai',
    "baseUrl" TEXT NOT NULL,
    "cipher" TEXT,
    "model" TEXT,
    "updatedAt" DATETIME NOT NULL
);
