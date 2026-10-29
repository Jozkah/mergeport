import { randomUUID } from "node:crypto";
import type { Space } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { GithubError } from "@/lib/github/port";
import { GitHubRest } from "@/lib/github/rest";
import { MANIFEST_SCHEMA, parseManifest, type Manifest, type SyncEngine } from "@/lib/sync/engine";
import { CoordinationStore } from "@/lib/sync/store";
import { slugify } from "@/lib/slug";

/**
 * Team lifecycle on GitHub: create, invite, accept, join, discover.
 *
 *  - Every GitHub call is made as the signed-in person, so GitHub itself decides who may create repositories or manage
 *    collaborators. The local role string is derived from those permissions and is never consulted for authority.
 *  - Nothing is created or sent without an explicit confirmed plan.
 *  - A join link names a repository; it is not a credential. Access is whatever GitHub already granted this account.
 *  - Nothing downloaded from a coordination repository is ever executed.
 */

export type Actor = { id: bigint; login: string };

export type TeamPlan = {
  teamName: string;
  teamSlug: string;
  owner: string;
  ownerType: "personal" | "organization";
  repoName: string;
  fullName: string;
  visibility: "private";
  purpose: string;
  permissions: string[];
  renamedBecauseOfCollision: boolean;
};

export type InvitePlan = { fullName: string; usernames: string[]; permission: "push" | "pull"; explanation: string[]; sourceAccessNote: string };
export type InviteOutcome = { username: string; state: "invited" | "already-collaborator" | "failed"; error?: string };
export type InvitationStatus = { username: string; state: "pending" | "expired" | "accepted"; invitationId?: number };

export type CandidateStatus =
  | "joinable"
  | "already-joined"
  | "needs-team"
  | "unsupported-schema"
  | "other-team"
  | "untrusted-owner"
  | "identity-changed"
  | "not-private"
  | "fork"
  | "no-manifest"
  | "invalid-manifest"
  | "no-access"
  | "unavailable";

/** What a person is shown BEFORE they consent to join a space. Everything here was read, not imported. */
export type SpaceCandidate = {
  repoId: number;
  fullName: string;
  owner: string;
  name: string;
  visibility: "private" | "public";
  expectedAccess: "read" | "write" | "admin" | "none";
  spaceName: string | null;
  spaceKind: "COMMON" | "RESTRICTED" | null;
  teamName: string | null;
  teamId: string | null;
  schema: number | null;
  createdBy: { id: string; login: string } | null;
  entityCounts: Record<string, number>;
  status: CandidateStatus;
  reason: string | null;
  warnings: string[];
  downloads: string;
  publishes: string;
  inspectedAt: string;
};

export const JOIN_DOWNLOADS = "Joining downloads this repository's Mergeport files (the manifest and the shared entity files) into this computer's database, and then keeps them in sync by polling. Nothing in it is ever executed or installed.";
export const JOIN_PUBLISHES = "Joining publishes nothing by itself. Later, edits you make to shared projects, and repositories you choose to share to this space, are written there for everyone who can read it.";

export const SOURCE_ACCESS_NOTE = "This invitation gives access only to the coordination repository. It does not grant access to the source-code repositories being tracked; those still need to be readable by each person's own GitHub account (“Source repository access required”).";

export class TeamService {
  readonly rest: GitHubRest;
  constructor(
    private readonly db: Db,
    fetchImpl: typeof fetch,
    private readonly actor: Actor,
    private readonly engine: SyncEngine | null = null,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.rest = new GitHubRest(fetchImpl);
  }

  private store(owner: string, repo: string) {
    return new CoordinationStore(this.rest, owner, repo);
  }

  // ---------- create team ----------

