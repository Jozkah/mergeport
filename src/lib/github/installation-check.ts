import type { Db } from "@/lib/db";
import { audit } from "@/lib/services/audit";
import { githubAppConfig } from "./app-config";
import { markInstallationState, refreshInstallationFacts } from "./binding";
import { connectOverrides } from "./connect";
import { fetchInstallationFacts } from "./connect-api";
import { githubAppFetch } from "./transport";

/**
 * The authoritative reaction to an installation lifecycle webhook. A webhook only says "something happened to installation N": its
 * action word is never trusted, because deliveries arrive late and out of order (a late `suspend` after an `unsuspend` would otherwise
 * win). This job (`github.installation.check`, deduplicated per installation) asks GitHub as the App, `GET /app/installations/:id`, and
 * records what GitHub answers NOW: 404 = deleted, `suspended_at` set = suspended, otherwise active. Audit rows (one per bound workspace)
 * are written only when the recorded state really changes. A failed request throws, so the job backs off and tries again.
 */

export type InstallationLiveState = "active" | "suspended" | "deleted";

const stateOf = (r: { suspendedAt: Date | null; deletedAt: Date | null }): InstallationLiveState => (r.deletedAt ? "deleted" : r.suspendedAt ? "suspended" : "active");

export async function checkInstallationFromGithub(db: Db, installationId: bigint): Promise<InstallationLiveState | null> {
  const config = githubAppConfig();
  if (!config) return null;
  const before = await db.githubInstallation.findUnique({ where: { installationId }, select: { suspendedAt: true, deletedAt: true } });
  if (!before) return null; // never create an installation from a webhook
  const facts = await fetchInstallationFacts(config, { ...(connectOverrides()?.deps ?? {}), fetch: githubAppFetch() ?? connectOverrides()?.deps?.fetch }, installationId);
  let next: InstallationLiveState;
  if (!facts) {
    await markInstallationState(db, installationId, "deleted");
    next = "deleted";
  } else {
    await refreshInstallationFacts(db, facts);
    next = facts.suspendedAt ? "suspended" : "active";
  }
  if (next !== stateOf(before)) {
    const bindings = await db.workspaceInstallation.findMany({ where: { installationId }, select: { workspaceId: true }, orderBy: { workspaceId: "asc" } });
    for (const b of bindings) await audit(db, { workspaceId: b.workspaceId, userId: null }, `github.installation-${next}`, { type: "GithubInstallation", id: String(installationId) }, { source: "webhook" });
  }
  return next;
}
