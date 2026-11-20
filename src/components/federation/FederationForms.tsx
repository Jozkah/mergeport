"use client";

import { ActionForm } from "@/components/forms/ActionForm";
import type { ActionResult } from "@/lib/action-result";
import { approveFederationAction, denyFederationAction, startLinkAction } from "@/app/federation-actions";

/** The action answered with an address in `data.redirect` (the other instance, or this one's callback): go there with a plain navigation. */
function go(r: ActionResult) {
  const to = r.ok ? r.data?.redirect : null;
  if (typeof to === "string" && /^https?:\/\//.test(to)) window.location.assign(to);
}

export function LinkInstanceForm() {
  return (
    <ActionForm action={startLinkAction} submitLabel="Link instance" pendingLabel="Contacting…" resetOnSuccess={false} onDone={go} className="max-w-md">
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

/** Approve / Deny on the consent page. `workspaces` is already filtered by this instance's policy. */
export function ConsentForms({ fields, workspaces }: { fields: Fields; workspaces: { id: string; name: string; role: string }[] }) {
  const only = workspaces.length === 1 ? workspaces[0].id : undefined;
  return (
    <div className="mt-5 flex flex-col gap-4">
      <ActionForm action={approveFederationAction} submitLabel="Approve read-only access" pendingLabel="Approving…" resetOnSuccess={false} onDone={go}>
        <Hidden f={fields} workspaceId={only} />
        {workspaces.length > 1 && (
          <>
            <label className="label" htmlFor="consent-ws">Workspace to share</label>
            <select id="consent-ws" name="workspaceId" className="select" defaultValue={workspaces[0].id}>
              {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
            </select>
          </>
        )}
      </ActionForm>
      <ActionForm action={denyFederationAction} submitLabel="Deny" pendingLabel="Denying…" resetOnSuccess={false} onDone={go} submitClassName="btn !h-10">
        <Hidden f={fields} workspaceId={only ?? workspaces[0]?.id} />
      </ActionForm>
    </div>
  );
}
