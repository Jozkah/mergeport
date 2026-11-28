import type { Db } from "@/lib/db";
import { audit } from "@/lib/services/audit";
import { GithubAppError } from "./app-auth";
import { getOrgMembership, listUserInstallations, type ConnectDeps, type GithubUser } from "./connect-api";

/**
 * Joining a workspace through GitHub (docs/roles.md, "Joining through GitHub"). A person whose linked GitHub account is an ACTIVE member
 * of the organization behind an installation connected to a workspace becomes a MEMBER of that workspace, without an invitation, when:
 *  - the workspace has `githubOrgAutoJoin` on (the default; owners and administrators can switch it off), and
 *  - the person has NO Member row there at all: someone who was removed or left keeps their REVOKED row and is never brought back.
 *
 * Evidence comes only from the person's own token, checked against the linked numeric GitHub id by the caller: the installation must be
 * in THEIR `GET /user/installations` list with the same account id as the stored installation, and `GET /user/memberships/orgs/:org`
 * (with the login GitHub reports now, never a stored one) must answer `state: active`. A pending invitation to the organization does not
 * count. Installations of a personal account never admit anyone. The role is always MEMBER: owners and administrators are never made
 * this way, and a MEMBER still sees only the repositories GitHub lets them open or that they hold a grant for.
 */
export const ORG_JOIN_ROLE = "MEMBER" as const;
/** At most this many organizations are asked about per run (each is one GitHub request). */
export const MAX_ORG_CHECKS = 20;

export async function joinWorkspacesThroughGithubOrgs(db: Db, input: { userId: string; github: GithubUser; token: string; deps: ConnectDeps }): Promise<string[]> {
  const { userId, github, token, deps } = input;
  // Workspaces that admit organization members, that this person has never been part of, with an organization installation in use.
  const candidates = await db.workspaceInstallation.findMany({
    where: {
      workspace: { githubOrgAutoJoin: true, members: { none: { userId } } },
      installation: { accountType: "ORGANIZATION", deletedAt: null, suspendedAt: null },
    },
    select: { workspaceId: true, installationId: true, installation: { select: { accountGithubId: true } } },
    take: 500,
  });
  if (candidates.length === 0) return [];

  let listed;
  try {
    listed = await listUserInstallations(deps, token);
  } catch (e) {
    if (e instanceof GithubAppError) return [];
    throw e;
  }
  if (!listed) return [];
  const visible = new Map(listed.filter((i) => i.accountType === "ORGANIZATION").map((i) => [i.id, i]));

  // One membership question per organization (by its numeric id), however many workspaces use it.
  const orgs = new Map<bigint, { login: string; workspaceIds: Set<string> }>();
  for (const c of candidates) {
    const seen = visible.get(c.installationId);
    if (!seen || seen.accountId !== c.installation.accountGithubId) continue;
    const o = orgs.get(seen.accountId) ?? { login: seen.accountLogin, workspaceIds: new Set<string>() };
    o.workspaceIds.add(c.workspaceId);
    orgs.set(seen.accountId, o);
  }

  const joined: string[] = [];
  for (const [orgId, o] of [...orgs].slice(0, MAX_ORG_CHECKS)) {
    let m;
    try {
      m = await getOrgMembership(deps, token, o.login);
    } catch (e) {
      if (e instanceof GithubAppError) continue;
      throw e;
    }
    if (m?.state !== "active") continue;
    for (const workspaceId of o.workspaceIds) {
      const made = await db.$transaction(async (tx) => {
        // Re-checked at write time: the switch may have gone off, or a row (even a REVOKED one) may have appeared meanwhile.
        const ws = await tx.workspace.findUnique({ where: { id: workspaceId }, select: { githubOrgAutoJoin: true } });
        if (!ws?.githubOrgAutoJoin) return false;
        const u = await tx.user.findUnique({ where: { id: userId }, select: { githubId: true } });
        if (u?.githubId !== github.id) return false;
        const r = await tx.member.createMany({ data: [{ workspaceId, userId, role: ORG_JOIN_ROLE }], skipDuplicates: true });
        if (r.count !== 1) return false;
        await audit(tx, { workspaceId, userId }, "member.joined_via_github_org", { type: "User", id: userId }, { githubOrgId: String(orgId), githubOrg: o.login, role: ORG_JOIN_ROLE });
        return true;
      });
      if (made) joined.push(workspaceId);
    }
  }
  return joined;
}
