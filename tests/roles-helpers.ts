import type { Db } from "@/lib/db";
import { createWorkspaceFor } from "@/lib/auth/workspaces";
import { createSession } from "@/lib/auth/session";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import type { Role } from "@/lib/authz/roles";
import { RecordingMailer } from "./auth-mocks";

let seq = 0;

/** A person with a verified email address (as if they had signed in by magic link). */
export async function person(db: Db, email: string, opts: { githubId?: bigint } = {}) {
  return db.user.create({ data: { login: email.split("@")[0], email, emailVerifiedAt: new Date(), githubId: opts.githubId ?? null } });
}

/** A workspace created the way onboarding does it (the creator becomes its OWNER), plus the owner's viewer. */
export async function workspaceWithOwner(db: Db, email = `owner${seq++}@example.com`, name = "Acme") {
  const user = await person(db, email);
  const ws = await createWorkspaceFor(db, user.id, name);
  const viewer = (await loadViewer(db, user.id, ws.id))!;
  return { ws, owner: user, viewer };
}

/** Adds an ACTIVE member with a role straight into the table (no invitation) and returns their user, member row and a fresh viewer loader. */
export async function addMember(db: Db, workspaceId: string, email: string, role: Exclude<Role, "OWNER">) {
  const user = (await db.user.findUnique({ where: { email } })) ?? (await person(db, email));
  const member = await db.member.create({ data: { workspaceId, userId: user.id, role, status: "ACTIVE" } });
  return { user, member, viewer: async () => (await loadViewer(db, user.id, workspaceId))! as Viewer };
}

export const tokenOf = (mailer: RecordingMailer, n = -1) => new URL(mailer.link(n)).pathname.split("/").pop()!;

/** A login session of this person bound to a workspace (as the switcher does), and the row for assertions. */
export async function sessionIn(db: Db, userId: string, workspaceId: string) {
  const { token } = await createSession(db, userId, new Date(), workspaceId);
  const { sha256 } = await import("@/lib/crypto");
  return db.session.findUniqueOrThrow({ where: { tokenHash: sha256(token) } });
}
