import type { Db } from "@/lib/db";

/** The reason text marks the rule a project's "required reviewers" setting owns, so editing the setting never touches rules written by hand. */
export const projectRuleReason = (projectName: string) => `Required by project ${projectName}: its pull requests need a review from the named people`;
const OWNED = "Required by project ";

export function parseReviewerRefs(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\s]+/)) {
    const ref = raw.trim().replace(/^@/, "");
    if (!ref || seen.has(ref.toLowerCase())) continue;
    seen.add(ref.toLowerCase());
    out.push(ref);
  }
  return out;
}

/**
 * Sets who must review every pull request in a project: a PROJECT-scope review rule, created, updated or (with no names)
 * removed. Anyone with admin rights can do it from the project page; it is the same rule the Review routing page edits.
 * The author of a pull request can never be its own approver, so a reviewer who also authors one is shown as such, not counted.
 */
export async function setProjectReviewers(db: Db, workspaceId: string, projectId: string, projectName: string, input: string) {
  const refs = parseReviewerRefs(input);
  const existing = await db.reviewRule.findFirst({ where: { workspaceId, scope: "PROJECT", projectId, reason: { startsWith: OWNED } } });
  if (refs.length === 0) {
    if (existing) await db.reviewRule.delete({ where: { id: existing.id } });
    return { reviewers: [] as string[] };
  }
  const reviewers = refs.map((ref) => ({ kind: ref.includes("/") ? "TEAM" : "USER", ref }));
  const data = { reviewers, reason: projectRuleReason(projectName), semantics: "ANY" as const, enabled: true };
  if (existing) await db.reviewRule.update({ where: { id: existing.id }, data });
  else await db.reviewRule.create({ data: { workspaceId, scope: "PROJECT", projectId, labels: [], ...data } });
  return { reviewers: refs };
}

export async function projectReviewerRefs(db: Db, workspaceId: string, projectId: string): Promise<string[]> {
  const r = await db.reviewRule.findFirst({ where: { workspaceId, scope: "PROJECT", projectId, reason: { startsWith: OWNED } } });
  return r ? (r.reviewers as unknown as { ref: string }[]).map((x) => x.ref) : [];
}
