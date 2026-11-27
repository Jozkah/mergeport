import { beforeAll, describe, expect, it } from "vitest";
import { insertMention, mentionTrigger, referencedNumbers } from "@/lib/mentions";
import { renderMarkdown } from "@/lib/markdown";
import { mentionRefs, suggestMentions } from "@/lib/services/mentions";
import { freshSeed, leaks } from "./helpers";

describe("mention trigger and insertion", () => {
  it("finds the mention being typed at the caret", () => {
    expect(mentionTrigger("hi @al", 6)).toEqual({ kind: "user", query: "al", start: 3 });
    expect(mentionTrigger("@al", 3)).toEqual({ kind: "user", query: "al", start: 0 });
    expect(mentionTrigger("see #12", 7)).toEqual({ kind: "item", query: "12", start: 4 });
    expect(mentionTrigger("see #token", 10)).toEqual({ kind: "item", query: "token", start: 4 });
    expect(mentionTrigger("(@bo", 4)).toEqual({ kind: "user", query: "bo", start: 1 });
    expect(mentionTrigger("x @al and more", 5)).toEqual({ kind: "user", query: "al", start: 2 }); // caret in the middle of the text
  });

  it("stays closed for emails, words with a hash, a bare marker, a heading and finished mentions", () => {
    expect(mentionTrigger("mail a@b.c", 10)).toBeNull();
    expect(mentionTrigger("foo#1", 5)).toBeNull();
    expect(mentionTrigger("hi @", 4)).toBeNull();
    expect(mentionTrigger("# Title", 1)).toBeNull();
    expect(mentionTrigger("@al ", 4)).toBeNull();
    expect(mentionTrigger("@a_b", 4)).toBeNull(); // not a GitHub login
  });

  it("inserts the token with one space and puts the caret right after it", () => {
    expect(insertMention("hi @al", 3, 6, "@alice")).toEqual({ text: "hi @alice ", caret: 10 });
    expect(insertMention("see #1 later", 4, 6, "#12")).toEqual({ text: "see #12 later", caret: 8 }); // existing space is reused
    expect(insertMention("@bo,x", 0, 3, "@bob")).toEqual({ text: "@bob ,x", caret: 5 });
  });

  it("collects referenced numbers, not entities or URL fragments", () => {
    expect(referencedNumbers(["fixes #12 and #3", "&#39; a/#9 #12", null])).toEqual([12, 3]);
  });
});

