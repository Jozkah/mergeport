"use client";

import { useEffect, useState } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { ConfirmSheet } from "@/components/forms/ConfirmSheet";
import { RoleChip } from "@/components/ui/identity";
import { Select } from "@/components/ui/Select";
import { CircleAlert } from "@/components/ui/icons";
import {
  changeRoleAction, reinstateMemberAction, removeMemberAction, resendInvitationAction, revokeInvitationAction, setProjectSpaceAclAction, transferOwnershipAction,
} from "@/app/workspace-actions";
import type { Role } from "@/lib/authz/roles";
import { formatDateOnly } from "@/lib/format";

/** A little longer than the row-leave animation (--duration-fast, 250 ms). */
const FOLD_MS = 320;

export type MemberView = { id: string; name: string; sub: string | null; role: Role; isSelf: boolean; manageable: boolean; removeText: string };
export type InvitationView = { id: string; email: string; role: Role; sendFailed: boolean; expired: boolean; expiresAt: string };

const ROLE_OPTIONS = (
  <>
    <option value="ADMIN">Admin</option>
    <option value="MEMBER">Member</option>
    <option value="READER">Reader</option>
  </>
);

/**
 * Rows that fold away after a success (the same leaving-Set + `.row-leave` pattern as the AI approvals): the server answer already
 * drops the row from `rows`, so a leaving row is kept from the previous list until its animation has run. Nothing animates on a
 * plain refresh, and nothing on first mount.
 */
function useFoldedRows<T extends { id: string }>(rows: T[]) {
  const [seen, setSeen] = useState(rows);
  const [list, setList] = useState(rows);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  if (rows !== seen) {
    setSeen(rows);
    setList((prev) => [...rows, ...prev.filter((p) => leaving.has(p.id) && !rows.some((r) => r.id === p.id))]);
  }
  const fold = (id: string) => {
    setLeaving((l) => new Set(l).add(id));
    setTimeout(() => {
      setLeaving((l) => {
        const n = new Set(l);
        n.delete(id);
        return n;
      });
      setList((l) => l.filter((x) => x.id !== id));
    }, FOLD_MS);
  };
  return { list, leaving, fold };
}

