import { beforeEach, describe, expect, it } from "vitest";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { commitFilesView, pullBlobView, pullCommitsView, pullFilesView, repoContentsView } from "@/lib/services/git-view";
import { freshSeed } from "./helpers";

let S: Awaited<ReturnType<typeof freshSeed>>;
beforeEach(async () => {
  S = await freshSeed();
});

describe("pull request files, commits and file contents", () => {
  it("returns highlighted diffs for a pull request the viewer can see, and caches them by commit", async () => {
    const { db, a, ids } = S;
    await db.workItem.update({ where: { id: ids.items.web9.id }, data: { headSha: "a".repeat(40) } });
    const first = await pullFilesView(db, a, ids.items.web9.id, true);
    expect(first.files.length).toBeGreaterThan(0);
    expect(first.files[0].hunks[0].lines.some((l) => l.t === "add")).toBe(true);
    expect(first.canComment).toBe(true);
    expect(await db.gitCache.count({ where: { key: { startsWith: "prfiles:2:" } } })).toBe(1);
    const again = await pullFilesView(db, a, ids.items.web9.id, false);
    expect(again.files).toEqual(first.files);
    expect(await db.gitCache.count()).toBe(1);
  });

  it("re-reads the diff when the PR is retargeted at the same head (B02)", async () => {
    const { db, a, ids } = S;
    await db.workItem.update({ where: { id: ids.items.web9.id }, data: { headSha: "a".repeat(40), baseRef: "main" } });
    await pullFilesView(db, a, ids.items.web9.id, false);
    await pullFilesView(db, a, ids.items.web9.id, false);
    expect(await db.gitCache.count({ where: { key: { startsWith: "prfiles:" } } })).toBe(1);
    await db.workItem.update({ where: { id: ids.items.web9.id }, data: { baseRef: "release/1.0" } });
    await pullFilesView(db, a, ids.items.web9.id, false);
    expect(await db.gitCache.count({ where: { key: { startsWith: "prfiles:" } } })).toBe(2); // fetched again, not served from the old base
  });

  it("does not look up a pull request the viewer cannot see, and rejects ids that are not commits", async () => {
    const { db, b, ids } = S;
    await expect(pullFilesView(db, b, ids.items.api14.id, false)).rejects.toBeInstanceOf(NotFoundError);
    await expect(pullCommitsView(db, b, ids.items.api14.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(commitFilesView(db, S.a, ids.items.web9.id, "../etc/passwd")).rejects.toBeInstanceOf(ValidationError);
  });

  it("lists commits with their descriptions, and the files of one commit", async () => {
    const { db, a, ids } = S;
    const { commits } = await pullCommitsView(db, a, ids.items.web9.id);
    expect(commits.length).toBe(3);
    expect(commits[0].body).toContain("32");
    const one = await commitFilesView(db, a, ids.items.web9.id, commits[0].sha);
    expect(one.files.map((f) => f.filename)).toEqual(["src/session.ts"]);
  });

  it("loads a file at the head commit for expanding context", async () => {
    const { db, a, ids } = S;
    await db.workItem.update({ where: { id: ids.items.web9.id }, data: { headSha: "b".repeat(40) } });
    const blob = await pullBlobView(db, a, ids.items.web9.id, "src/session.ts");
    expect(blob.lang).toBe("typescript");
    expect(blob.lines.length).toBeGreaterThan(30);
    expect(blob.lines[0].map((t) => t[0]).join("")).toContain("randomBytes");
  });
});

describe("browsing a repository", () => {
  it("shows a folder with its README and a file with line-by-line tokens", async () => {
    const { db, a, ids } = S;
    const repoId = (await db.workItem.findUniqueOrThrow({ where: { id: ids.items.web9.id } })).repositoryId;
    const root = await repoContentsView(db, a, repoId, "", null);
    expect(root.kind).toBe("dir");
    if (root.kind === "dir") {
      expect(root.entries[0].type).toBe("dir"); // folders first
      expect(root.readme?.html).toContain("<h1");
      expect(root.readme?.html).toContain('class="hl"'); // the fenced bash block is coloured
    }
    const file = await repoContentsView(db, a, repoId, "src/utils/format.ts", null);
    expect(file.kind).toBe("file");
    if (file.kind === "file") expect(file.blob.lines.length).toBeGreaterThan(5);
  });

  it("is not available for a repository the viewer has no grant on", async () => {
    const { db, b, ids } = S;
    const repoId = (await db.workItem.findUniqueOrThrow({ where: { id: ids.items.api14.id } })).repositoryId;
    await expect(repoContentsView(db, b, repoId, "", null)).rejects.toBeInstanceOf(NotFoundError);
  });
});
