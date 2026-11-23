import type { Db } from "@/lib/db";

/** Cache rows an earlier version wrote for the hub relay; still removed on leave. */
const LEGACY_HUB_KEYS = ["github-app-coverage", "github-app-hub-coverage", "github-app-hub-webhooks"];

/**
 * Stops using the current team on THIS computer: spaces are forgotten, shared repositories and projects become local again,
 * and the profile returns to personal mode. It writes nothing to GitHub (the repositories, invitations and collaborators stay as
 * they are; remove those on GitHub). Local data (cards, rules, boards) is kept; unsent edits to shared records are dropped
 * with their space. Afterwards a new team can be created or joined.
 */
export async function leaveTeamLocally(db: Db, workspaceId: string): Promise<{ spaces: number }> {
  const ws = workspaceId;
  const spaces = await db.space.count({ where: { workspaceId: ws } });
  // The person owns their personal workspace: back in personal mode they are its administrator again, not the team's MEMBER.
  const me = (await db.member.findFirst({ where: { workspaceId: ws, user: { isDemo: false } }, orderBy: { createdAt: "asc" }, include: { user: true } }))?.user;
  await db.$transaction([
    ...(me ? [db.member.updateMany({ where: { workspaceId: ws, userId: me.id, role: { not: "OWNER" } }, data: { role: "ADMIN", status: "ACTIVE" } })] : []),
    db.repository.updateMany({ where: { workspaceId: ws, spaceId: { not: null } }, data: { spaceId: null } }),
    db.project.updateMany({ where: { workspaceId: ws, spaceId: { not: null } }, data: { spaceId: null } }),
    db.space.deleteMany({ where: { workspaceId: ws } }),
    db.teamConfig.upsert({ where: { workspaceId: ws }, create: { workspaceId: ws, mode: "PERSONAL" }, update: { mode: "PERSONAL", teamRemoteId: null, name: null, ownerLogin: null, commonSpaceId: null } }),
    db.discoveryCache.deleteMany({ where: { workspaceId: ws, OR: [{ key: { startsWith: "inv-status:" } }, { key: { in: ["invitations", "candidates", ...LEGACY_HUB_KEYS] } }] } }),
  ]);
  return { spaces };
}
