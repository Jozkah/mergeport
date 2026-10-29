import { beforeEach, describe, expect, it } from "vitest";
import { byOwnerFirst, byPersonalFirst, isPersonalName, personFirst } from "@/lib/domain/ordering";
import { parseReviewerRefs, projectReviewerRefs, setProjectReviewers } from "@/lib/services/project-reviewers";
import { truncateAll } from "@/lib/demo/seed";
import { testDb } from "./helpers";

describe("the person comes first", () => {
  it("recognises personal names and the viewer's own login", () => {
    expect(["Me", "Mine", "Personal", "personal workspace", "octocat"].every((n) => isPersonalName(n, "octocat"))).toBe(true);
    expect(isPersonalName("Globex", "octocat")).toBe(false);
  });
  it("puts Me/Personal ahead of teams on name lists", () => expect(["Globex", "Initech", "Mine", "Acme"].sort(byPersonalFirst("octocat"))).toEqual(["Mine", "Acme", "Globex", "Initech"]));
  it("puts the viewer's own repositories first", () => expect(["3DStore/x", "octocat/b", "globex/s", "octocat/a"].sort(byOwnerFirst("octocat"))).toEqual(["octocat/a", "octocat/b", "3DStore/x", "globex/s"]));
  it("keeps the order of everything else", () => expect(personFirst([{ o: "x" }, { o: "me" }, { o: "y" }], (i) => i.o === "me").map((i) => i.o)).toEqual(["me", "x", "y"]));
});

describe("project required reviewers", () => {
  const db = testDb();
  let ws: string;
  let project: string;
  beforeEach(async () => {
    await truncateAll(db);
    ws = (await db.workspace.create({ data: { name: "w" } })).id;
    project = (await db.project.create({ data: { workspaceId: ws, name: "Globex", slug: "globex" } })).id;
  });
  it("parses names from commas, spaces and @ prefixes without duplicates", () => expect(parseReviewerRefs("@maintainer, maintainer org/team  other")).toEqual(["maintainer", "org/team", "other"]));
  it("creates, updates and removes one project rule and leaves hand-written rules alone", async () => {
    const manual = await db.reviewRule.create({ data: { workspaceId: ws, scope: "PROJECT", projectId: project, labels: [], reviewers: [{ kind: "USER", ref: "someone" }], reason: "Written by hand" } });
    await setProjectReviewers(db, ws, project, "Globex", "maintainer");
    expect(await projectReviewerRefs(db, ws, project)).toEqual(["maintainer"]);
    await setProjectReviewers(db, ws, project, "Globex", "maintainer, org/leads");
    expect(await db.reviewRule.count({ where: { projectId: project } })).toBe(2);
    expect(await projectReviewerRefs(db, ws, project)).toEqual(["maintainer", "org/leads"]);
    await setProjectReviewers(db, ws, project, "Globex", "");
    expect(await db.reviewRule.findMany({ where: { projectId: project } })).toHaveLength(1);
    expect((await db.reviewRule.findFirstOrThrow({ where: { projectId: project } })).id).toBe(manual.id);
  });
});

describe("leaving a team locally", () => {
  it("returns shared things to local and personal mode without losing boards or rules", async () => {
    const { leaveTeamLocally } = await import("@/lib/team/leave");
    const db = testDb();
    await truncateAll(db);
    const ws = (await db.workspace.create({ data: { name: "w" } })).id;
    const space = await db.space.create({ data: { remoteId: "s", teamRemoteId: "t", kind: "COMMON", name: "Team", repoOwner: "o", repoName: "r", repoGithubId: 1n, branch: "main" } as never });
    await db.teamConfig.upsert({ where: { id: "team" }, create: { id: "team", mode: "TEAM", teamRemoteId: "t", name: "Team", commonSpaceId: space.id }, update: { mode: "TEAM", teamRemoteId: "t", name: "Team", commonSpaceId: space.id } });
    const project = await db.project.create({ data: { workspaceId: ws, name: "P", slug: "p", spaceId: space.id } });
    await db.reviewRule.create({ data: { workspaceId: ws, scope: "PROJECT", projectId: project.id, labels: [], reviewers: [{ kind: "USER", ref: "x" }], reason: "r" } });
    expect((await leaveTeamLocally(db)).spaces).toBe(1);
    expect(await db.space.count()).toBe(0);
    expect((await db.project.findUniqueOrThrow({ where: { id: project.id } })).spaceId).toBeNull();
    expect((await db.teamConfig.findUniqueOrThrow({ where: { id: "team" } })).mode).toBe("PERSONAL");
    expect(await db.reviewRule.count()).toBe(1);
  });
});