  /** Proposes the exact repository. Nothing is created. Collisions get a numeric suffix; existing repositories are never touched. */
  async planTeam(input: { name: string; owner?: string }): Promise<TeamPlan> {
    const teamName = input.name.trim();
    if (teamName.length < 2 || teamName.length > 60) throw new ValidationError("Give the team a name of 2 to 60 characters");
    const owner = (input.owner ?? this.actor.login).trim();
    const teamSlug = slugify(teamName);
    let repoName = `mergeport-${teamSlug}-workspace`;
    let renamed = false;
    for (let n = 2; await this.exists(owner, repoName); n++) {
      if (n > 20) throw new ValidationError("Too many repositories with that name; choose a different team name");
      repoName = `mergeport-${teamSlug}-workspace-${n}`;
      renamed = true;
    }
    return {
      teamName, teamSlug, owner, ownerType: owner.toLowerCase() === this.actor.login.toLowerCase() ? "personal" : "organization", repoName, fullName: `${owner}/${repoName}`, visibility: "private",
      purpose: "Stores Mergeport-owned team data only: shared configuration, board state, internal tasks and milestones that every team member may see. It never stores GitHub conversations, tokens or local files.",
      permissions: [
        `Creates the private repository ${owner}/${repoName} under ${owner} using your GitHub account.`,
        "You become its administrator. Teammates you invite get write access so they can edit shared planning data; anyone with write access can edit and read everything in this repository and its history.",
        "Restricted projects use separate private repositories with their own audience. This one is for information every team member may see.",
      ],
      renamedBecauseOfCollision: renamed,
    };
  }

  private async exists(owner: string, repo: string): Promise<boolean> {
    try {
      await this.rest.get(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
      return true;
    } catch (e) {
      if (e instanceof GithubError && e.kind === "not-found") return false;
      throw e;
    }
  }

  async createTeam(plan: TeamPlan, opts: { confirmed: boolean }): Promise<Space> {
    if (!opts.confirmed) throw new ValidationError("Confirm the repository, owner and permissions before anything is created");
    const existing = await this.db.teamConfig.findUnique({ where: { id: "team" } });
    if (existing?.mode === "TEAM") throw new ValidationError("This profile is already part of a team");
    if (await this.exists(plan.owner, plan.repoName)) throw new ValidationError("A repository with that name appeared since the plan was made. Review a new plan.");
    const teamId = randomUUID();
    const space = await this.createSpaceRepo({ owner: plan.owner, repoName: plan.repoName, name: "Team workspace", kind: "COMMON", teamId, teamName: plan.teamName });
    await this.db.teamConfig.upsert({
      where: { id: "team" },
      create: { id: "team", mode: "TEAM", teamRemoteId: teamId, name: plan.teamName, ownerLogin: this.actor.login, commonSpaceId: space.id },
      update: { mode: "TEAM", teamRemoteId: teamId, name: plan.teamName, ownerLogin: this.actor.login, commonSpaceId: space.id },
    });
    await this.engine?.refreshRole();
    return space;
  }

  /** Creates a private repository, writes the manifest as the first commit and records the local space. */
  private async createSpaceRepo(i: { owner: string; repoName: string; name: string; kind: "COMMON" | "RESTRICTED"; teamId: string; teamName: string }): Promise<Space> {
    const isPersonal = i.owner.toLowerCase() === this.actor.login.toLowerCase();
    const created = await this.rest.request("POST", isPersonal ? "/user/repos" : `/orgs/${encodeURIComponent(i.owner)}/repos`, { name: i.repoName, private: true, description: `Mergeport ${i.kind === "COMMON" ? "team workspace" : "restricted space"}: ${i.name}`, auto_init: false });
    if (!created.data.private) throw new ValidationError("GitHub did not create a private repository");
    const spaceId = randomUUID();
    const manifest: Manifest = { schema: MANIFEST_SCHEMA, kind: "mergeport-space", spaceId, teamId: i.teamId, teamName: i.teamName, spaceKind: i.kind, name: i.name, createdAt: this.now().toISOString(), createdBy: { id: this.actor.id.toString(), login: this.actor.login } };
    await this.store(i.owner, i.repoName).initialCommit("main", "mergeport.json", JSON.stringify(manifest, null, 2) + "\n", "Initialize Mergeport space");
    const space = await this.db.space.create({
      data: { remoteId: spaceId, teamRemoteId: i.teamId, kind: i.kind, name: i.name, repoOwner: i.owner, repoName: i.repoName, repoGithubId: BigInt(created.data.id), branch: created.data.default_branch ?? "main", canWrite: true, canAdmin: true, access: "OK" },
    });
    return space;
  }

  // ---------- restricted spaces ----------

  /** A separate private repository whose collaborators are exactly the audience. Admin of the common space only (GitHub enforces repo creation rights). */
  async createRestrictedSpace(input: { name: string; owner?: string }): Promise<Space> {
    const team = await this.db.teamConfig.findUnique({ where: { id: "team" } });
    if (!team || team.mode !== "TEAM" || !team.teamRemoteId) throw new ValidationError("Create or join a team first");
    const common = team.commonSpaceId ? await this.db.space.findUnique({ where: { id: team.commonSpaceId } }) : null;
    const name = input.name.trim();
    if (name.length < 2) throw new ValidationError("Name the space");
    const owner = input.owner ?? common?.repoOwner ?? this.actor.login;
    let repoName = `mergeport-${slugify(team.name ?? "team")}-${slugify(name)}`;
    for (let n = 2; await this.exists(owner, repoName); n++) {
      if (n > 20) throw new ValidationError("Too many spaces with that name");
      repoName = `mergeport-${slugify(team.name ?? "team")}-${slugify(name)}-${n}`;
    }
    return this.createSpaceRepo({ owner, repoName, name, kind: "RESTRICTED", teamId: team.teamRemoteId, teamName: team.name ?? "Team" });
  }

  // ---------- invitations ----------

  planInvite(space: Space, usernames: string[], permission: "push" | "pull" = "push"): InvitePlan {
    const names = [...new Set(usernames.map((u) => u.trim().replace(/^@/, "")).filter(Boolean))];
    if (names.length === 0) throw new ValidationError("Name at least one GitHub username");
    for (const n of names) if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(n)) throw new ValidationError(`“${n}” is not a valid GitHub username`);
    return {
      fullName: `${space.repoOwner}/${space.repoName}`, usernames: names, permission,
      explanation: [
        `GitHub will send each person an invitation to ${space.repoOwner}/${space.repoName} with ${permission === "push" ? "write" : "read"} access.`,
        permission === "push" ? "Write access lets them edit this space's data. They can read all files and history in it." : "Read access lets them read all files and history in it.",
        "Organization policy may require approval or block outside collaborators; any such failure is reported per person.",
      ],
      sourceAccessNote: SOURCE_ACCESS_NOTE,
    };
  }

