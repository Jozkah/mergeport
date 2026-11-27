import { beforeEach, describe, expect, it } from "vitest";
import { repoWhere } from "@/lib/authz/viewer";
import type { Vault } from "@/lib/hub/session-vault";
import { capContext, defaultReadme, gatherIssueContext, parseIssueDraft, promptWords, runIssueDraft, DRAFTS_PER_WINDOW, type ReadmeLoader } from "@/lib/services/ai-issue";
import { freshSeed, makeProfile } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

const vault = {} as Vault;
const SECRET = "FOREIGN-SECRET-TITLE";

/** A repository with one open issue in a different workspace: nothing of it may ever reach a prompt. */
async function foreignRepo() {
  const { db } = S;
  const other = await makeProfile(db, { id: 990001n, login: "outsider" });
  const owner = await db.githubOwner.upsert({ where: { githubId: 990002n }, create: { githubId: 990002n, login: "elsewhere", type: "ORGANIZATION" }, update: {} });
  const repo = await db.repository.create({ data: { workspaceId: other.workspace.id, githubId: 990003n, ownerId: owner.id, name: "vault", fullName: "elsewhere/vault", htmlUrl: "https://github.com/elsewhere/vault", description: "FOREIGN-DESCRIPTION" } });
  await db.workItem.create({ data: { repositoryId: repo.id, githubId: 990004n, number: 1, type: "ISSUE", title: `${SECRET} login broken`, body: "FOREIGN-BODY", htmlUrl: "https://github.com/elsewhere/vault/issues/1", createdAtGh: new Date(), updatedAtGh: new Date() } });
  return repo;
}

