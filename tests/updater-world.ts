import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Db } from "@/lib/db";
import { loadViewer } from "@/lib/authz/viewer";
import { truncateAll } from "@/lib/demo/seed";
import { FakeGithub } from "@/lib/github/fake";
import { ensureLocalProfile } from "@/lib/local/profile";
import type { UpdaterDeps } from "@/lib/local/upstream-updater";
import { upsertRepository, type RepoMeta } from "@/lib/services/repositories";

/**
 * Real git against tiny local repositories: a bare "upstream" and a bare "fork" in a SHORT temp folder (git fails on `.git` paths of about
 * 218 characters on Windows), cloned and pushed over plain file paths. Nothing here touches the network or a real repository.
 */

const slash = (p: string) => p.replace(/\\/g, "/");
const base = process.platform === "win32" && fs.existsSync("C:/tmp") ? "C:/tmp" : os.tmpdir();

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Tester", "-c", "user.email=tester@example.test", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }).trim();
}

export class World {
  readonly root: string;
  readonly upstream: string;
  readonly fork: string;
  readonly home: string;
  private readonly wUp: string;
  private readonly wFork: string;

  constructor() {
    this.root = slash(fs.mkdtempSync(path.join(base, "mpu-")));
    this.upstream = `${this.root}/up.git`;
    this.fork = `${this.root}/fk.git`;
    this.home = `${this.root}/home`;
    this.wUp = `${this.root}/wu`;
    this.wFork = `${this.root}/wf`;
    for (const bare of [this.upstream, this.fork]) git(this.root, "init", "--bare", "-b", "main", bare);
    fs.mkdirSync(this.wUp);
    git(this.wUp, "init", "-b", "main");
    git(this.wUp, "remote", "add", "origin", this.upstream);
    fs.writeFileSync(`${this.wUp}/base.txt`, "line1\nline2\nline3\n");
    git(this.wUp, "add", "-A");
    git(this.wUp, "commit", "-m", "base");
    git(this.wUp, "push", "origin", "main");
    git(this.root, "clone", this.upstream, this.wFork);
    git(this.wFork, "remote", "set-url", "origin", this.fork);
    git(this.wFork, "push", "origin", "main");
  }

  private commit(work: string, files: Record<string, string>, message: string, author?: string) {
    for (const [f, c] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(`${work}/${f}`), { recursive: true });
      fs.writeFileSync(`${work}/${f}`, c);
    }
    git(work, "add", "-A");
    git(work, ...(author ? ["-c", `user.name=${author}`] : []), "commit", "-m", message);
    git(work, "push", "origin", "main");
    return git(work, "rev-parse", "HEAD");
  }
  commitUpstream(files: Record<string, string>, message: string, author?: string) {
    return this.commit(this.wUp, files, message, author);
  }
  commitFork(files: Record<string, string>, message: string) {
    return this.commit(this.wFork, files, message);
  }
  tip(bare: string, branch = "main"): string | null {
    try {
      return git(bare, "rev-parse", "--verify", "-q", `refs/heads/${branch}`);
    } catch {
      return null;
    }
  }
  branches(bare: string): string[] {
    return git(bare, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").filter(Boolean).sort();
  }
  isAncestor(bare: string, a: string, b: string): boolean {
    try {
      git(bare, "merge-base", "--is-ancestor", a, b);
      return true;
    } catch {
      return false;
    }
  }
  show(bare: string, ref: string, file: string): string | null {
    try {
      return git(bare, "show", `${ref}:${file}`);
    } catch {
      return null;
    }
  }
  destroy() {
    fs.rmSync(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  /** A script the verify command runs; `body` is its code. Returns the command line to store (program and script quoted). */
  script(name: string, body: string): string {
    const file = `${this.root}/${name}.cjs`;
    fs.writeFileSync(file, body);
    return `"${slash(process.execPath)}" "${file}"`;
  }
}

const meta = (id: bigint, owner: string, name: string): RepoMeta => ({ githubId: id, fullName: `${owner}/${name}`, name, htmlUrl: `https://github.com/${owner}/${name}`, visibility: "PUBLIC", isFork: owner === "owner", defaultBranch: "main", archived: false, owner: { githubId: id + 1000n, login: owner, type: "USER" } });

/** A fresh profile (administrator), a fork `owner/proj`, its upstream `upstream/proj` and the mapping between them. */
export async function setupMapping(db: Db, cfg: { enabled?: boolean; verifyCommand?: string | null; promote?: "pr" | "push"; timeoutSec?: number; branchName?: string; mode?: "merge" | "releases"; includePrereleases?: boolean } | null = {}) {
  await truncateAll(db);
  const p = await ensureLocalProfile(db, { id: 1n, login: "owner", name: "Owner", avatarUrl: null, host: "github.com" });
  const fork = await upsertRepository(db, p.workspace.id, meta(11n, "owner", "proj"));
  const upstream = await upsertRepository(db, p.workspace.id, meta(12n, "upstream", "proj"));
  const mapping = await db.forkMapping.create({ data: { forkRepoId: fork.id, upstreamRepoId: upstream.id, forkBranch: "main", upstreamBranch: "main" } });
  if (cfg) await db.upstreamUpdateConfig.create({ data: { mappingId: mapping.id, enabled: cfg.enabled ?? true, verifyCommand: cfg.verifyCommand ?? null, promote: cfg.promote ?? "pr", timeoutSec: cfg.timeoutSec ?? 60, branchName: cfg.branchName ?? "mergeport/upstream-sync", mode: cfg.mode ?? "merge", includePrereleases: cfg.includePrereleases ?? false } });
  const viewer = (await loadViewer(db, p.user.id))!;
  return { ...p, fork, upstream, mapping, viewer };
}

export function depsFor(world: World, db: Db, port: FakeGithub, extra: Partial<UpdaterDeps> = {}): UpdaterDeps {
  return { db, home: world.home, host: "github.com", port: async () => port, remoteUrl: (role) => (role === "fork" ? world.fork : world.upstream), ...extra };
}
