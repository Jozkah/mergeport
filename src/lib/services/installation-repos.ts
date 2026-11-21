import type { Db } from "@/lib/db";
import { requireAdmin, type Viewer } from "@/lib/authz/viewer";
import { ValidationError } from "@/lib/errors";
import { listBoundInstallations, setRepositoryInstallation } from "@/lib/github/binding";
import type { BoundInstallation } from "@/lib/github/bound-installation";
import { installationPort } from "@/lib/github/factory";
import { GithubNotConnectedError } from "@/lib/github/hosted";
import { GithubError } from "@/lib/github/port";
import { workspaceGithubStatus } from "@/lib/github/status";
import { audit } from "./audit";
import { upsertRepository, type RepoMeta } from "./repositories";

/**
 * Hosted repository discovery: what the workspace's own GitHub App installations can access, and tracking a chosen subset.
 * Listing needs a binding the workspace proved (`listBoundInstallations`); there is no other way to a token. The list is
 * everything the installation may read, so only an administrator sees it and selects from it. Which repositories a MEMBER then
 * sees is decided by `repoWhere` (explicit grants), never by what GitHub's token could read.
 */

/** At most this many repositories are listed per installation (pages of 100). */
export const INSTALLATION_LIST_MAX_PAGES = 10;

export type InstallationRepo = { meta: RepoMeta; installationId: bigint; /** Already tracked in THIS workspace (and not removed). */ tracked: boolean };
export type InstallationRepoList = {
  state: "not-connected" | "suspended" | "ok";
  repos: InstallationRepo[];
  /** One line per installation that could not be listed (the others still are). */
  problems: string[];
  /** An installation has more repositories than the cap lists. */
  truncated: boolean;
};

async function listOne(db: Db, bound: BoundInstallation): Promise<{ repos: RepoMeta[]; truncated: boolean }> {
  const port = await installationPort(db, bound);
  const repos: RepoMeta[] = [];
  let page: number | null = 1;
  for (let i = 0; page && i < INSTALLATION_LIST_MAX_PAGES; i++) {
    const r = await port.listInstallationRepositories(page);
    repos.push(...r.repos);
    page = r.nextPage;
  }
  return { repos, truncated: page !== null };
}

/** The repositories of every installation this workspace has bound, read live with each installation's own token. Never throws for a GitHub failure: it is reported in `problems`. */
export async function listInstallationRepos(db: Db, workspaceId: string): Promise<InstallationRepoList> {
  const bounds = await listBoundInstallations(db, workspaceId);
  if (bounds.length === 0) {
    const s = await workspaceGithubStatus(db, workspaceId);
    return { state: s.suspended ? "suspended" : "not-connected", repos: [], problems: [], truncated: false };
  }
  const tracked = new Set((await db.repository.findMany({ where: { workspaceId, trackingStatus: { not: "REMOVED" } }, select: { githubId: true } })).map((r) => r.githubId.toString()));
  const out: InstallationRepo[] = [];
  const problems: string[] = [];
  let truncated = false;
  const seen = new Set<string>();
  for (const bound of bounds) {
    try {
      const one = await listOne(db, bound);
      truncated ||= one.truncated;
      for (const meta of one.repos) {
        const key = meta.githubId.toString();
        if (seen.has(key)) continue; // reachable through two installations: listed once, served by the older binding
        seen.add(key);
        out.push({ meta, installationId: bound.installationId, tracked: tracked.has(key) });
      }
    } catch (e) {
      if (e instanceof GithubNotConnectedError) continue; // went away while listing: the state is recorded, the rest still lists
      problems.push(e instanceof GithubError ? e.message : "GitHub could not be read for one connection.");
    }
  }
  out.sort((a, b) => a.meta.fullName.localeCompare(b.meta.fullName));
  return { state: "ok", repos: out, problems, truncated };
}

/**
 * Tracks the selected repositories (by GitHub id) in this workspace through the installation that lists them. Administrators only.
 * The selection is checked against a fresh listing, so an id that no installation of THIS workspace lists is refused, whatever the
 * form said. The repository row points at its installation through the binding service only (`setRepositoryInstallation`).
 */
export async function trackInstallationRepos(db: Db, v: Viewer, githubIds: string[]) {
  requireAdmin(v);
  const wanted = new Set(githubIds);
  if (wanted.size === 0) throw new ValidationError("Select at least one repository");
  const list = await listInstallationRepos(db, v.workspaceId);
  if (list.state !== "ok") throw new GithubNotConnectedError();
  const chosen = list.repos.filter((r) => wanted.has(r.meta.githubId.toString()));
  if (chosen.length !== wanted.size) throw new ValidationError("Some selected repositories are no longer available to this workspace's GitHub connection");
  const rows = [];
  for (const c of chosen) {
    const row = await upsertRepository(db, v.workspaceId, c.meta);
    await setRepositoryInstallation(db, v.workspaceId, row.id, c.installationId);
    rows.push(row);
  }
  await audit(db, v, "repository.track", undefined, { githubIds: chosen.map((c) => c.meta.githubId.toString()), via: "installation" });
  return rows;
}