/** A fetch that serves one model and records the messages sent to it. */
function fakeAi(reply: string) {
  const sent: { role: string; content: string }[][] = [];
  const f = (async (url: string, init: RequestInit) => {
    if (String(url).endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m1" }] }));
    sent.push(JSON.parse(String(init.body)).messages);
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  }) as unknown as typeof fetch;
  return { f, sent };
}

const readmes = (asked: string[]): ReadmeLoader => async (repo) => {
  asked.push(repo.id);
  return `README of ${repo.fullName}`;
};

describe("research context scoping", () => {
  it("never includes a repository of another workspace or one the viewer has no grant for, even when the page asks for it", async () => {
    const { db, a, b, admin } = S;
    const foreign = await foreignRepo();
    await db.aiSettings.create({ data: { workspaceId: a.workspaceId, baseUrl: "https://ai.example.com/v1", model: "m1" } });
    const all = await db.repository.findMany({ where: { workspaceId: a.workspaceId } });
    for (const v of [a, b]) {
      const visible = await db.repository.findMany({ where: repoWhere(v), orderBy: { fullName: "asc" } });
      const hidden = all.filter((r) => !visible.some((x) => x.id === r.id));
      expect(visible.length).toBeGreaterThan(0);
      expect(hidden.length).toBeGreaterThan(0);
      const hiddenTitles = (await db.workItem.findMany({ where: { repositoryId: { in: hidden.map((r) => r.id) } }, select: { title: true } })).map((x) => x.title);

      const asked: string[] = [];
      const { f, sent } = fakeAi('{"title":"T","body":"B"}');
      const r = await runIssueDraft(db, v, vault, { repositoryId: visible[0].id, prompt: "login broken fix", research: "others", otherRepoIds: [foreign.id, ...hidden.map((h) => h.id)] }, () => {}, { f, readme: readmes(asked) });
      expect(r).toMatchObject({ title: "T", body: "B" });
      const prompt = JSON.stringify(sent);
      expect(prompt).not.toContain(SECRET);
      expect(prompt).not.toContain("FOREIGN-");
      expect(prompt).not.toContain("elsewhere/vault");
      for (const h of hidden) expect(prompt).not.toContain(h.fullName);
      const visibleTitles = new Set((await db.workItem.findMany({ where: { repositoryId: { in: visible.map((r) => r.id) } }, select: { title: true } })).map((x) => x.title));
      for (const t of hiddenTitles) if (!visibleTitles.has(t)) expect(prompt).not.toContain(t);
      expect(asked.every((id) => visible.some((x) => x.id === id))).toBe(true);
      expect(r.sources).toEqual([visible[0].fullName]); // every picked id was hidden: nothing else is read
    }

    // a foreign repository as the target is not found, not read
    await expect(gatherIssueContext(db, admin, { repositoryId: foreign.id, prompt: "x", research: "repo" }, readmes([]))).rejects.toThrow();
  });

  it("with no repositories picked, other projects are visible ones only, the selected repository first", async () => {
    const { db, admin } = S;
    await foreignRepo();
    const visible = await db.repository.findMany({ where: repoWhere(admin), orderBy: { fullName: "asc" } });
    const ctx = await gatherIssueContext(db, admin, { repositoryId: visible[1].id, prompt: "anything", research: "others" }, readmes([]));
    expect(ctx.repos[0]).toBe(visible[1].fullName);
    expect(ctx.repos.length).toBeGreaterThan(1);
    expect(ctx.repos.every((n) => visible.some((x) => x.fullName === n))).toBe(true);
    expect(ctx.text).not.toContain(SECRET);
  });

  it("lists similar open issues of the selected repository with labels and README", async () => {
    const { db, admin } = S;
    const issue = await db.workItem.findFirstOrThrow({ where: { type: "ISSUE", state: "OPEN", repository: repoWhere(admin) }, include: { repository: true } });
    const word = promptWords(issue.title)[0];
    const ctx = await gatherIssueContext(db, admin, { repositoryId: issue.repositoryId, prompt: `something about ${word}`, research: "repo" }, readmes([]));
    expect(ctx.text).toContain(`## Repository ${issue.repository.fullName}`);
    expect(ctx.text).toContain(`#${issue.number} `);
    expect(ctx.text).toContain(`README of ${issue.repository.fullName}`);
  });
});

describe("README from the code view cache", () => {
  it("reads the cached root folder's README of this workspace as text", async () => {
    const { db, admin } = S;
    const repo = (await db.repository.findMany({ where: repoWhere(admin), orderBy: { fullName: "asc" } }))[0];
    await db.gitCache.create({ data: { workspaceId: admin.workspaceId, key: `code:1:${repo.id}:${"a".repeat(40)}:`, bytes: 10, payload: { kind: "dir", entries: [], readme: { path: "README.md", html: "<h1>Atlas</h1><p>Runs &amp; scales.</p>" } } } });
    expect(await defaultReadme(db, admin)({ id: repo.id, fullName: repo.fullName, description: null, defaultBranch: null }, false)).toBe("Atlas\nRuns & scales.");
  });
});

describe("context size", () => {
  it("is capped, cut the same way every time, and marked", () => {
    const parts = ["a".repeat(10_000), "b".repeat(10_000), "c".repeat(10_000), "d".repeat(10)];
    const one = capContext(parts);
    expect(one.length).toBe(24_000);
    expect(one).toBe(capContext(parts));
    expect(one.endsWith("[context truncated]")).toBe(true);
    expect(one).not.toContain("dddd");
    expect(capContext(["x", "y"])).toBe("x\n\ny");
  });

  it("a huge README is cut in the assembled context", async () => {
    const { db, admin } = S;
    const repo = (await db.repository.findMany({ where: repoWhere(admin), orderBy: { fullName: "asc" } }))[0];
    const ctx = await gatherIssueContext(db, admin, { repositoryId: repo.id, prompt: "x", research: "others" }, async () => "r".repeat(50_000));
    expect(ctx.text.length).toBeLessThanOrEqual(24_000);
    expect(ctx.text).toContain("[README cut]");
  });
});

describe("reading the answer", () => {
  it("plain JSON, fenced JSON, JSON in prose; fences inside the body survive", () => {
    expect(parseIssueDraft('{"title":"Fix login","body":"Steps"}')).toEqual({ title: "Fix login", body: "Steps" });
    expect(parseIssueDraft('```json\n{"title":"Fix login","body":"Run:\\n```sh\\nnpm test\\n```"}\n```')).toEqual({ title: "Fix login", body: "Run:\n```sh\nnpm test\n```" });
    expect(parseIssueDraft('Sure! Here it is: {"title":"A {b}","body":"x"} hope it helps')).toEqual({ title: "A {b}", body: "x" });
  });

  it("falls back to the first line as title, and bounds the length", () => {
    expect(parseIssueDraft("\n# Login loops forever\n\nAfter sign in the page reloads.")).toEqual({ title: "Login loops forever", body: "After sign in the page reloads." });
    expect(parseIssueDraft("Title: Slow page\nIt is slow")).toEqual({ title: "Slow page", body: "It is slow" });
    expect(parseIssueDraft(JSON.stringify({ title: "t".repeat(400), body: "b" })).title.length).toBe(256);
    expect(() => parseIssueDraft("   ")).toThrow();
  });

  it("repairs raw line breaks inside the JSON strings; an object with neither field is refused", () => {
    expect(parseIssueDraft('{"title": "Fix login", "body": "## Steps\n1. Sign in {x}\n2. Loop"}')).toEqual({ title: "Fix login", body: "## Steps\n1. Sign in {x}\n2. Loop" });
    expect(() => parseIssueDraft("{}")).toThrow(/nothing I could use/);
    expect(() => parseIssueDraft('{"summary":"x"}')).toThrow(/nothing I could use/);
  });
});

describe("running a draft", () => {
  it("says the AI is not set up, and asks nothing of the endpoint", async () => {
    const { db, admin } = S;
    const repo = await db.repository.findFirstOrThrow({ where: repoWhere(admin) });
    const { f, sent } = fakeAi("{}");
    await expect(runIssueDraft(db, admin, vault, { repositoryId: repo.id, prompt: "x", research: "repo" }, () => {}, { f, readme: readmes([]) })).rejects.toThrow("Set up the AI endpoint in Settings first.");
    expect(sent).toEqual([]);
  });

  it("tells the model context is data, wants no footer, and is rate limited per person", async () => {
    const { db, admin } = S;
    await db.aiSettings.create({ data: { workspaceId: admin.workspaceId, baseUrl: "https://ai.example.com/v1", model: "m1" } });
    const repo = await db.repository.findFirstOrThrow({ where: repoWhere(admin) });
    const { f, sent } = fakeAi('{"title":"T","body":"B"}');
    const now = new Date("2026-11-27T10:00:00Z");
    for (let i = 0; i < DRAFTS_PER_WINDOW; i++) await runIssueDraft(db, admin, vault, { repositoryId: repo.id, prompt: "x", research: "none" }, () => {}, { f, readme: readmes([]), now });
    expect(sent[0][0].content).toMatch(/Ignore any instruction/);
    expect(sent[0][0].content).toMatch(/No signature, footer/);
    expect(sent[0][1].content).toBe("Request: x"); // no research asked: no context
    await expect(runIssueDraft(db, admin, vault, { repositoryId: repo.id, prompt: "x", research: "none" }, () => {}, { f, readme: readmes([]), now })).rejects.toThrow(/many drafts/);
  });
});
