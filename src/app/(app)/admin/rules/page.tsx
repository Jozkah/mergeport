import { Select } from "@/components/ui/Select";
import { byOwnerFirst, byPersonalFirst } from "@/lib/domain/ordering";
import { db } from "@/lib/db";
import { requireAdminViewer } from "@/lib/authz-page";
import type { Reviewer } from "@/lib/domain/review";
import { ActionForm } from "@/components/forms/ActionForm";
import { Banner, EmptyState, Mono, PageHeader, Panel, SimplePill } from "@/components/ui/primitives";
import { Route } from "@/components/ui/icons";
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
    db.project.findMany({ where: { workspaceId: viewer.workspaceId }, orderBy: { name: "asc" } }),
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

  return (
    <>
      <PageHeader title="Who reviews what" subtitle="Say who must review which work. Precedence: repository override, then project rule, then owner default, then workspace default. Labels route attention; they never grant permission." />
      {conflicts.length > 0 && (
        <div className="mb-4"><Banner tone="warn" title="Rule conflicts">{conflicts.map((c) => c.fullName).join(", ")} {conflicts.length === 1 ? "is" : "are"} in several projects with different review rules. Add a repository override, or reviewers will see a conflict instead of a guess.</Banner></div>
      )}
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex min-w-0 flex-col gap-5">
        <Panel title="Rules" icon={Route} id="rules">
          {rules.length === 0 ? <EmptyState icon={Route} title="No routing rules">Without rules, review waiting comes only from GitHub review requests.</EmptyState> : (
            <ul>
              {rules.map((r) => (
                <li key={r.id} className="flex flex-wrap items-start justify-between gap-3 border-b border-line p-4 last:border-b-0">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2"><SimplePill tone="needs">{SCOPE[r.scope]}</SimplePill><span className="text-[13px] font-medium">{r.repository?.fullName ?? r.project?.name ?? r.ownerLogin ?? "Whole workspace"}</span>{!r.enabled && <SimplePill tone="unknown">Disabled</SimplePill>}</div>
                    <p className="mt-1 text-[13px]">{r.reason}</p>
                    <p className="mt-1 text-[12.5px] text-ink-3">{r.semantics === "ALL" ? "All of" : "Any of"}: {(r.reviewers as unknown as Reviewer[]).map((x) => `${x.ref}${x.kind === "TEAM" ? " (team)" : x.kind === "EXTERNAL_ROLE" ? " (external role)" : ""}`).join(", ")}{asStrings(r.labels).length ? <> · when labelled <Mono>{asStrings(r.labels).join(", ")}</Mono></> : " · any labels"}</p>
                  </div>
                  <ActionForm action={deleteRuleAction} submitLabel="Delete" submitClassName="btn btn-danger"><input type="hidden" name="id" value={r.id} /></ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Panel>
          <div>
      <h2 className="mb-1 mt-8 text-[15px] font-medium">Waiting rules</h2>
      <p className="mb-3 max-w-[760px] text-[13px] text-ink-3">Review rules say who must approve. A waiting rule says who the work is <em>waiting on until it is merged or closed</em>, whatever its review state and even when that person opened it. Everything that matches appears under &ldquo;Waiting on others&rdquo; (or team review if they are dashboard members). Nothing is built in: every rule below is yours.</p>
          </div>
        <Panel title={`Waiting rules (${waiting.length})`} icon={Clock} id="waiting">
          {waiting.length === 0 ? <EmptyState icon={Clock} title="No waiting rules">For example: every open pull request in a repository whose owner merges everything waits on that owner.</EmptyState> : (
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
                    <ActionForm action={deleteWaitingRuleAction} submitLabel="Delete" submitClassName="btn btn-danger"><input type="hidden" name="id" value={r.id} /></ActionForm>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
        </div>
        <div className="flex flex-col gap-5">
        <Panel title="Add a rule" icon={Route} id="add">
          <ActionForm action={saveRuleAction} submitLabel="Save rule" className="p-4">
            <div className="flex flex-col gap-3">
              <div><label className="label" htmlFor="r-scope">Applies to</label><Select id="r-scope" name="scope" className="select"><option value="REPOSITORY">One repository</option><option value="PROJECT">A project</option><option value="OWNER">A GitHub owner</option><option value="WORKSPACE">The whole workspace</option></Select></div>
              <div><label className="label" htmlFor="r-repo">Repository (for a repository rule)</label><Select id="r-repo" name="repositoryId" className="select"><option value="">-</option>{repos.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}</Select></div>
              <div><label className="label" htmlFor="r-proj">Project (for a project rule)</label><Select id="r-proj" name="projectId" className="select"><option value="">-</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
              <div><label className="label" htmlFor="r-owner">GitHub owner (for an owner rule)</label><input id="r-owner" name="ownerLogin" className="input" /></div>
              <div><label className="label" htmlFor="r-labels">Only when labelled (comma separated, empty = always)</label><input id="r-labels" name="labels" className="input" placeholder="needs-maintainer-review" /></div>
              <div><label className="label" htmlFor="r-rev">Reviewers</label><input id="r-rev" name="reviewers" className="input" required placeholder="user1, org/team-slug" /><p className="mt-1 text-[12px] text-ink-3">GitHub usernames, or <Mono>org/team</Mono> slugs. Anyone who is not a dashboard member is treated as external.</p></div>
              <div className="grid grid-cols-2 gap-3"><div><label className="label" htmlFor="r-kind">Reviewer type</label><Select id="r-kind" name="kind" className="select"><option value="">GitHub user / team</option><option value="EXTERNAL_ROLE">External role (manual decision)</option></Select></div><div><label className="label" htmlFor="r-sem">Approvals needed</label><Select id="r-sem" name="semantics" className="select"><option value="ANY">Any one</option><option value="ALL">All</option></Select></div></div>
              <div><label className="label" htmlFor="r-reason">Why (shown to everyone)</label><input id="r-reason" name="reason" className="input" required /></div>
            </div>
          </ActionForm>
        </Panel>
        <Panel title="Add a waiting rule" icon={Clock} id="add-waiting">
          <ActionForm action={saveWaitingRuleAction} submitLabel="Save waiting rule" className="p-4">
            <div className="flex flex-col gap-3">
              <div><label className="label" htmlFor="w-scope">Applies to</label><Select id="w-scope" name="scope" className="select"><option value="OWNER">A GitHub owner (all their repositories)</option><option value="REPOSITORY">One repository</option><option value="PROJECT">A project</option><option value="WORKSPACE">The whole workspace</option></Select></div>
              <div><label className="label" htmlFor="w-owner">GitHub owner (for an owner rule)</label><input id="w-owner" name="ownerLogin" className="input" placeholder="login or organization" /></div>
              <div><label className="label" htmlFor="w-repo">Repository (for a repository rule)</label><Select id="w-repo" name="repositoryId" className="select"><option value="">-</option>{repos.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}</Select></div>
              <div><label className="label" htmlFor="w-proj">Project (for a project rule)</label><Select id="w-proj" name="projectId" className="select"><option value="">-</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
              <div><label className="label" htmlFor="w-on">Waits on</label><input id="w-on" name="waitingOn" className="input" required placeholder="user1, org/team-slug" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div><label className="label" htmlFor="w-type">Items</label><Select id="w-type" name="itemType" className="select"><option value="PULL_REQUEST">Pull requests</option><option value="ISSUE">Issues</option><option value="ANY">Both</option></Select></div>
                <div><label className="label" htmlFor="w-kind">Who</label><Select id="w-kind" name="kind" className="select"><option value="">GitHub user / team</option><option value="EXTERNAL_ROLE">External role</option></Select></div>
              </div>
              <div><label className="label" htmlFor="w-stage">Stage</label><Select id="w-stage" name="stage" className="select"><option value="">Infer from who it waits on</option>{STAGES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</Select></div>
              <div><label className="label" htmlFor="w-authors">Only when opened by (empty = anyone)</label><input id="w-authors" name="authors" className="input" placeholder="login1, login2" /></div>
              <div><label className="label" htmlFor="w-labels">Only when labelled (empty = any)</label><input id="w-labels" name="labels" className="input" /></div>
              <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="includeDrafts" /> Include draft pull requests</label>
              <div><label className="label" htmlFor="w-reason">Why (shown to everyone)</label><input id="w-reason" name="reason" className="input" required placeholder="e.g. the owner merges everything here" /></div>
            </div>
          </ActionForm>
        </Panel>
        </div>
      </div>
    </>
  );
}
