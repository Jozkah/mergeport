import Link from "next/link";
import { Banner } from "@/components/ui/primitives";
import type { ConnectionState } from "@/lib/github/connection-state";

/**
 * The banner a hosted workspace shows while GitHub is not usable. Owners and administrators get the way to fix it (a link to
 * Settings > GitHub); everyone else gets plain text that says who to ask. Nothing is shown while a connection is active.
 */
export function GithubConnectionBanner({ state, manage }: { state: ConnectionState; manage: boolean }) {
  if (state === "ok") return null;
  const action = manage ? <Link href="/settings/github" prefetch={false} className="btn shrink-0">{state === "none" ? "Connect GitHub" : "Open GitHub settings"}</Link> : undefined;
  const ask = manage ? "" : " Ask the owner or an administrator.";
  if (state === "none") {
    return (
      <Banner tone="warn" dismissible storageKey="github-not-connected" title="GitHub is not connected yet" action={action}>
        Repository sync and GitHub actions are off. Your workspace data is still here.{ask}
      </Banner>
    );
  }
  if (state === "suspended") {
    return (
      <Banner tone="warn" title="GitHub is suspended for this workspace" action={action}>
        The GitHub account owner suspended the Mergeport App. Repository sync is off until it is unsuspended on GitHub. Your workspace data is still here.{ask}
      </Banner>
    );
  }
  return (
    <Banner tone="warn" title="GitHub was removed for this workspace" action={action}>
      The Mergeport App was uninstalled on GitHub. Repository sync is off until GitHub is connected again. Your workspace data is still here.{ask}
    </Banner>
  );
}
