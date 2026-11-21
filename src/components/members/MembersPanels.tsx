import { ActionForm } from "@/components/forms/ActionForm";
import { ConfirmSheet } from "@/components/forms/ConfirmSheet";
import { Select } from "@/components/ui/Select";
import { Banner, EmptyState, Panel } from "@/components/ui/primitives";
import { RoleChip, ScopeChip } from "@/components/ui/identity";
import { Lock, Mail, ShieldCheck, Users } from "@/components/ui/icons";
import {
  createAccessSpaceAction, deleteAccessSpaceAction, inviteMemberAction, leaveWorkspaceAction, removeSpaceMemberAction, setSpaceMemberAction,
} from "@/app/workspace-actions";
import { can, type Role } from "@/lib/authz/roles";
import type { Viewer } from "@/lib/authz/viewer";
import type { InvitationRow } from "@/lib/services/invitations";
import type { MemberRow } from "@/lib/services/members";
import type { SpaceSummary } from "@/lib/services/access-spaces";
import { ActiveMembers, MoveProjectForm, PendingInvitations, RemovedMembers, TransferForm } from "./MembersClient";

/** Presentational: the page decided what to load for this viewer, and every write goes through a server action that checks the policy again. */
const ROLE_OPTIONS = (
  <>
    <option value="ADMIN">Admin</option>
    <option value="MEMBER">Member</option>
    <option value="READER">Reader</option>
  </>
);

export const REMOVE_WARNING = (name: string) => `${name} loses access to this workspace now, on every device, and is dropped from every project and space. You can reinstate them later.`;
export const LEAVE_WARNING = "You lose access to this workspace and its projects. An administrator can reinstate you.";

const label = (m: { login: string; name: string | null; email: string | null }) => m.name ?? m.email ?? `@${m.login}`;

export function MembersPanel({ viewer, members, invitations }: { viewer: Viewer; members: MemberRow[]; invitations: InvitationRow[] }) {
  const active = members.filter((m) => m.status === "ACTIVE");
  const removed = members.filter((m) => m.status === "REVOKED");
  const rows = active.map((m) => {
    const name = label(m);
    const sub = m.email ?? `@${m.login}`;
    // The second line only when it adds something: a person with no name would otherwise see their email twice.
    return { id: m.id, name, sub: sub === name ? null : sub, role: m.role, isSelf: m.isSelf, manageable: !m.isSelf && can(viewer, "manageMembers", { targetRole: m.role }), removeText: REMOVE_WARNING(name) };
  });
  const pending = invitations.map((i) => ({ id: i.id, email: i.email, role: i.role, sendFailed: i.sendFailed, expired: i.expired, expiresAt: i.expiresAt.toISOString() }));
  return (
    <Panel title={<>Members (<span className="tnum">{active.length}</span>)</>} icon={Users} id="members" summary={`${active.length} active${invitations.length ? `, ${invitations.length} invited` : ""}`}>
      <ActiveMembers members={rows} />
      {removed.length > 0 && (
        <div className="border-t border-line p-4">
          <h3 className="text-[13px] font-medium">Removed (<span className="tnum">{removed.length}</span>)</h3>
          <RemovedMembers members={removed.map((m) => ({ id: m.id, name: label(m) }))} />
        </div>
      )}
      <div className="border-t border-line p-4">
        <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium"><Mail size={14} aria-hidden /> Invite by email</h3>
        <ActionForm action={inviteMemberAction} submitLabel="Send invitation" pendingLabel="Sending…" className="flex flex-wrap items-end gap-3" layout="inline" submitClassName="btn btn-primary">
          <div className="min-w-0 max-sm:basis-full"><label className="label" htmlFor="invite-email">Email address</label><input id="invite-email" name="email" type="email" required maxLength={254} className="input w-full sm:w-64" placeholder="alice@example.com" autoComplete="off" autoCapitalize="none" spellCheck={false} /></div>
          <div><label className="label" htmlFor="invite-role">Role</label><Select id="invite-role" name="role" defaultValue="MEMBER" className="select w-32">{ROLE_OPTIONS}</Select></div>
        </ActionForm>
        <p className="mt-2 max-w-[70ch] text-pretty text-[12.5px] text-ink-3">Each invitation works once, for 7 days, and only for someone signed in with this address.</p>
        {pending.length > 0 && <PendingInvitations invitations={pending} />}
      </div>
    </Panel>
  );
}

