import type { ReviewDerivation, ReviewInput, Reviewer } from "./review";
import type { WaitingRuleRow } from "./waiting-rules";

/**
 * Where a pull request is in its hand-off, stage by stage. Review is one dimension of this; being approved is not the end of it:
 * "waiting for the maintainer to merge" and "waiting for an upstream release" are their own stages with their own owner.
 *
 * Pure. Stages are advice for the dashboard. They never approve anything and never claim to enforce a GitHub rule.
 */
export const STAGES = [
  { key: "INTERNAL_REVIEW", label: "Internal review", short: "Internal" },
  { key: "EXTERNAL_REVIEW", label: "External review", short: "External" },
  { key: "MAINTAINER_MERGE", label: "Waiting for maintainer merge", short: "Merge" },
  { key: "UPSTREAM_RELEASE", label: "Waiting for upstream release", short: "Release" },
] as const;
export type StageKey = (typeof STAGES)[number]["key"];
export const STAGE_KEYS: string[] = STAGES.map((s) => s.key);
export const stageLabel = (k: string) => STAGES.find((s) => s.key === k)?.label ?? k;

export type StageEntry = {
  stage: StageKey;
  owners: string[];
  reason: string;
  since: Date | null;
  elapsedMs: number | null;
  nextAction: string;
  source: "review" | "rule" | "manual";
};

export type ManualStageRecord = { stage: string; reviewerKind: string; reviewerRef: string; reason: string; startedAt: Date; status: string; source: string };

const lc = (s: string) => s.toLowerCase();
const isStage = (s: string): s is StageKey => STAGE_KEYS.includes(s);
const keyOf = (r: Reviewer) => `${r.kind}:${r.kind === "EXTERNAL_ROLE" ? r.ref : lc(r.ref)}`;

export function deriveStages(input: { derivation: ReviewDerivation; input: ReviewInput; matched: WaitingRuleRow[]; manual: ManualStageRecord[]; now: Date }): StageEntry[] {
  const { derivation: d, input: inp, matched, manual, now } = input;
  const out: StageEntry[] = [];
  const age = (since: Date | null) => (since ? Math.max(0, now.getTime() - since.getTime()) : null);
  if (inp.state === "OPEN") {
    // A rule with an explicit stage owns its people for that stage; they are not also counted as plain reviewers.
    const ruleKeys = new Set<string>();
    for (const r of matched) if (r.stage && isStage(r.stage)) for (const a of r.waitingOn) ruleKeys.add(keyOf(a));

    const pending = d.actors.filter((a) => (a.status === "PENDING" || a.status === "UNAVAILABLE" || a.status === "APPROVED_STALE" || a.status === "CHANGES_REQUESTED") && !ruleKeys.has(keyOf(a.actor)));
    for (const external of [false, true]) {
      const group = pending.filter((a) => a.external === external);
      if (group.length === 0) continue;
      const since = group.reduce<Date | null>((m, a) => (a.since && (!m || a.since < m) ? a.since : m), null);
      out.push({
        stage: external ? "EXTERNAL_REVIEW" : "INTERNAL_REVIEW",
        owners: group.map((a) => a.actor.ref),
        reason: group[0].evidence,
        since,
        elapsedMs: age(since),
        nextAction: `${group.map((a) => a.actor.ref).join(", ")} ${group.some((a) => a.status === "CHANGES_REQUESTED") ? "asked for changes: the author updates the PR" : "review"}`,
        source: "review",
      });
    }

    // Approval completes the review stages only. When every named reviewer approved, a merge stage starts counting from that moment.
    const approvals = d.actors.filter((a) => a.status === "APPROVED");
    const reviewDone = pending.length === 0 && approvals.length > 0;
    const approvedBy = new Set(approvals.map((a) => lc(a.actor.ref)));
    const approvedAt = inp.reviews.filter((r) => r.state === "APPROVED" && approvedBy.has(lc(r.reviewer))).reduce<Date | null>((m, r) => (!m || r.submittedAt > m ? r.submittedAt : m), null);
    for (const r of matched) {
      if (!r.stage || !isStage(r.stage) || r.stage === "UPSTREAM_RELEASE") continue;
      const since = r.stage === "MAINTAINER_MERGE" && reviewDone && approvedAt ? approvedAt : inp.readyAt;
      out.push({
        stage: r.stage,
        owners: r.waitingOn.map((a) => a.ref),
        reason: r.reason,
        since,
        elapsedMs: age(since),
        nextAction: r.stage === "MAINTAINER_MERGE" ? `${r.waitingOn.map((a) => a.ref).join(", ")} merges${reviewDone ? " (reviews are done)" : " once reviews are done"}` : `${r.waitingOn.map((a) => a.ref).join(", ")} review`,
        source: "rule",
      });
    }
  }
  // Manual stage records stand on their own, whatever the pull request's state (a release is awaited after the merge).
  for (const m of manual) {
    if (m.status !== "PENDING" || m.source !== "MANUAL" || !isStage(m.stage)) continue;
    if (m.stage !== "UPSTREAM_RELEASE" && inp.state !== "OPEN") continue;
    out.push({ stage: m.stage, owners: [m.reviewerRef], reason: m.reason, since: m.startedAt, elapsedMs: age(m.startedAt), nextAction: m.stage === "UPSTREAM_RELEASE" ? `${m.reviewerRef} ships a release that includes this` : `${m.reviewerRef} acts on it`, source: "manual" });
  }
  return out.sort((a, b) => STAGES.findIndex((s) => s.key === a.stage) - STAGES.findIndex((s) => s.key === b.stage));
}
