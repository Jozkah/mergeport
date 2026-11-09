/**
 * Where a change is on its way, stated as separate facts instead of one vague "syncing". Pure.
 *
 * The five places a change can be, in order:
 *   saved on this computer -> queued to publish -> published to the coordination repository -> waiting for teammates' apps to poll
 *   (or) held: conflicted, unavailable, or blocked by authorization.
 * Mergeport is eventually consistent. A teammate sees a published change only on THEIR next poll, and only while their app is open.
 */
export type SpaceSyncInput = {
  /** Operations saved locally and not yet sent. */
  queued: number;
  /** Operations whose commit is in flight right now. */
  sending: number;
  failed: number;
  blocked: number;
  conflicts: number;
  deferred: number;
  access: "OK" | string;
  lastPushedAt: Date | null;
  lastPolledAt: Date | null;
  nextPollAt: Date | null;
  rateLimitedUntil: Date | null;
  lastError: string | null;
  canWrite: boolean;
  /** Seconds a teammate's app may take to notice a published change, with the app open (see expectedConsistencyDelaySeconds). */
  teammateDelaySeconds: number;
  now: Date;
};

export type FactTone = "ok" | "wait" | "hold" | "info";
export type SyncFact = { key: "saved" | "queued" | "sending" | "published" | "waiting-teammates" | "conflict" | "blocked" | "unavailable" | "failed" | "rate-limited" | "deferred" | "read-only"; tone: FactTone; label: string; detail: string };

const when = (d: Date, now: Date) => {
  const s = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
  return s < 60 ? "moments ago" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const until = (d: Date, now: Date) => {
  const s = Math.max(0, Math.round((d.getTime() - now.getTime()) / 1000));
  return s < 60 ? `in ${s} s` : s < 3600 ? `in ${Math.round(s / 60)} min` : `in ${Math.round(s / 3600)} h`;
};

export function syncFacts(i: SpaceSyncInput): SyncFact[] {
  const out: SyncFact[] = [];
  if (i.access !== "OK") out.push({ key: "unavailable", tone: "hold", label: "Space unavailable", detail: `Access to this space is ${i.access.toLowerCase().replace(/_/g, " ")}. Nothing is sent or received until that is resolved.` });
  if (i.blocked > 0) out.push({ key: "blocked", tone: "hold", label: `${i.blocked} change${i.blocked === 1 ? "" : "s"} blocked by authorization`, detail: "GitHub access to this space was removed. The changes are kept here, not sent, and wait for your decision." });
  if (i.conflicts > 0) out.push({ key: "conflict", tone: "hold", label: `${i.conflicts} conflict${i.conflicts === 1 ? "" : "s"} need${i.conflicts === 1 ? "s" : ""} your decision`, detail: "You and a teammate changed the same thing. Neither version is lost until you choose." });
  if (!i.canWrite && i.access === "OK") out.push({ key: "read-only", tone: "info", label: "Read only", detail: "You can read this space but not publish to it, so local edits to its records cannot be shared." });
  if (i.rateLimitedUntil && i.rateLimitedUntil > i.now) out.push({ key: "rate-limited", tone: "wait", label: "GitHub rate limit", detail: `Syncing pauses and retries ${until(i.rateLimitedUntil, i.now)}.` });
  if (i.failed > 0) out.push({ key: "failed", tone: "hold", label: `${i.failed} change${i.failed === 1 ? "" : "s"} failed to send`, detail: i.lastError ? `Last error: ${i.lastError}. They are kept and retried.` : "They are kept and retried." });
  if (i.queued > 0) out.push({ key: "queued", tone: "wait", label: `${i.queued} change${i.queued === 1 ? "" : "s"} saved here, queued to publish`, detail: i.nextPollAt ? `They are sent with the next sync (${until(i.nextPollAt, i.now)}).` : "They are sent with the next sync." });
  if (i.sending > 0) out.push({ key: "sending", tone: "wait", label: `${i.sending} change${i.sending === 1 ? "" : "s"} being sent now`, detail: "Waiting for GitHub to confirm. If the app stops now they are recovered and sent exactly once." });
  if (i.deferred > 0) out.push({ key: "deferred", tone: "wait", label: `${i.deferred} shared record${i.deferred === 1 ? "" : "s"} waiting for source data`, detail: "They refer to a repository or item that has not been refreshed on this computer yet. They apply once it arrives." });
  if (i.lastPushedAt) {
    const age = (i.now.getTime() - i.lastPushedAt.getTime()) / 1000;
    out.push({ key: "published", tone: "ok", label: `Last published ${when(i.lastPushedAt, i.now)}`, detail: "Written to the coordination repository on GitHub." });
    if (age < i.teammateDelaySeconds && i.queued === 0 && i.sending === 0) out.push({ key: "waiting-teammates", tone: "wait", label: "Waiting for teammates' apps to poll", detail: `A teammate sees it on their next check, within about ${Math.round(i.teammateDelaySeconds)} s while their app is open. If their app is closed, when they next open it.` });
  }
  const hasPending = out.some((f) => ["queued", "sending", "failed", "conflict", "blocked", "unavailable"].includes(f.key));
  if (!hasPending) out.unshift({ key: "saved", tone: "ok", label: "Everything on this computer is published", detail: i.lastPolledAt ? `Last checked for teammates' changes ${when(i.lastPolledAt, i.now)}.` : "Not checked for teammates' changes yet." });
  return out;
}
