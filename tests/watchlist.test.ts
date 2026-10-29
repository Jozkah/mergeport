import { beforeEach, describe, expect, it } from "vitest";
import { FakeGithub } from "@/lib/github/fake";
import type { RepoMeta } from "@/lib/services/repositories";
import { applyWatchlist, parseRef, parseWatchlist } from "@/lib/services/watchlist";
import { ValidationError } from "@/lib/errors";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

const meta = (full: string, id: number, o: Partial<RepoMeta> = {}): RepoMeta => {
  const [owner, name] = full.split("/");
  return { githubId: BigInt(id), fullName: full, name, htmlUrl: `https://github.com/${full}`, visibility: "PUBLIC", isFork: false, defaultBranch: "main", archived: false, owner: { githubId: BigInt(id + 9000), login: owner, type: "USER" }, ...o };
};
function port(...repos: RepoMeta[]) {
  const p = new FakeGithub();
  for (const r of repos) p.repos.set(`${r.owner.login}/${r.name}`, r);
  return p;
}

describe("reading a pasted list", () => {
  it("accepts addresses with trailing paths, slashes, .git and comments", () => {
    expect(parseRef("https://github.com/AtomicBot-ai/Atomic-Chat/")).toEqual({ owner: "AtomicBot-ai", name: "Atomic-Chat" });
    expect(parseRef("https://github.com/janhq/jan/tree/dev/web")).toEqual({ owner: "janhq", name: "jan" });
    expect(parseRef("Jozkah/flint.git")).toEqual({ owner: "Jozkah", name: "flint" });
    expect(parseRef("not an address")).toBeNull();
  });

  it("reads one address per line, pairs, arrows, duplicates and mistakes", () => {
    const lines = parseWatchlist(["https://github.com/a/one", "", "# a comment", "a/one", "b/fork -> c/up", "d/x e/y f/z", "nonsense"].join("\n"));
    expect(lines.map((l) => [l.refs.map((r) => `${r.owner}/${r.name}`), !!l.error])).toEqual([[["a/one"], false], [["b/fork", "c/up"], false], [[], true], [[], true]]);
  });
});

describe("applying it", () => {
  it("tracks a fork with its parent and maps them, and maps an explicit pair even when GitHub does not call it a fork", async () => {
    const { db, admin } = S;
    const parent = meta("1CatAI/1Cat-vLLM", 7001);
    const fork = meta("AI-Cluster-Kewaii/1cat-vllm-pxa", 7002, { isFork: true, parentGithubId: 7001n, parentFullName: "1CatAI/1Cat-vLLM" });
    const mine = meta("Jozkah/flint", 7003);
    const upstream = meta("someone/flint-core", 7004);
    const p = port(parent, fork, mine, upstream, meta("janhq/jan", 7005));
    const res = await applyWatchlist(db, admin, p, ["https://github.com/AI-Cluster-Kewaii/1cat-vllm-pxa", "Jozkah/flint someone/flint-core", "https://github.com/janhq/jan/", "ghost/missing"].join("\n"));
    expect(res.map((r) => r.ok)).toEqual([true, true, true, false]);
    expect(res[3].error).toMatch(/Not found/);
    expect(res[2].notes.join(" ")).toMatch(/not list it as a fork/);
    const maps = (await db.forkMapping.findMany({ include: { fork: true, upstream: true } })).filter((m) => !m.fork.isDemo);
    expect(maps.map((m) => `${m.fork.fullName} -> ${m.upstream.fullName}`).sort()).toEqual(["AI-Cluster-Kewaii/1cat-vllm-pxa -> 1CatAI/1Cat-vLLM", "Jozkah/flint -> someone/flint-core"]);
    // adding the same list again changes nothing
    await applyWatchlist(db, admin, p, "Jozkah/flint someone/flint-core");
    expect(await db.forkMapping.count({ where: { fork: { isDemo: false } } })).toBe(2);
  });

  it("is for administrators, and refuses an empty or oversized paste", async () => {
    const { db, a, admin } = S;
    await expect(applyWatchlist(db, a, port(), "x/y")).rejects.toBeInstanceOf(ValidationError);
    await expect(applyWatchlist(db, admin, port(), "   \n# nothing")).rejects.toThrow(/at least one/);
    await expect(applyWatchlist(db, admin, port(), Array.from({ length: 41 }, (_, i) => `o/r${i}`).join("\n"))).rejects.toThrow(/At most 40/);
  });
});