  /** Uses GitHub's own collaborator API as the acting person. A non-admin gets GitHub's 403, whatever the local role says. */
  async invite(space: Space, plan: InvitePlan, opts: { confirmed: boolean }): Promise<InviteOutcome[]> {
    if (!opts.confirmed) throw new ValidationError("Confirm the invitation before it is sent");
    const out: InviteOutcome[] = [];
    for (const username of plan.usernames) {
      try {
        const r = await this.rest.request("PUT", `/repos/${encodeURIComponent(space.repoOwner)}/${encodeURIComponent(space.repoName)}/collaborators/${encodeURIComponent(username)}`, { permission: plan.permission });
        out.push({ username, state: r.status === 204 ? "already-collaborator" : "invited" });
      } catch (e) {
        if (e instanceof GithubError && e.kind === "forbidden") throw new ForbiddenError("GitHub says you are not an administrator of this repository, so you cannot invite people to it.");
        out.push({ username, state: "failed", error: e instanceof GithubError ? (e.kind === "not-found" ? "GitHub user not found" : e.message) : "failed" });
      }
    }
    return out;
  }

  async invitationStatuses(space: Space, usernames?: string[]): Promise<InvitationStatus[]> {
    const base = `/repos/${encodeURIComponent(space.repoOwner)}/${encodeURIComponent(space.repoName)}`;
    const [invs, collabs] = await Promise.all([this.rest.paginate<{ id: number; invitee: { login: string }; expired?: boolean }>(`${base}/invitations`), this.rest.paginate<{ login: string }>(`${base}/collaborators`)]);
    const out: InvitationStatus[] = [];
    for (const i of invs) out.push({ username: i.invitee.login, state: i.expired ? "expired" : "pending", invitationId: i.id });
    for (const c of collabs) if (c.login.toLowerCase() !== space.repoOwner.toLowerCase() && !out.some((o) => o.username === c.login)) out.push({ username: c.login, state: "accepted" });
    return usernames ? out.filter((o) => usernames.some((u) => u.toLowerCase() === o.username.toLowerCase())) : out;
  }

