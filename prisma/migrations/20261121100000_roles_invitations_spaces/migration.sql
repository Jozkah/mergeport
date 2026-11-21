-- Workspace membership management: four roles with one OWNER, email invitations, access-control spaces. See docs/roles.md.

-- The role enum grows OWNER and READER. A new type replaces the old one so no value is added inside this transaction and used in it.
ALTER TYPE "MemberRole" RENAME TO "MemberRole_old";
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'READER');
ALTER TABLE "Member" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "Member" ALTER COLUMN "role" TYPE "MemberRole" USING ("role"::text::"MemberRole");
ALTER TABLE "Member" ALTER COLUMN "role" SET DEFAULT 'MEMBER';
DROP TYPE "MemberRole_old";

-- Every existing workspace with an ACTIVE member gets exactly one OWNER: its oldest ACTIVE ADMIN (ties by id); with no ACTIVE ADMIN, its oldest
-- ACTIVE member. A REVOKED member is never made OWNER. A workspace with no ACTIVE member at all gets no OWNER (nobody can use it; an operator
-- promotes one row by hand: UPDATE "Member" SET "role" = 'OWNER', "status" = 'ACTIVE' WHERE "id" = ...; the unique index below allows it).
UPDATE "Member" SET "role" = 'OWNER'
WHERE "id" IN (
  SELECT DISTINCT ON ("workspaceId") "id"
  FROM "Member"
  WHERE "status" = 'ACTIVE'
  ORDER BY "workspaceId", ("role" = 'ADMIN') DESC, "createdAt" ASC, "id" ASC
);

-- At most one OWNER per workspace. Ownership moves only by an atomic swap in the service (demote, then promote).
CREATE UNIQUE INDEX "Member_one_owner" ON "Member"("workspaceId") WHERE "role" = 'OWNER';

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "emailLowercased" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL,
    "invitedByMemberId" TEXT,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "sendFailedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessSpace" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "SpaceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessSpace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessSpaceMember" (
    "spaceId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "canWrite" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AccessSpaceMember_pkey" PRIMARY KEY ("spaceId","memberId")
);

-- AlterTable
ALTER TABLE "Project" ADD COLUMN "accessSpaceId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");
CREATE INDEX "Invitation_workspaceId_createdAt_idx" ON "Invitation"("workspaceId", "createdAt");
CREATE INDEX "AccessSpace_workspaceId_idx" ON "AccessSpace"("workspaceId");
CREATE INDEX "AccessSpaceMember_memberId_idx" ON "AccessSpaceMember"("memberId");
CREATE INDEX "Project_accessSpaceId_idx" ON "Project"("accessSpaceId");

-- One pending invitation per workspace and address; accepted and revoked rows stay as history.
CREATE UNIQUE INDEX "Invitation_pending_key" ON "Invitation"("workspaceId", "emailLowercased") WHERE "acceptedAt" IS NULL AND "revokedAt" IS NULL;
-- One COMMON space per workspace.
CREATE UNIQUE INDEX "AccessSpace_one_common" ON "AccessSpace"("workspaceId") WHERE "kind" = 'COMMON';

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_invitedByMemberId_fkey" FOREIGN KEY ("invitedByMemberId") REFERENCES "Member"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AccessSpace" ADD CONSTRAINT "AccessSpace_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessSpaceMember" ADD CONSTRAINT "AccessSpaceMember_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "AccessSpace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccessSpaceMember" ADD CONSTRAINT "AccessSpaceMember_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project" ADD CONSTRAINT "Project_accessSpaceId_fkey" FOREIGN KEY ("accessSpaceId") REFERENCES "AccessSpace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The database itself refuses an OWNER invitation and an address that is not lowercased.
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_role_not_owner" CHECK ("role" <> 'OWNER');
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_email_lowercase" CHECK ("emailLowercased" = lower("emailLowercased"));

-- Every existing workspace gets its COMMON space (ids are generated here; the app uses cuid for new ones).
INSERT INTO "AccessSpace" ("id", "workspaceId", "kind", "name")
SELECT 'cs_' || md5("id"), "id", 'COMMON', 'Everyone' FROM "Workspace";
