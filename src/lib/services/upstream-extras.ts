import type { Db } from "@/lib/db";
import { repoWhere, requireRepo, type Viewer } from "@/lib/authz/viewer";
import { cleanCriteria, hasCriteria, matchAll, type Criteria, type Match, type Subscription } from "@/lib/domain/relevance";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { checkBackport, type BackportCheck } from "@/lib/local/backport-check";
import { validateRoot } from "@/lib/local/git";
import { audit } from "./audit";
import { addDependency } from "./planning";
import { createTask } from "./tasks";

/** Upstream relevance subscriptions, explicit backport records with verified local evidence, and the adoption planner. */

async function mappingFor(db: Db, v: Viewer, mappingId: string) {
  const m = await db.forkMapping.findFirst({ where: { id: mappingId, fork: repoWhere(v), upstream: repoWhere(v) }, include: { fork: { include: { owner: true } }, upstream: { include: { owner: true } } } });
  if (!m) throw new NotFoundError();
  return m;
}

// ---------- subscriptions ----------

export type SubscriptionRow = Subscription & { mappingName: string | null };

export async function listSubscriptions(db: Db, v: Viewer): Promise<SubscriptionRow[]> {
  const rows = await db.upstreamSubscription.findMany({ where: { workspaceId: v.workspaceId }, orderBy: { name: "asc" } });
  const maps = await db.forkMapping.findMany({ where: { id: { in: rows.flatMap((r) => (r.mappingId ? [r.mappingId] : [])) } }, include: { upstream: true } });
  const name = new Map(maps.map((m) => [m.id, m.upstream.fullName]));
  return rows.map((r) => ({ id: r.id, name: r.name, criteria: cleanCriteria(r.criteria), muted: r.muted, mappingId: r.mappingId, mappingName: r.mappingId ? (name.get(r.mappingId) ?? null) : null }));
}

export async function createSubscription(db: Db, v: Viewer, input: { name: string; mappingId?: string | null; criteria: unknown }) {
  if (!v.isAdmin) throw new ValidationError("Only an administrator can change shared subscriptions");
  const name = input.name.trim();
  if (!name) throw new ValidationError("Name the subscription");
  const criteria = cleanCriteria(input.criteria);
  if (!hasCriteria(criteria)) throw new ValidationError("Add at least one thing to watch for: a label, a path, a milestone, an author or a word in the title");
  if (input.mappingId) await mappingFor(db, v, input.mappingId);
  const s = await db.upstreamSubscription.create({ data: { workspaceId: v.workspaceId, mappingId: input.mappingId || null, name: name.slice(0, 80), criteria: criteria as never } });
  await audit(db, v, "upstream.subscribe", { type: "UpstreamSubscription", id: s.id });
  return s;
}

export async function setSubscriptionMuted(db: Db, v: Viewer, id: string, muted: boolean) {
  if (!v.isAdmin) throw new ValidationError("Only an administrator can change shared subscriptions");
  const s = await db.upstreamSubscription.findFirst({ where: { id, workspaceId: v.workspaceId } });
  if (!s) throw new NotFoundError();
  await db.upstreamSubscription.update({ where: { id }, data: { muted } });
}

export async function deleteSubscription(db: Db, v: Viewer, id: string) {
  if (!v.isAdmin) throw new ValidationError("Only an administrator can change shared subscriptions");
  await db.upstreamSubscription.deleteMany({ where: { id, workspaceId: v.workspaceId } });
}

/** Which upstream issues and pull requests of a mapping the subscriptions select, with the reason for each. */
export async function upstreamRelevance(db: Db, v: Viewer, mappingId: string): Promise<{ issues: Record<number, Match[]>; prs: Record<number, Match[]> }> {
  const m = await mappingFor(db, v, mappingId);
  const subs = (await listSubscriptions(db, v)).filter((s) => !s.muted);
  const out = { issues: {} as Record<number, Match[]>, prs: {} as Record<number, Match[]> };
  if (subs.length === 0) return out;
  const triage = await db.upstreamIssueTriage.findMany({ where: { mappingId }, select: { issueNumber: true } });
  const prs = await db.upstreamPrState.findMany({ where: { mappingId }, select: { number: true } });
  const items = await db.workItem.findMany({ where: { repositoryId: m.upstreamRepoId, number: { in: [...triage.map((t) => t.issueNumber), ...prs.map((p) => p.number)] } } });
  const byNumber = new Map(items.map((i) => [i.number, i]));
  const filesOf = async (i: (typeof items)[number]): Promise<string[] | null> => {
    if (i.type !== "PULL_REQUEST" || !i.headSha) return null;
    const hit = await db.gitCache.findUnique({ where: { key: `prfiles:2:${i.repositoryId}:${i.number}:${i.baseRef ?? "-"}:${i.headSha}` } });
    const files = (hit?.payload as { files?: { filename: string }[] } | undefined)?.files;
    return files ? files.map((f) => f.filename) : null;
  };
  const facts = async (n: number) => {
    const i = byNumber.get(n);
    if (!i) return null;
    return { labels: ((i.labels as unknown as { name: string }[]) ?? []).map((l) => l.name), author: i.authorLogin, milestone: i.milestoneTitle, title: i.title, files: await filesOf(i) };
  };
  for (const t of triage) {
    const f = await facts(t.issueNumber);
    const hit = f ? matchAll(subs, f, mappingId) : [];
    if (hit.length) out.issues[t.issueNumber] = hit;
  }
  for (const p of prs) {
    const f = await facts(p.number);
    const hit = f ? matchAll(subs, f, mappingId) : [];
    if (hit.length) out.prs[p.number] = hit;
  }
  return out;
}

