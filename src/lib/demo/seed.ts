import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { createColumnsForProject } from "@/lib/services/planning";
import { indexList } from "@/lib/domain/text-index";

/**
 * Deterministic demo data. EVERYTHING here is synthetic: owners such as "northwind" are fixture names, not
 * claims about any real GitHub account. Timestamps are offsets from `base` so tests are reproducible.
 * Repositories and owners carry isDemo / synthetic flags so the UI can label them.
 */

export type DemoIds = Awaited<ReturnType<typeof seedDemo>>;

const H = 3600_000;
const D = 24 * H;

export async function truncateAll(db: Db) {
  const all = await db.$queryRawUnsafe<{ name: string }[]>("SELECT name FROM sqlite_master WHERE type = 'table'");
  const rows = all.filter((r) => !r.name.startsWith("sqlite_") && !r.name.startsWith("_")); // keep migration bookkeeping
  await db.$executeRawUnsafe("PRAGMA foreign_keys = OFF");
  for (const r of rows) await db.$executeRawUnsafe(`DELETE FROM "${r.name}"`);
  await db.$executeRawUnsafe("PRAGMA foreign_keys = ON");
}

export async function seedDemo(db: Db, base = new Date()) {
  const at = (offsetMs: number) => new Date(base.getTime() + offsetMs);

  const ws = await db.workspace.create({ data: { name: "Demo workspace (synthetic data)" } });

  const mkUser = (githubId: number, login: string, name: string) => db.user.create({ data: { githubId: BigInt(githubId), login, name, isDemo: true, avatarUrl: null } });
  const [uAdmin, uA, uB, uExt] = await Promise.all([
    mkUser(1001, "owner-demo", "Olive Owner"),
    mkUser(1002, "alice-demo", "Alice Demo"),
    mkUser(1003, "bram-demo", "Bram Demo"),
    mkUser(1004, "maintainer-demo", "Mina Maintainer"), // NOT a dashboard member
  ]);
  const mkMember = (userId: string, role: "ADMIN" | "MEMBER") => db.member.create({ data: { workspaceId: ws.id, userId, role } });
  const mAdmin = await mkMember(uAdmin.id, "ADMIN");
  const mA = await mkMember(uA.id, "MEMBER");
  const mB = await mkMember(uB.id, "MEMBER");

  // Owners: account type comes from (synthetic) API metadata, never from the name.
  const oNorthwind = await db.githubOwner.create({ data: { githubId: 5001n, login: "northwind", type: "ORGANIZATION", synthetic: true } });
  const oOwner = await db.githubOwner.create({ data: { githubId: 1001n, login: "owner-demo", type: "USER", synthetic: true } });
  const oAcme = await db.githubOwner.create({ data: { githubId: 5002n, login: "acme-labs", type: "ORGANIZATION", synthetic: true } });

  let gh = 9000n;
  const mkRepo = (owner: { id: string; login: string }, name: string, o: Partial<Prisma.RepositoryUncheckedCreateInput> = {}) =>
    db.repository.create({
      data: {
        workspaceId: ws.id,
        githubId: gh++,
        ownerId: owner.id,
        name,
        fullName: `${owner.login}/${name}`,
        htmlUrl: `https://github.com/${owner.login}/${name}`,
        visibility: "PRIVATE",
        defaultBranch: "main",
        isDemo: true,
        lastSyncedAt: at(-5 * 60_000),
        ...o,
      },
    });
  const rApi = await mkRepo(oNorthwind, "atlas-api", { description: "Synthetic: backend service" });
  const rWeb = await mkRepo(oNorthwind, "atlas-web", { visibility: "PUBLIC", description: "Synthetic: web client" });
  const rCore = await mkRepo(oAcme, "dashboard-core", { visibility: "PUBLIC", description: "Synthetic upstream" });
  const rFork = await mkRepo(oOwner, "dashboard-fork", { visibility: "PUBLIC", isFork: true, parentGithubId: rCore.githubId, parentFullName: rCore.fullName });
  const rInternal = await mkRepo(oAcme, "internal-tools", { description: "Synthetic: admin-only repository" });
  const rSandbox = await mkRepo(oOwner, "public-sandbox", { visibility: "PUBLIC", description: "Public on GitHub but granted to nobody" });
  await mkRepo(oOwner, "legacy-disconnected", { trackingStatus: "DISCONNECTED", statusDetail: "Installation was removed from this repository", lastSyncedAt: at(-9 * D) });

  const pAtlas = await db.project.create({ data: { workspaceId: ws.id, name: "Atlas", slug: "atlas" } });
  const pDash = await db.project.create({ data: { workspaceId: ws.id, name: "Dashboard", slug: "dashboard" } });
  await db.projectRepository.createMany({
    data: [
      { projectId: pAtlas.id, repositoryId: rApi.id },
      { projectId: pAtlas.id, repositoryId: rWeb.id },
      { projectId: pDash.id, repositoryId: rWeb.id }, // multi-project repository
      { projectId: pDash.id, repositoryId: rCore.id },
      { projectId: pDash.id, repositoryId: rFork.id },
      { projectId: pDash.id, repositoryId: rInternal.id },
    ],
  });
  await db.projectMember.createMany({
    data: [
      { projectId: pAtlas.id, memberId: mA.id },
      { projectId: pDash.id, memberId: mA.id },
      { projectId: pAtlas.id, memberId: mB.id },
      { projectId: pDash.id, memberId: mB.id },
    ],
  });
  await createColumnsForProject(db, pAtlas.id);
  await createColumnsForProject(db, pDash.id);

  // Member A: api, web, fork. Member B: web, core. Nobody: internal-tools, sandbox, legacy.
  const grant = (memberId: string, repositoryId: string, canManageWork: boolean, canReview: boolean) =>
    db.repositoryGrant.create({ data: { memberId, repositoryId, grantedById: uAdmin.id, canManageWork, canReview } });
  await grant(mA.id, rApi.id, true, true);
  await grant(mA.id, rWeb.id, true, true);
  await grant(mA.id, rFork.id, true, false);
  await grant(mB.id, rWeb.id, false, true);
  await grant(mB.id, rCore.id, true, true);

  // Review routing: label on atlas-api routes to an external maintainer.
  await db.reviewRule.create({
    data: {
      workspaceId: ws.id,
      scope: "REPOSITORY",
      repositoryId: rApi.id,
      labels: ["needs-maintainer-review"],
      reviewers: [{ kind: "USER", ref: "maintainer-demo", display: "Mina Maintainer" }],
      semantics: "ANY",
      reason: "Proposed rule: PRs labeled needs-maintainer-review wait on the maintainer",
    },
  });
  await db.reviewRule.create({
    data: { workspaceId: ws.id, scope: "OWNER", ownerLogin: "acme-labs", labels: [], reviewers: [{ kind: "USER", ref: "owner-demo" }], semantics: "ANY", reason: "Owner default: acme-labs work is reviewed by the owner" },
  });

  let n = 1;
  const num = () => n++;
  const mkItem = async (repo: { id: string }, o: { type: "ISSUE" | "PULL_REQUEST"; title: string; author: string; labels?: { name: string; color: string }[]; draft?: boolean; headSha?: string; checks?: "SUCCESS" | "FAILURE" | "PENDING" | "NONE"; mergeable?: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"; created: number; updated?: number; state?: "OPEN" | "CLOSED" | "MERGED"; number?: number }) => {
    const number = o.number ?? num();
    return db.workItem.create({
      data: {
        repositoryId: repo.id,
        githubId: BigInt(100000 + Number(gh) + number),
        number,
        type: o.type,
        title: o.title,
        body: "Synthetic body text for demo data.",
        state: o.state ?? "OPEN",
        draft: !!o.draft,
        authorLogin: o.author,
        labels: o.labels ?? [],
        labelNames: indexList((o.labels ?? []).map((l) => l.name)),
        assignees: [],
        htmlUrl: `https://github.com/example/synthetic/${o.type === "PULL_REQUEST" ? "pull" : "issues"}/${number}`,
        headSha: o.type === "PULL_REQUEST" ? o.headSha ?? "bbbbbbb1" : null,
        headRef: o.type === "PULL_REQUEST" ? "feature/" + number : null,
        baseRef: o.type === "PULL_REQUEST" ? "main" : null,
        checksState: o.checks ?? "SUCCESS",
        mergeable: o.mergeable ?? "MERGEABLE",
        additions: o.type === "PULL_REQUEST" ? 40 : null,
        deletions: o.type === "PULL_REQUEST" ? 12 : null,
        changedFiles: o.type === "PULL_REQUEST" ? 3 : null,
        createdAtGh: at(o.created),
        updatedAtGh: at(o.updated ?? o.created),
      },
    });
  };
  const request = (workItemId: string, ref: string, when: number, kind: "USER" | "TEAM" = "USER") => db.reviewRequest.create({ data: { workItemId, kind, reviewerRef: ref, requestedAt: at(when) } });
  const review = (workItemId: string, login: string, state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED", sha: string, when: number, id: number) =>
    db.workItemComment.create({ data: { workItemId, githubId: BigInt(id), kind: "REVIEW", authorLogin: login, reviewState: state, commitSha: sha, body: "Synthetic review", createdAtGh: at(when), updatedAtGh: at(when) } });
  const comment = (workItemId: string, login: string, body: string, when: number, id: number) =>
    db.workItemComment.create({ data: { workItemId, githubId: BigInt(id), kind: "ISSUE_COMMENT", authorLogin: login, body, createdAtGh: at(when), updatedAtGh: at(when) } });

  const L = {
    bug: { name: "bug", color: "d73a4a" },
    feat: { name: "enhancement", color: "a2eeef" },
    maint: { name: "needs-maintainer-review", color: "fbca04" },
    docs: { name: "documentation", color: "0075ca" },
  };

  // atlas-api
  const api12 = await mkItem(rApi, { type: "PULL_REQUEST", title: "Add pagination to the repositories endpoint", author: "owner-demo", labels: [L.feat, L.maint], created: -3 * D, number: 12 });
  const api14 = await mkItem(rApi, { type: "PULL_REQUEST", title: "Fix token refresh race in the session middleware", author: "alice-demo", labels: [L.bug], created: -1 * D, number: 14 });
  await request(api14.id, "owner-demo", -20 * H);
  const api15 = await mkItem(rApi, { type: "PULL_REQUEST", title: "Migrate webhook handler to idempotent processing", author: "alice-demo", labels: [L.feat], created: -2 * D, checks: "FAILURE", number: 15 });
  await request(api15.id, "owner-demo", -2 * D);
  const api16 = await mkItem(rApi, { type: "ISSUE", title: "Rate limit headers are missing from 429 responses", author: "bram-demo", labels: [L.bug], created: -6 * D, number: 16 });
  await comment(api16.id, "alice-demo", "Reproduced on staging.", -5 * D, 1);

  // atlas-web (visible to A and B; multi-project)
  const web7 = await mkItem(rWeb, { type: "PULL_REQUEST", title: "Replace the legacy table with the virtualized list", author: "bram-demo", created: -2 * D, number: 7 });
  await request(web7.id, "alice-demo", -30 * H);
  const web8 = await mkItem(rWeb, { type: "PULL_REQUEST", title: "Rework the onboarding empty states", author: "alice-demo", created: -4 * D, number: 8 });
  await request(web8.id, "bram-demo", -4 * D);
  await review(web8.id, "bram-demo", "CHANGES_REQUESTED", "bbbbbbb1", -3 * D, 11);
  const web9 = await mkItem(rWeb, { type: "PULL_REQUEST", title: "Keyboard shortcuts for the command palette", author: "bram-demo", headSha: "ccccccc2", created: -5 * D, number: 9 });
  await request(web9.id, "alice-demo", -5 * D);
  await review(web9.id, "alice-demo", "APPROVED", "aaaaaaa0", -4 * D, 12); // approved an older commit: stale
  const web10 = await mkItem(rWeb, { type: "ISSUE", title: "Focus ring is clipped inside the sidebar", author: "alice-demo", labels: [L.bug, L.docs], created: -8 * D, number: 10 });
  await mkItem(rWeb, { type: "PULL_REQUEST", title: "WIP: dark theme tokens", author: "bram-demo", draft: true, created: -1 * D, number: 11 });

  // dashboard-core (upstream) and fork
  const core101 = await mkItem(rCore, { type: "PULL_REQUEST", title: "Fix off-by-one in the pagination component", author: "upstream-dev", state: "MERGED", created: -20 * D, number: 101 });
  const core102 = await mkItem(rCore, { type: "PULL_REQUEST", title: "Add keyboard navigation to the data grid", author: "upstream-dev", state: "MERGED", created: -12 * D, number: 102 });
  const core103 = await mkItem(rCore, { type: "PULL_REQUEST", title: "Upgrade the chart library", author: "upstream-dev", created: -2 * D, number: 103 });
  await request(core103.id, "owner-demo", -2 * D); // acme-labs owner default also applies
  await mkItem(rCore, { type: "ISSUE", title: "Grid loses focus after sorting", author: "someone", labels: [L.bug], created: -9 * D, number: 104 });
  await mkItem(rCore, { type: "ISSUE", title: "Support custom row renderers", author: "someone-else", labels: [L.feat], created: -7 * D, number: 105 });
  await mkItem(rFork, { type: "ISSUE", title: "Fork: port the grid keyboard fix", author: "owner-demo", created: -3 * D, number: 1 });

  // admin-only and unassigned public repos
  await mkItem(rInternal, { type: "PULL_REQUEST", title: "HIDDEN-FROM-MEMBERS internal credential rotation", author: "owner-demo", labels: [L.maint], created: -1 * D, number: 1 });
  await mkItem(rInternal, { type: "ISSUE", title: "HIDDEN-FROM-MEMBERS payroll export is slow", author: "owner-demo", created: -2 * D, number: 2 });
  await mkItem(rSandbox, { type: "ISSUE", title: "HIDDEN-FROM-MEMBERS public but unassigned issue", author: "randomuser", created: -2 * D, number: 1 });

  // Fork mapping and comparison/evidence/triage state
  const map = await db.forkMapping.create({ data: { forkRepoId: rFork.id, upstreamRepoId: rCore.id, forkBranch: "main", upstreamBranch: "main" } });
  await db.forkComparison.create({ data: { mappingId: map.id, status: "diverged", aheadBy: 2, behindBy: 3, baseSha: "u0000003", headSha: "f0000002", comparedAt: at(-30 * 60_000) } });
  await db.upstreamPrState.createMany({
    data: [
      { mappingId: map.id, number: 101, title: core101.title, state: "merged", htmlUrl: core101.htmlUrl, mergeSha: "m101", mergedAtGh: at(-19 * D), evidence: "ANCESTRY_EXACT", evidenceNote: "The upstream merge commit is an ancestor of the fork branch." },
      { mappingId: map.id, number: 102, title: core102.title, state: "merged", htmlUrl: core102.htmlUrl, mergeSha: "m102", mergedAtGh: at(-11 * D), evidence: "NOT_DETECTED", evidenceNote: "Not an ancestor and no equivalent patch found. This does not prove the change is absent." },
      { mappingId: map.id, number: 103, title: core103.title, state: "open", htmlUrl: core103.htmlUrl, evidence: "UNKNOWN" },
    ],
  });
  await db.upstreamIssueTriage.createMany({
    data: [
      { mappingId: map.id, issueNumber: 104, title: "Grid loses focus after sorting", htmlUrl: "https://github.com/example/synthetic/issues/104", status: "RELEVANT", note: "Seen in our fork too" },
      { mappingId: map.id, issueNumber: 105, title: "Support custom row renderers", htmlUrl: "https://github.com/example/synthetic/issues/105", status: "UNTRIAGED" },
    ],
  });
  await db.branch.createMany({
    data: [
      { repositoryId: rFork.id, name: "main", sha: "f0000002", isDefault: true },
      { repositoryId: rFork.id, name: "feature/grid-keys", sha: "f0000009" },
      { repositoryId: rCore.id, name: "main", sha: "u0000003", isDefault: true },
      { repositoryId: rApi.id, name: "main", sha: "a0000001", isDefault: true },
    ],
  });

  // Planning
  const col = async (projectId: string, key: string) => (await db.planningColumn.findFirstOrThrow({ where: { projectId, key } })).id;
  const ms = await db.dashboardMilestone.create({
    data: { workspaceId: ws.id, projectId: pAtlas.id, name: "Beta launch", description: "Cross-repository milestone owned by the dashboard", ownerId: mAdmin.id, startDate: new Date("2026-10-15"), targetDate: new Date("2026-11-30") },
  });
  await db.milestoneRepoLink.create({ data: { milestoneId: ms.id, repositoryId: rApi.id, githubMilestoneNumber: 3 } });
  const card = (projectId: string, columnId: string, position: number, o: Partial<Prisma.PlanningItemUncheckedCreateInput> & { title: string }) =>
    db.planningItem.create({ data: { projectId, columnId, position, createdById: mAdmin.id, ...o } });
  const cApiPr = await card(pAtlas.id, await col(pAtlas.id, "in-review"), 1024, { title: api14.title, workItemId: api14.id, milestoneId: ms.id, priority: 2 });
  const cApiPr2 = await card(pAtlas.id, await col(pAtlas.id, "blocked"), 1024, { title: api15.title, workItemId: api15.id, milestoneId: ms.id, priority: 3 });
  const cWeb = await card(pAtlas.id, await col(pAtlas.id, "in-progress"), 1024, { title: web7.title, workItemId: web7.id, milestoneId: ms.id });
  const cDraft = await card(pAtlas.id, await col(pAtlas.id, "ready"), 1024, { title: "Write the launch checklist (internal draft)", milestoneId: ms.id, dueDate: new Date("2026-10-31"), assigneeLogin: "alice-demo" });
  await card(pAtlas.id, await col(pAtlas.id, "done"), 1024, { title: "Choose the hosting target", milestoneId: ms.id });
  await card(pAtlas.id, await col(pAtlas.id, "backlog"), 1024, { title: web10.title, workItemId: web10.id });
  await card(pDash.id, await col(pDash.id, "backlog"), 1024, { title: "Triage upstream grid issues", dueDate: new Date("2026-10-20") });
  await card(pDash.id, await col(pDash.id, "ready"), 1024, { title: "HIDDEN-FROM-MEMBERS rotate internal credentials", workItemId: (await db.workItem.findFirstOrThrow({ where: { repositoryId: rInternal.id, number: 1 } })).id });
  await db.planningLink.create({ data: { fromId: cApiPr2.id, toId: cApiPr.id } });
  await db.planningLink.create({ data: { fromId: cDraft.id, toId: cWeb.id } });

  // A manual waiting record on an issue (non-PR) with an external reviewer
  await db.waitingRecord.create({
    data: { workspaceId: ws.id, workItemId: api16.id, source: "MANUAL", reviewerKind: "USER", reviewerRef: "maintainer-demo", reason: "Needs the maintainer's decision on the response format", startedAt: at(-2 * D) },
  });

  // Local connector: member A has a paired device with a snapshot
  const dev = await db.device.create({ data: { userId: uA.id, name: "This computer (synthetic)", lastSeenAt: at(-2 * 60_000) } });
  await db.deviceRepoMapping.create({ data: { deviceId: dev.id, repositoryId: rApi.id } });
  await db.worktreeSnapshot.create({
    data: {
      deviceId: dev.id,
      repositoryId: rApi.id,
      capturedAt: at(-2 * 60_000),
      data: {
        capturedAt: at(-2 * 60_000).toISOString(),
        worktrees: [
          { path: "C:\\work\\atlas-api", branch: "main", head: "a0000001", detached: false, locked: false, prunable: false, dirty: { staged: 0, unstaged: 2, untracked: 1, conflicted: 0 }, tracking: { upstream: "origin/main", ahead: 0, behind: 2 } },
          { path: "C:\\work\\atlas-api-fix", branch: "fix/token-refresh", head: "a0000044", detached: false, locked: false, prunable: false, dirty: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 }, tracking: { upstream: "origin/fix/token-refresh", ahead: 3, behind: 0 } },
          { path: "C:\\work\\atlas-api-detached", branch: null, head: "a0000077", detached: true, locked: true, prunable: false },
        ],
      },
    },
  });

  return {
    ws, users: { admin: uAdmin, a: uA, b: uB, ext: uExt }, members: { admin: mAdmin, a: mA, b: mB },
    repos: { api: rApi, web: rWeb, core: rCore, fork: rFork, internal: rInternal, sandbox: rSandbox },
    projects: { atlas: pAtlas, dash: pDash }, items: { api12, api14, api15, api16, web7, web8, web9, web10, core101, core102, core103 },
    milestone: ms, cards: { cApiPr, cApiPr2, cWeb, cDraft }, device: dev, map,
  };
}
