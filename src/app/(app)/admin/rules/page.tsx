import { Select } from "@/components/ui/Select";
import { byOwnerFirst, byPersonalFirst } from "@/lib/domain/ordering";
import { db } from "@/lib/db";
import { requireAdminViewer } from "@/lib/authz-page";
import { projectWhere } from "@/lib/authz/viewer";
import type { Reviewer } from "@/lib/domain/review";
import { ActionForm } from "@/components/forms/ActionForm";
import { ScopeTarget } from "@/components/forms/ScopeTarget";
import { Sheet } from "@/components/ui/dialog";
import { Banner, EmptyState, Mono, PageHeader, Panel, SimplePill } from "@/components/ui/primitives";
import { Plus, Route } from "@/components/ui/icons";
import { asStrings } from "@/lib/services/queries";
import { deleteRuleAction, deleteWaitingRuleAction, saveRuleAction, saveWaitingRuleAction, toggleWaitingRuleAction } from "@/app/actions";
import { Clock } from "@/components/ui/icons";
import { STAGES, stageLabel } from "@/lib/domain/stages";

export const metadata = { title: "Who reviews what" };

export default async function Rules() {
  const { viewer } = await requireAdminViewer();
  const waiting = await db.waitingRule.findMany({ where: { workspaceId: viewer.workspaceId }, include: { repository: { select: { fullName: true } }, project: { select: { name: true } } }, orderBy: { createdAt: "asc" } });
  const [rules, reposRaw, projectsRaw] = await Promise.all([
    db.reviewRule.findMany({ where: { workspaceId: viewer.workspaceId }, include: { repository: { select: { fullName: true } }, project: { select: { name: true } } }, orderBy: [{ scope: "asc" }, { createdAt: "asc" }] }),
    db.repository.findMany({ where: { workspaceId: viewer.workspaceId, trackingStatus: { not: "REMOVED" } }, select: { id: true, fullName: true, projects: { select: { projectId: true } } }, orderBy: { fullName: "asc" } }),
    db.project.findMany({ where: projectWhere(viewer), orderBy: { name: "asc" } }),
  ]);

  const repos = [...reposRaw].sort((x, y) => byOwnerFirst(viewer.login)(x.fullName, y.fullName));
  const projects = [...projectsRaw].sort((x, y) => byPersonalFirst(viewer.login)(x.name, y.name));

  // Configuration conflicts: a repository in several projects with differing project rules and no repository override.
  const conflicts = repos.filter((r) => {
    if (rules.some((x) => x.enabled && x.scope === "REPOSITORY" && x.repositoryId === r.id)) return false;
    const pr = new Set(rules.filter((x) => x.enabled && x.scope === "PROJECT" && x.projectId && r.projects.some((p) => p.projectId === x.projectId)).map((x) => x.projectId));
    return pr.size > 1;
  });

  const SCOPE = { REPOSITORY: "Repository override", PROJECT: "Project rule", OWNER: "Owner default", WORKSPACE: "Workspace default" } as const;

  const addRule = (
    <Sheet title="Add a rule" trigger={<button className="btn btn-primary"><Plus size={14} aria-hidden /> Add rule</button>}>
      <ActionForm action={saveRuleAction} submitLabel="Save rule" closeOnSuccess>
        <div className="flex flex-col gap-3">
          <ScopeTarget prefix="r" defaultScope="REPOSITORY" repos={repos} projects={projects} scopes={[{ value: "REPOSITORY", label: "One repository" }, { value: "PROJECT", label: "A project" }, { value: "OWNER", label: "A GitHub owner" }, { value: "WORKSPACE", label: "The whole workspace" }]} />
          <div><label className="label" htmlFor="r-labels">Only when labelled (comma separated, empty = always)</label><input id="r-labels" name="labels" className="input" placeholder="needs-maintainer-review" /></div>
          <div><label className="label" htmlFor="r-rev">Reviewers</label><input id="r-rev" name="reviewers" className="input" required placeholder="user1, org/team-slug" /><p className="mt-1 text-[12px] text-ink-3">GitHub usernames, or <Mono>org/team</Mono> slugs. Anyone who is not a dashboard member is treated as external.</p></div>
          <div><label className="label" htmlFor="r-reason">Why (shown to everyone)</label><input id="r-reason" name="reason" className="input" required /></div>
          <details className="rounded-[8px] border border-line p-3">
            <summary className="cursor-pointer list-none text-[13px] font-medium [&::-webkit-details-marker]:hidden">Advanced</summary>
            <div className="mt-3 grid grid-cols-2 gap-3"><div><label className="label" htmlFor="r-kind">Reviewer type</label><Select id="r-kind" name="kind" className="select"><option value="">GitHub user / team</option><option value="EXTERNAL_ROLE">External role (manual decision)</option></Select></div><div><label className="label" htmlFor="r-sem">Approvals needed</label><Select id="r-sem" name="semantics" className="select"><option value="ANY">Any one</option><option value="ALL">All</option></Select></div></div>
          </details>
        </div>
      </ActionForm>
    </Sheet>
  );

  const addWaiting = (
    <Sheet title="Add a waiting rule" trigger={<button className="btn btn-primary"><Plus size={14} aria-hidden /> Add waiting rule</button>}>
      <ActionForm action={saveWaitingRuleAction} submitLabel="Save waiting rule" closeOnSuccess>
        <div className="flex flex-col gap-3">
          <ScopeTarget prefix="w" defaultScope="OWNER" repos={repos} projects={projects} ownerPlaceholder="login or organization" scopes={[{ value: "OWNER", label: "A GitHub owner (all their repositories)" }, { value: "REPOSITORY", label: "One repository" }, { value: "PROJECT", label: "A project" }, { value: "WORKSPACE", label: "The whole workspace" }]} />
          <div><label className="label" htmlFor="w-on">Waits on</label><input id="w-on" name="waitingOn" className="input" required placeholder="user1, org/team-slug" /></div>
          <div><label className="label" htmlFor="w-type">Items</label><Select id="w-type" name="itemType" className="select"><option value="PULL_REQUEST">Pull requests</option><option value="ISSUE">Issues</option><option value="ANY">Both</option></Select></div>
          <div><label className="label" htmlFor="w-labels">Only when labelled (empty = any)</label><input id="w-labels" name="labels" className="input" /></div>
          <div><label className="label" htmlFor="w-reason">Why (shown to everyone)</label><input id="w-reason" name="reason" className="input" required placeholder="e.g. the owner merges everything here" /></div>
          <details className="rounded-[8px] border border-line p-3">
            <summary className="cursor-pointer list-none text-[13px] font-medium [&::-webkit-details-marker]:hidden">Advanced</summary>
            <div className="mt-3 flex flex-col gap-3">
              <div><label className="label" htmlFor="w-kind">Who</label><Select id="w-kind" name="kind" className="select"><option value="">GitHub user / team</option><option value="EXTERNAL_ROLE">External role</option></Select></div>
              <div><label className="label" htmlFor="w-stage">Stage</label><Select id="w-stage" name="stage" className="select"><option value="">Infer from who it waits on</option>{STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</Select></div>
              <div><label className="label" htmlFor="w-authors">Only when opened by (empty = anyone)</label><input id="w-authors" name="authors" className="input" placeholder="login1, login2" /></div>
              <label className="flex min-h-10 items-center gap-2 text-[13px]"><input type="checkbox" name="includeDrafts" /> Include draft pull requests</label>
            </div>
          </details>
        </div>
      </ActionForm>
    </Sheet>
  );

  return (
    <>
      <PageHeader title="Who reviews what" subtitle="Who must review which work." />
      {conflicts.length > 0 && (
        <div className="mb-4"><Banner tone="warn" title="Rule conflicts">{conflicts.map((c) => c.fullName).join(", ")} {conflicts.length === 1 ? "is" : "are"} in several projects with different review rules. Add a repository override, or reviewers will see a conflict instead of a guess.</Banner></div>
      )}
      <div className="flex min-w-0 flex-col gap-5">
        <Panel title="Rules" icon={Route} id="rules" actions={addRule}>
          <details className="border-b border-line px-4 py-2.5 text-[12.5px] text-ink-3">
            <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">How rules are chosen</summary>
            <p className="mt-1.5 max-w-[70ch]">Precedence: repository override, then project rule, then owner default, then workspace default. Labels route attention; they never grant permission.</p>
          </details>
          {rules.length === 0 ? <EmptyState icon={Route} title="No routing rules">Without rules, review waiting comes only from GitHub review requests.</EmptyState> : (
            <ul>
              {rules.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4 last:border-b-0">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><SimplePill tone="needs">{SCOPE[r.scope]}</SimplePill><span className="text-[13px] font-medium">{r.repository?.fullName ?? r.project?.name ?? r.ownerLogin ?? "Whole workspace"}</span>{!r.enabled && <SimplePill tone="unknown">Disabled</SimplePill>}</div>
                    <p className="mt-1 text-[13px]">{r.reason}</p>
                    <p className="mt-1 text-[12.5px] text-ink-3">{r.semantics === "ALL" ? "All of" : "Any of"}: {(r.reviewers as unknown as Reviewer[]).map((x) => `${x.ref}${x.kind === "TEAM" ? " (team)" : x.kind === "EXTERNAL_ROLE" ? " (external role)" : ""}`).join(", ")}{asStrings(r.labels).length ? <> · when labelled <Mono>{asStrings(r.labels).join(", ")}</Mono></> : " · any labels"}</p>
                  </div>
                  <ActionForm action={deleteRuleAction} submitLabel="Delete" submitClassName="btn text-blocked"><input type="hidden" name="id" value={r.id} /></ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title={`Waiting rules (${waiting.length})`} icon={Clock} id="waiting" actions={addWaiting}>
          <p className="border-b border-line px-4 py-2.5 text-[12.5px] text-ink-3">Who work waits on until merged or closed.</p>
          {waiting.length === 0 ? <EmptyState icon={Clock} title="No waiting rules">Example: a repository whose owner merges everything waits on that owner.</EmptyState> : (
            <ul>
              {waiting.map((r) => (
                <li key={r.id} className={`flex flex-wrap items-start justify-between gap-3 border-b border-line p-4 last:border-b-0 ${r.enabled ? "" : "opacity-60"}`}>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><SimplePill tone={r.enabled ? "needs" : "unknown"}>{SCOPE[r.scope]}</SimplePill><span className="text-[13px] font-medium">{r.repository?.fullName ?? r.project?.name ?? r.ownerLogin ?? "Everything"}</span>{!r.enabled && <span className="text-[12px] text-ink-3">off</span>}</div>
                    <p className="mt-1 text-[13px]">{r.reason}</p>
                    <p className="mt-1 text-[12.5px] text-ink-3">{r.stage ? `${stageLabel(r.stage)} · ` : ""}Waits on {(r.waitingOn as unknown as Reviewer[]).map((x) => x.ref).join(", ")} · {r.itemType === "ANY" ? "pull requests and issues" : r.itemType === "ISSUE" ? "issues" : "pull requests"}{asStrings(r.authors).length ? ` opened by ${asStrings(r.authors).join(", ")}` : " opened by anyone"}{asStrings(r.labels).length ? ` · labelled ${asStrings(r.labels).join(", ")}` : ""}{r.includeDrafts ? " · drafts included" : ""}</p>
                  </div>
                  <div className="flex gap-2">
                    <ActionForm action={toggleWaitingRuleAction} submitLabel={r.enabled ? "Turn off" : "Turn on"} submitClassName="btn" resetOnSuccess={false}><input type="hidden" name="id" value={r.id} /></ActionForm>
                    <ActionForm action={deleteWaitingRuleAction} submitLabel="Delete" submitClassName="btn text-blocked"><input type="hidden" name="id" value={r.id} /></ActionForm>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