/** Owner only: hands the workspace to an active admin. */
export function TransferPanel({ admins }: { admins: MemberRow[] }) {
  return (
    <Panel title="Transfer ownership" icon={ShieldCheck} id="ownership" defaultOpen={false} summary="Owner only">
      <div className="p-4">
        {admins.length === 0 ? (
          <p className="text-[13px] text-ink-3">Make someone an admin first. Ownership can only go to an active admin, and you become an admin when it does.</p>
        ) : (
          <TransferForm admins={admins.map((m) => ({ id: m.id, name: label(m) }))} />
        )}
      </div>
    </Panel>
  );
}

export function LeavePanel({ role }: { role: Role }) {
  const owner = role === "OWNER";
  return (
    <Panel title="Your membership" icon={Users} id="leave" defaultOpen={owner ? false : true}>
      <div className="p-4 text-[13px]">
        <p className="flex flex-wrap items-center gap-2">Your role: <RoleChip role={role} /></p>
        {owner ? (
          <p className="mt-2 text-ink-3">The owner cannot leave. Transfer ownership to an admin first.</p>
        ) : (
          <div className="mt-3">
            <ConfirmSheet title="Leave this workspace?" consequence={LEAVE_WARNING} action={leaveWorkspaceAction} submitLabel="Leave workspace" pendingLabel="Leaving…" trigger={<button type="button" className="btn btn-danger">Leave workspace</button>}>
              <input type="hidden" name="leave" value="1" />
            </ConfirmSheet>
          </div>
        )}
      </div>
    </Panel>
  );
}