  async revokeInvitationOrAccess(space: Space, username: string): Promise<void> {
    const base = `/repos/${encodeURIComponent(space.repoOwner)}/${encodeURIComponent(space.repoName)}`;
    const pending = (await this.rest.paginate<{ id: number; invitee: { login: string } }>(`${base}/invitations`)).find((i) => i.invitee.login.toLowerCase() === username.toLowerCase());
    if (pending) await this.rest.request("DELETE", `${base}/invitations/${pending.id}`);
    else await this.rest.request("DELETE", `${base}/collaborators/${encodeURIComponent(username)}`);
  }

  // ---------- join ----------

  /** Pending GitHub invitations that look like Mergeport spaces, for the signed-in person to accept explicitly. */
  async myInvitations(): Promise<{ id: number; fullName: string; inviter: string; permission: string }[]> {
    const rows = await this.rest.paginate<{ id: number; repository: { full_name: string; name: string }; inviter: { login: string }; permissions: string; expired?: boolean }>("/user/repository_invitations");
    return rows.filter((r) => r.repository.name.startsWith("mergeport-") && !r.expired).map((r) => ({ id: r.id, fullName: r.repository.full_name, inviter: r.inviter.login, permission: r.permissions }));
  }

  async acceptInvitation(id: number): Promise<void> {
    await this.rest.request("PATCH", `/user/repository_invitations/${id}`);
  }

  static parseRepoRef(input: string): { owner: string; repo: string } {
    const s = input.trim();
    let m = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\/join\?(?:.*&)?repo=([^&]+)/.exec(s);
    const raw = m ? decodeURIComponent(m[1]) : s;
    m = /^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/.exec(raw);
    if (!m) throw new ValidationError("Enter owner/repo, a GitHub URL, or a Mergeport join link");
    return { owner: m[1], repo: m[2] };
  }

