import { joinSpaceAction } from "@/app/team-actions";
import { ActionForm } from "@/components/forms/ActionForm";
import { Mono, SimplePill } from "@/components/ui/primitives";
import { Lock, ShieldCheck } from "@/components/ui/icons";
import type { SpaceCandidate } from "@/lib/team/service";

const WHY: Record<string, string> = {
  "already-joined": "Already joined",
  "needs-team": "Join the common space first",
  "unsupported-schema": "Needs a newer Mergeport",
  "other-team": "Belongs to a different team",
  "untrusted-owner": "Not trusted: unexpected owner",
  "identity-changed": "Not trusted: a different repository",
  "not-private": "Not private",
  fork: "A fork",
  "no-manifest": "Not a Mergeport space",
  "invalid-manifest": "Invalid manifest",
  "no-access": "No access",
  unavailable: "Could not be inspected",
};

const entityLine = (c: Record<string, number>) => {
  const parts = Object.entries(c).map(([k, n]) => `${n} ${k}${n === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : "no shared items yet";
};

/**
 * What a person reviews BEFORE joining: who owns it, that it is private, which team it claims, what access they would
 * have, what joining downloads and what it publishes. Nothing here has been imported. Only the explicit Join button, with
 * its confirmation box, imports shared state and starts syncing. Rejected candidates are shown with the reason and no button.
 */
export function CandidateCard({ c }: { c: SpaceCandidate }) {
  const joinable = c.status === "joinable";
  return (
    <li className="rounded-[10px] border border-line p-3 text-[13px]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-2 font-medium"><Mono>{c.fullName}</Mono>{c.spaceKind && <SimplePill tone={c.spaceKind === "COMMON" ? "needs" : "waiting"}>{c.spaceKind === "COMMON" ? "Common space" : "Restricted audience"}</SimplePill>}{!joinable && <SimplePill tone={c.status === "already-joined" ? "ok" : "blocked"}>{WHY[c.status] ?? c.status}</SimplePill>}</p>
      </div>
      <dl className="mt-2 grid grid-cols-[120px_1fr] gap-y-1 text-[12.5px]">
        <dt className="text-ink-3">Owner</dt><dd>{c.owner}</dd>
        <dt className="text-ink-3">Visibility</dt><dd className="inline-flex items-center gap-1"><Lock size={12} aria-hidden /> {c.visibility}</dd>
        <dt className="text-ink-3">Team</dt><dd>{c.teamName ?? "unknown"}{c.createdBy ? <> · created by @{c.createdBy.login}</> : null}</dd>
        <dt className="text-ink-3">Your access</dt><dd>{c.expectedAccess === "none" ? "none" : c.expectedAccess === "admin" ? "admin (you could invite people)" : c.expectedAccess === "write" ? "write (you could edit shared data)" : "read only"}</dd>
        {c.schema !== null && (<><dt className="text-ink-3">Contains</dt><dd>{entityLine(c.entityCounts)}</dd></>)}
      </dl>
      {c.reason && !joinable && <p className="mt-2 text-[12.5px] text-ink-2">{c.reason}</p>}
      {c.warnings.map((w) => <p key={w} className="mt-2 text-[12.5px] text-waiting">{w}</p>)}
      {joinable && (
        <ActionForm action={joinSpaceAction} submitLabel="Join this space" pendingLabel="Joining…" resetOnSuccess={false} className="mt-3" submitAriaLabel={`Join ${c.fullName}`}>
          <input type="hidden" name="repo" value={c.fullName} />
          <input type="hidden" name="repoId" value={c.repoId} />
          <div className="rounded-[8px] border border-line bg-canvas p-2.5 text-[12.5px] text-ink-2">
            <p className="flex items-start gap-1.5"><ShieldCheck size={13} aria-hidden className="mt-0.5 shrink-0" /><span><strong className="font-medium text-ink">Downloads.</strong> {c.downloads}</span></p>
            <p className="mt-1.5 pl-[19px]"><strong className="font-medium text-ink">Publishes.</strong> {c.publishes}</p>
          </div>
          <label className="mt-2 flex items-start gap-2"><input type="checkbox" name="confirm" required className="mt-1" /> <span>I have reviewed this repository and want to join it.</span></label>
        </ActionForm>
      )}
    </li>
  );
}
