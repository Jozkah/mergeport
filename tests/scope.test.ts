import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
import { GLOBAL, resolveScope, scopeKey, scopeLabel, scopeRepositoryIds } from "@/lib/scope";
import { attention } from "@/lib/services/queries";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

describe("working scope", () => {
  it("parses only well-formed values and falls back to Global for anything else", async () => {
    const { db, admin } = S;
    for (const raw of [undefined, "", "all", "x:1", "p:", "p:../etc", "p:" + "a".repeat(80)]) expect(await resolveScope(db, admin, raw)).toEqual(GLOBAL);
  });

  it("resolves a visible project and repository, and drops one the viewer cannot see", async () => {
    const { db, admin, b, ids } = S;
    const p = await resolveScope(db, admin, `p:${ids.projects.atlas.id}`);
    expect(p).toMatchObject({ kind: "project", id: ids.projects.atlas.id });
    expect(scopeKey(p)).toBe(`p:${ids.projects.atlas.id}`);
    expect(scopeLabel(p)).toMatch(/^Project /);
    const hidden = await db.repository.findFirstOrThrow({ where: { fullName: { contains: "HIDDEN" } } }).catch(() => null);
    const apiRepo = await db.repository.findFirstOrThrow({ where: { fullName: "northwind/atlas-api" } });
    expect(await resolveScope(db, admin, `r:${apiRepo.id}`)).toMatchObject({ kind: "repo" });
    expect(await resolveScope(db, b, `r:${apiRepo.id}`)).toEqual(GLOBAL); // B has no grant on it
    void hidden;
  });

  it("narrows the attention queues to the scope's repositories", async () => {
    const { db, admin } = S;
    const apiRepo = await db.repository.findFirstOrThrow({ where: { fullName: "northwind/atlas-api" } });
    const scope = await resolveScope(db, admin, `r:${apiRepo.id}`);
    const ids = await scopeRepositoryIds(db, scope);
    expect(ids).toEqual([apiRepo.id]);
    const all = await attention(db, admin);
    const scoped = await attention(db, admin, { repositoryIds: ids });
    const repos = (q: typeof all) => new Set([...q.needsTeamReview, ...q.waitingExternal, ...q.blocked].map((d) => d.item.repositoryId));
    expect(repos(scoped).size).toBeLessThanOrEqual(1);
    expect(repos(all).size).toBeGreaterThan(1);
    expect(await scopeRepositoryIds(db, GLOBAL)).toBeUndefined();
  });
});
