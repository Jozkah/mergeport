import { ActionForm } from "@/components/forms/ActionForm";
import { Select } from "@/components/ui/Select";
import { Sheet } from "@/components/ui/dialog";
import { Banner, EmptyState, Panel, SimplePill } from "@/components/ui/primitives";
import { Lock, Mail, ShieldCheck, Users } from "@/components/ui/icons";
import {
  changeRoleAction, createAccessSpaceAction, deleteAccessSpaceAction, inviteMemberAction, leaveWorkspaceAction, reinstateMemberAction, removeMemberAction,
  removeSpaceMemberAction, resendInvitationAction, revokeInvitationAction, setProjectSpaceAclAction, setSpaceMemberAction, transferOwnershipAction,
} from "@/app/workspace-actions";
import { ROLE_LABEL, can, type Role } from "@/lib/authz/roles";
import type { Viewer } from "@/lib/authz/viewer";
import type { InvitationRow } from "@/lib/services/invitations";
import type { MemberRow } from "@/lib/services/members";
import type { SpaceSummary } from "@/lib/services/access-spaces";

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
  return (
    <Panel title={<>Members (<span className="tnum">{active.length}</span>)</>} icon={Users} id="members">
      <ul>
        {active.map((m) => {
          const canManage = !m.isSelf && can(viewer, "manageMembers", { targetRole: m.role });
          return (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4 last:border-b-0">
              <div className="min-w-0">
                <p className="truncate font-medium">{label(m)}{m.isSelf && <span className="ml-1 font-normal text-ink-3">(you)</span>}</p>
                <p className="truncate text-[12.5px] text-ink-3">{m.email ?? `@${m.login}`}</p>
              </div>
              <SimplePill tone={m.role === "OWNER" ? "ok" : "needs"}>{ROLE_LABEL[m.role]}</SimplePill>
              {canManage && (
                <div className="flex flex-wrap items-start gap-2">
                  <ActionForm action={changeRoleAction} submitLabel="Save role" pendingLabel="Saving…" submitClassName="btn !h-10" resetOnSuccess={false} className="flex flex-wrap items-start gap-2 [&>div:last-child]:!mt-0">
                    <input type="hidden" name="memberId" value={m.id} />
                    <Select name="role" aria-label={`Role for ${label(m)}`} defaultValue={m.role} className="select !h-10 !w-32">{ROLE_OPTIONS}</Select>
                  </ActionForm>
                  <Sheet title={`Remove ${label(m)}?`} description={REMOVE_WARNING(label(m))} trigger={<button type="button" className="btn btn-danger !h-10" aria-label={`Remove ${label(m)}`}>Remove</button>}>
                    <ActionForm action={removeMemberAction} submitLabel="Remove" pendingLabel="Removing…" submitClassName="btn btn-danger !h-10" closeOnSuccess>
                      <input type="hidden" name="memberId" value={m.id} />
                    </ActionForm>
                  </Sheet>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {removed.length > 0 && (
        <div className="border-t border-line p-4">
          <h3 className="text-[13px] font-medium">Removed (<span className="tnum">{removed.length}</span>)</h3>
          <ul className="max-h-72 overflow-y-auto" aria-label="Removed people">
            {removed.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span className="min-w-0 max-w-full break-all">{label(m)} <span className="text-ink-3">(removed)</span></span>
                <ActionForm action={reinstateMemberAction} submitLabel="Reinstate" pendingLabel="Reinstating…" submitClassName="btn !h-10" submitAriaLabel={`Reinstate ${label(m)}`} className="flex flex-wrap items-start gap-2 [&>div:last-child]:!mt-0">
                  <input type="hidden" name="memberId" value={m.id} />
                  <span className="inline-flex h-10 items-center text-[12.5px] text-ink-3" aria-hidden>as</span>
                  <Select name="role" aria-label={`Role for ${label(m)} when reinstated`} defaultValue="MEMBER" className="select !h-10 !w-32">{ROLE_OPTIONS}</Select>
                </ActionForm>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="border-t border-line p-4">
        <h3 className="mb-2 flex items-center gap-1.5 text-[13px] font-medium"><Mail size={14} aria-hidden /> Invite by email</h3>
        <ActionForm action={inviteMemberAction} submitLabel="Send invitation" pendingLabel="Sending…" submitClassName="btn btn-primary !h-10" className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 max-sm:basis-full"><label className="label" htmlFor="invite-email">Email address</label><input id="invite-email" name="email" type="email" required maxLength={254} className="input !h-10 !w-full sm:!w-64" placeholder="alice@example.com" autoComplete="off" /></div>
          <div><label className="label" htmlFor="invite-role">Role</label><Select id="invite-role" name="role" defaultValue="MEMBER" className="select !h-10 !w-32">{ROLE_OPTIONS}</Select></div>
        </ActionForm>
        <p className="mt-2 max-w-[70ch] text-pretty text-[12.5px] text-ink-3">The invitation works for 7 days, once, and only for someone signed in with this address. Nobody joins by signing up alone.</p>
        {invitations.length > 0 && (
          <ul className="mt-3 max-h-72 overflow-y-auto" aria-label="Pending invitations">
            {invitations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                <span className="min-w-0 max-w-full break-all">{i.email} <span className="text-ink-3">({ROLE_LABEL[i.role]}, {i.sendFailed ? "email not sent, use Resend, " : ""}{i.expired ? "expired" : <>expires {i.expiresAt.toISOString().slice(0, 10)}</>})</span></span>
                <span className="flex flex-wrap gap-2">
                  <ActionForm action={resendInvitationAction} submitLabel="Resend" pendingLabel="Sending…" submitClassName="btn !h-10" submitAriaLabel={`Resend invitation to ${i.email}`} className="[&>div:last-child]:!mt-0">
                    <input type="hidden" name="invitationId" value={i.id} />
                  </ActionForm>
                  <ActionForm action={revokeInvitationAction} submitLabel="Withdraw" pendingLabel="Withdrawing…" submitClassName="btn !h-10" submitAriaLabel={`Withdraw invitation to ${i.email}`} className="[&>div:last-child]:!mt-0">
                    <input type="hidden" name="invitationId" value={i.id} />
                  </ActionForm>
                </span>
              </li>
            ))}
          </ul>
        )}
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
          <ActionForm action={transferOwnershipAction} submitLabel="Transfer ownership" pendingLabel="Transferring…" submitClassName="btn btn-danger !h-10" resetOnSuccess={false} className="max-w-md">
            <label className="label" htmlFor="transfer-to">New owner</label>
            <Select id="transfer-to" name="memberId" defaultValue={admins[0].id} className="select !h-10 !w-full">{admins.map((m) => <option key={m.id} value={m.id}>{label(m)}</option>)}</Select>
            <label className="mt-3 flex min-h-10 w-fit cursor-pointer items-center gap-2 text-[13px]"><input type="checkbox" name="confirm" /> I understand I become an admin and can no longer delete the workspace or move ownership.</label>
          </ActionForm>
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
        <p>Your role: <strong>{ROLE_LABEL[role]}</strong>.</p>
        {owner ? (
          <p className="mt-2 text-ink-3">The owner cannot leave. Transfer ownership to an admin first.</p>
        ) : (
          <Sheet title="Leave this workspace?" description={LEAVE_WARNING} trigger={<button type="button" className="btn btn-danger mt-3 !h-10">Leave workspace</button>}>
            <ActionForm action={leaveWorkspaceAction} submitLabel="Leave workspace" pendingLabel="Leaving…" submitClassName="btn btn-danger !h-10"><input type="hidden" name="leave" value="1" /></ActionForm>
          </Sheet>
        )}
      </div>
    </Panel>
  );
}

export function SpacesPanel({ spaces, members, projects }: { spaces: SpaceSummary[]; members: MemberRow[]; projects: { id: string; name: string }[] }) {
  const restricted = spaces.filter((s) => s.kind === "RESTRICTED");
  const active = members.filter((m) => m.status === "ACTIVE");
  return (
    <Panel title={<>Spaces (<span className="tnum">{spaces.length}</span>)</>} icon={ShieldCheck} id="spaces">
      <p className="max-w-[70ch] text-pretty border-b border-line p-4 text-[12.5px] text-ink-3">Everyone in the workspace reads the common space. A restricted space is read only by the people listed in it, and edited only by those with edit access. Readers never edit.</p>
      {spaces.filter((s) => s.kind === "COMMON").map((s) => (
        <p key={s.id} className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3 text-[13px]"><span className="font-medium">{s.name}</span><SimplePill tone="ok">Everyone</SimplePill><span className="text-[12.5px] text-ink-3">{s.projectCount} project{s.projectCount === 1 ? "" : "s"}</span></p>
      ))}
      {restricted.length === 0 ? (
        <EmptyState icon={Lock} title="No restricted spaces">Projects live in the common space until you move them into a restricted one.</EmptyState>
      ) : (
        <ul>
          {restricted.map((s) => (
            <li key={s.id} className="border-b border-line p-4 last:border-b-0">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="flex min-w-0 flex-wrap items-center gap-2 font-medium"><span className="truncate">{s.name}</span><SimplePill tone="waiting">Restricted</SimplePill><span className="text-[12.5px] font-normal text-ink-3">{s.projectCount} project{s.projectCount === 1 ? "" : "s"}</span></p>
                <Sheet title={`Delete “${s.name}”?`} description="Its members lose the space. A space that still holds projects cannot be deleted." trigger={<button type="button" className="btn btn-danger !h-10">Delete space</button>}>
                  <ActionForm action={deleteAccessSpaceAction} submitLabel="Delete space" pendingLabel="Deleting…" submitClassName="btn btn-danger !h-10" closeOnSuccess>
                    <input type="hidden" name="spaceId" value={s.id} />
                  </ActionForm>
                </Sheet>
              </div>
              {s.isMember && projects.length > 0 && (
                <ActionForm action={setProjectSpaceAclAction} submitLabel="Move here" pendingLabel="Moving…" submitClassName="btn !h-10" resetOnSuccess={false} submitAriaLabel={`Move a project into ${s.name}`} className="mt-2 flex flex-wrap items-end gap-3 [&>div:last-child]:!mt-0">
                  <input type="hidden" name="spaceId" value={s.id} />
                  <div><label className="label" htmlFor={`mvh-${s.id}`}>Move a project here</label>
                    <Select id={`mvh-${s.id}`} name="projectId" defaultValue={projects[0].id} className="select !h-10 !w-56">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
                </ActionForm>
              )}
              {s.members.length === 0 ? <p className="mt-2 text-[12.5px] text-ink-3">No members yet.</p> : (
                <ul className="mt-2" aria-label={`Members of ${s.name}`}>
                  {s.members.map((m) => (
                    <li key={m.memberId} className="flex flex-wrap items-center justify-between gap-2 py-1 text-[13px]">
                      <span className="min-w-0 break-all">{m.email ?? `@${m.login}`}</span>
                      <span className="flex flex-wrap items-center gap-2">
                        <ActionForm action={setSpaceMemberAction} submitLabel="Save" pendingLabel="Saving…" submitClassName="btn !h-10" resetOnSuccess={false} submitAriaLabel={`Save access for ${m.email ?? m.login}`} className="flex flex-wrap items-center gap-2 [&>div:last-child]:!mt-0">
                          <input type="hidden" name="spaceId" value={s.id} />
                          <input type="hidden" name="memberId" value={m.memberId} />
                          <label className="flex min-h-10 items-center gap-2 text-ink-3"><input type="checkbox" name="canWrite" defaultChecked={m.canWrite} /> can edit</label>
                        </ActionForm>
                        <ActionForm action={removeSpaceMemberAction} submitLabel="Remove" pendingLabel="Removing…" submitClassName="btn !h-10" submitAriaLabel={`Remove ${m.email ?? m.login} from ${s.name}`} className="[&>div:last-child]:!mt-0">
                          <input type="hidden" name="spaceId" value={s.id} />
                          <input type="hidden" name="memberId" value={m.memberId} />
                        </ActionForm>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <ActionForm action={setSpaceMemberAction} submitLabel="Add" pendingLabel="Adding…" submitClassName="btn !h-10" className="mt-2 flex flex-wrap items-end gap-3 [&>div:last-child]:!mt-0">
                <input type="hidden" name="spaceId" value={s.id} />
                <div><label className="label" htmlFor={`add-${s.id}`}>Add a member</label>
                  <Select id={`add-${s.id}`} name="memberId" defaultValue="" className="select !h-10 !w-56">
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
        <ActionForm action={createAccessSpaceAction} submitLabel="Create space" pendingLabel="Creating…" submitClassName="btn btn-primary !h-10" className="flex flex-wrap items-end gap-3">
          <div><label className="label" htmlFor="space-name">Name</label><input id="space-name" name="name" className="input !h-10 !w-full sm:!w-64" required maxLength={60} /></div>
        </ActionForm>
      </div>
      {projects.length > 0 && (
        <div className="border-t border-line p-4">
          <p className="mb-2 text-[12.5px] font-medium">Move a project</p>
          <ActionForm action={setProjectSpaceAclAction} submitLabel="Move project" pendingLabel="Moving…" submitClassName="btn !h-10" resetOnSuccess={false} className="flex flex-wrap items-end gap-3">
            <div><label className="label" htmlFor="mv-project">Project</label><Select id="mv-project" name="projectId" defaultValue={projects[0].id} className="select !h-10 !w-56">{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
            <div><label className="label" htmlFor="mv-space">Into</label>
              <Select id="mv-space" name="spaceId" defaultValue="" className="select !h-10 !w-56">
                <option value="">Common space (everyone)</option>
                {restricted.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select></div>
          </ActionForm>
          <div className="mt-3"><Banner tone="info" title="Moving out of a restricted space shows the project to everyone">Check who is in the space first. People outside a restricted space cannot see its projects, cards or search results.</Banner></div>
        </div>
      )}
    </Panel>
  );
}
