import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { createCard } from "@/lib/services/planning";
import { mapLocalRoot, scanWorktrees } from "@/lib/services/worktrees";
import { projectReviewerRefs, setProjectReviewers } from "@/lib/services/project-reviewers";
import { enqueue } from "@/lib/jobs";
import { isPersonalName } from "@/lib/domain/ordering";

/**
 * "Set up automatically": looks at what is already tracked and proposes configuration that follows from GitHub's own
 * metadata. Everything is local (projects, fork mappings, waiting rules): nothing is written to GitHub, nothing is shared,
 * existing configuration is never changed or removed, and running it twice proposes nothing the second time. Each proposal
 * says what it is based on; nothing is guessed from names. Settings that do not exist (there is no per-kind notification
 * preference, no automation scheduler to tune) are not invented: they are listed as "nothing to configure".
 */
export type SetupStep = { id: string; kind: "project" | "fork" | "waiting-rule" | "planning" | "folder" | "review-rule"; title: string; basis: string };
export type SetupOptions = { clonesFolder?: string | null };
export type SetupPlan = { steps: SetupStep[]; skipped: string[]; nothingToConfigure: string[] };

type Apply = () => Promise<void>;

async function build(db: Db, v: Viewer, opts: SetupOptions): Promise<{ plan: SetupPlan; apply: Map<string, Apply> }> {
  const workspaceId = v.workspaceId;
  const viewerLogin = v.login;
  const apply = new Map<string, Apply>();
  const steps: SetupStep[] = [];
  const skipped: string[] = [];
  const add = (s: SetupStep, fn: Apply) => {
    steps.push(s);
    apply.set(s.id, fn);
  };
  const me = viewerLogin.toLowerCase();

  const repos = await db.repository.findMany({
    where: { workspaceId, trackingStatus: { not: "REMOVED" }, isDemo: false },
    include: { owner: true, projects: { select: { projectId: true } }, forkMappings: { select: { id: true } } },
    orderBy: { fullName: "asc" },
  });

  // 1. Projects: tracked repositories that belong to no project, grouped by GitHub owner when an owner has several.
  const loose = repos.filter((r) => r.projects.length === 0);
  const byOwner = new Map<string, typeof loose>();
  for (const r of loose) (byOwner.get(r.owner.login) ?? byOwner.set(r.owner.login, []).get(r.owner.login)!).push(r);
  const projects = await db.project.findMany({ where: { workspaceId }, select: { id: true, name: true } });
  for (const [owner, rs] of byOwner) {
    if (rs.length < 2) {
      skipped.push(`${rs[0].fullName} is in no project, but ${owner} has only this one tracked repository, so no project was proposed.`);
      continue;
    }
    const personal = owner.toLowerCase() === me;
    const name = personal ? (projects.find((p) => isPersonalName(p.name, viewerLogin))?.name ?? "Mine") : owner;
    add(
      { id: `project:${owner}`, kind: "project", title: `${personal ? "Add" : "Create"} project “${name}” with ${rs.length} repositories`, basis: `${rs.length} tracked repositories have the GitHub owner ${owner} and are in no project.` },
      async () => {
        let p = projects.find((x) => x.name.toLowerCase() === name.toLowerCase());
        if (!p) {
          const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project";
          const made = await db.project.create({ data: { workspaceId, name, slug } });
          const { createColumnsForProject } = await import("@/lib/services/planning");
          await createColumnsForProject(db, made.id);
          p = { id: made.id, name };
        }
        await db.projectRepository.createMany({ data: rs.map((r) => ({ projectId: p!.id, repositoryId: r.id })) });
      },
    );
  }

  // 2. Forks: map a tracked fork to its tracked parent, using GitHub's own parent id.
  const byGithubId = new Map(repos.map((r) => [r.githubId.toString(), r]));
  for (const f of repos.filter((r) => r.isFork && r.forkMappings.length === 0)) {
    const parent = f.parentGithubId !== null ? byGithubId.get(f.parentGithubId.toString()) : undefined;
    if (!parent) {
      skipped.push(`${f.fullName} is a fork${f.parentFullName ? ` of ${f.parentFullName}` : ""}, which is not tracked. Track it (a public one can be added by URL), then run this again.`);
      continue;
    }
    add(
      { id: `fork:${f.id}`, kind: "fork", title: `Compare ${f.fullName} with its upstream ${parent.fullName}`, basis: `GitHub lists ${parent.fullName} as the parent of ${f.fullName}.` },
      async () => {
        const forkBranch = f.defaultBranch || "main";
        const upstreamBranch = parent.defaultBranch || "main";
        const m = await db.forkMapping.upsert({
          where: { forkRepoId_upstreamRepoId_forkBranch_upstreamBranch: { forkRepoId: f.id, upstreamRepoId: parent.id, forkBranch, upstreamBranch } },
          create: { forkRepoId: f.id, upstreamRepoId: parent.id, forkBranch, upstreamBranch },
          update: {},
        });
        await enqueue(db, { type: "sync.fork", payload: { mappingId: m.id }, dedupeKey: `fork:${m.id}` });
      },
    );
  }

  // 3. Waiting rules: in another person's own repository, work waits on that person (the maintainer who merges it).
  const existing = await db.waitingRule.findMany({ where: { workspaceId } });
  const covered = new Set(existing.filter((w) => w.scope === "OWNER" && w.ownerLogin).map((w) => w.ownerLogin!.toLowerCase()));
  const owners = new Map<string, number>();
  for (const r of repos) if (r.owner.type === "USER" && r.owner.login.toLowerCase() !== me) owners.set(r.owner.login, (owners.get(r.owner.login) ?? 0) + 1);
  for (const [owner, n] of owners) {
    if (covered.has(owner.toLowerCase())) continue;
    add(
      { id: `waiting:${owner}`, kind: "waiting-rule", title: `Open pull requests in ${owner}'s repositories wait on ${owner}`, basis: `${n} tracked ${n === 1 ? "repository is" : "repositories are"} owned by the person ${owner} (GitHub account type User), not by you or an organization.` },
      async () => {
        await db.waitingRule.create({ data: { workspaceId, scope: "OWNER", ownerLogin: owner, itemType: "PULL_REQUEST", labels: [], authors: [], includeDrafts: false, waitingOn: [{ kind: "USER", ref: owner }], reason: `${owner} owns and merges the repositories they own` } });
      },
    );
  }


  // 4. Planning: open work of each project that is on no board yet, placed by what GitHub says about it.
  for (const pr of await db.project.findMany({ where: { workspaceId }, include: { repositories: { select: { repositoryId: true } } }, orderBy: { name: "asc" } })) {
    const repoIds = pr.repositories.map((x) => x.repositoryId);
    if (repoIds.length === 0) continue;
    const items = await db.workItem.findMany({ where: { repositoryId: { in: repoIds }, state: "OPEN", planningItems: { none: {} } }, select: { id: true, type: true, draft: true, checksState: true, mergeable: true } });
    if (items.length === 0) continue;
    const column = (i: (typeof items)[number]) => (i.type === "ISSUE" ? "backlog" : i.checksState === "FAILURE" || i.mergeable === "CONFLICTING" ? "blocked" : i.draft ? "in-progress" : "in-review");
    const prs = items.filter((i) => i.type === "PULL_REQUEST").length;
    add(
      { id: `planning:${pr.id}`, kind: "planning", title: `Put ${items.length} open item${items.length === 1 ? "" : "s"} on the “${pr.name}” board`, basis: `${prs} pull request${prs === 1 ? "" : "s"} (draft: In progress, failing or conflicting: Blocked, otherwise In review) and ${items.length - prs} issue${items.length - prs === 1 ? "" : "s"} (Backlog) are open in this project's repositories and on no board. Cards link to GitHub; dragging them never changes GitHub.` },
      async () => {
        for (const i of items) await createCard(db, v, { projectId: pr.id, workItemId: i.id, columnKey: column(i) }).catch(() => undefined);
      },
    );
  }

  // 5. Branches and worktrees: local clones (found by their own `origin` URL) of tracked repositories.
  const folder = opts.clonesFolder?.trim();
  if (folder) {
    const mapped = new Set((await db.deviceRepoMapping.findMany({ select: { repositoryId: true } })).map((m) => m.repositoryId));
    const byName = new Map(repos.map((r) => [r.fullName.toLowerCase(), r]));
    let dirs: string[] = [];
    try {
      dirs = (await fs.readdir(folder, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => path.join(folder, d.name));
    } catch {
      skipped.push(`The folder ${folder} could not be read, so no local clones were looked for.`);
    }
    for (const dir of dirs) {
      const cfg = await fs.readFile(path.join(dir, ".git", "config"), "utf8").catch(() => null);
      const url = cfg?.match(/\[remote "origin"\][^\[]*?url\s*=\s*(\S+)/)?.[1];
      const m = url?.match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i);
      const repo = m ? byName.get(`${m[1]}/${m[2]}`.toLowerCase()) : undefined;
      if (!repo || mapped.has(repo.id)) continue;
      mapped.add(repo.id);
      add(
        { id: `folder:${repo.id}`, kind: "folder", title: `Map ${dir} to ${repo.fullName}`, basis: `The clone's origin is ${url}. Only branch names and changed-file counts are read; nothing leaves this computer.` },
        async () => {
          await mapLocalRoot(db, v, repo.id, dir);
          await scanWorktrees(db, v, repo.id).catch(() => undefined);
        },
      );
    }
  }

  // 6. Review routing learned from history: people GitHub asked to review nearly every pull request of a project.
  for (const pr of await db.project.findMany({ where: { workspaceId }, include: { repositories: { select: { repositoryId: true } } }, orderBy: { name: "asc" } })) {
    if ((await projectReviewerRefs(db, workspaceId, pr.id)).length > 0) continue;
    const repoIds = pr.repositories.map((x) => x.repositoryId);
    if (repoIds.length === 0) continue;
    const prs = await db.workItem.findMany({ where: { repositoryId: { in: repoIds }, type: "PULL_REQUEST", draft: false }, select: { reviewRequests: { where: { kind: "USER" }, select: { reviewerRef: true } } } });
    const asked = prs.filter((x) => x.reviewRequests.length > 0);
    if (asked.length < 3) continue;
    const count = new Map<string, number>();
    for (const x of asked) for (const ref of new Set(x.reviewRequests.map((r) => r.reviewerRef))) count.set(ref, (count.get(ref) ?? 0) + 1);
    const steady = [...count].filter(([, c]) => c / asked.length >= 0.8).map(([ref]) => ref);
    if (steady.length === 0) continue;
    add(
      { id: `review:${pr.id}`, kind: "review-rule", title: `Require review from ${steady.join(", ")} in “${pr.name}”`, basis: `GitHub asked ${steady.length === 1 ? "this person" : "these people"} to review at least 80% of the ${asked.length} pull requests that had a review request in this project.` },
      async () => {
        await setProjectReviewers(db, workspaceId, pr.id, pr.name, steady.join(", "));
      },
    );
  }

  return {
    plan: {
      steps,
      skipped,
      nothingToConfigure: [
        "Notifications: choose which events notify you, and whether they also pop up on the desktop, in the Notifications panel on this page.",
        "Automations: refresh runs in the background on its own schedule; the polling interval for shared team data is on the Sync page.",
        "Review rules are only proposed where GitHub's own review requests show a steady pattern; anything else needs your decision under Review routing or on a project.",
      ],
    },
    apply,
  };
}

export async function planAutoSetup(db: Db, v: Viewer, opts: SetupOptions = {}): Promise<SetupPlan> {
  return (await build(db, v, opts)).plan;
}

export async function applyAutoSetup(db: Db, v: Viewer, ids: string[], opts: SetupOptions = {}): Promise<SetupStep[]> {
  const { plan, apply } = await build(db, v, opts);
  const done: SetupStep[] = [];
  for (const s of plan.steps) {
    if (!ids.includes(s.id)) continue;
    await apply.get(s.id)!();
    done.push(s);
  }
  return done;
}
