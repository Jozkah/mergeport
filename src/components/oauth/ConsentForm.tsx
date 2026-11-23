"use client";

import { useState } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { RoleChip } from "@/components/ui/identity";
import { can, type Role } from "@/lib/authz/roles";
import type { ActionResult } from "@/lib/action-result";
import { decideOAuthAction } from "@/app/oauth-actions";

export type ConsentRequest = { clientId: string; redirectUri: string; state?: string; codeChallenge: string; resource: string };
export type ConsentWorkspace = { id: string; name: string; role: Role };

/** Only an address the server built from a registered redirect address: https, or http on a loopback name. Anything else is never opened. */
const SAFE_TARGET = /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|\?|$))/i;
function go(r: ActionResult): boolean {
  const to = r.ok ? r.data?.redirect : null;
  if (typeof to !== "string" || !SAFE_TARGET.test(to)) return false;
  window.location.assign(to);
  return true;
}

function Hidden({ req, csrf }: { req: ConsentRequest; csrf: string }) {
  return (
    <>
      <input type="hidden" name="csrf" value={csrf} />
      <input type="hidden" name="client_id" value={req.clientId} />
      <input type="hidden" name="redirect_uri" value={req.redirectUri} />
      <input type="hidden" name="code_challenge" value={req.codeChallenge} />
      <input type="hidden" name="resource" value={req.resource} />
      {req.state !== undefined && <input type="hidden" name="state" value={req.state} />}
    </>
  );
}

/** Allow or Cancel. The workspace is a choice among the person's own; read and write is offered only where their role may change things. */
export function ConsentForm({ req, csrf, workspaces, wantsWrite, defaultWorkspace }: { req: ConsentRequest; csrf: string; workspaces: ConsentWorkspace[]; wantsWrite: boolean; defaultWorkspace: string }) {
  const [ws, setWs] = useState(workspaces.some((w) => w.id === defaultWorkspace) ? defaultWorkspace : workspaces[0].id);
  const [scope, setScope] = useState<"READ" | "WRITE">("READ");
  const canWrite = can({ role: workspaces.find((w) => w.id === ws)?.role ?? "READER" }, "write");
  const effective = canWrite ? scope : "READ";

  async function deny(): Promise<void> {
    const fd = new FormData();
    fd.set("csrf", csrf);
    fd.set("client_id", req.clientId);
    fd.set("redirect_uri", req.redirectUri);
    fd.set("code_challenge", req.codeChallenge);
    fd.set("resource", req.resource);
    if (req.state !== undefined) fd.set("state", req.state);
    fd.set("decision", "deny");
    go(await decideOAuthAction(fd));
  }

  return (
    <ActionForm
      action={decideOAuthAction}
      submitLabel="Allow"
      pendingLabel="Connecting…"
      resetOnSuccess={false}
      onDone={go}
      className="mt-5 flex flex-col gap-5"
      secondary={<button type="button" className="btn btn-lg" onClick={() => void deny()}>Cancel</button>}
      submitClassName="btn btn-primary btn-lg"
    >
      <Hidden req={req} csrf={csrf} />
      <input type="hidden" name="decision" value="approve" />
      <fieldset className="min-w-0">
        <legend className="label">Workspace</legend>
        <div className="flex flex-col gap-1">
          {workspaces.map((w) => (
            <label key={w.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[8px] border border-line px-3 py-2 text-[13px] has-[:checked]:border-line-strong has-[:checked]:bg-subtle">
              <input type="radio" name="workspace" value={w.id} checked={ws === w.id} onChange={() => setWs(w.id)} />
              <span className="min-w-0 flex-1 truncate font-medium" translate="no"><bdi>{w.name}</bdi></span>
              <RoleChip role={w.role} />
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="min-w-0">
        <legend className="label">Access</legend>
        <div className="flex flex-col gap-1">
          <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-[8px] border border-line px-3 py-2 text-[13px] has-[:checked]:border-line-strong has-[:checked]:bg-subtle">
            <input type="radio" name="scope" value="READ" checked={effective === "READ"} onChange={() => setScope("READ")} className="mt-0.5" />
            <span><span className="font-medium">Read only</span><span className="block text-[12px] text-ink-3">Look at projects and tasks you can see.</span></span>
          </label>
          <label className={`flex min-h-11 items-start gap-3 rounded-[8px] border border-line px-3 py-2 text-[13px] has-[:checked]:border-line-strong has-[:checked]:bg-subtle ${canWrite ? "cursor-pointer" : "opacity-60"}`}>
            <input type="radio" name="scope" value="WRITE" checked={effective === "WRITE"} disabled={!canWrite} onChange={() => setScope("WRITE")} className="mt-0.5" />
            <span>
              <span className="font-medium">Read, open tasks and comment</span>
              <span className="block text-[12px] text-ink-3">{canWrite ? (wantsWrite ? "This app asked for this." : "Not editing, moving or deleting.") : "Your role here is read-only."}</span>
            </span>
          </label>
        </div>
      </fieldset>
    </ActionForm>
  );
}
