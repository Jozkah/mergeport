"use client";

import { ActionForm } from "@/components/forms/ActionForm";
import { ConfirmSheet } from "@/components/forms/ConfirmSheet";
import type { ActionResult } from "@/lib/action-result";
import { Unplug } from "@/components/ui/icons";
import { checkGithubAccessAction, startGithubLinkAction, unlinkGithubAction } from "@/app/github-link-actions";
import { go, redirectOf } from "./GithubConnectForms";

/** A success without a usable address would leave the button on "Redirecting…" for good: say so instead. */
const start = async (fd: FormData): Promise<ActionResult> => {
  const r = await startGithubLinkAction(fd);
  return r.ok && !redirectOf(r) ? { ok: false, error: "GitHub could not be reached from here. Nothing was linked. Try again." } : r;
};

/** The one way to link: sends the browser to GitHub to authorize, then GitHub sends it back. `primary` for the main action of a panel; a plain button inside a banner. */
export function LinkGithubForm({ primary = true, label = "Link GitHub" }: { primary?: boolean; label?: string }) {
  return (
    <ActionForm action={start} submitLabel={label} pendingLabel="Opening GitHub…" resetOnSuccess={false} onDone={go} submitClassName={primary ? "btn btn-primary btn-lg" : "btn"} layout="inline">
      <></>
    </ActionForm>
  );
}

export function CheckAccessForm() {
  return (
    <ActionForm action={checkGithubAccessAction} submitLabel="Check again" pendingLabel="Checking…" resetOnSuccess={false} layout="inline" submitClassName="btn">
      <></>
    </ActionForm>
  );
}

export function UnlinkGithubButton({ login }: { login: string | null }) {
  return (
    <ConfirmSheet
      title="Unlink your GitHub account?"
      consequence={<>Mergeport stops using {login ? <bdi>@{login}</bdi> : "your GitHub account"} and forgets the sign-in it kept. Repositories you can only open through GitHub are hidden from you again, unless an administrator gave you access. Nothing changes on GitHub, and you can link it again later.</>}
      action={unlinkGithubAction}
      submitLabel="Unlink"
      pendingLabel="Unlinking…"
      trigger={<button type="button" className="btn text-blocked"><Unplug size={14} aria-hidden />Unlink</button>}
    >
      <></>
    </ConfirmSheet>
  );
}