export function SpacesPanel({ spaces, members, projects }: { spaces: SpaceSummary[]; members: MemberRow[]; projects: { id: string; name: string }[] }) {
  const restricted = spaces.filter((s) => s.kind === "RESTRICTED");
  const active = members.filter((m) => m.status === "ACTIVE");
  return (
    <Panel title={<>Spaces (<span className="tnum">{spaces.length}</span>)</>} icon={ShieldCheck} id="spaces" summary={`${restricted.length} restricted`}>
      <p className="max-w-[70ch] text-pretty border-b border-line p-4 text-[12.5px] text-ink-3">Everyone in the workspace reads the common space. A restricted space is read only by the people listed in it, and edited only by those with edit access. Readers never edit.</p>
      {spaces.filter((s) => s.kind === "COMMON").map((s) => (
        <p key={s.id} className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 text-[13px]"><span className="font-medium">{s.name}</span><ScopeChip scope="everyone" /><span className="tnum text-[12.5px] text-ink-3">{s.projectCount} project{s.projectCount === 1 ? "" : "s"}</span></p>
      ))}
      {restricted.length === 0 ? (
        <EmptyState icon={Lock} title="No restricted spaces">Projects live in the common space until you move them into a restricted one.</EmptyState>
      ) : (
        <ul>
          {restricted.map((s) => (
            <li key={s.id} className="border-b border-line p-4 last:border-b-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="flex min-w-0 flex-wrap items-center gap-2 font-medium"><span className="wrap-any"><bdi>{s.name}</bdi></span><ScopeChip scope="restricted" /><span className="tnum text-[12.5px] font-normal text-ink-3">{s.projectCount} project{s.projectCount === 1 ? "" : "s"}</span></p>
                <ConfirmSheet title={`Delete “${s.name}”?`} consequence="Its members lose the space. A space that still holds projects cannot be deleted." action={deleteAccessSpaceAction} submitLabel="Delete space" pendingLabel="Deleting…" trigger={<button type="button" className="btn btn-danger">Delete space</button>}>
                  <input type="hidden" name="spaceId" value={s.id} />
                </ConfirmSheet>
              </div>
              {s.members.length === 0 ? <p className="mt-2 text-[12.5px] text-ink-3">No members yet.</p> : (
                <ul className="mt-2" aria-label={`Members of ${s.name}`}>
                  {s.members.map((m) => (
                    <li key={m.memberId} className="flex flex-wrap items-center justify-between gap-2 py-1 text-[13px]">
                      <span className="min-w-0 break-all"><bdi>{m.email ?? `@${m.login}`}</bdi></span>
                      <span className="flex flex-wrap items-center gap-2">
                        <ActionForm action={setSpaceMemberAction} submitLabel="Save" pendingLabel="Saving…" resetOnSuccess={false} submitAriaLabel={`Save access for ${m.email ?? m.login}`} className="flex flex-wrap items-center gap-2" layout="inline">
                          <input type="hidden" name="spaceId" value={s.id} />
                          <input type="hidden" name="memberId" value={m.memberId} />
                          <label className="flex min-h-10 items-center gap-2 text-ink-3"><input type="checkbox" name="canWrite" defaultChecked={m.canWrite} /> can edit</label>
                        </ActionForm>
                        <ConfirmSheet
                          title={`Remove ${m.email ?? `@${m.login}`} from ${s.name}?`}
                          consequence={<>They can no longer see <bdi>{s.name}</bdi> or its projects. They stay in the workspace.</>}
                          action={removeSpaceMemberAction}
                          submitLabel="Remove"
                          pendingLabel="Removing…"
                          trigger={<button type="button" className="btn" aria-label={`Remove ${m.email ?? m.login} from ${s.name}`}>Remove</button>}
                        >
                          <input type="hidden" name="spaceId" value={s.id} />
                          <input type="hidden" name="memberId" value={m.memberId} />
                        </ConfirmSheet>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <ActionForm action={setSpaceMemberAction} submitLabel="Add" pendingLabel="Adding…" className="mt-2 flex flex-wrap items-end gap-3" layout="inline">
                <input type="hidden" name="spaceId" value={s.id} />
                <div><label className="label" htmlFor={`add-${s.id}`}>Add a member</label>
                  <Select id={`add-${s.id}`} name="memberId" defaultValue="" required className="select w-56">
                    <option value="">Choose…</option>
                    {active.filter((m) => !s.members.some((x) => x.memberId === m.id)).map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}
                  </Select></div>
                <label className="flex min-h-10 items-center gap-2 text-[13px] text-ink-3"><input type="checkbox" name="canWrite" defaultChecked /> can edit</label>
              </ActionForm>
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-line p-4">
        <p className="mb-2 text-[12.5px] font-medium">New restricted space</p>
        <ActionForm action={createAccessSpaceAction} submitLabel="Create space" pendingLabel="Creating…" className="flex flex-wrap items-end gap-3" layout="inline">
          <div><label className="label" htmlFor="space-name">Name</label><input id="space-name" name="name" className="input w-full sm:w-64" required maxLength={60} /></div>
        </ActionForm>
      </div>
      {projects.length > 0 && (
        <div className="border-t border-line p-4">
          <p className="mb-2 text-[12.5px] font-medium">Move a project</p>
          <MoveProjectForm projects={projects} spaces={restricted.filter((s) => s.isMember).map((s) => ({ id: s.id, name: s.name }))} />
          <div className="mt-3"><Banner tone="info" title="Moving out of a restricted space shows the project to everyone">Check who is in the space first. People outside a restricted space cannot see its projects, cards or search results.</Banner></div>
        </div>
      )}
    </Panel>
  );
}
