"use client";

import { useState, useTransition, type FormEvent } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { CircleAlert, LoaderCircle } from "@/components/ui/icons";
import { Select } from "@/components/ui/Select";
import type { ActionResult } from "@/lib/action-result";
import { approveFederationAction, denyFederationAction, startLinkAction } from "@/app/federation-actions";

/** The action answered with an address in `data.redirect` (the other instance, or this one's callback): go there with a plain navigation. */
function go(r: ActionResult) {
  const to = r.ok ? r.data?.redirect : null;
  if (typeof to === "string" && /^https?:\/\//.test(to)) window.location.assign(to);
}

export function LinkInstanceForm() {
  return (
    <ActionForm action={startLinkAction} submitLabel="Link instance" pendingLabel="Contacting…" resetOnSuccess={false} onDone={(r) => { go(r); return r.ok; }} className="max-w-md">
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
      setResult(r);
      if (r.ok) {
        setHolding(true); // stay disabled until the browser leaves this page
        go(r);
      }
    });
  }

  const label = (kind: "approve" | "deny", idle: string, doing: string) => (
    <>
      {busy && chosen === kind ? <LoaderCircle size={14} aria-hidden className="shrink-0 animate-spin motion-reduce:animate-none" /> : null}
      <span className="inline-grid text-center">
        <span className={`col-start-1 row-start-1 ${busy && chosen === kind ? "invisible" : ""}`}>{idle}</span>
        <span className={`col-start-1 row-start-1 ${busy && chosen === kind ? "" : "invisible"}`} aria-hidden={!(busy && chosen === kind)}>{holding ? "Redirecting…" : doing}</span>
      </span>
    </>
  );

  return (
    <form onSubmit={submit} className="mt-5" aria-busy={busy}>
      <Hidden f={fields} workspaceId={only} />
      {workspaces.length > 1 && (
        <div className="mb-4">
          <label className="label" htmlFor="consent-ws">Workspace to share</label>
          <Select id="consent-ws" name="workspaceId" defaultValue={workspaces[0].id} required>
            {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <button type="submit" name="intent" value="approve" className="btn btn-primary btn-lg w-full sm:flex-1" disabled={busy} data-loading={busy && chosen === "approve"}>
          {label("approve", "Approve read-only access", "Approving…")}
        </button>
        <button type="submit" name="intent" value="deny" className="btn btn-lg w-full sm:flex-1" disabled={busy} data-loading={busy && chosen === "deny"}>
          {label("deny", "Deny", "Denying…")}
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