// ---------- backport records ----------

export type BackportView = { id: string; upstreamNumber: number; targetBranch: string; state: string; evidence: string; localSha: string | null; note: string | null; byLogin: string | null };

export async function listBackports(db: Db, v: Viewer, mappingId: string): Promise<BackportView[]> {
  await mappingFor(db, v, mappingId);
  const rows = await db.backportRecord.findMany({ where: { mappingId }, orderBy: [{ upstreamNumber: "asc" }, { targetBranch: "asc" }] });
  return rows.map((r) => ({ id: r.id, upstreamNumber: r.upstreamNumber, targetBranch: r.targetBranch, state: r.state, evidence: r.evidence, localSha: r.localSha, note: r.note, byLogin: r.byLogin }));
}

const branchOk = (b: string) => /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,199}$/.test(b) && !b.includes("..");

/** A person's own record. Evidence can only be "manual" (their decision) or "unknown" here; verified evidence comes only from checkBackportLocally. */
export async function recordBackport(db: Db, v: Viewer, input: { mappingId: string; upstreamNumber: number; targetBranch: string; state: "planned" | "done"; evidence?: "manual" | "unknown"; note?: string }) {
  await mappingFor(db, v, input.mappingId);
  if (!Number.isInteger(input.upstreamNumber) || input.upstreamNumber < 1) throw new ValidationError("Enter the upstream number");
  if (!branchOk(input.targetBranch)) throw new ValidationError("Enter a branch name");
  const data = { state: input.state === "done" ? "done" : "planned", evidence: input.state === "done" ? "manual" : (input.evidence ?? "unknown"), note: input.note?.trim().slice(0, 300) || null, byLogin: v.login };
  const key = { mappingId_upstreamNumber_targetBranch: { mappingId: input.mappingId, upstreamNumber: input.upstreamNumber, targetBranch: input.targetBranch } };
  const existing = await db.backportRecord.findUnique({ where: key });
  // Marking done by hand never overwrites verified evidence: ancestry and patch equivalence stay what Git showed.
  const keepEvidence = existing && (existing.evidence === "ancestry" || existing.evidence === "patch-equivalent");
  const r = await db.backportRecord.upsert({ where: key, create: { mappingId: input.mappingId, upstreamNumber: input.upstreamNumber, targetBranch: input.targetBranch, ...data }, update: { ...data, ...(keepEvidence ? { evidence: existing!.evidence } : {}) } });
  await audit(db, v, "backport.record", { type: "BackportRecord", id: r.id });
  return r;
}

export async function deleteBackport(db: Db, v: Viewer, id: string) {
  const r = await db.backportRecord.findUnique({ where: { id } });
  if (!r) throw new NotFoundError();
  await mappingFor(db, v, r.mappingId);
  await db.backportRecord.delete({ where: { id } });
}

/**
 * Looks in the person's own local clone (the one mapped on this computer) for Git evidence that an upstream pull request's change is
 * on the target branch, and records the result with its kind. Possible equivalence never marks the work done by itself.
 */
export async function checkBackportLocally(db: Db, v: Viewer, input: { mappingId: string; upstreamNumber: number; targetBranch: string }): Promise<BackportCheck & { recorded: boolean }> {
  const m = await mappingFor(db, v, input.mappingId);
  await requireRepo(db, v, m.forkRepoId, "view");
  const pr = await db.upstreamPrState.findUnique({ where: { mappingId_number: { mappingId: input.mappingId, number: input.upstreamNumber } } });
  if (!pr?.mergeSha) return { result: "not-checked", reason: "This pull request has no merge commit known yet (it may not be merged).", recorded: false };
  const dev = await db.device.findFirst({ where: { userId: v.userId } });
  const map = dev ? await db.deviceRepoMapping.findFirst({ where: { deviceId: dev.id, repositoryId: m.forkRepoId } }) : null;
  if (!map?.rootPath) return { result: "not-checked", reason: "Map this repository to a folder on this computer first (Branches page).", recorded: false };
  let root: string;
  try {
    root = await validateRoot(map.rootPath);
  } catch {
    return { result: "not-checked", reason: "The mapped folder is no longer a Git repository.", recorded: false };
  }
  const c = await checkBackport(root, pr.mergeSha, input.targetBranch);
  if (c.result === "not-checked") return { ...c, recorded: false };
  const evidence = c.result === "ancestor" ? "ancestry" : c.result === "patch-equivalent" ? "patch-equivalent" : "unknown";
  const key = { mappingId_upstreamNumber_targetBranch: { mappingId: input.mappingId, upstreamNumber: input.upstreamNumber, targetBranch: input.targetBranch } };
  const existing = await db.backportRecord.findUnique({ where: key });
  const state = c.result === "ancestor" ? "done" : (existing?.state ?? "planned");
  await db.backportRecord.upsert({ where: key, create: { ...key.mappingId_upstreamNumber_targetBranch, state, evidence, localSha: c.localSha ?? null, note: c.reason.slice(0, 300), byLogin: v.login }, update: { state, evidence: existing?.evidence === "manual" && c.result === "not-found" ? "manual" : evidence, localSha: c.localSha ?? null, note: c.reason.slice(0, 300) } });
  return { ...c, recorded: true };
}

