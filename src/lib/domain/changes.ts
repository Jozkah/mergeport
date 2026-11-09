/**
 * "Since you last looked": the differences between what a person last saw of an item and what is there now. Pure.
 * The snapshot holds only facts that were visible; nothing is guessed. A missing earlier snapshot means "no baseline", never "everything is new".
 */
export type Snapshot = {
  v: 1;
  state: string;
  headSha: string | null;
  checks: string;
  mergeable: string;
  commentCount: number;
  lastCommentAt: number;
  /** Latest effective decision per reviewer login (lower case). */
  reviews: Record<string, string>;
  title: string;
};

export type Change = { kind: "comments" | "commits" | "checks" | "review" | "state" | "conflicts" | "title"; text: string };

type CommentLike = { kind: string; authorLogin: string | null; createdAtGh: Date; reviewState: string | null };
type ItemLike = { state: string; headSha: string | null; checksState: string; mergeable: string; title: string; comments: CommentLike[] };

export function takeSnapshot(item: ItemLike, viewerLogin: string): Snapshot {
  const me = viewerLogin.toLowerCase();
  const talk = item.comments.filter((c) => (c.kind === "ISSUE_COMMENT" || c.kind === "REVIEW_COMMENT") && c.authorLogin?.toLowerCase() !== me);
  const reviews: Record<string, string> = {};
  for (const c of [...item.comments].filter((c) => c.kind === "REVIEW" && c.authorLogin && c.reviewState).sort((a, b) => a.createdAtGh.getTime() - b.createdAtGh.getTime())) {
    if (c.reviewState === "APPROVED" || c.reviewState === "CHANGES_REQUESTED") reviews[c.authorLogin!.toLowerCase()] = c.reviewState;
    else if (c.reviewState === "DISMISSED") delete reviews[c.authorLogin!.toLowerCase()];
  }
  return { v: 1, state: item.state, headSha: item.headSha, checks: item.checksState, mergeable: item.mergeable, commentCount: talk.length, lastCommentAt: talk.reduce((m, c) => Math.max(m, c.createdAtGh.getTime()), 0), reviews, title: item.title };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const CHECK_WORD: Record<string, string> = { SUCCESS: "passing", FAILURE: "failing", PENDING: "running", NONE: "not reported", UNKNOWN: "unknown" };

export function changesSince(prev: Snapshot | null, cur: Snapshot): Change[] {
  if (!prev) return [];
  const out: Change[] = [];
  if (cur.state !== prev.state) out.push({ kind: "state", text: `It was ${cur.state.toLowerCase()}` });
  if (cur.headSha !== prev.headSha) out.push({ kind: "commits", text: "New commits were pushed" });
  if (cur.commentCount > prev.commentCount) out.push({ kind: "comments", text: `${plural(cur.commentCount - prev.commentCount, "new comment")} from others` });
  else if (cur.commentCount < prev.commentCount) out.push({ kind: "comments", text: `${plural(prev.commentCount - cur.commentCount, "comment")} removed` });
  for (const login of new Set([...Object.keys(prev.reviews), ...Object.keys(cur.reviews)])) {
    const a = prev.reviews[login];
    const b = cur.reviews[login];
    if (a === b) continue;
    out.push({ kind: "review", text: b ? `${login} ${b === "APPROVED" ? "approved" : "requested changes"}` : `${login}'s review was dismissed` });
  }
  if (cur.checks !== prev.checks) out.push({ kind: "checks", text: `Checks are now ${CHECK_WORD[cur.checks] ?? cur.checks.toLowerCase()}` });
  if (cur.mergeable !== prev.mergeable && cur.mergeable === "CONFLICTING") out.push({ kind: "conflicts", text: "It now conflicts with the base branch" });
  if (cur.title !== prev.title) out.push({ kind: "title", text: "The title changed" });
  return out;
}
