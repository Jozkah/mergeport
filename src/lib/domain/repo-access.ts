/** What GitHub itself reports about a repository for the signed-in account, turned into words. Nothing here is guessed. */

export type RepoPermissions = { admin?: boolean; maintain?: boolean; push?: boolean; triage?: boolean; pull?: boolean } | null | undefined;
export type OwnerKind = "USER" | "ORGANIZATION" | "UNKNOWN";

export type RepoAccess = { level: "admin" | "maintain" | "write" | "triage" | "read" | "unknown"; label: string; detail: string };

/** The strongest permission GitHub reports for this account. Missing permissions are "unknown", never "read". */
export function describeAccess(p: RepoPermissions): RepoAccess {
  if (!p || typeof p !== "object") return { level: "unknown", label: "Access unknown", detail: "GitHub did not report your permission on this repository." };
  if (p.admin) return { level: "admin", label: "Admin", detail: "You can read, change work items and administer this repository." };
  if (p.maintain) return { level: "maintain", label: "Maintain", detail: "You can read and change work items and manage the repository without administering it." };
  if (p.push) return { level: "write", label: "Write", detail: "You can read and change issues and pull requests, and push." };
  if (p.triage) return { level: "triage", label: "Triage", detail: "You can read, and manage issues and pull requests (labels, assignees); you cannot push." };
  if (p.pull) return { level: "read", label: "Read only", detail: "You can read this repository. Comments, reviews and merges may be refused by GitHub." };
  return { level: "unknown", label: "Access unknown", detail: "GitHub did not report your permission on this repository." };
}

/** Account type comes from GitHub's `owner.type`, never from the shape of the name. */
export function describeOwner(kind: OwnerKind | string | undefined, ownerLogin: string, viewerLogin: string): { label: string; detail: string } {
  if (kind === "ORGANIZATION") return { label: "Organization", detail: `${ownerLogin} is an organization account.` };
  if (kind === "USER") return ownerLogin.toLowerCase() === viewerLogin.toLowerCase() ? { label: "Personal", detail: "Owned by your own account." } : { label: "Other user", detail: `${ownerLogin} is another person's account; you are a collaborator.` };
  return { label: "Owner type unknown", detail: "GitHub did not report the account type." };
}
