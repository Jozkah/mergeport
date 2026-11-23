"use client";

import { ActionForm } from "@/components/forms/ActionForm";
import type { ActionResult } from "@/lib/action-result";
import { plainText } from "@/lib/inputs";
import { startGithubConnectAction } from "@/app/github-actions";

/**
 * The address the action asked to go to, when it is a plain https one; anything else is never opened. In development only, a loopback
 * http address is accepted too, so the local fake GitHub (docs/dev-github-fake.md) works. NODE_ENV is fixed at build time, so a
 * production build never opens one.
 */
const OPENABLE = process.env.NODE_ENV === "production" ? /^https:\/\//i : /^(?:https:\/\/|http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])[:/])/i;
export function redirectOf(r: ActionResult): string | null {
  const to = r.ok ? r.data?.redirect : null;
  return typeof to === "string" && OPENABLE.test(to) ? to : null;
}

export function go(r: ActionResult): boolean {
  const to = redirectOf(r);
  if (to) window.location.assign(to);
  return r.ok && Boolean(to);
}

/** A success without a usable address would leave the button on "Redirecting…" for good: say so instead. */
const start = async (fd: FormData): Promise<ActionResult> => {
  const r = await startGithubConnectAction(fd);
  return r.ok && !redirectOf(r) ? { ok: false, error: "GitHub could not be reached from here. Nothing was connected. Try again." } : r;
};

/** Primary path: GitHub's install page, where the person picks the account and repositories. */
export function ConnectGithubForm() {
  return (
    <ActionForm action={start} submitLabel="Connect GitHub" pendingLabel="Opening GitHub…" resetOnSuccess={false} onDone={go} submitClassName="btn btn-primary btn-lg" className="max-w-md">
      <input type="hidden" name="mode" value="install" />
      <p className="text-[13px] text-ink-2">You will pick the GitHub account and the repositories on GitHub, then come back here. Mergeport only asks for read access.</p>
    </ActionForm>
  );
}

/** Second path: the App is already installed on an account the person owns; sign in with GitHub to prove it. */
export function UseExistingForm() {
  return (
    <ActionForm action={start} submitLabel="Use an existing installation" pendingLabel="Opening GitHub…" resetOnSuccess={false} onDone={go} submitClassName="btn btn-lg" className="max-w-md">
      <input type="hidden" name="mode" value="existing" />
      <label className="label" htmlFor="gh-account">GitHub account (only needed if you have several)</label>
      <input id="gh-account" name="account" type="text" inputMode="text" maxLength={39} placeholder="For example acme" aria-describedby="gh-account-help" className="input max-w-xs" autoCapitalize="none" {...plainText} />
      <p id="gh-account-help" className="mt-1 text-[12px] text-ink-3 text-pretty">You will sign in with GitHub so Mergeport can check that you control that installation. Mergeport does not keep that sign-in.</p>
    </ActionForm>
  );
}
