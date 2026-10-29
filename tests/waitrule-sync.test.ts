import { beforeEach, describe, expect, it } from "vitest";
import { entityDef, entityPath, parseEntityPath } from "@/lib/sync/entities";
import { truncateAll } from "@/lib/demo/seed";
import { testDb } from "./helpers";

const db = testDb();
beforeEach(() => truncateAll(db));

describe("waiting rules are shared data", () => {
  it("is a known entity type with a valid path", () => {
    expect(entityDef("waitrule")).toBeTruthy();
    expect(parseEntityPath(entityPath("waitrule", "abc123"))).toEqual({ type: "waitrule", id: "abc123" });
  });

  it("lists a project rule under its project's space and applies it on another computer", async () => {
    const def = entityDef("waitrule")!;
    const ws = (await db.workspace.create({ data: { name: "w" } })).id;
    const space = await db.space.create({ data: { remoteId: "s", teamRemoteId: "t", kind: "RESTRICTED", name: "K", repoOwner: "o", repoName: "r", repoGithubId: 1n, branch: "main" } as never });
    const project = await db.project.create({ data: { workspaceId: ws, name: "K", slug: "k", spaceId: space.id } });
    await db.waitingRule.create({ data: { workspaceId: ws, scope: "PROJECT", projectId: project.id, waitingOn: [{ kind: "USER", ref: "acme" }], reason: "He merges", labels: [], authors: [] } });
    const listed = await def.list(db, { commonSpaceId: null } as never);
    expect(listed).toHaveLength(1);
    expect(listed[0].spaceId).toBe(space.id);
    expect(listed[0].data).toMatchObject({ scope: "PROJECT", reason: "He merges", itemType: "PULL_REQUEST", includeDrafts: false });
    await db.waitingRule.deleteMany({});
    await def.apply(db, { workspaceId: ws } as never, listed[0].id, listed[0].data as never, 0 as never);
    const back = await db.waitingRule.findFirstOrThrow();
    expect(back.waitingOn).toEqual([{ kind: "USER", ref: "acme" }]);
    await def.apply(db, { workspaceId: ws } as never, listed[0].id, null, 0 as never);
    expect(await db.waitingRule.count()).toBe(0);
  });
});
