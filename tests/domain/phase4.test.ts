import { describe, expect, it } from "vitest";
import { ownersFor, parseCodeowners, parseOwner, patternToRegExp, routeFiles } from "@/lib/domain/codeowners";
import { conceptOf, conflicts, families, parseScoped, previewMapping, spellingsOf, type Mapping } from "@/lib/domain/labels";
import { cleanCriteria, matchAll, matchSubscription, pathMatches } from "@/lib/domain/relevance";
import { describeWorktree, worktreesOnBranch } from "@/lib/domain/worktree-links";

const NL = String.fromCharCode(10);

describe("CODEOWNERS", () => {
  const file = ["# owners", "*       @org/everyone", "/docs/   @docs-team  # trailing comment", "*.js    @frontend @org/web", "/src/auth/**  @sec", "/src/auth/README.md", "!weird @x"].join(NL);
  const rules = parseCodeowners(file);

  it("parses owners and ignores comments", () => {
    expect(rules.map((r) => r.pattern)).toEqual(["*", "/docs/", "*.js", "/src/auth/**", "/src/auth/README.md", "!weird"]);
    expect(rules[1].owners).toEqual(["@docs-team"]);
    expect(parseOwner("@org/team")).toMatchObject({ kind: "team", ref: "org/team" });
    expect(parseOwner("a@b.io")).toMatchObject({ kind: "email" });
    expect(parseOwner("nobody")).toBeNull();
  });

  it("the last matching rule wins, and an ownerless rule clears ownership", () => {
    expect(ownersFor("README.md", rules).owners).toEqual(["@org/everyone"]);
    expect(ownersFor("docs/guide/a.md", rules).owners).toEqual(["@docs-team"]);
    expect(ownersFor("web/app.js", rules).owners).toEqual(["@frontend", "@org/web"]);
    expect(ownersFor("src/auth/login.js", rules).owners).toEqual(["@sec"]); // the later, more specific rule beats *.js
    expect(ownersFor("src/auth/README.md", rules).owners).toEqual([]); // cleared
  });

  it("matches gitignore-style patterns", () => {
    const m = (p: string, path: string) => patternToRegExp(p).test(path);
    expect(m("*.md", "docs/a/b.md")).toBe(true);
    expect(m("/*.md", "docs/b.md")).toBe(false);
    expect(m("/*.md", "b.md")).toBe(true);
    expect(m("docs/", "x/docs/a.md")).toBe(true); // a trailing slash alone does not anchor
    expect(m("docs/api/", "x/docs/api/a.md")).toBe(false); // a slash inside the pattern anchors it to the root
    expect(m("docs/api/", "docs/api/a.md")).toBe(true);
    expect(m("/docs/", "docs/a.md")).toBe(true);
    expect(m("**/logs", "a/b/logs/x.txt")).toBe(true);
    expect(m("src/**/util.ts", "src/a/b/util.ts")).toBe(true);
    expect(m("src/**/util.ts", "src/util.ts")).toBe(true);
    expect(m("a?c", "abc")).toBe(true);
    expect(m("a.c", "abc")).toBe(false);
  });

  it("routes changed files to owners, reporting unowned files and invalid owners without guessing", () => {
    const r = routeFiles(["web/app.js", "docs/a.md", "src/auth/README.md", "Makefile", "x.bad"], parseCodeowners(["*.js @a", "/docs/ @team", "/src/auth/README.md", "x.bad notanowner"].join(NL)));
    expect(r.entries.map((e) => [e.owner.raw, e.files])).toEqual([["@a", ["web/app.js"]], ["@team", ["docs/a.md"]]]);
    expect(r.unowned.sort()).toEqual(["Makefile", "src/auth/README.md"]);
    expect(r.invalid).toEqual(["notanowner"]);
  });
});

describe("scoped labels and mappings", () => {
  const maps: Mapping[] = [
    { concept: "priority::high", spelling: "P1", repositoryId: null },
    { concept: "priority::high", spelling: "urgent", repositoryId: "r2" },
    { concept: "type::bug", spelling: "bug", repositoryId: null },
  ];

  it("parses scopes strictly", () => {
    expect(parseScoped("Priority::High")).toEqual({ family: "priority", value: "high" });
    for (const bad of ["priority", "::x", "a::", "a::b::c", "plain label"]) expect(parseScoped(bad)).toBeNull();
  });

  it("a repository mapping beats a global one, which beats the label's own scope", () => {
    expect(conceptOf("P1", "r1", maps)).toBe("priority::high");
    expect(conceptOf("urgent", "r2", maps)).toBe("priority::high");
    expect(conceptOf("urgent", "r1", maps)).toBeNull(); // only mapped in r2
    expect(conceptOf("type::chore", "r1", maps)).toBe("type::chore");
    expect(conceptOf("random", "r1", maps)).toBeNull();
    const override: Mapping[] = [...maps, { concept: "priority::low", spelling: "P1", repositoryId: "r3" }];
    expect(conceptOf("P1", "r3", override)).toBe("priority::low");
  });

  it("finds every spelling of a concept, lists families and flags two values of one family", () => {
    expect(spellingsOf("priority::high", maps).sort()).toEqual(["P1", "priority::high", "urgent"]);
    expect(families(["type::bug", "priority::low", "x"], maps)).toEqual([{ family: "priority", values: ["high", "low"] }, { family: "type", values: ["bug"] }]);
    expect(conflicts(["P1", "priority::low"], "r1", maps)).toEqual(["priority"]);
    expect(conflicts(["P1", "bug"], "r1", maps)).toEqual([]);
  });

  it("previews a mapping as counts only", () => {
    const p = previewMapping([{ repositoryId: "r1", labels: ["P1", "bug"] }, { repositoryId: "r1", labels: ["P1"] }, { repositoryId: "r2", labels: ["urgent", "other"] }], maps);
    expect(p).toEqual([{ concept: "priority::high", spelling: "P1", repositoryId: null, items: 2 }, { concept: "type::bug", spelling: "bug", repositoryId: null, items: 1 }, { concept: "priority::high", spelling: "urgent", repositoryId: "r2", items: 1 }]);
  });
});

