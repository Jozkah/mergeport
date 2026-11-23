import type { Db } from "@/lib/db";
import { can } from "@/lib/authz/roles";
import { subjectOf, type Viewer } from "@/lib/authz/viewer";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { githubWritesCeiling } from "@/lib/github/writes-ceiling";
import { audit } from "./audit";

/** The workspace switch for writing to GitHub as the acting person (docs/github-app.md). Owners and administrators; audited; only while the deployment allows it. */
export async function setWorkspaceGithubWrites(db: Db, v: Viewer, enabled: boolean): Promise<boolean> {
  if (!can(subjectOf(v), "manageGithub")) throw new ForbiddenError("Only the owner and administrators can change this");
  if (!githubWritesCeiling()) throw new ValidationError("This server does not allow writing to GitHub");
  const before = await db.workspace.findUniqueOrThrow({ where: { id: v.workspaceId }, select: { githubWritesEnabled: true } });
  if (before.githubWritesEnabled === enabled) return false;
  await db.workspace.update({ where: { id: v.workspaceId }, data: { githubWritesEnabled: enabled } });
  await audit(db, v, enabled ? "github.writes.enable" : "github.writes.disable", { type: "Workspace", id: v.workspaceId });
  return true;
}

/** What Settings, GitHub shows: whether the server allows writes at all, and this workspace's own choice. */
export async function githubWritesView(db: Db, workspaceId: string): Promise<{ ceiling: boolean; enabled: boolean }> {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { githubWritesEnabled: true } });
  return { ceiling: githubWritesCeiling(), enabled: ws?.githubWritesEnabled === true };
}
