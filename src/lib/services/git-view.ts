import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { repoWhere, viaRepo, type Viewer } from "@/lib/authz/viewer";
import { buildDiffFile, type DiffFile } from "@/lib/diff";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { portForSync } from "@/lib/github/factory";
import type { RemoteCommit, Contents, TreeEntry } from "@/lib/github/port";
import { highlightLines, langForPath, type Tok } from "@/lib/highlight";
import { renderMarkdown } from "@/lib/markdown";

/**
 * Everything the pull request "Files" and "Commits" tabs and the code browser show, fetched from GitHub on demand with the
 * viewer's own access and kept in a local cache. A diff, a commit list or a file at a given commit never changes, so the second
 * look is free; only a moving ref (a branch name) is looked up again.
 */

const MAX_ENTRY_BYTES = 6_000_000;
const MAX_ROWS = 400;

async function cached<T>(db: Db, key: string, load: () => Promise<T>, o: { cache?: boolean } = {}): Promise<T> {
  if (o.cache !== false) {
    const hit = await db.gitCache.findUnique({ where: { key } });
    if (hit) {
      void db.gitCache.update({ where: { key }, data: { accessedAt: new Date() } }).catch(() => {});
      return hit.payload as T;
    }
  }
  const value = await load();
  if (o.cache !== false) {
    const text = JSON.stringify(value);
    if (text.length <= MAX_ENTRY_BYTES) {
      await db.gitCache.upsert({ where: { key }, create: { key, payload: value as Prisma.InputJsonValue, bytes: text.length }, update: { payload: value as Prisma.InputJsonValue, bytes: text.length, accessedAt: new Date() } }).catch(() => {});
      void prune(db);
    }
  }
  return value;
}

let lastPrune = 0;
async function prune(db: Db) {
  if (Date.now() - lastPrune < 60_000) return;
  lastPrune = Date.now();
  try {
    const n = await db.gitCache.count();
    if (n > MAX_ROWS) {
      const old = await db.gitCache.findMany({ orderBy: { accessedAt: "asc" }, take: n - MAX_ROWS, select: { key: true } });
      await db.gitCache.deleteMany({ where: { key: { in: old.map((o) => o.key) } } });
    }
    await db.gitCache.deleteMany({ where: { accessedAt: { lt: new Date(Date.now() - 30 * 86400_000) } } });
  } catch {
    // pruning is best effort
  }
}

async function loadItem(db: Db, v: Viewer, id: string) {
  const item = await db.workItem.findFirst({ where: { id, ...viaRepo(v) }, include: { repository: { include: { owner: true } }, comments: { where: { kind: "REVIEW_COMMENT" }, orderBy: { createdAtGh: "asc" } } } });
  if (!item) throw new NotFoundError();
  return item;
}

export async function portFor(db: Db, repositoryId: string) {
  const port = await portForSync(db, repositoryId);
  if (!port) throw new ValidationError("No credential can read this repository right now.");
  return port;
}

export type InlineComment = { id: string; author: string | null; html: string; createdAt: string; line: number; commitSha: string | null; resolved?: boolean | null };
export type PrFilesView = { /** The commit this viewer last submitted a review on, for "changes since my last review". */ lastReviewedSha: string | null; headSha: string | null; files: DiffFile[]; truncated: boolean; inline: Record<string, InlineComment[]>; canComment: boolean };

/** All changed files of a pull request, highlighted and ready to draw, with the review comments already on it. */
export async function pullFilesView(db: Db, v: Viewer, id: string, canComment: boolean): Promise<PrFilesView> {
  const item = await loadItem(db, v, id);
  if (item.type !== "PULL_REQUEST") throw new NotFoundError();
  const port = await portFor(db, item.repositoryId);
  // The diff depends on the base as well as the head: retargeting a PR changes its files while the head stays the same.
  const key = item.headSha ? `prfiles:2:${item.repositoryId}:${item.number}:${item.baseRef ?? "-"}:${item.headSha}` : null;
  const load = async () => {
    const r = await port.listPullFiles(item.repository.owner.login, item.repository.name, item.number);
    return { files: r.files.map(buildDiffFile), truncated: r.truncated };
  };
  const { files, truncated } = key ? await cached(db, key, load) : await load();
  const inline: Record<string, InlineComment[]> = {};
  for (const c of item.comments) {
    if (!c.path || !c.line) continue;
    (inline[c.path] ??= []).push({ id: c.id, author: c.authorLogin, html: renderMarkdown(c.body), createdAt: c.createdAtGh.toISOString(), line: c.line, commitSha: c.commitSha, resolved: c.threadResolved });
  }
  const mine = await db.workItemComment.findFirst({ where: { workItemId: item.id, kind: "REVIEW", authorLogin: { equals: v.login }, commitSha: { not: null } }, orderBy: { createdAtGh: "desc" }, select: { commitSha: true } });
  return { lastReviewedSha: mine?.commitSha ?? null, headSha: item.headSha, files, truncated, inline, canComment };
}

export type CommitView = { sha: string; message: string; body: string; author: string | null; authorAvatar: string | null; date: string | null };

export async function pullCommitsView(db: Db, v: Viewer, id: string): Promise<{ commits: CommitView[]; truncated: boolean }> {
  const item = await loadItem(db, v, id);
  if (item.type !== "PULL_REQUEST") throw new NotFoundError();
  const port = await portFor(db, item.repositoryId);
  const load = async () => {
    const r = await port.listPullCommits(item.repository.owner.login, item.repository.name, item.number);
    return { commits: r.commits.map(toCommitView), truncated: r.truncated };
  };
  return item.headSha ? cached(db, `prcommits:2:${item.repositoryId}:${item.number}:${item.baseRef ?? "-"}:${item.headSha}`, load) : load();
}

