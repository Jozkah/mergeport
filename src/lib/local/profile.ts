import path from "node:path";
import type { Db } from "@/lib/db";
import { ensureCommonSpace } from "@/lib/services/access-spaces";
import type { Backend } from "@/lib/local/backends";

/**
 * A local profile = one SQLite file for one (host, GitHub account id). Credentials, caches and pending edits are
 * namespaced by that pair, so switching accounts can never mix data: a different account gets a different file.
 */

export type LocalIdentity = { id: bigint; login: string; name: string | null; avatarUrl: string | null; host: string };

export class AccountMismatchError extends Error {
  constructor(readonly expected: string, readonly actual: string) {
    super(`This profile belongs to GitHub account ${expected}, but gh is signed in as ${actual}. Switch back with gh auth switch, or start Mergeport for the other account.`);
  }
}

export const mergeportHome = (override?: string) => override ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".mergeport");
/** GitHub profiles keep their original folder name; a hub profile is the same name plus `-hub-<fingerprint>`. */
export const profileDirName = (host: string, accountId: bigint, backend: Backend = "github") => {
  const base = `${host.replace(/[^a-z0-9.-]/gi, "_")}-${accountId}`;
  return backend === "github" ? base : `${base}-${backend}`;
};
export const profileDbPath = (home: string, host: string, accountId: bigint, backend: Backend = "github") => path.join(home, "profiles", profileDirName(host, accountId, backend), "mergeport.db");

/**
 * The one workspace of a LOCAL profile, created once even when callers race: a transaction-scoped advisory lock serialises the
 * find-or-create. Single-profile plumbing (hub link, discovery caches, the in-process scheduler) has no signed-in viewer and uses
 * this as its workspace; anything that serves a request takes the viewer's workspaceId instead.
 */
export async function firstWorkspace(db: Db) {
  const found = await db.workspace.findMany({ orderBy: { createdAt: "asc" }, take: 2 });
  // FAIL CLOSED: with several workspaces "the first" would silently be the oldest tenant's. Code that has no workspace of its own
  // is single-profile code; it must not run against a multi-workspace database. Pass the workspace instead.
  if (found.length > 1) throw new Error("This code path serves one workspace per database and was reached with several. Pass the workspace explicitly.");
  if (found.length === 1) return found[0];
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(7771001)`;
    return (await tx.workspace.findFirst({ orderBy: { createdAt: "asc" } })) ?? (await tx.workspace.create({ data: { name: "Personal workspace" } }));
  });
}

/** Creates the single local workspace, user and member for this profile, or verifies the stored one matches. */
export async function ensureLocalProfile(db: Db, who: LocalIdentity) {
  const existing = await db.user.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
  if (existing && existing.githubId !== who.id) throw new AccountMismatchError(existing.login, who.login);
  const workspace = await firstWorkspace(db);
  const user = await db.user.upsert({ where: { githubId: who.id }, create: { githubId: who.id, login: who.login, name: who.name, avatarUrl: who.avatarUrl }, update: { login: who.login, name: who.name, avatarUrl: who.avatarUrl } });
  // The local app is one person on one computer: ADMIN as before, and in team mode GitHub (or the hub) decides it. OWNER is for hosted workspaces.
  const member = await db.member.upsert({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } }, create: { workspaceId: workspace.id, userId: user.id, role: "ADMIN" }, update: { status: "ACTIVE" } });
  await ensureCommonSpace(db, workspace.id);
  // createMany + skipDuplicates is INSERT ... ON CONFLICT DO NOTHING: safe when two callers race on the unique workspaceId.
  await db.teamConfig.createMany({ data: [{ workspaceId: workspace.id, mode: "PERSONAL" }], skipDuplicates: true });
  const team = await db.teamConfig.findUniqueOrThrow({ where: { workspaceId: workspace.id } });
  // Personal mode means the person administers their own workspace. (In team mode the role comes from GitHub permissions.)
  if (team.mode === "PERSONAL" && member.role !== "ADMIN") {
    const fixed = await db.member.update({ where: { id: member.id, workspaceId: workspace.id }, data: { role: "ADMIN" } });
    return { workspace, user, member: fixed };
  }
  return { workspace, user, member };
}
