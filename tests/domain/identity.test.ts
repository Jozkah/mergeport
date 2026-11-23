import { describe, expect, it } from "vitest";
import { assignedTo, authoredBy, samePerson, viewerWho } from "@/lib/domain/identity";
import { deriveReview, type ReviewEvent, type ReviewInput } from "@/lib/domain/review";
import { takeSnapshot } from "@/lib/domain/changes";

const t = (h: number) => new Date(Date.UTC(2026, 9, 1, h));
const now = new Date(Date.UTC(2026, 9, 2, 0));

function pr(over: Partial<ReviewInput> = {}): ReviewInput {
  return { type: "PULL_REQUEST", state: "OPEN", draft: false, authorLogin: "author", headSha: "bbbbbbb", checksState: "SUCCESS", mergeable: "MERGEABLE", reviews: [], requests: [], rule: null, readyAt: t(0), internalLogins: new Set(["me", "author"]), now, ...over };
}

describe("samePerson", () => {
  it("ids decide when both sides have one, whatever the logins say", () => {
    expect(samePerson({ login: "new-name", id: 5n }, { login: "old-name", id: 5n })).toBe(true); // renamed
    expect(samePerson({ login: "old-name", id: 9n }, { login: "old-name", id: 5n })).toBe(false); // login taken by someone else
  });
  it("falls back to the login when a side has no id, and never matches nothing with nothing", () => {
    expect(samePerson({ login: "Alice", id: null }, { login: "alice", id: 5n })).toBe(true);
    expect(samePerson("alice", "ALICE")).toBe(true);
    expect(samePerson({ login: null, id: null }, { login: null, id: null })).toBe(false);
    expect(samePerson(null, "alice")).toBe(false);
  });
  it("a viewer without a trusted login has no identity at all", () => {
    expect(viewerWho({ githubLogin: null, githubId: 5n })).toEqual({ login: null, id: null });
  });
});

describe("assignee and author matching", () => {
  it("assignees match by id when the item recorded ids; a re-used login does not inherit", () => {
    const row = { assigneeLogins: "|alice-old|", assigneeIds: "|9|" };
    expect(assignedTo(row, { login: "alice-new", id: 5n })).toBe(false);
    expect(assignedTo(row, { login: "alice-old", id: 5n })).toBe(false); // somebody else (id 9) holds that login now
    expect(assignedTo(row, { login: "anything", id: 9n })).toBe(true); // renamed: still id 9
  });
  it("assignees fall back to the login for items without recorded ids", () => {
    expect(assignedTo({ assigneeLogins: "|alice|", assigneeIds: "" }, { login: "Alice", id: 5n })).toBe(true);
    expect(assignedTo({ assigneeLogins: "|alice|" }, "alice")).toBe(true);
    expect(assignedTo({ assigneeLogins: "|alice|", assigneeIds: "" }, "bob")).toBe(false);
  });
  it("authors match by id, with the login only as a fallback", () => {
    expect(authoredBy({ authorLogin: "old", authorGithubId: 9n }, { login: "old", id: 5n })).toBe(false);
    expect(authoredBy({ authorLogin: "renamed", authorGithubId: 5n }, { login: "old", id: 5n })).toBe(true);
    expect(authoredBy({ authorLogin: "old", authorGithubId: null }, { login: "old", id: 5n })).toBe(true);
  });
});

describe("review queue matching", () => {
  const me = { login: "old-name", id: 5n };

  it("a review request still reaches me after I renamed my GitHub login", () => {
    const d = deriveReview(pr({ requests: [{ kind: "USER", ref: "new-name", requestedAt: t(1), githubId: 5n }] }), me);
    expect(d.queues.needsMyReview).toBe(true);
  });

  it("a different person who took my old login does not inherit my queue", () => {
    const d = deriveReview(pr({ requests: [{ kind: "USER", ref: "old-name", requestedAt: t(1), githubId: 9n }] }), me);
    expect(d.queues.needsMyReview).toBe(false);
  });

  it("without ids on the request (unlinked or local data) the login still decides", () => {
    const d = deriveReview(pr({ requests: [{ kind: "USER", ref: "Old-Name", requestedAt: t(1) }] }), me);
    expect(d.queues.needsMyReview).toBe(true);
    expect(deriveReview(pr({ requests: [{ kind: "USER", ref: "old-name", requestedAt: t(1) }] }), "old-name").queues.needsMyReview).toBe(true);
    expect(deriveReview(pr({ requests: [{ kind: "USER", ref: "old-name", requestedAt: t(1) }] }), null).queues.needsMyReview).toBe(false);
  });

  it("changes requested reaches the author by id, not by a re-used login", () => {
    const review: ReviewEvent = { reviewer: "teammate", reviewerId: 7n, state: "CHANGES_REQUESTED", commitSha: "bbbbbbb", submittedAt: t(5) };
    const own = pr({ authorLogin: "renamed", authorGithubId: 5n, reviews: [review], requests: [{ kind: "USER", ref: "teammate", requestedAt: t(1), githubId: 7n }] });
    expect(deriveReview(own, me).queues.changesRequestedForMe).toBe(true);
    const theirs = pr({ authorLogin: "old-name", authorGithubId: 9n, reviews: [review], requests: [{ kind: "USER", ref: "teammate", requestedAt: t(1), githubId: 7n }] });
    expect(deriveReview(theirs, me).queues.changesRequestedForMe).toBe(false);
  });

  it("a review recorded under my old login still counts as mine by id, and a stranger's under that login does not", () => {
    const mineEv: ReviewEvent = { reviewer: "old-name", reviewerId: 5n, state: "APPROVED", commitSha: "bbbbbbb", submittedAt: t(5) };
    const strangerEv: ReviewEvent = { reviewer: "old-name", reviewerId: 9n, state: "APPROVED", commitSha: "bbbbbbb", submittedAt: t(5) };
    const req = [{ kind: "USER" as const, ref: "new-name", requestedAt: t(1), githubId: 5n }];
    expect(deriveReview(pr({ reviews: [mineEv], requests: req }), me).satisfied).toBe(true);
    expect(deriveReview(pr({ reviews: [strangerEv], requests: req }), me).satisfied).toBe(false);
  });

  it("a snapshot ignores my own comments by id, not those of a re-used login", () => {
    const item = { state: "OPEN", headSha: null, checksState: "NONE", mergeable: "UNKNOWN", title: "t", comments: [
      { kind: "ISSUE_COMMENT", authorLogin: "renamed", authorGithubId: 5n, createdAtGh: t(1), reviewState: null },
      { kind: "ISSUE_COMMENT", authorLogin: "old-name", authorGithubId: 9n, createdAtGh: t(2), reviewState: null },
    ] };
    expect(takeSnapshot(item, me).commentCount).toBe(1);
  });
});