const toCommitView = (c: RemoteCommit): CommitView => ({ sha: c.sha, message: c.message, body: c.body ?? "", author: c.author, authorAvatar: c.authorAvatar ?? null, date: c.date ? c.date.toISOString() : null });

/** One commit's files, so each commit of a pull request can be reviewed on its own. */
export async function commitFilesView(db: Db, v: Viewer, id: string, sha: string): Promise<{ files: DiffFile[]; truncated: boolean }> {
  if (!/^[0-9a-f]{7,40}$/i.test(sha)) throw new ValidationError("That is not a commit id");
  const item = await loadItem(db, v, id);
  const port = await portFor(db, item.repositoryId);
  return cached(db, `commitfiles:2:${item.repositoryId}:${sha.toLowerCase()}`, async () => {
    const r = await port.listCommitFiles(item.repository.owner.login, item.repository.name, sha);
    return { files: r.files.map(buildDiffFile), truncated: r.truncated };
  });
}

const SHA = /^[0-9a-f]{7,40}$/i;

/**
 * What changed between two commits of this pull request's repository, for "since my last review" or "between these two versions".
 * Two full commit ids never change what they mean, so the answer is kept; short ids are looked up each time.
 */
export async function compareFilesView(db: Db, v: Viewer, id: string, from: string, to: string): Promise<{ files: DiffFile[]; truncated: boolean; from: string; to: string }> {
  if (!SHA.test(from) || !SHA.test(to)) throw new ValidationError("That is not a commit id");
  const item = await loadItem(db, v, id);
  if (item.type !== "PULL_REQUEST") throw new NotFoundError();
  const port = await portFor(db, item.repositoryId);
  const immutable = from.length === 40 && to.length === 40;
  const r = await cached(db, `cmp:1:${item.repositoryId}:${from.toLowerCase()}:${to.toLowerCase()}`, async () => {
    const c = await port.compareCommits(item.repository.owner.login, item.repository.name, from, to);
    return { files: c.files.map(buildDiffFile), truncated: c.truncated };
  }, { cache: immutable });
  return { ...r, from, to };
}

export type BlobView = { path: string; binary: boolean; tooLarge: boolean; size: number; lines: Tok[][]; palette: string[]; htmlUrl: string | null; lang: string | null };

function toBlob(file: Extract<Contents, { kind: "file" }>["file"]): BlobView {
  const lang = langForPath(file.path);
  if (file.text === null) return { path: file.path, binary: file.binary, tooLarge: file.tooLarge, size: file.size, lines: [], palette: [], htmlUrl: file.htmlUrl, lang };
  const text = file.text.endsWith("\n") ? file.text.slice(0, -1) : file.text;
  const h = highlightLines(text, lang);
  return { path: file.path, binary: false, tooLarge: false, size: file.size, lines: h.lines, palette: h.palette, htmlUrl: file.htmlUrl, lang };
}

const isSha = (ref: string) => /^[0-9a-f]{40}$/i.test(ref);

/** A file at a commit, for expanding the lines between diff hunks. */
export async function pullBlobView(db: Db, v: Viewer, id: string, path: string): Promise<BlobView> {
  const item = await loadItem(db, v, id);
  if (!item.headSha) throw new ValidationError("This pull request has no head commit yet");
  const port = await portFor(db, item.repositoryId);
  return cached(db, `blob:1:${item.repositoryId}:${item.headSha}:${path}`, async () => {
    const c = await port.getContents(item.repository.owner.login, item.repository.name, path, item.headSha!);
    if (c.kind !== "file") throw new NotFoundError();
    return toBlob(c.file);
  });
}

export type CodeView = { kind: "dir"; entries: TreeEntry[]; readme: { path: string; html: string } | null } | { kind: "file"; blob: BlobView; markdown: string | null };

/** A folder or a file of a repository at a branch, tag or commit. */
export async function repoContentsView(db: Db, v: Viewer, repositoryId: string, path: string, ref: string | null): Promise<CodeView> {
  const repo = await db.repository.findFirst({ where: { id: repositoryId, ...repoWhere(v) }, include: { owner: true } });
  if (!repo) throw new NotFoundError();
  const port = await portFor(db, repo.id);
  const at = ref || repo.defaultBranch || undefined;
  const clean = path.replace(/^\/+|\/+$/g, "");
  const load = async (): Promise<CodeView> => {
    const c = await port.getContents(repo.owner.login, repo.name, clean, at);
    if (c.kind === "file") {
      const blob = toBlob(c.file);
      return { kind: "file", blob, markdown: /\.(md|markdown)$/i.test(c.file.path) && c.file.text ? renderMarkdown(c.file.text) : null };
    }
    const readmeEntry = c.entries.find((e) => e.type === "file" && /^readme(\.(md|markdown|txt))?$/i.test(e.name));
    let readme: { path: string; html: string } | null = null;
    if (readmeEntry) {
      try {
        const r = await port.getContents(repo.owner.login, repo.name, readmeEntry.path, at);
        if (r.kind === "file" && r.file.text) readme = { path: readmeEntry.path, html: /\.txt$/i.test(readmeEntry.name) ? `<pre>${r.file.text.replace(/[&<>]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch]!)}</pre>` : renderMarkdown(r.file.text) };
      } catch {
        readme = null;
      }
    }
    return { kind: "dir", entries: c.entries, readme };
  };
  // A commit id never changes; a branch name does, so it is always asked again (the request itself is ETag-cached by GitHub).
  return at && isSha(at) ? cached(db, `code:1:${repo.id}:${at}:${clean}`, load) : load();
}