describe("mention links in GitHub text", () => {
  const refs = { repoUrl: "https://github.com/acme/web", items: new Map([[12, "/issues/wi12"]]) };

  it("links @login to GitHub and #123 to the Mergeport page or GitHub", () => {
    const html = renderMarkdown("ping @alice-b about #12 and #99", { breaks: true, refs });
    expect(html).toContain('<a href="https://github.com/alice-b" rel="noopener noreferrer nofollow" target="_blank">@alice-b</a>');
    expect(html).toContain('<a href="/issues/wi12">#12</a>');
    expect(html).toContain('<a href="https://github.com/acme/web/issues/99" rel="noopener noreferrer nofollow" target="_blank">#99</a>');
  });

  it("leaves code spans, code blocks, links, emails and entities alone", () => {
    const html = renderMarkdown("`@alice #12`\n\n```\n@bob #12\n```\n\n[@carol #12](https://example.com) mail a@b.com it's org/#12 @org/team", { breaks: true, refs });
    expect(html).toContain("<code>@alice #12</code>");
    expect(html).toMatch(/<pre><code>@bob #12\n<\/code><\/pre>/);
    expect(html).toContain('<a href="https://example.com">@carol #12</a>');
    expect(html).not.toContain("github.com/b");
    expect(html).not.toContain("github.com/org");
    expect((html.match(/<a /g) ?? []).length).toBe(2); // the written link and the email autolink, nothing added
    expect(html).toContain("it's org/#12 @org/team");
    expect(renderMarkdown("a&#35;12", { breaks: true, refs })).not.toContain("<a"); // `#` behind an entity or a word is not a reference
  });

  it("links #123 only with refs, and never in files (README)", () => {
    expect(renderMarkdown("see #12", { breaks: true })).not.toContain("<a");
    expect(renderMarkdown("ping @alice #12", { refs })).not.toContain("<a");
  });
});

describe("mention suggestions are scoped", () => {
  let S: Awaited<ReturnType<typeof freshSeed>>;
  let apiId: string;
  let foreignId: string;
  beforeAll(async () => {
    S = await freshSeed();
    const { db } = S;
    const api = await db.repository.findFirstOrThrow({ where: { fullName: "northwind/atlas-api" } });
    apiId = api.id;
    const item = await db.workItem.findFirstOrThrow({ where: { repositoryId: api.id, number: 16 } });
    await db.workItem.update({ where: { id: item.id }, data: { assignees: ["Zed-Assignee"], assigneeLogins: "|zed-assignee|" } });
    await db.workItemComment.create({ data: { workItemId: item.id, githubId: 9001n, kind: "ISSUE_COMMENT", authorLogin: "zara-commenter", body: "x", createdAtGh: new Date(), updatedAtGh: new Date() } });
    // Another workspace with its own repository, person and item.
    const ws = await db.workspace.create({ data: { name: "Other" } });
    const owner = await db.githubOwner.create({ data: { githubId: 777n, login: "secretorg", type: "ORGANIZATION" } });
    const repo = await db.repository.create({ data: { workspaceId: ws.id, githubId: 778n, ownerId: owner.id, name: "vault", fullName: "secretorg/vault", htmlUrl: "https://github.com/secretorg/vault" } });
    foreignId = repo.id;
    await db.workItem.create({ data: { repositoryId: repo.id, githubId: 779n, number: 16, type: "ISSUE", title: "Zeta secret plan", authorLogin: "zelda-secret", htmlUrl: "https://github.com/secretorg/vault/issues/16", createdAtGh: new Date(), updatedAtGh: new Date() } });
  });

  it("returns nothing for another workspace's repository or one without a grant", async () => {
    const { db, admin, b } = S;
    for (const [kind, q] of [["user", "z"], ["item", "1"], ["item", "secret"]] as const) {
      const r = await suggestMentions(db, admin, foreignId, kind, q);
      expect(r).toEqual([]);
      expect(leaks(r, "secret")).toBe(false);
    }
    expect(await suggestMentions(db, b, apiId, "user", "a")).toEqual([]); // B has no grant on atlas-api
    expect(await suggestMentions(db, b, apiId, "item", "")).toEqual([]);
    expect(await mentionRefs(db, admin, foreignId, ["#16"])).toBeUndefined();
    expect(await suggestMentions(db, admin, "", "user", "a")).toEqual([]);
  });

  it("matches people by author, assignee and commenter, prefix first, from that repository only", async () => {
    const { db, admin } = S;
    const z = await suggestMentions(db, admin, apiId, "user", "z");
    expect(z.map((s) => (s.kind === "user" ? s.login : ""))).toEqual(["zara-commenter", "Zed-Assignee"]);
    expect(leaks(z, "zelda")).toBe(false);
    const al = await suggestMentions(db, admin, apiId, "user", "ALI");
    expect(al.map((s) => (s.kind === "user" ? s.login : ""))).toEqual(["alice-demo"]);
    expect(await suggestMentions(db, admin, apiId, "user", "a_b")).toEqual([]);
  });

  it("matches issues and pull requests by number prefix and by title, at most eight", async () => {
    const { db, admin } = S;
    const byNum = await suggestMentions(db, admin, apiId, "item", "1");
    expect(byNum.length).toBeLessThanOrEqual(8);
    expect(byNum.every((s) => s.kind === "item" && String(s.number).startsWith("1"))).toBe(true);
    const exact = await suggestMentions(db, admin, apiId, "item", "16");
    expect(exact[0]).toMatchObject({ kind: "item", number: 16, type: "ISSUE", state: "OPEN", title: "Rate limit headers are missing from 429 responses" });
    expect(exact[0].kind === "item" && exact[0].href).toMatch(/^\/issues\//);
    const byTitle = await suggestMentions(db, admin, apiId, "item", "token");
    expect(byTitle.map((s) => (s.kind === "item" ? s.number : 0))).toEqual([14]);
    expect(byTitle[0].kind === "item" && byTitle[0].href).toMatch(/^\/pull-requests\//);
    expect(leaks(await suggestMentions(db, admin, apiId, "item", "zeta"), "secret")).toBe(false);
  });

  it("keeps the exact number first even when many longer numbers share its digits", async () => {
    const { db, admin } = S;
    const t = new Date();
    await db.workItem.createMany({ data: Array.from({ length: 60 }, (_, i) => ({ repositoryId: apiId, githubId: BigInt(5000 + i), number: 1600 + i, type: "ISSUE" as const, title: `Bulk ${i}`, htmlUrl: "https://github.com/northwind/atlas-api/issues/x", createdAtGh: t, updatedAtGh: t })) });
    const r = await suggestMentions(db, admin, apiId, "item", "16");
    expect(r).toHaveLength(8);
    expect(r[0]).toMatchObject({ number: 16 });
    expect(r.slice(1).every((s) => s.kind === "item" && String(s.number).startsWith("16"))).toBe(true);
  });

  it("resolves #123 links inside the repository only", async () => {
    const { db, admin } = S;
    const refs = await mentionRefs(db, admin, apiId, ["see #16 and #4242"]);
    expect(refs?.repoUrl).toBe("https://github.com/northwind/atlas-api");
    expect(refs?.items.get(16)).toMatch(/^\/issues\//);
    expect(refs?.items.has(4242)).toBe(false);
  });
});
