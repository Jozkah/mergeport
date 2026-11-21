"use client";

import { useEffect, useState, useTransition, type FormEvent } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { CircleAlert } from "@/components/ui/icons";
import { PendingLabel } from "@/components/ui/PendingLabel";
import { Select } from "@/components/ui/Select";
import type { ActionResult } from "@/lib/action-result";
import { approveFederationAction, denyFederationAction, startLinkAction } from "@/app/federation-actions";

/** The address the action asked to go to, when it is a plain http(s) one; any other scheme or a relative address is never opened. */
function redirectOf(r: ActionResult): string | null {
  const to = r.ok ? r.data?.redirect : null;
  return typeof to === "string" && /^https?:\/\//i.test(to) ? to : null;
}

/** The action answered with an address in `data.redirect` (the other instance, or this one's callback): go there with a plain navigation. */
function go(r: ActionResult) {
  const to = redirectOf(r);
  if (to) window.location.assign(to);
}

/** A success that carries no usable address would leave the button on "Redirecting…" for good: say so instead. */
function checked(r: ActionResult, field?: string): ActionResult {
  if (r.ok && !redirectOf(r)) return { ok: false, error: "The other instance answered with an address that cannot be opened. Nothing was shared. Check the address and try again.", field };
  return r;
}

export function LinkInstanceForm() {
  return (
    <ActionForm action={async (fd) => checked(await startLinkAction(fd), "address")} submitLabel="Link instance" pendingLabel="Contacting…" resetOnSuccess={false} onDone={(r) => { go(r); return r.ok; }} className="max-w-md">
      <label className="label" htmlFor="peer-address">Address of the other Mergeport instance</label>
      <input id="peer-address" name="address" type="text" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://mergeport.example.com" required maxLength={300} className="input" aria-describedby="peer-address-help" />
      <p id="peer-address-help" className="mt-1 text-[12px] text-ink-3 text-pretty">You will sign in there and approve read-only access. Nothing is copied here: that instance keeps the data.</p>
    </ActionForm>
  );
}

type Fields = { clientOrigin: string; redirectUri: string; state: string; codeChallenge: string; csrf: string };

function Hidden({ f, workspaceId }: { f: Fields; workspaceId?: string }) {
  return (
    <>
      <input type="hidden" name="client_origin" value={f.clientOrigin} />
      <input type="hidden" name="redirect_uri" value={f.redirectUri} />
      <input type="hidden" name="state" value={f.state} />
      <input type="hidden" name="code_challenge" value={f.codeChallenge} />
      <input type="hidden" name="scope" value="read" />
      <input type="hidden" name="csrf" value={f.csrf} />
      {workspaceId && <input type="hidden" name="workspaceId" value={workspaceId} />}
    </>
  );
}

/**
 * Approve / Deny on the consent page: ONE form with two submit buttons of the same size and one pending state. Pressing either
 * disables both until the page navigates away (the redirect to the other instance), so Approve cannot be double-clicked and Deny
 * cannot be pressed while Approve is pending. `workspaces` is already filtered by this instance's policy.
 */
export function ConsentForms({ fields, workspaces }: { fields: Fields; workspaces: { id: string; name: string; role: string }[] }) {
  const only = workspaces.length === 1 ? workspaces[0].id : undefined;
  const [pending, start] = useTransition();
  const [chosen, setChosen] = useState<"approve" | "deny" | null>(null);
  const [holding, setHolding] = useState(false);
  const [result, setResult] = useState<ActionResult | null>(null);
  const busy = pending || holding;
  useEffect(() => {
    if (!holding) return;
    const t = setTimeout(() => setHolding(false), 10_000);
    return () => clearTimeout(t);
  }, [holding]);

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    const kind = submitter?.value === "deny" ? "deny" : "approve";
    const fd = new FormData(e.currentTarget);
    setChosen(kind);
    setResult(null);
    start(async () => {
      let r: ActionResult;
      try {
        r = await (kind === "deny" ? denyFederationAction(fd) : approveFederationAction(fd));
      } catch {
        r = { ok: false, error: "Could not reach the server. Check your connection and try again.", retryable: true };
      }
      r = checked(r);
      setResult(r);
      if (r.ok) {
        setHolding(true); // stay busy until the browser leaves this page (let go after a while if it never does)
        go(r);
      }
    });
  }

  const label = (kind: "approve" | "deny", idle: string, doing: string) => (
    <PendingLabel mode={busy && chosen === kind ? (holding ? "hold" : "pending") : "idle"} pending={doing} hold="Redirecting…">{idle}</PendingLabel>
  );

  return (
    <form onSubmit={submit} className="mt-5" aria-busy={busy}>
      <Hidden f={fields} workspaceId={only} />
      {workspaces.length > 1 && (
        <div className="mb-4">
          <label className="label" htmlFor="consent-ws">Workspace to share</label>
          <Select id="consent-ws" name="workspaceId" defaultValue={workspaces[0].id} required disabled={busy}>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </div>
      )}
      {/* Primary on top on a phone, rightmost from sm up. aria-disabled (not disabled) keeps keyboard focus on the pressed button. */}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button type="submit" name="intent" value="deny" className="btn btn-lg w-full sm:w-auto sm:min-w-32" aria-disabled={busy || undefined} data-loading={busy && chosen === "deny"} onClick={(e) => { if (busy) e.preventDefault(); }}>
          {label("deny", "Deny", "Denying…")}
        </button>
        <button type="submit" name="intent" value="approve" className="btn btn-primary btn-lg w-full sm:w-auto sm:min-w-48" aria-disabled={busy || undefined} data-loading={busy && chosen === "approve"} onClick={(e) => { if (busy) e.preventDefault(); }}>
          {label("approve", "Approve read-only access", "Approving…")}
        </button>
      </div>
      <p role="status" aria-live="polite" className="mt-2 min-h-5 text-[12.5px]">
        {result?.ok && <span className="result-in text-ink-2">{result.message}</span>}
      </p>
      <p role="alert" className="min-h-5 text-[12.5px]">
        {result && !result.ok && <span className="result-in inline-flex items-start gap-1 text-blocked"><CircleAlert size={14} aria-hidden className="mt-0.5 shrink-0" /> {result.error}</span>}
      </p>
    </form>
  );
}
