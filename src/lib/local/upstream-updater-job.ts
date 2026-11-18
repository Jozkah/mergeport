import type { Db } from "@/lib/db";
import { env } from "@/lib/env";
import { portForWrite } from "@/lib/github/factory";
import { getGhRunner } from "@/lib/github/gh";
import { IdentityError, ghExecutable } from "@/lib/github/exec";
import { enqueue, type Handler } from "@/lib/jobs";
import { mergeportHome } from "@/lib/local/profile";
import { runUpdate, type UpdaterDeps } from "@/lib/local/upstream-updater";

/**
 * Scheduling of the upstream auto-updater. The job `upstream.update` (one per mapping, deduplicated by `upstream:<mappingId>`) only
 * REQUESTS a run; the run itself can take as long as the verify command, so it must not hold the job worker (that would stall every
 * other sync) and is kept in this process instead. One run at a time across all mappings; others wait their turn here.
 */

export const UPDATE_JOB = "upstream.update";
export const updateJobKey = (mappingId: string) => `upstream:${mappingId}`;

/** In-process FIFO with one active run. Pure scheduling: what a run does is the `start` callback. */
export class UpdateQueue {
  active: string | null = null;
  readonly waiting: { mappingId: string; manual: boolean }[] = [];
  private current: Promise<void> = Promise.resolve();
  constructor(private readonly start: (mappingId: string, manual: boolean) => Promise<unknown>) {}

  request(mappingId: string, manual: boolean): "started" | "queued" | "duplicate" {
    if (this.active === mappingId) return "duplicate";
    const w = this.waiting.find((x) => x.mappingId === mappingId);
    if (w) {
      w.manual ||= manual;
      return "duplicate";
    }
    if (this.active) {
      this.waiting.push({ mappingId, manual });
      return "queued";
    }
    this.begin(mappingId, manual);
    return "started";
  }

  private begin(mappingId: string, manual: boolean) {
    this.active = mappingId;
    this.current = this.start(mappingId, manual)
      .then(() => {})
      .catch((e) => console.error("upstream update failed", e instanceof Error ? e.message : e))
      .finally(() => {
        this.active = null;
        const next = this.waiting.shift();
        if (next) this.begin(next.mappingId, next.manual);
      });
  }

  /** Resolves when the active run and everything queued behind it are done. */
  async whenIdle(): Promise<void> {
    do await this.current;
    while (this.active);
  }
}

type G = typeof globalThis & { __mpUpdateQueue?: UpdateQueue };
const g = globalThis as G;

/** The credential helper line: the GitHub CLI's own, so Mergeport never touches a token. */
export function credentialHelper(): string {
  const exe = ghExecutable();
  if (!exe) return "!gh auth git-credential";
  const q = (s: string) => `'${s.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;
  return `!${[exe.file, ...exe.prefix].map(q).join(" ")} auth git-credential`;
}

/** The CLI would answer a git credential request as its SELECTED account. If that is not this profile's account, nothing is sent. */
export async function assertActiveAccount(db: Db, host: string): Promise<void> {
  const user = await db.user.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
  if (!user) throw new IdentityError("not-signed-in", "This profile has no GitHub account yet. Sign in first.");
  const r = await getGhRunner()(["api", "--hostname", host, "user", "--jq", ".id"], { timeoutMs: 15_000 });
  if (r.code !== 0) throw new IdentityError("not-signed-in", `The GitHub CLI is not signed in on ${host}. Run: gh auth login --hostname ${host}`);
  if (r.stdout.trim() !== user.githubId.toString()) throw new IdentityError("mismatch", `The GitHub CLI has a different account selected than this profile (${user.login}). Nothing was sent. Run gh auth switch, then run the update again.`);
}

export function productionDeps(db: Db, signal?: AbortSignal): UpdaterDeps {
  const host = env().MERGEPORT_HOST;
  const remoteEnv: Record<string, string> = { GH_HOST: host };
  for (const k of ["GH_CONFIG_DIR", "XDG_CONFIG_HOME", "APPDATA", "LOCALAPPDATA"] as const) if (process.env[k]) remoteEnv[k] = process.env[k]!; // where the CLI keeps its sign-in; no token
  return {
    db,
    home: mergeportHome(env().MERGEPORT_HOME),
    host,
    port: async () => {
      const user = await db.user.findFirstOrThrow({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
      return portForWrite(db, user, { isDemo: false });
    },
    remoteUrl: (_role, fullName) => `https://${host}/${fullName}.git`,
    credentialHelper: credentialHelper(),
    remoteEnv,
    beforeRemote: () => assertActiveAccount(db, host),
    signal,
  };
}

/** Runs left `running` by a process that no longer exists are marked cancelled (call at start-up and before starting a run). */
export async function recoverUpdateRuns(db: Db, queue: UpdateQueue | undefined = g.__mpUpdateQueue): Promise<number> {
  const running = await db.upstreamUpdateRun.findMany({ where: { state: "running" }, select: { id: true, mappingId: true } });
  let n = 0;
  for (const r of running) {
    if (queue && (queue.active === r.mappingId)) continue;
    await db.upstreamUpdateRun.updateMany({ where: { id: r.id, state: "running" }, data: { state: "cancelled", finishedAt: new Date(), error: "Mergeport was closed during this run" } });
    n++;
  }
  return n;
}

function queueFor(db: Db): UpdateQueue {
  return (g.__mpUpdateQueue ??= new UpdateQueue(async (mappingId, manual) => {
    try {
      await runUpdate(productionDeps(db), mappingId, { manual });
    } finally {
      void import("@/lib/local/runtime").then((m) => m.notifyChange("state")).catch(() => {}); // redraw open pages: the history changed
    }
  }));
}

/**
 * After a fork comparison: if auto-update is on for the mapping and the fork is behind, ask for a run. Asking again while the fork and
 * upstream are where the last settled run left them is skipped, so a conflict or a waiting pull request is not rebuilt (and re-announced)
 * on every 15-minute cycle. A run that FAILED (offline, a transient error) is retried.
 */
export async function maybeRequestUpdate(db: Db, mappingId: string): Promise<boolean> {
  const cfg = await db.upstreamUpdateConfig.findUnique({ where: { mappingId } });
  if (!cfg?.enabled || cfg.mode !== "merge") return false; // `releases` mode has its own check (services/upstream-releases)
  const cmp = await db.forkComparison.findFirst({ where: { mappingId }, orderBy: { comparedAt: "desc" } });
  if (!cmp || !(cmp.status === "behind" || cmp.status === "fork-behind" || cmp.status === "diverged") || !(cmp.behindBy && cmp.behindBy > 0)) return false;
  const last = await db.upstreamUpdateRun.findFirst({ where: { mappingId, finishedAt: { not: null } }, orderBy: { startedAt: "desc" } });
  if (last && last.upstreamSha && last.upstreamSha === cmp.baseSha && last.forkSha === cmp.headSha && !["failed", "cancelled"].includes(last.state)) return false;
  await enqueue(db, { type: UPDATE_JOB, payload: { mappingId }, dedupeKey: updateJobKey(mappingId), maxAttempts: 2 });
  return true;
}

export function updateHandlers(db: Db): Record<string, Handler> {
  return {
    [UPDATE_JOB]: (async (p: { mappingId: string; manual?: boolean }) => {
      await recoverUpdateRuns(db);
      queueFor(db).request(p.mappingId, p.manual === true);
    }) as Handler,
  };
}
