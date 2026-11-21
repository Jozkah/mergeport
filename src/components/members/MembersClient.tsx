"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { ConfirmSheet } from "@/components/forms/ConfirmSheet";
import { RoleChip } from "@/components/ui/identity";
import { Select } from "@/components/ui/Select";
import { CircleAlert } from "@/components/ui/icons";
import {
  changeRoleAction, reinstateMemberAction, removeMemberAction, resendInvitationAction, revokeInvitationAction, setProjectSpaceAclAction, transferOwnershipAction,
} from "@/app/workspace-actions";
import { ROLE_LABEL, type Role } from "@/lib/authz/roles";
import { formatDateOnly } from "@/lib/format";
import { FOLD_MS } from "@/lib/motion";

export type MemberView = { id: string; name: string; sub: string | null; role: Role; isSelf: boolean; manageable: boolean; removeText: string };
export type InvitationView = { id: string; email: string; role: Role; sendFailed: boolean; expired: boolean; expiresAt: string };

const ROLE_OPTIONS = (
  <>
    <option value="ADMIN">Admin</option>
    <option value="MEMBER">Member</option>
    <option value="READER">Reader</option>
  </>
);

/** Rows are separated by their own borders: the folding animation must not pull in a list gap. */
const NO_GAP = { "--row-gap": "0px" } as CSSProperties;

/**
 * Rows that fold away after a success (the same leaving-Set + `.row-leave` pattern as the AI approvals): the server answer already
 * drops the row from `rows`, so a leaving row is kept from the previous list, at the index it had, until its animation has run.
 * Nothing animates on a plain refresh, and nothing on first mount. When the row that held the keyboard is gone, focus moves to a
 * status line (`status`, rendered by the caller) instead of dropping to the page.
 */
function useFoldedRows<T extends { id: string }>(rows: T[]) {
  const [seen, setSeen] = useState(rows);
  const [list, setList] = useState(rows);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const noteEl = useRef<HTMLParagraphElement>(null);
  if (rows !== seen) {
    setSeen(rows);
    setList((prev) => {
      const out = [...rows];
      prev.forEach((p, i) => {
        if (leaving.has(p.id) && !rows.some((r) => r.id === p.id)) out.splice(Math.min(i, out.length), 0, p);
      });
      return out;
    });
  }
  const fold = (id: string, text?: string) => {
    setLeaving((l) => new Set(l).add(id));
    if (text) setNote(text);
    setTimeout(() => {
      setLeaving((l) => {
        const n = new Set(l);
        n.delete(id);
        return n;
      });
      setList((l) => l.filter((x) => x.id !== id));
      // The trigger that held focus left with its row: say what happened and keep the keyboard on the page.
      setTimeout(() => {
        if (typeof document !== "undefined" && (document.activeElement === document.body || !document.activeElement)) noteEl.current?.focus();
      }, 0);
    }, FOLD_MS);
  };
  const status = <p ref={noteEl} tabIndex={-1} role="status" className="sr-only outline-none">{note}</p>;
  return { list, leaving, fold, status };
}

/** A role picker that saves by choosing. Promoting to, or demoting from, admin asks first (it changes what that person can do). */
function RoleCell({ m }: { m: MemberView }) {
  const [ask, setAsk] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const saved = useRef(false);
  const involvesAdmin = (next: string) => (next === "ADMIN") !== (m.role === "ADMIN");
  return (
    <>
      <ActionForm key={nonce} action={changeRoleAction} submitLabel="Save role" hideSubmit resetOnSuccess={false} layout="inline" className="flex items-center gap-2">
        <input type="hidden" name="memberId" value={m.id} />
        <Select
          name="role"
          aria-label={`Role for ${m.name}`}
          defaultValue={m.role}
          autoSubmit={(next) => {
            if (!involvesAdmin(next)) return true;
            saved.current = false;
            setAsk(next);
            return false;
          }}
          className="select w-32"
        >{ROLE_OPTIONS}</Select>
      </ActionForm>
      <ConfirmSheet
        open={ask !== null}
        onOpenChange={(o) => {
          if (o) return;
          setAsk(null);
          if (!saved.current) setNonce((n) => n + 1); // cancelled: the picker goes back to the stored role
        }}
        title={ask === "ADMIN" ? `Make ${m.name} an admin?` : `Remove admin rights from ${m.name}?`}
        consequence={ask === "ADMIN"
          ? <><bdi>{m.name}</bdi> will be able to invite and remove people, change roles and manage projects and spaces.</>
          : <><bdi>{m.name}</bdi> loses admin rights and becomes {ask ? `a ${ROLE_LABEL[ask as Role]?.toLowerCase() ?? "member"}` : "a member"}.</>}
        action={changeRoleAction}
        submitLabel={ask === "ADMIN" ? "Make admin" : "Change role"}
        pendingLabel="Saving…"
        danger={false}
        onDone={(r) => { saved.current = r.ok; }}
      >
        <input type="hidden" name="memberId" value={m.id} />
        <input type="hidden" name="role" value={ask ?? m.role} />
      </ConfirmSheet>
    </>
  );
}