  /**
   * Reads (never imports) a repository and decides whether it may be offered for joining. A matching name prefix or a
   * manifest anyone with write access can edit is NOT enough. A space is joinable only when:
   *   - GitHub says it is private, not a fork, and this account can read it;
   *   - its manifest is a valid Mergeport manifest of a schema this version understands;
   *   - once in a team: it belongs to the same team id AND sits under the same owner as the team's common space;
   *   - for a personal account owner, the manifest's creator is that owner (so a copied manifest in someone else's account fails);
   *   - if it is already joined, it is the SAME repository (numeric GitHub id), not one recreated under the same name.
   */
  async inspect(refInput: string): Promise<SpaceCandidate> {
    const { owner, repo } = TeamService.parseRepoRef(refInput);
    const base: SpaceCandidate = { repoId: 0, fullName: `${owner}/${repo}`, owner, name: repo, visibility: "private", expectedAccess: "none", spaceName: null, spaceKind: null, teamName: null, teamId: null, schema: null, createdBy: null, entityCounts: {}, status: "unavailable", reason: null, warnings: [], downloads: JOIN_DOWNLOADS, publishes: JOIN_PUBLISHES, inspectedAt: this.now().toISOString() };
    const reject = (status: CandidateStatus, reason: string, extra: Partial<SpaceCandidate> = {}): SpaceCandidate => ({ ...base, ...extra, status, reason });
    const store = this.store(owner, repo);
    let info;
    try {
      info = await store.info();
    } catch (e) {
      if (e instanceof GithubError && (e.kind === "not-found" || e.kind === "forbidden")) return reject("no-access", "This repository does not exist, or your GitHub account cannot see it. Accept the invitation first, or ask for access.");
      throw e; // offline, rate limited, auth: the caller reports those honestly instead of calling the repository bad
    }
    const [o, n] = info.fullName.split("/");
    const common: Partial<SpaceCandidate> = { repoId: info.id, fullName: info.fullName, owner: o, name: n, visibility: info.private ? "private" : "public", expectedAccess: info.permissions.admin ? "admin" : info.permissions.push ? "write" : info.permissions.pull ? "read" : "none" };
    if (!info.private) return reject("not-private", "That repository is public. Mergeport only uses private repositories as coordination spaces.", common);
    if (info.fork) return reject("fork", "That repository is a fork. Coordination spaces are original repositories created by Mergeport.", common);
    if (!info.permissions.pull) return reject("no-access", "Your GitHub account cannot read that repository. Accept the invitation first.", common);

    const head = await store.head(info.defaultBranch);
    if (!head || head === "empty") return reject("no-manifest", "That repository has no Mergeport manifest.", common);
    const tree = await store.tree(head.treeSha);
    const mf = tree.find((t) => t.path === "mergeport.json");
    if (!mf) return reject("no-manifest", "That repository is not a Mergeport coordination space (no manifest).", common);
    const man = parseManifest(await store.blob(mf.sha));
    if ("error" in man) return reject("invalid-manifest", man.error, common);
    const entityCounts: Record<string, number> = {};
    for (const t of tree) {
      const m = /^entities\/([a-z-]+)\/[^/]+\.json$/.exec(t.path);
      if (m) entityCounts[m[1]] = (entityCounts[m[1]] ?? 0) + 1;
    }
    const described: Partial<SpaceCandidate> = { ...common, spaceName: man.name, spaceKind: man.spaceKind, teamName: man.teamName, teamId: man.teamId, schema: man.schema, createdBy: man.createdBy, entityCounts };
    if (man.schema > MANIFEST_SCHEMA) return reject("unsupported-schema", "This space was created by a newer Mergeport. Update the app before joining.", described);

    const team = await this.db.teamConfig.findUnique({ where: { id: "team" } });
    const commonSpace = team?.commonSpaceId ? await this.db.space.findUnique({ where: { id: team.commonSpaceId } }) : null;
    const warnings: string[] = [];
    if (team?.mode === "TEAM") {
      if (team.teamRemoteId !== man.teamId) return reject("other-team", `This space belongs to a different team (${man.teamName}). You are in “${team.name}”. Leave it before joining another.`, described);
      if (commonSpace && o.toLowerCase() !== commonSpace.repoOwner.toLowerCase()) return reject("untrusted-owner", `Your team's spaces live under ${commonSpace.repoOwner}. This repository is under ${o}, so it is not offered. A matching name is not proof it belongs to your team.`, described);
      if (team.ownerLogin && man.createdBy.login.toLowerCase() !== team.ownerLogin.toLowerCase()) warnings.push(`Created by @${man.createdBy.login}, not the team owner @${team.ownerLogin}. Join only if you expected this space.`);
    } else if (man.spaceKind !== "COMMON") {
      return reject("needs-team", "This is a restricted space. Join the team's common space first.", described);
    }
    if (info.ownerType === "User" && man.createdBy.id !== String(info.ownerId)) return reject("untrusted-owner", `The manifest says @${man.createdBy.login} created this space, but it lives in a personal account owned by @${info.ownerLogin}. A copied manifest does not make a repository trustworthy.`, described);

    const known = await this.db.space.findFirst({ where: { OR: [{ remoteId: man.spaceId }, { repoGithubId: BigInt(info.id) }, { repoOwner: o, repoName: n }] } });
    if (known) {
      if ((known.repoGithubId !== null && known.repoGithubId !== BigInt(info.id)) || known.remoteId !== man.spaceId) {
        return reject("identity-changed", "A space with this name was joined before, but this is a different repository (its GitHub id or space id changed). It will not be trusted automatically.", described);
      }
      return { ...base, ...described, status: "already-joined", reason: "You have already joined this space.", warnings } as SpaceCandidate;
    }
    return { ...base, ...described, status: "joinable", reason: null, warnings } as SpaceCandidate;
  }

