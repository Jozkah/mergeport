import { GITHUB_BACKEND, hubBackendId, type Backend } from "@/lib/local/backends";
import { readActive, readHubs } from "@/lib/local/registry";

export type WorkspaceEntry = { backend: Backend; label: string; detail?: string; available: boolean };

/** What the workspace switcher offers: GitHub, then every known hub server in the order it was added. */
export function listWorkspaces(home: string, _host: string, accountId: string): { active: Backend; entries: WorkspaceEntry[] } {
  const entries: WorkspaceEntry[] = [{ backend: GITHUB_BACKEND, label: "GitHub (repositories)", available: true }];
  for (const h of readHubs(home).sort((a, b) => a.addedAt.localeCompare(b.addedAt))) {
    let backend: Backend;
    try {
      backend = hubBackendId(h.origin);
    } catch {
      continue; // an origin that no longer normalizes cannot be switched to
    }
    const other = h.lastSignedInAs.id !== accountId;
    entries.push({ backend, label: h.teamName || h.origin, detail: other ? `Signed in as @${h.lastSignedInAs.login}` : h.origin, available: !other });
  }
  const wanted = readActive(home)?.backend ?? GITHUB_BACKEND;
  return { active: entries.some((e) => e.backend === wanted) ? wanted : GITHUB_BACKEND, entries };
}