export function ActiveMembers({ members }: { members: MemberView[] }) {
  const { list, leaving, fold } = useFoldedRows(members);
  return (
    <ul>
      {list.map((m) => (
        <li key={m.id} className={leaving.has(m.id) ? "row-leave" : undefined}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4">
            <div className="min-w-0 flex-1">
              <p className="wrap-any font-medium"><bdi>{m.name}</bdi>{m.isSelf && <span className="ml-1 font-normal text-ink-3">(you)</span>}</p>
              {m.sub && <p className="truncate text-[12.5px] text-ink-3"><bdi>{m.sub}</bdi></p>}
            </div>
            {m.manageable ? (
              <div className="flex flex-wrap items-center gap-2">
                {/* Choosing a role saves it: no separate Save button to forget. */}
                <ActionForm action={changeRoleAction} submitLabel="Save role" hideSubmit resetOnSuccess={false} layout="inline" className="flex items-center gap-2">
                  <input type="hidden" name="memberId" value={m.id} />
                  <Select name="role" aria-label={`Role for ${m.name}`} defaultValue={m.role} autoSubmit className="select w-32">{ROLE_OPTIONS}</Select>
                </ActionForm>
                <ConfirmSheet
                  title={`Remove ${m.name}?`}
                  consequence={m.removeText}
                  action={removeMemberAction}
                  submitLabel="Remove"
                  pendingLabel="Removing…"
                  onDone={(r) => { if (r.ok) fold(m.id); }}
                  trigger={<button type="button" className="btn btn-danger" aria-label={`Remove ${m.name}`}>Remove</button>}
                >
                  <input type="hidden" name="memberId" value={m.id} />
                </ConfirmSheet>
              </div>
            ) : (
              <RoleChip role={m.role} />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function RemovedMembers({ members }: { members: { id: string; name: string }[] }) {
  const { list, leaving, fold } = useFoldedRows(members);
  return (
    <ul className="max-h-72 overflow-y-auto" aria-label="Removed people">
      {list.map((m) => (
        <li key={m.id} className={leaving.has(m.id) ? "row-leave" : undefined}>
          <div className="flex flex-wrap items-center justify-between gap-3 py-2">
            <span className="wrap-any min-w-0 max-w-full"><bdi>{m.name}</bdi> <span className="text-ink-3">(removed)</span></span>
            <ActionForm action={reinstateMemberAction} submitLabel="Reinstate" pendingLabel="Reinstating…" submitAriaLabel={`Reinstate ${m.name}`} onDone={(r) => { if (r.ok) fold(m.id); }} layout="inline" className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="memberId" value={m.id} />
              <span className="text-[12.5px] text-ink-3" aria-hidden>as</span>
              <Select name="role" aria-label={`Role for ${m.name} when reinstated`} defaultValue="MEMBER" className="select w-32">{ROLE_OPTIONS}</Select>
            </ActionForm>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One fixed format (en-US, UTC calendar day) on server and browser, so the text is identical in both and never flips after hydration. */
export function ExpiresOn({ iso }: { iso: string }) {
  return <time dateTime={iso} className="tnum">{formatDateOnly(new Date(iso))}</time>;
}

export function PendingInvitations({ invitations }: { invitations: InvitationView[] }) {
  const { list, leaving, fold } = useFoldedRows(invitations);
  // A row that was not in the previous render rises in once. `known` is null until the first paint, so the initial list and a plain refresh never animate.
  const [known, setKnown] = useState<Set<string> | null>(null);
  const ids = invitations.map((i) => i.id).join(",");
  useEffect(() => {
    const t = setTimeout(() => setKnown(new Set(ids ? ids.split(",") : [])), known === null ? 0 : FOLD_MS);
    return () => clearTimeout(t);
  }, [ids, known]);
  return (
    <ul className="mt-3 max-h-72 overflow-y-auto" aria-label="Pending invitations">
      {list.map((i) => (
        <li key={i.id} className={leaving.has(i.id) ? "row-leave" : known && !known.has(i.id) ? "card-enter" : undefined}>
          <div className="flex flex-wrap items-center justify-between gap-3 py-2">
            <div className="min-w-0 max-w-full">
              <p className="break-all"><bdi>{i.email}</bdi></p>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-3">
                <RoleChip role={i.role} />
                {i.expired ? <span>Expired</span> : <span>Expires <ExpiresOn iso={i.expiresAt} /></span>}
                {i.sendFailed && <span className="pill pill-blocked"><CircleAlert size={12} aria-hidden />Email not sent</span>}
              </p>
            </div>
            <span className="flex flex-wrap gap-2">
              <ActionForm action={resendInvitationAction} submitLabel="Resend" pendingLabel="Sending…" submitAriaLabel={`Resend invitation to ${i.email}`} layout="inline">
                <input type="hidden" name="invitationId" value={i.id} />
              </ActionForm>
              <ConfirmSheet
                title="Withdraw this invitation?"
                consequence={<><bdi>{i.email}</bdi> can no longer join with it. You can send a new one later.</>}
                action={revokeInvitationAction}
                submitLabel="Withdraw"
                pendingLabel="Withdrawing…"
                onDone={(r) => { if (r.ok) fold(i.id); }}
                trigger={<button type="button" className="btn" aria-label={`Withdraw invitation to ${i.email}`}>Withdraw</button>}
              >
                <input type="hidden" name="invitationId" value={i.id} />
              </ConfirmSheet>
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * The one place a project changes space. Both choices start blank (a project is never preselected), the button stays off until a
 * project is chosen, and moving into the common space asks first because it shows the project to everyone.
 */
export function MoveProjectForm({ projects, spaces }: { projects: { id: string; name: string }[]; spaces: { id: string; name: string }[] }) {
  const [project, setProject] = useState("");
  const [space, setSpace] = useState("");
  const name = projects.find((p) => p.id === project)?.name ?? "";
  const hidden = (
    <>
      <input type="hidden" name="projectId" value={project} />
      <input type="hidden" name="spaceId" value={space} />
    </>
  );
  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <label className="label" htmlFor="mv-project">Project</label>
        <Select id="mv-project" value={project} onChange={(e) => setProject(e.target.value)} className="select w-56">
          <option value="" disabled>Choose a project…</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </div>
      <div>
        <label className="label" htmlFor="mv-space">Into</label>
        <Select id="mv-space" value={space} onChange={(e) => setSpace(e.target.value)} className="select w-56">
          <option value="">Common space (everyone)</option>
          {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </Select>
      </div>
      {space === "" ? (
        <ConfirmSheet
          title={name ? `Show “${name}” to everyone?` : "Show this project to everyone?"}
          consequence="The common space is visible to everyone in the workspace. People outside the restricted space it comes from will see this project, its cards and its search results."
          action={setProjectSpaceAclAction}
          submitLabel="Move to common space"
          pendingLabel="Moving…"
          danger={false}
          onDone={(r) => { if (r.ok) setProject(""); }}
          trigger={<button type="button" className="btn" disabled={!project}>Move project</button>}
        >
          {hidden}
        </ConfirmSheet>
      ) : (
        <ActionForm action={setProjectSpaceAclAction} submitLabel="Move project" pendingLabel="Moving…" submitClassName="btn" resetOnSuccess={false} submitDisabled={!project} onDone={(r) => { if (r.ok) setProject(""); }} layout="inline">
          {hidden}
        </ActionForm>
      )}
    </div>
  );
}

/** Owner only. The box must be ticked before the button works, and the sheet names who becomes the owner. */
export function TransferForm({ admins }: { admins: { id: string; name: string }[] }) {
  const [to, setTo] = useState(admins[0]?.id ?? "");
  const [ok, setOk] = useState(false);
  const target = admins.find((a) => a.id === to)?.name ?? "";
  return (
    <div className="max-w-md">
      <label className="label" htmlFor="transfer-to">New owner</label>
      <Select id="transfer-to" value={to} onChange={(e) => setTo(e.target.value)} className="select w-full">{admins.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
      <label className="mt-3 flex min-h-10 w-fit cursor-pointer items-center gap-2 text-[13px]"><input type="checkbox" checked={ok} required onChange={(e) => setOk(e.target.checked)} /> I understand I become an admin and can no longer delete the workspace or move ownership.</label>
      <div className="mt-3">
        <ConfirmSheet
          title={`Make ${target} the owner?`}
          consequence={<><bdi>{target}</bdi> becomes the owner of this workspace and you become an admin. Only the new owner can move ownership again.</>}
          action={transferOwnershipAction}
          submitLabel="Transfer ownership"
          pendingLabel="Transferring…"
          trigger={<button type="button" className="btn btn-danger" disabled={!ok || !to}>Transfer ownership</button>}
        >
          <input type="hidden" name="memberId" value={to} />
          <input type="hidden" name="confirm" value="on" />
        </ConfirmSheet>
      </div>
    </div>
  );
}
