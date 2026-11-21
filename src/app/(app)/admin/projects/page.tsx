import Link from "next/link";
import { RepoChecklist } from "@/components/forms/RepoChecklist";
import { Select } from "@/components/ui/Select";
import { db } from "@/lib/db";
import { requireAdminViewer } from "@/lib/authz-page";
import { projectWhere } from "@/lib/authz/viewer";
import { ActionForm } from "@/components/forms/ActionForm";
import { Sheet } from "@/components/ui/dialog";
import { EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { Layers, Plus } from "@/components/ui/icons";
import { Disclosure } from "@/components/ui/Disclosure";
import { createProjectAction, setProjectMembersAction, setProjectReposAction, setProjectReviewersAction } from "@/app/actions";
import { byOwnerFirst, byPersonalFirst } from "@/lib/domain/ordering";
import { projectReviewerRefs } from "@/lib/services/project-reviewers";
import { setProjectSpaceAction } from "@/app/team-actions";
import { setProjectSpaceAclAction } from "@/app/workspace-actions";
import { ProjectAccessForm } from "@/components/members/ProjectAccessForm";
import { listMySpaces } from "@/lib/services/access-spaces";
import { isHosted } from "@/lib/public-url";

export const metadata = { title: "Projects" };
export const dynamic = "force-dynamic";

export default async function Projects() {
  const { viewer } = await requireAdminViewer();
  const hosted = isHosted();
  // Hosted: the access spaces this person may use (the common one, and the restricted ones they are in). Names of other restricted spaces are never loaded here.
  const mySpaces = hosted ? await listMySpaces(db, viewer) : [];
  const spaces = hosted ? [] : await db.space.findMany({ where: { workspaceId: viewer.workspaceId, access: "OK", canWrite: true }, orderBy: [{ kind: "asc" }, { name: "asc" }] });
  const [projectsRaw, reposRaw, members] = await Promise.all([
    db.project.findMany({ where: projectWhere(viewer), include: { repositories: true, members: true, accessSpace: { select: { name: true, kind: true } } }, orderBy: { name: "asc" } }),
    db.repository.findMany({ where: { workspaceId: viewer.workspaceId, trackingStatus: { not: "REMOVED" } }, select: { id: true, fullName: true }, orderBy: { fullName: "asc" } }),
    db.member.findMany({ where: { workspaceId: viewer.workspaceId, status: "ACTIVE", role: { in: ["MEMBER", "READER"] } }, include: { user: true } }),
  ]);
  const canShareWithTeam = !hosted && spaces.some((s) => s.kind === "COMMON");
  const me = viewer.login;
  const projects = [...projectsRaw].sort((x, y) => byPersonalFirst(me)(x.name, y.name));
  const repos = [...reposRaw].sort((x, y) => byOwnerFirst(me)(x.fullName, y.fullName));
  const reviewerText = new Map(await Promise.all(projects.map(async (p) => [p.id, (await projectReviewerRefs(db, viewer.workspaceId, p.id)).join(", ")] as const)));
  // One line per project: counts, who reviews, who sees it. Long reviewer lists keep their first three names.
  const reviewerShort = (id: string) => {
    const all = (reviewerText.get(id) ?? "").split(", ").filter(Boolean);
    return all.length > 3 ? `${all.slice(0, 3).join(", ")} +${all.length - 3}` : all.join(", ");
  };
  const lineOf = (p: (typeof projects)[number]) => `${p.repositories.length} repositories · ${p.members.length} people${reviewerShort(p.id) ? ` · reviewers: ${reviewerShort(p.id)}` : ""} · ${hosted ? (p.accessSpace?.kind === "RESTRICTED" ? `space: ${p.accessSpace.name}` : "Everyone in the workspace") : p.spaceId ? "shared" : "only on this computer"}`;
  return (
    <>
      <PageHeader
        title="Projects"
        subtitle="Groups repositories and people for planning. Membership never grants repository access."
        help={<>A GitHub organization is not a project.</>}
        actions={
          <Sheet title="New project" trigger={<button className="btn btn-primary"><Plus size={14} aria-hidden /> New project</button>}>
            <ActionForm action={createProjectAction} submitLabel="Create project" closeOnSuccess>
              <div className="flex flex-col gap-3"><div><label className="label" htmlFor="p-name">Name</label><input id="p-name" name="name" className="input" required /></div><div><label className="label" htmlFor="p-rev">Required reviewers (optional)</label><input id="p-rev" name="reviewers" className="input" placeholder="GitHubLogin, org/team-slug" /></div><div><label className="label" htmlFor="p-desc">Description</label><input id="p-desc" name="description" className="input" /></div>{canShareWithTeam && <fieldset><legend className="label">Sharing</legend><label className="check-row text-[13px]"><input type="checkbox" name="share" value="1" />Share with everyone in the team</label><p className="max-w-[60ch] text-pretty text-[12px] text-ink-3">Everyone on the team will see its cards and tasks. Leave off to keep it on this computer.</p></fieldset>}</div>
            </ActionForm>
          </Sheet>
        }
      />
      {projects.length === 0 ? <Panel title="Projects" icon={Layers}><EmptyState icon={Layers} title="No projects yet">Use <strong>New project</strong> to group repositories you plan together.</EmptyState></Panel> : (
        <div className="fit-grid" style={{ "--fit-min": "720px" } as React.CSSProperties}>
          {projects.map((p) => (
            <Panel key={p.id} title={p.name} icon={Layers} id={`p-${p.id}`} actions={<span className="hidden max-w-[28rem] truncate text-[12px] text-ink-3 sm:inline" title={lineOf(p)}>{lineOf(p)}</span>}>
              <p className="border-b border-line px-4 py-2 text-[12px] text-ink-3 sm:hidden">{lineOf(p)}</p>
              <div className="flex flex-col divide-y divide-line">
                <Disclosure className="px-4" summary={<span className="font-medium">Repositories</span>} meta={<>({p.repositories.length})</>}>
                  <ActionForm action={setProjectReposAction} submitLabel="Save repositories" resetOnSuccess={false} className="mt-3">
                    <input type="hidden" name="projectId" value={p.id} />
                    <RepoChecklist name="repo" repos={repos.map((r) => ({ id: r.id, fullName: r.fullName, checked: p.repositories.some((x) => x.repositoryId === r.id) }))} />
                  </ActionForm>
                </Disclosure>
                <Disclosure className="px-4" summary={<span className="font-medium">People</span>} meta={<>({p.members.length})</>}>
                  <div className="mt-3">
                    {members.length === 0 ? (
                      <div className="rounded-[8px] border border-dashed border-line-strong p-3 text-[12.5px] text-ink-2">
                        <p className="font-medium">Nobody to add yet.</p>
                        <p className="mt-1 text-ink-3">{hosted ? "People appear once they join this workspace. Membership never grants repository access." : "People appear once they join your team. Invites grant the private coordination repository only, never source repositories."}</p>
                        <Link href={hosted ? "/settings/members" : "/team"} className="btn mt-2 inline-flex">{hosted ? "Invite people in Members" : "Invite people on Team"}</Link>
                      </div>
                    ) : (
                      <>
                        <ActionForm action={setProjectMembersAction} submitLabel="Save members" resetOnSuccess={false}>
                          <input type="hidden" name="projectId" value={p.id} />
                          <fieldset>
                            <legend className="label">People in this project</legend>
                            <ul className="flex flex-col text-[13px]">{members.map((m) => <li key={m.id}><label className="check-row"><input type="checkbox" name="member" value={m.id} defaultChecked={p.members.some((x) => x.memberId === m.id)} />@{m.user.login}</label></li>)}</ul>
                          </fieldset>
                          <p className="mt-2 text-[12px] text-ink-3">Members see internal tasks. Repository content still needs a repository grant.</p>
                        </ActionForm>
                        <p className="mt-2 text-[12px] text-ink-3">Need someone else? <Link className="underline" href={hosted ? "/settings/members" : "/team"}>{hosted ? "Invite people in Members" : "Invite people on Team"}</Link>.</p>
                      </>
                    )}
                  </div>
                </Disclosure>
                <Disclosure className="px-4" summary={<span className="font-medium">Required reviewers</span>} meta={<>({reviewerShort(p.id) || "none"})</>}>
                  <div className="mt-3"><ActionForm action={setProjectReviewersAction} submitLabel="Save reviewers" resetOnSuccess={false} className="max-w-md">
                  <input type="hidden" name="projectId" value={p.id} />
                  <label className="label" htmlFor={`rv-${p.id}`}>Required reviewers</label>
                  <input id={`rv-${p.id}`} name="reviewers" className="input" defaultValue={reviewerText.get(p.id) ?? ""} placeholder="GitHubLogin, org/team-slug (empty = none)" />
                  <p className="mt-1 text-[12px] text-ink-3">Every open pull request here waits for these people. Authors cannot approve their own, so it stays unmet for them. Finer rules: Review routing.</p>
                </ActionForm></div>
                </Disclosure>
                {hosted ? (
                <Disclosure className="px-4" summary={<span className="font-medium">Access</span>} meta={<>({p.accessSpace?.kind === "RESTRICTED" ? p.accessSpace.name : "Everyone in the workspace"})</>}>
                  <div className="mt-3">
                    <ProjectAccessForm projectId={p.id} current={p.accessSpaceId ?? ""} spaces={mySpaces.filter((sp) => sp.kind === "RESTRICTED").map((sp) => ({ id: sp.id, name: sp.name }))} action={setProjectSpaceAclAction} />
                  </div>
                </Disclosure>
                ) : (
                <Disclosure className="px-4" summary={<span className="font-medium">Sharing</span>} meta={<>({p.spaceId ? "shared through a team space" : "only on this computer"})</>}>
                  <div className="mt-3"><ActionForm action={setProjectSpaceAction} submitLabel="Save sharing" resetOnSuccess={false} className="max-w-md">
                  <input type="hidden" name="projectId" value={p.id} />
                  <label className="label" htmlFor={`sp-${p.id}`}>Shared through</label>
                  <Select id={`sp-${p.id}`} name="spaceId" defaultValue={p.spaceId ?? ""} className="select">
                    <option value="">Only on this computer</option>
                    {spaces.map((sp) => <option key={sp.id} value={sp.id}>{sp.name}{sp.kind === "COMMON" ? " (everyone in the team)" : " (restricted)"}</option>)}
                  </Select>
                  <p className="mt-1 text-[12px] text-ink-3">The project, board and tasks go to that space&apos;s private repository; everyone who can read it sees them.</p>
                </ActionForm></div>
                </Disclosure>
                )}
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