export function ActiveMembers({ members }: { members: MemberView[] }) {
  const { list, leaving, fold, status } = useFoldedRows(members);
  return (
    <>
    {status}
    <ul style={NO_GAP}>
      {list.map((m) => (
        <li key={m.id} className={`border-b border-line last:border-b-0 ${leaving.has(m.id) ? "row-leave" : ""}`}>
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="min-w-0 flex-1">
              <p className="wrap-any font-medium"><bdi>{m.name}</bdi>{m.isSelf && <span className="ml-1 font-normal text-ink-3">(you)</span>}</p>
              {m.sub && <p className="truncate text-[12.5px] text-ink-3"><bdi>{m.sub}</bdi></p>}
            </div>
            {m.manageable ? (
              <div className="flex flex-wrap items-center gap-2">
                {/* Choosing a role saves it: no separate Save button to forget (admin changes ask first). */}
                <RoleCell m={m} />
                <ConfirmSheet
                  title={`Remove ${m.name}?`}
                  consequence={m.removeText}
                  action={removeMemberAction}
                  submitLabel="Remove"
                  pendingLabel="Removing…"
                  onDone={(r) => { if (r.ok) fold(m.id, `${m.name} was removed.`); }}
                  trigger={<button type="button" className="btn text-blocked" aria-label={`Remove ${m.name}`}>Remove</button>}
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
    </>
  );
}

export function RemovedMembers({ members }: { members: { id: string; name: string }[] }) {
  const { list, leaving, fold, status } = useFoldedRows(members);
  return (
    <>
    {status}
    <ul className="-mx-1 max-h-72 overflow-y-auto px-1" style={NO_GAP} tabIndex={0} aria-label="Removed people">
      {list.map((m) => (
        <li key={m.id} className={`border-b border-line last:border-b-0 ${leaving.has(m.id) ? "row-leave" : ""}`}>
          <div className="flex flex-wrap items-center justify-between gap-3 py-2">
            <span className="wrap-any min-w-0 max-w-full"><bdi>{m.name}</bdi> <span className="text-ink-3">(removed)</span></span>
            <ActionForm action={reinstateMemberAction} submitLabel="Reinstate" pendingLabel="Reinstating…" submitAriaLabel={`Reinstate ${m.name}`} onDone={(r) => { if (r.ok) fold(m.id, `${m.name} was reinstated.`); }} layout="inline" className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="memberId" value={m.id} />
              <span className="text-[12.5px] text-ink-3" aria-hidden>as</span>
              <Select name="role" aria-label={`Role for ${m.name} when reinstated`} defaultValue="MEMBER" className="select w-32">{ROLE_OPTIONS}</Select>
            </ActionForm>
          </div>
        </li>
      ))}
    </ul>
    </>
  );
}

/** One fixed format (en-US, UTC calendar day) on server and browser, so the text is identical in both and never flips after hydration. */
export function ExpiresOn({ iso }: { iso: string }) {
  return <time dateTime={iso} className="tnum">{formatDateOnly(new Date(iso))}</time>;
}

export function PendingInvitations({ invitations }: { invitations: InvitationView[] }) {
  const { list, leaving, fold, status } = useFoldedRows(invitations);
  // A row that was not in the previous render rises in once. `known` holds the ids seen at the last paint (null until the first), so
  // the initial list and a plain refresh never animate. The effect depends on the ids only: recording them must not re-trigger it.
  const [known, setKnown] = useState<Set<string> | null>(null);
  const primed = useRef(false);
  const ids = invitations.map((i) => i.id).join(",");
  useEffect(() => {
    const t = setTimeout(() => {
      setKnown(new Set(ids ? ids.split(",") : []));
      primed.current = true;
    }, primed.current ? FOLD_MS : 0);
    return () => clearTimeout(t);
  }, [ids]);
  return (
    <>
    {status}
    <ul className="-mx-1 mt-3 max-h-72 overflow-y-auto px-1" style={NO_GAP} tabIndex={0} aria-label="Pending invitations">
      {list.map((i) => (
        <li key={i.id} className={`border-b border-line last:border-b-0 ${leaving.has(i.id) ? "row-leave" : known && !known.has(i.id) ? "card-enter" : ""}`}>
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
                onDone={(r) => { if (r.ok) fold(i.id, `The invitation to ${i.email} was withdrawn.`); }}
                trigger={<button type="button" className="btn" aria-label={`Withdraw invitation to ${i.email}`}>Withdraw</button>}
              >
                <input type="hidden" name="invitationId" value={i.id} />
              </ConfirmSheet>
            </span>
          </div>
        </li>
      ))}
    </ul>
    </>
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
  const why = "Choose a project first.";
  return (
    <div className="flex flex-wrap items-end gap-3">
      {!project ? <span id="mv-why" className="sr-only">{why}</span> : null}
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
          trigger={<button type="button" className="btn" disabled={!project} aria-describedby={!project ? "mv-why" : undefined}>Move project</button>}
        >
          {hidden}
        </ConfirmSheet>
      ) : (
        <ActionForm action={setProjectSpaceAclAction} submitLabel="Move project" pendingLabel="Moving…" submitClassName="btn" resetOnSuccess={false} submitDisabled={!project} submitDisabledReason={why} onDone={(r) => { if (r.ok) setProject(""); }} layout="inline">
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
      <label className="check-row mt-3 w-fit text-[13px]"><input type="checkbox" checked={ok} required onChange={(e) => setOk(e.target.checked)} /> I understand I become an admin and can no longer delete the workspace or move ownership.</label>
      {!ok ? <span id="transfer-why" className="sr-only">Tick the box above to confirm first.</span> : null}
      <div className="mt-3">
        <ConfirmSheet
          title={`Make ${target} the owner?`}
          consequence={<><bdi>{target}</bdi> becomes the owner of this workspace and you become an admin. Only the new owner can move ownership again.</>}
          action={transferOwnershipAction}
          submitLabel="Transfer ownership"
          pendingLabel="Transferring…"
          trigger={<button type="button" className="btn text-blocked" disabled={!ok || !to} aria-describedby={!ok ? "transfer-why" : undefined}>Transfer ownership</button>}
        >
          <input type="hidden" name="memberId" value={to} />
          <input type="hidden" name="confirm" value="on" />
        </ConfirmSheet>
      </div>
    </div>
  );
}
