import type { Db } from "@/lib/db";
import type { SyncEngine } from "@/lib/sync/engine";
import type { Me } from "./types";

/**
 * Brings the local Space rows in line with what the hub says this member may see.
 * Spaces the member cannot see are never listed by the hub, so a restricted space only ever exists locally for its members.
 * Returns hub space ids.
 */
export async function syncHubSpaces(db: Db, engine: SyncEngine, me: Me, origin?: string): Promise<{ added: string[]; removed: string[] }> {
  engine.assertBackend("HUB"); // a GitHub profile never records or opens hub spaces
  const added: string[] = [];
  const removed: string[] = [];
  const workspaceId = await engine.workspaceId();
  const local = await db.space.findMany({ where: { workspaceId, backend: "HUB" } });
  const byHubId = new Map(local.map((s) => [s.hubSpaceId, s]));
  let commonId: string | null = null;

  for (const hs of me.spaces) {
    const existing = byHubId.get(hs.id);
    const fields = { kind: hs.kind, name: hs.name, canWrite: hs.canWrite, canAdmin: false, teamRemoteId: me.team.id };
    if (!existing) {
      const created = await db.space.create({ data: { workspaceId, ...fields, backend: "HUB", remoteId: hs.id, hubSpaceId: hs.id, repoOwner: "", repoName: "", access: "OK" } });
      added.push(hs.id);
      if (hs.kind === "COMMON") commonId = created.id;
      continue;
    }
    // Access that came back after a revocation starts from a clean position: the purge dropped everything this cursor referred to.
    const reopened = existing.access === "REVOKED";
    await db.space.update({ where: { id: existing.id, workspaceId }, data: { ...fields, access: "OK", ...(reopened ? { hubCursor: 0n, hubCursorOp: "", hubEpoch: "", lastError: null, nextPollAt: null } : {}) } });
    if (reopened) added.push(hs.id);
    if (hs.kind === "COMMON") commonId = existing.id;
  }

  const visible = new Set(me.spaces.map((s) => s.id));
  for (const s of local) {
    if (visible.has(s.hubSpaceId) || s.access === "REVOKED") continue;
    await engine.revokeSpace(s.id, "You no longer have access to this space");
    removed.push(s.hubSpaceId);
  }

  // In a hub profile the local role is the hub's own: hub spaces never carry an admin bit, so it cannot come from a space.
  const hubAdmin = me.member.role === "OWNER" || me.member.role === "ADMIN";
  // A READER is never promoted by this; an OWNER row only exists in a database that was a hosted workspace or migrated, and here authority comes from the hub.
  await db.member.updateMany({ where: { workspaceId, status: "ACTIVE", role: { in: ["OWNER", "ADMIN", "MEMBER"] } }, data: { role: hubAdmin ? "ADMIN" : "MEMBER" } });

  if (commonId) {
    await db.teamConfig.upsert({
      where: { workspaceId },
      create: { workspaceId, mode: "TEAM", backend: "HUB", teamRemoteId: me.team.id, name: me.team.name, commonSpaceId: commonId, ...(origin ? { hubOrigin: origin } : {}) },
      update: { backend: "HUB", commonSpaceId: commonId, teamRemoteId: me.team.id, ...(origin ? { hubOrigin: origin } : {}) },
    });
  }
  return { added, removed };
}