describe("upstream relevance", () => {
  const facts = { labels: ["Security", "docs"], author: "Alice", milestone: "v2", title: "Fix auth token leak", files: ["src/auth/token.ts", "README.md"] as string[] | null };
  const sub = (c: object, over = {}) => ({ id: "s1", name: "Security", criteria: cleanCriteria(c), muted: false, mappingId: null, ...over });

  it("cleans criteria and ignores junk", () => {
    expect(cleanCriteria({ labels: [" a ", "", 5], milestone: " v1 ", authors: ["@bo"], extra: 1 })).toEqual({ labels: ["a", "5"], authors: ["bo"], milestone: "v1" });
    expect(cleanCriteria(null)).toEqual({});
  });

  it("matches on any criterion and says why", () => {
    const m = matchSubscription(sub({ labels: ["security"], authors: ["alice"], titleContains: ["token"], milestone: "V2" }), facts)!;
    expect(m.reasons).toEqual(['has the label "security"', 'is in milestone "V2"', "was opened by @alice", 'mentions "token" in its title']);
    expect(matchSubscription(sub({ labels: ["performance"] }), facts)).toBeNull();
  });

  it("path criteria match known files and are reported unknown (not a match, not a miss) when files are not loaded", () => {
    expect(matchSubscription(sub({ paths: ["src/auth/"] }), facts)!.reasons[0]).toMatch(/changes src\/auth\/token.ts/);
    expect(matchSubscription(sub({ paths: ["src/db/"] }), facts)).toBeNull();
    const unknown = matchSubscription(sub({ paths: ["src/auth/"] }), { ...facts, files: null })!;
    expect(unknown.reasons).toEqual([]);
    expect(unknown.unknown[0]).toMatch(/not loaded/);
    expect(pathMatches("src/**/*.ts", "src/a/b.ts")).toBe(true);
    expect(pathMatches("src/auth", "src/authz/x")).toBe(false);
  });

  it("muted and empty subscriptions never match; a subscription for another mapping is skipped", () => {
    expect(matchSubscription(sub({ labels: ["security"] }, { muted: true }), facts)).toBeNull();
    expect(matchSubscription(sub({}), facts)).toBeNull();
    const subs = [sub({ labels: ["security"] }, { id: "a", mappingId: "m1" }), sub({ labels: ["docs"] }, { id: "b", mappingId: null })];
    expect(matchAll(subs, facts, "m2").map((m) => m.subscriptionId)).toEqual(["b"]);
    expect(matchAll(subs, facts, "m1").map((m) => m.subscriptionId)).toEqual(["a", "b"]);
  });
});

describe("worktree links", () => {
  const wts = [
    { path: "C:/code/app", branch: "main", head: "a1", dirty: { staged: 0, unstaged: 0, untracked: 0 }, aheadBehind: { ahead: 0, behind: 0 } },
    { path: "C:/code/app-fix", branch: "refs/heads/fix-login", head: "b2", dirty: { staged: 1, unstaged: 2, untracked: 0 }, aheadBehind: { ahead: 3, behind: 1 } },
    { path: "C:/code/app-detached", branch: null, head: "c3", detached: true },
  ];
  it("matches by branch name only, never detached trees", () => {
    expect(worktreesOnBranch(wts, "fix-login").map((w) => w.path)).toEqual(["C:/code/app-fix"]);
    expect(worktreesOnBranch(wts, "refs/heads/main").map((w) => w.path)).toEqual(["C:/code/app"]);
    expect(worktreesOnBranch(wts, null)).toEqual([]);
    expect(worktreesOnBranch(wts, "nope")).toEqual([]);
  });
  it("describes facts without advice", () => {
    const [a] = worktreesOnBranch(wts, "fix-login");
    expect(describeWorktree(a)).toBe("3 uncommitted changes, 3 ahead, 1 behind");
    expect(describeWorktree(worktreesOnBranch(wts, "main")[0])).toBe("clean, in step with its upstream");
  });
});
