import Link from "next/link";
import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { adoptionAction, backportAction, subscriptionAction } from "@/app/phase4-actions";
import { listBackports, listSubscriptions, previewAdoption, upstreamRelevance } from "@/lib/services/upstream-extras";
import { listProjects } from "@/lib/services/queries";
import { ActionForm } from "@/components/forms/ActionForm";
import { Panel } from "@/components/ui/primitives";
import { Select } from "@/components/ui/Select";
import { Eye, Flag, GitFork } from "@/components/ui/icons";

const EVIDENCE: Record<string, string> = {
  ancestry: "Present: the upstream commit is part of the branch (Git ancestry)",
  "patch-equivalent": "Possible equivalent: a commit makes the same change (not proof)",
  manual: "Addressed: your team's decision (not Git evidence)",
  unknown: "Not checked",
};

/** Saved interests in upstream changes. Any criterion that hits selects an item and the reason is shown with it. */
export async function SubscriptionsPanel({ db, viewer, mappings }: { db: Db; viewer: Viewer; mappings: { id: string; label: string }[] }) {
  const subs = await listSubscriptions(db, viewer);
  return (
    <Panel title="What matters to us upstream" icon={Eye} id="subscriptions">
      <div className="flex flex-col gap-3 p-4 text-[13px]">
        {subs.length === 0 ? <p className="text-ink-3">Save the things you care about (a label, a folder, an author, a milestone). Matching upstream items are marked with the reason they matched.</p> : (
          <ul className="divide-y divide-line">
            {subs.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <div><p className={`font-medium ${s.muted ? "text-ink-3 line-through" : ""}`}>{s.name}{s.mappingName ? <span className="font-normal text-ink-3"> · {s.mappingName}</span> : <span className="font-normal text-ink-3"> · every fork</span>}</p>
                  <p className="text-[12px] text-ink-3">{[s.criteria.labels?.length ? `labels ${s.criteria.labels.join(", ")}` : "", s.criteria.paths?.length ? `paths ${s.criteria.paths.join(", ")}` : "", s.criteria.milestone ? `milestone ${s.criteria.milestone}` : "", s.criteria.authors?.length ? `authors ${s.criteria.authors.join(", ")}` : "", s.criteria.titleContains?.length ? `words ${s.criteria.titleContains.join(", ")}` : ""].filter(Boolean).join(" · ")}</p></div>
                {viewer.isAdmin && (
                  <div className="flex gap-2">
                    <ActionForm action={subscriptionAction} submitLabel={s.muted ? "Unmute" : "Mute"} submitClassName="btn" resetOnSuccess={false}><input type="hidden" name="id" value={s.id} /><input type="hidden" name="op" value={s.muted ? "unmute" : "mute"} /></ActionForm>
                    <ActionForm action={subscriptionAction} submitLabel="Delete" submitClassName="btn btn-danger"><input type="hidden" name="id" value={s.id} /><input type="hidden" name="op" value="delete" /></ActionForm>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {viewer.isAdmin && (
          <details className="rounded-[10px] border border-line p-3">
            <summary className="cursor-pointer font-medium">New subscription</summary>
            <ActionForm action={subscriptionAction} submitLabel="Save subscription" className="mt-3">
              <div className="grid gap-3 md:grid-cols-2">
                <div><label className="label" htmlFor="sb-name">Name</label><input id="sb-name" name="name" className="input" required placeholder="Security fixes" /></div>
                <div><label className="label" htmlFor="sb-map">For</label><Select id="sb-map" name="mappingId" className="select" defaultValue=""><option value="">Every fork</option>{mappings.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Select></div>
                <div><label className="label" htmlFor="sb-labels">Labels (comma separated)</label><input id="sb-labels" name="labels" className="input" placeholder="security, regression" /></div>
                <div><label className="label" htmlFor="sb-paths">Paths (folder or pattern)</label><input id="sb-paths" name="paths" className="input" placeholder="src/auth/, **/*.sql" /></div>
                <div><label className="label" htmlFor="sb-ms">Milestone</label><input id="sb-ms" name="milestone" className="input" /></div>
                <div><label className="label" htmlFor="sb-au">Authors</label><input id="sb-au" name="authors" className="input" placeholder="login1, login2" /></div>
                <div className="md:col-span-2"><label className="label" htmlFor="sb-w">Words in the title</label><input id="sb-w" name="words" className="input" placeholder="token, CVE" /></div>
              </div>
              <input type="hidden" name="op" value="create" />
              <p className="mt-2 text-[12px] text-ink-3">Any one match is enough. Path criteria only work once an upstream pull request&rsquo;s files have been opened here; until then they are reported as not checked.</p>
            </ActionForm>
          </details>
        )}
      </div>
    </Panel>
  );
}

/** For one fork: upstream items the subscriptions select, explicit backport records, and the adoption planner. */
export async function MappingTools({ db, viewer, mappingId, forkBranch, upstreamName, adopt }: { db: Db; viewer: Viewer; mappingId: string; forkBranch: string; upstreamName: string; adopt?: { items: string; branch: string; project: string } | null }) {
  const [rel, backports, projects, prs, issues] = await Promise.all([upstreamRelevance(db, viewer, mappingId), listBackports(db, viewer, mappingId), listProjects(db, viewer), db.upstreamPrState.findMany({ where: { mappingId }, select: { number: true, title: true } }), db.upstreamIssueTriage.findMany({ where: { mappingId }, select: { issueNumber: true, title: true } })]);
  const titleOf = new Map<string, string>([...prs.map((p) => [`p${p.number}`, p.title] as const), ...issues.map((i) => [`i${i.issueNumber}`, i.title] as const)]);
  const matches = [...Object.entries(rel.prs).map(([n, m]) => ({ key: `p${n}`, label: `PR #${n}`, m })), ...Object.entries(rel.issues).map(([n, m]) => ({ key: `i${n}`, label: `Issue #${n}`, m }))];
  let preview = null as Awaited<ReturnType<typeof previewAdoption>> | null;
  let previewError: string | null = null;
  if (adopt) {
    try {
      preview = await previewAdoption(db, viewer, { mappingId, items: adopt.items.split(",").map((x) => x.trim()).filter(Boolean).map((x) => ({ kind: x.startsWith("i") ? ("issue" as const) : ("pr" as const), number: Number(x.replace(/^[pi]/, "")) })), targetBranch: adopt.branch });
    } catch (e) {
      previewError = e instanceof Error ? e.message : "Could not preview";
    }
  }
  return (
    <div className="mt-4 flex flex-col gap-4">
      <section aria-label="Relevant upstream items">
        <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-medium"><Flag size={13} aria-hidden /> Relevant to us</h3>
        {matches.length === 0 ? <p className="text-[12.5px] text-ink-3">No upstream item matches your subscriptions.</p> : (
          <ul className="flex flex-col gap-1.5 text-[12.5px]">
            {matches.map(({ key, label, m }) => (
              <li key={key} className="rounded-[8px] border border-line p-2"><span className="font-medium">{label}: {titleOf.get(key)}</span>{m.map((x) => <span key={x.subscriptionId} className="block text-ink-3">{x.name}: {[...x.reasons, ...x.unknown].join("; ")}</span>)}</li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Backports">
        <h3 className="mb-1 flex items-center gap-1.5 text-[13px] font-medium"><GitFork size={13} aria-hidden /> Backports and cherry-picks</h3>
        <p className="mb-2 text-[12px] text-ink-3">Evidence and decisions are kept apart. Titles and numbers never count as evidence. A check reads the clone mapped on this computer (it needs the upstream commit fetched).</p>
        {backports.length > 0 && (
          <ul className="mb-2 flex flex-col gap-1.5 text-[12.5px]">
            {backports.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[8px] border border-line p-2">
                <div><p className="font-medium">#{b.upstreamNumber} → {b.targetBranch} <span className="font-normal text-ink-3">· {b.state === "done" ? "done" : "planned"}</span></p><p className="text-ink-3">{EVIDENCE[b.evidence] ?? b.evidence}{b.localSha ? ` · ${b.localSha.slice(0, 7)}` : ""}{b.note ? ` · ${b.note}` : ""}</p></div>
                <ActionForm action={backportAction} submitLabel="Remove" submitClassName="btn btn-danger"><input type="hidden" name="op" value="delete" /><input type="hidden" name="id" value={b.id} /></ActionForm>
              </li>
            ))}
          </ul>
        )}
        <ActionForm action={backportAction} submitLabel="Record" className="flex flex-wrap items-end gap-3" submitClassName="btn" resetOnSuccess={false}>
          <input type="hidden" name="mappingId" value={mappingId} />
          <div><label className="label" htmlFor={`bp-n-${mappingId}`}>Upstream PR number</label><input id={`bp-n-${mappingId}`} name="number" inputMode="numeric" className="input w-28" required /></div>
          <div><label className="label" htmlFor={`bp-b-${mappingId}`}>Target branch</label><input id={`bp-b-${mappingId}`} name="branch" className="input font-mono" defaultValue={forkBranch} required /></div>
          <div><label className="label" htmlFor={`bp-o-${mappingId}`}>Action</label><Select id={`bp-o-${mappingId}`} name="op" className="select" defaultValue="check"><option value="check">Check my local clone</option><option value="plan">Plan it</option><option value="done">Mark addressed (my decision)</option></Select></div>
        </ActionForm>
      </section>

      <section aria-label="Plan adoption">
        <h3 className="mb-1 text-[13px] font-medium">Plan adopting upstream changes</h3>
        {!preview ? (
          <form method="get" className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="adopt" value={mappingId} />
            <div><label className="label" htmlFor={`ad-i-${mappingId}`}>Changes (p101 for a PR, i104 for an issue)</label><input id={`ad-i-${mappingId}`} name="items" className="input w-56 font-mono" placeholder="p101, p102" defaultValue={adopt?.items ?? ""} required /></div>
            <div><label className="label" htmlFor={`ad-b-${mappingId}`}>Bring them to branch</label><input id={`ad-b-${mappingId}`} name="branch" className="input font-mono" defaultValue={adopt?.branch ?? forkBranch} required /></div>
            {projects.length > 0 && <div><label className="label" htmlFor={`ad-p-${mappingId}`}>Plan in project</label><Select id={`ad-p-${mappingId}`} name="project" className="select" defaultValue={adopt?.project ?? projects[0].id}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>}
            <button type="submit" className="btn">Preview the plan</button>
            {previewError && <p role="alert" className="w-full text-[12.5px] text-blocked">{previewError}</p>}
          </form>
        ) : (
          <div className="rounded-[10px] border border-line p-3 text-[12.5px]">
            <p className="font-medium">{preview.milestoneName}</p>
            <ul className="mt-1 list-disc pl-5 text-ink-2">{preview.tasks.map((t) => <li key={t.title}>{t.title}</li>)}<li>{preview.finalStep.title} (after all of the above)</li></ul>
            {preview.notes.map((n) => <p key={n} className="mt-1 text-ink-3">{n}</p>)}
            {viewer.isAdmin ? (
              <div className="mt-2 flex items-center gap-3">
                <ActionForm action={adoptionAction} submitLabel="Create this plan">
                  <input type="hidden" name="mappingId" value={mappingId} /><input type="hidden" name="items" value={adopt!.items} /><input type="hidden" name="branch" value={adopt!.branch} /><input type="hidden" name="projectId" value={adopt!.project} />
                </ActionForm>
                <Link className="btn btn-quiet" href="/forks">Cancel</Link>
              </div>
            ) : <p className="mt-2 text-ink-3">An administrator creates the plan.</p>}
          </div>
        )}
        <span hidden>{upstreamName}</span>
      </section>
    </div>
  );
}
