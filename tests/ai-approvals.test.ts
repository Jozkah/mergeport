import { beforeEach, describe, expect, it } from "vitest";
import { handle } from "@/lib/mcp/server";
import { TOOLS } from "@/lib/mcp/tools";
import { approve, listPending, pendingCount, propose, reject, status } from "@/lib/services/ai-approvals";
import { listWorkItems } from "@/lib/services/queries";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

const firstPr = async () => (await listWorkItems(S.db, S.admin, { type: "PULL_REQUEST", state: "OPEN", pageSize: 1 })).rows[0];
const comments = (id: string) => S.db.workItemComment.count({ where: { workItemId: id } });

describe("requests from AI apps", () => {
  it("are only stored: nothing reaches the item until a person approves, and approving sends it once", async () => {
    const { db, admin } = S;
    const pr = await firstPr();
    const before = await comments(pr.id);
    const q = await propose(db, admin, { kind: "comment", item: `PR ${pr.number} from ${pr.repository.name}`, body: "Looks good to me." });
    expect(q.summary).toBe(`Comment on ${pr.repository.fullName}#${pr.number}`);
    expect(await comments(pr.id)).toBe(before);
    expect(await pendingCount(db)).toBe(1);
    expect((await listPending(db))[0]).toMatchObject({ id: q.id, detail: "Looks good to me.", href: `/pull-requests/${pr.id}` });
    expect(await status(db, q.id)).toMatchObject({ state: "PENDING" });

    const r = await approve(db, admin, q.id);
    expect(r.ok).toBe(true);
    expect(await comments(pr.id)).toBe(before + 1);
    expect(await status(db, q.id)).toMatchObject({ state: "DONE", result: "Sent to GitHub" });
    await expect(approve(db, admin, q.id)).rejects.toBeInstanceOf(ValidationError); // a second click sends nothing
    expect(await comments(pr.id)).toBe(before + 1);
  });

  it("can be rejected, and expire after a day", async () => {
    const { db, admin } = S;
    const pr = await firstPr();
    const a = await propose(db, admin, { kind: "comment", item: pr.id, body: "x" });
    expect(await reject(db, a.id)).toBe(true);
    expect(await status(db, a.id)).toMatchObject({ state: "REJECTED" });
    await expect(approve(db, admin, a.id)).rejects.toBeInstanceOf(ValidationError);
    const b = await propose(db, admin, { kind: "comment", item: pr.id, body: "y" });
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect(await listPending(db, later)).toHaveLength(0);
    expect((await status(db, b.id, later)).state).toBe("EXPIRED");
    await expect(approve(db, admin, b.id, later)).rejects.toBeInstanceOf(ValidationError);
  });

  it("a request that cannot be sent goes back to waiting with the reason, so it is never lost", async () => {
    const { db, admin } = S;
    const closed = await firstPr();
    await db.workItem.update({ where: { id: closed.id }, data: { state: "CLOSED" } }); // GitHub refuses a review request on a closed pull request
    const q = await propose(db, admin, { kind: "request-review", item: closed.id, users: ["alice"] });
    const r = await approve(db, admin, q.id);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Not sent: /);
    const waiting = (await listPending(db)).find((p) => p.id === q.id)!;
    expect(waiting.error).toMatch(/^Not sent: /);
    expect(await status(db, q.id)).toMatchObject({ state: "PENDING" });
    expect(await reject(db, q.id)).toBe(true); // and it can still be rejected
  });

  it("are checked when asked for: vague, empty or malformed requests are refused at once", async () => {
    const { db, admin } = S;
    const pr = await firstPr();
    await expect(propose(db, admin, { kind: "comment", item: "the thing", body: "x" })).rejects.toThrow(/exactly one/);
    await expect(propose(db, admin, { kind: "comment", item: pr.id, body: "  " })).rejects.toThrow(/empty/);
    await expect(propose(db, admin, { kind: "request-review", item: pr.id, users: ["not a login!"] })).rejects.toThrow(/usernames/);
    await expect(propose(db, admin, { kind: "review", item: pr.id, event: "MERGE" })).rejects.toThrow(/COMMENT, REQUEST_CHANGES or APPROVE/);
    await expect(propose(db, admin, { kind: "review", item: pr.id, event: "REQUEST_CHANGES", body: "" })).rejects.toThrow(/text of the review/);
    expect(await pendingCount(db)).toBe(0);
  });

  it("cannot name an item the person cannot see", async () => {
    const { db, admin, b } = S;
    const visible = new Set((await listWorkItems(db, b, { state: "ALL", pageSize: 100 })).rows.map((r) => r.id));
    const hidden = (await listWorkItems(db, admin, { state: "ALL", pageSize: 100 })).rows.find((r) => !visible.has(r.id))!;
    await expect(propose(db, b, { kind: "comment", item: hidden.id, body: "x" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("through the MCP server", () => {
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { db: S.db, viewer: S.admin });
    const res = r!.result as { content: { text: string }[]; isError?: boolean };
    return { json: JSON.parse(res.content[0].text), isError: !!res.isError };
  };

  it("queues a request, never sends it, and reports its status", async () => {
    const pr = await firstPr();
    const before = await comments(pr.id);
    const q = await call("mergeport_propose_review", { item: pr.id, event: "APPROVE" });
    expect(q.isError).toBe(false);
    expect(q.json).toMatchObject({ queued: true });
    expect(q.json.note).toMatch(/must approve/);
    expect(await comments(pr.id)).toBe(before);
    expect((await call("mergeport_action_status", { id: q.json.id })).json.state).toBe("PENDING");
    const bad = await call("mergeport_propose_review", { item: pr.id, event: "NOPE" });
    expect(bad.isError).toBe(true);
    expect(bad.json.error).toMatch(/COMMENT, REQUEST_CHANGES or APPROVE/);
  });

  it("has no tool that approves, merges or sends on its own", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.filter((n) => /_(approve|merge|send|execute)/.test(n))).toEqual([]);
    expect(names).toEqual(expect.arrayContaining(["mergeport_propose_comment", "mergeport_propose_review_request", "mergeport_propose_review", "mergeport_action_status"]));
  });
});
