import { GithubError } from "@/lib/github/port";
import { GitHubRest } from "@/lib/github/rest";

/**
 * One coordination space as seen through GitHub's documented APIs.
 *  - head check: a conditional `GET commits/{branch}` (304 when unchanged, no file downloads);
 *  - read: one recursive tree call, then only the blobs whose SHA changed;
 *  - write: blobs -> tree (based on the head we READ) -> commit -> fast-forward-only ref update. Never force.
 */

export type RepoInfo = { id: number; fullName: string; private: boolean; defaultBranch: string; fork: boolean; permissions: { pull: boolean; push: boolean; admin: boolean }; ownerLogin: string; ownerType: string; ownerId: number };
export type Head = { sha: string; treeSha: string; etag: string | null };
export type TreeEntry = { path: string; sha: string };
export type CommitFile = { path: string; content: string | null }; // null = delete

export class HeadMovedError extends Error {
  constructor() {
    super("The branch moved while we were writing");
  }
}

export class CoordinationStore {
  constructor(
    private readonly rest: GitHubRest,
    readonly owner: string,
    readonly repo: string,
  ) {}

  private p(sub = "") {
    return `/repos/${encodeURIComponent(this.owner)}/${encodeURIComponent(this.repo)}${sub}`;
  }

  async info(): Promise<RepoInfo> {
    const { data } = await this.rest.get(this.p());
    return { id: data.id, fullName: data.full_name, private: !!data.private, defaultBranch: data.default_branch, fork: !!data.fork, permissions: { pull: !!data.permissions?.pull, push: !!data.permissions?.push, admin: !!data.permissions?.admin }, ownerLogin: data.owner.login, ownerType: data.owner.type, ownerId: data.owner.id };
  }

  /** Returns null when nothing changed (304). Empty repositories (no commits yet) report `empty`. */
  async head(branch: string, etag?: string | null): Promise<Head | null | "empty"> {
    try {
      const r = await this.rest.get(this.p(`/commits/${encodeURIComponent(branch)}`), { headers: etag ? { "if-none-match": etag } : {} });
      if (r.status === 304) return null;
      return { sha: r.data.sha, treeSha: r.data.commit.tree.sha, etag: r.headers.get("etag") };
    } catch (e) {
      if (e instanceof GithubError && (e.status === 409 || e.status === 422)) return "empty";
      throw e;
    }
  }

  async tree(treeSha: string): Promise<TreeEntry[]> {
    const { data } = await this.rest.get(this.p(`/git/trees/${treeSha}?recursive=1`));
    if (data.truncated) throw new GithubError("unknown", "The coordination repository is too large to read in one call");
    return (data.tree as { path: string; sha: string; type: string }[]).filter((t) => t.type === "blob").map((t) => ({ path: t.path, sha: t.sha }));
  }

  async blob(sha: string): Promise<string> {
    const { data } = await this.rest.get(this.p(`/git/blobs/${sha}`));
    return Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf8").toString("utf8");
  }

  /** Atomic multi-file commit on top of `base` (the head the caller read). Throws HeadMovedError if the ref advanced. */
  async commit(branch: string, base: { sha: string; treeSha: string }, files: CommitFile[], message: string): Promise<string> {
    const tree: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = [];
    for (const f of files) {
      if (f.content === null) tree.push({ path: f.path, mode: "100644", type: "blob", sha: null });
      else {
        const { data } = await this.rest.request("POST", this.p("/git/blobs"), { content: f.content, encoding: "utf-8" });
        tree.push({ path: f.path, mode: "100644", type: "blob", sha: data.sha });
      }
    }
    const t = await this.rest.request("POST", this.p("/git/trees"), { base_tree: base.treeSha, tree });
    const c = await this.rest.request("POST", this.p("/git/commits"), { message, tree: t.data.sha, parents: [base.sha] });
    try {
      await this.rest.request("PATCH", this.p(`/git/refs/heads/${encodeURIComponent(branch)}`), { sha: c.data.sha, force: false });
    } catch (e) {
      if (e instanceof GithubError && e.status === 422) throw new HeadMovedError(); // not a fast-forward
      throw e;
    }
    return c.data.sha as string;
  }

  /** First commit of a brand-new empty repository (the Git Data API cannot create the first commit). */
  async initialCommit(branch: string, path: string, content: string, message: string): Promise<void> {
    await this.rest.request("PUT", this.p(`/contents/${path}`), { message, content: Buffer.from(content, "utf8").toString("base64"), branch });
  }
}