// ---------- adoption planner ----------

export type AdoptionItem = { kind: "pr" | "issue"; number: number };
export type AdoptionPreview = { milestoneName: string; targetBranch: string; tasks: { title: string; description: string; labels: string[] }[]; finalStep: { title: string; checklist: string[] }; notes: string[] };

async function adoptionTitles(db: Db, v: Viewer, mappingId: string, items: AdoptionItem[]) {
  const m = await mappingFor(db, v, mappingId);
  const rows = [];
  for (const it of items) {
    const row = it.kind === "pr" ? await db.upstreamPrState.findUnique({ where: { mappingId_number: { mappingId, number: it.number } } }) : await db.upstreamIssueTriage.findUnique({ where: { mappingId_issueNumber: { mappingId, issueNumber: it.number } } });
    if (!row) throw new ValidationError(`Upstream #${it.number} is not tracked for this fork`);
    rows.push({ ...it, title: row.title, url: row.htmlUrl });
  }
  return { m, rows };
}

/** What the plan would create, before anything is written: a milestone, one task per upstream item, and a final sync step. */
export async function previewAdoption(db: Db, v: Viewer, input: { mappingId: string; items: AdoptionItem[]; targetBranch: string; name?: string }): Promise<AdoptionPreview> {
  if (input.items.length === 0) throw new ValidationError("Choose at least one upstream change");
  if (input.items.length > 30) throw new ValidationError("Plan at most 30 changes at a time");
  if (!branchOk(input.targetBranch)) throw new ValidationError("Enter the branch to bring them to");
  const { m, rows } = await adoptionTitles(db, v, input.mappingId, input.items);
  const name = (input.name?.trim() || `Adopt upstream changes into ${input.targetBranch}`).slice(0, 80);
  return {
    milestoneName: name,
    targetBranch: input.targetBranch,
    tasks: rows.map((r) => ({ title: `Adopt ${m.upstream.fullName}#${r.number}: ${r.title}`.slice(0, 200), description: `Bring ${r.url} to ${input.targetBranch} of ${m.fork.fullName}.`, labels: ["upstream", "adopt"] })),
    finalStep: { title: `Sync ${m.fork.fullName} with ${m.upstream.fullName}`, checklist: ["Review the adopted changes together", `Use the fork sync action for ${input.targetBranch} (it asks for confirmation)`, "Verify the build and tests", "Close the milestone"] },
    notes: ["Nothing is changed on GitHub or in any repository. Tasks and the milestone live in the dashboard.", "The sync step comes last and waits for every adopted change."],
  };
}

/** Creates the plan: a maintenance milestone, one task per change (with a planned backport record for pull requests), and a final sync task they all block. */
export async function createAdoption(db: Db, v: Viewer, input: { mappingId: string; items: AdoptionItem[]; targetBranch: string; projectId: string; name?: string; assigneeLogin?: string | null }) {
  if (!v.isAdmin) throw new ValidationError("Only an administrator can create a milestone");
  const preview = await previewAdoption(db, v, input);
  const { m, rows } = await adoptionTitles(db, v, input.mappingId, input.items);
  const ms = await db.dashboardMilestone.create({ data: { workspaceId: v.workspaceId, projectId: input.projectId, name: preview.milestoneName, description: `Plan to bring upstream changes from ${m.upstream.fullName} to ${input.targetBranch}.`, ownerId: v.memberId } });
  const tasks: string[] = [];
  for (const [i, t] of preview.tasks.entries()) {
    const task = await createTask(db, v, { projectId: input.projectId, title: t.title, description: t.description, labels: t.labels, assigneeLogin: input.assigneeLogin, milestoneId: ms.id });
    tasks.push(task.id);
    if (rows[i].kind === "pr") await recordBackport(db, v, { mappingId: input.mappingId, upstreamNumber: rows[i].number, targetBranch: input.targetBranch, state: "planned", note: "Planned in an adoption milestone" });
  }
  const final = await createTask(db, v, { projectId: input.projectId, title: preview.finalStep.title, description: preview.finalStep.checklist.map((c) => `- ${c}`).join(String.fromCharCode(10)), labels: ["upstream", "sync"], milestoneId: ms.id });
  for (const id of tasks) await addDependency(db, v, id, final.id, "blocks");
  await audit(db, v, "upstream.adoption", { type: "DashboardMilestone", id: ms.id }, { changes: tasks.length });
  return { milestoneId: ms.id, taskIds: tasks, finalTaskId: final.id };
}

export type { Criteria };