  /**
   * Joins ONE space the person has looked at and agreed to. `expectedRepoId` is the GitHub id they were shown: if the
   * repository behind the name changed since, nothing is joined. Everything is re-validated here; a cached listing or a
   * link is never trusted. Reads data only: no script, dependency or instruction found there is ever executed.
   */
  async join(refInput: string, opts: { confirmed: boolean; expectedRepoId?: number }): Promise<Space> {
    if (!opts.confirmed) throw new ValidationError("Joining needs your explicit confirmation after reviewing what it downloads and publishes");
    const c = await this.inspect(refInput);
    if (opts.expectedRepoId !== undefined && c.repoId !== 0 && c.repoId !== opts.expectedRepoId) throw new ValidationError("That repository changed since it was listed (its GitHub id is different). Review it again before joining.");
    if (c.status === "no-access") throw new ForbiddenError(c.reason ?? "No access");
    if (c.status !== "joinable" && c.status !== "already-joined") throw new ValidationError(c.reason ?? "That repository cannot be joined");
    const { owner, repo } = TeamService.parseRepoRef(c.fullName);
    const store = this.store(owner, repo);
    const info = await store.info();
    const man = parseManifest(await store.blob((await store.tree((await store.head(info.defaultBranch) as { treeSha: string }).treeSha)).find((t) => t.path === "mergeport.json")!.sha));
    if ("error" in man) throw new ValidationError(man.error);
    const team = await this.db.teamConfig.findUnique({ where: { id: "team" } });
    const known = await this.db.space.findFirst({ where: { OR: [{ remoteId: man.spaceId }, { repoOwner: owner, repoName: repo }] } });
    if (known) {
      return this.db.space.update({ where: { id: known.id }, data: { access: "OK", canWrite: info.permissions.push || info.permissions.admin, canAdmin: info.permissions.admin, nextPollAt: null, headSha: null, etag: null, lastError: null } });
    }
    const space = await this.db.space.create({
      data: { remoteId: man.spaceId, teamRemoteId: man.teamId, kind: man.spaceKind, name: man.name, repoOwner: info.fullName.split("/")[0], repoName: info.fullName.split("/")[1], repoGithubId: BigInt(info.id), branch: info.defaultBranch, canWrite: info.permissions.push || info.permissions.admin, canAdmin: info.permissions.admin, access: "OK" },
    });
    if (!team || team.mode !== "TEAM") {
      await this.db.teamConfig.upsert({
        where: { id: "team" },
        create: { id: "team", mode: "TEAM", teamRemoteId: man.teamId, name: man.teamName, ownerLogin: man.createdBy.login, commonSpaceId: man.spaceKind === "COMMON" ? space.id : null },
        update: { mode: "TEAM", teamRemoteId: man.teamId, name: man.teamName, ownerLogin: man.createdBy.login, commonSpaceId: man.spaceKind === "COMMON" ? space.id : null },
      });
    } else if (man.spaceKind === "COMMON" && !team.commonSpaceId) await this.db.teamConfig.update({ where: { id: "team" }, data: { commonSpaceId: space.id } });
    await this.engine?.refreshRole();
    return space;
  }

  /**
   * Finds repositories THIS account can already read that look like spaces of our team, and reports what each one is.
   * It joins nothing and imports nothing: the person chooses. Restricted spaces are never listed in the common
   * repository, so this is the only way they are found. Bounded: at most `limit` repositories are inspected.
   */
  async candidates(limit = 25): Promise<SpaceCandidate[]> {
    const team = await this.db.teamConfig.findUnique({ where: { id: "team" } });
    if (!team || team.mode !== "TEAM" || !team.teamRemoteId) return [];
    const prefix = `mergeport-${slugify(team.name ?? "team")}-`;
    const repos = await this.rest.paginate<{ full_name: string; name: string; private: boolean }>("/user/repos?affiliation=owner,collaborator,organization_member", 5);
    const named = repos.filter((r) => r.name.startsWith(prefix)).slice(0, limit);
    const out: SpaceCandidate[] = [];
    for (let i = 0; i < named.length; i += 3) {
      const batch = await Promise.all(
        named.slice(i, i + 3).map(async (r) => {
          try {
            return await this.inspect(r.full_name);
          } catch (e) {
            if (e instanceof GithubError && (e.kind === "network" || e.kind === "rate-limited" || e.kind === "auth")) throw e; // the whole listing is unreliable: say so instead of listing "unavailable" repositories
            const [owner, name] = r.full_name.split("/");
            return { repoId: 0, fullName: r.full_name, owner, name, visibility: r.private ? "private" : "public", expectedAccess: "none", spaceName: null, spaceKind: null, teamName: null, teamId: null, schema: null, createdBy: null, entityCounts: {}, status: "unavailable", reason: "Could not be inspected", warnings: [], downloads: JOIN_DOWNLOADS, publishes: JOIN_PUBLISHES, inspectedAt: this.now().toISOString() } as SpaceCandidate;
          }
        }),
      );
      out.push(...batch);
    }
    return out;
  }

  /** A join link names a space. It carries no token and grants nothing by itself. */
  joinLink(space: Space, port: number): string {
    return `http://127.0.0.1:${port}/join?repo=${encodeURIComponent(`${space.repoOwner}/${space.repoName}`)}`;
  }
}
