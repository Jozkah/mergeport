import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { take, claimGap } from "@/lib/auth/rate-limit";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { audit } from "@/lib/services/audit";
import { enqueue } from "@/lib/jobs";
import { GithubAppError, githubApiBase } from "./app-auth";
import { githubAppConfig } from "./app-config";
import { VALID_FOR_MS, READ_PERMISSIONS } from "./access-cache";
import { loadBoundInstallation } from "./binding";
import { connectOverrides } from "./connect";
import { OctokitPort, createOctokit } from "./octokit";
import { GithubError, type GithubPort } from "./port";
import { githubAppFetch } from "./transport";
import { getUserAccessToken, markRelinkIfCurrent } from "./user-token";
import { githubWritesCeiling } from "./writes-ceiling";
import { FOOTER, TITLE_MAX, BODY_MAX, validateWriteText, withFooter } from "./write-text";

export { FOOTER, TITLE_MAX, BODY_MAX, validateWriteText, withFooter };

/**
 * Opt-in GitHub writes made AS THE PERSON (docs/github-app.md, "Writing to GitHub as you"). Scope of this change, and no more:
 * create an issue from a task, and comment on a tracked issue or pull request. Never merge, close, delete, push, label, assign, edit
 * somebody else's comment or submit a review.
 *
 * Every write passes `githubWrite`, which in this order requires: the deployment ceiling (MERGEPORT_GITHUB_WRITES=on), the workspace switch,
 * a repository served by an installation this workspace proved it controls, the person's own working GitHub link, and a fresh cached
 * repository grant for them (GithubRepoAccess, pull or better, as the "may see this repository" gate; what they may DO is GitHub's answer).
 * The call is made with the person's own user-to-server token, never the installation's, so GitHub authorizes and attributes it.
 * Callers have already required the Mergeport capability (requireRepo "manageWork"). Rate limits, audit rows and the typed refusals live here.
 */

export type WriteKind = "issue.create" | "comment";
export type RefusalReason = "ceiling-off" | "workspace-off" | "not-connected" | "not-linked" | "relink" | "no-key" | "no-access" | "unavailable" | "rate-user" | "rate-workspace" | "duplicate";

export const REFUSAL_MESSAGES: Record<RefusalReason, string> = {
  "ceiling-off": "GitHub writes are not enabled yet",
  "workspace-off": "Writing to GitHub is turned off for this workspace. An owner or administrator can turn it on in Settings, GitHub.",
  "not-connected": "This repository is not connected to GitHub through this workspace right now.",
  "not-linked": "Link GitHub first: this is written to GitHub as you, so Mergeport needs your own GitHub account linked (Settings, Linked accounts).",
  relink: "Your GitHub link needs a new sign-in before Mergeport can write as you (Settings, Linked accounts).",
  "no-key": "Writing to GitHub as you is unavailable on this server right now. Ask the person who runs it.",
  "no-access": "GitHub has not confirmed that you can open this repository. Open Settings, Linked accounts, check your access, then try again.",
  unavailable: "Could not reach GitHub to renew your sign-in. Nothing was written. Try again in a minute.",
  "rate-user": "You have written to GitHub through Mergeport a lot in the last hour. Wait a little and try again.",
  "rate-workspace": "This workspace has written to GitHub through Mergeport a lot in the last hour. Wait a little and try again.",
  duplicate: "That was just sent. Reload to see it.",
};

/** A write that was refused before (or instead of) reaching GitHub. Shown to the person as is: it holds no token and no internal id. */
export class GithubWriteRefusedError extends ForbiddenError {
  constructor(readonly reason: RefusalReason) {
    super(REFUSAL_MESSAGES[reason]);
  }
}

/** GitHub itself answered no (or something failed on the way): `explain` turned it into a sentence. */
export class GithubWriteError extends ValidationError {
  constructor(
    message: string,
    readonly kind: string,
    readonly githubStatus?: number,
  ) {
    super(message);
  }
}

export const USER_WRITES_PER_HOUR = 20;
export const WORKSPACE_WRITES_PER_HOUR = 100;
const HOUR_MS = 3_600_000;
export const userWriteKey = (userId: string) => `ghwrite:user:${userId}`;
export const workspaceWriteKey = (workspaceId: string) => `ghwrite:ws:${workspaceId}`;

type Repo = { id: string; githubId: bigint; installationId: bigint | null; isDemo: boolean; fullName: string; workspaceId: string };

/**
 * Why this person cannot write to this repository from here, or null when they can. Cheap (no GitHub call, no token use): the UI asks
 * it to decide what to offer, and `githubWrite` asks it again before every write. A demo repository is never subject to it.
 */
export async function writeRefusal(db: Db, v: Pick<Viewer, "userId" | "workspaceId">, repo: Repo, now: Date = new Date()): Promise<RefusalReason | null> {
  if (repo.isDemo) return null;
  if (!githubWritesCeiling()) return "ceiling-off";
  const ws = await db.workspace.findUnique({ where: { id: v.workspaceId }, select: { githubWritesEnabled: true } });
  if (!ws?.githubWritesEnabled) return "workspace-off";
  if (repo.workspaceId !== v.workspaceId || repo.installationId === null || !(await loadBoundInstallation(db, v.workspaceId, repo.installationId))) return "not-connected";
  const link = await db.githubUserToken.findUnique({ where: { userId: v.userId }, select: { status: true } });
  const u = await db.user.findUnique({ where: { id: v.userId }, select: { githubId: true } });
  if (!link || u?.githubId == null) return "not-linked";
  if (link.status !== "OK") return "relink";
  if (!process.env.MERGEPORT_ENCRYPTION_KEY) return "no-key";
  const cutoff = new Date(now.getTime() - VALID_FOR_MS);
  const grant = await db.githubRepoAccess.findFirst({ where: { userId: v.userId, repositoryGithubId: repo.githubId, installationId: repo.installationId, checkedAt: { gte: cutoff }, permission: { in: [...READ_PERMISSIONS] } }, select: { id: true } });
  return grant ? null : "no-access";
}

/** The sentence for GitHub's own refusal. GitHub's raw message is not repeated: it is not ours to vouch for. */
export function explain(e: GithubError, kind: WriteKind): string {
  switch (e.kind) {
    case "rate-limited":
      return "GitHub is limiting requests right now. Nothing was written. Try again in a few minutes.";
    case "sso":
      return e.message;
    case "network":
      return "Could not reach GitHub. Nothing was written. Try again.";
    case "forbidden":
      return "GitHub refused this. Your GitHub account may not be allowed to write here, the conversation may be locked, or the Mergeport GitHub App has not been given permission to write issues and pull requests yet: an owner of the GitHub account has to accept the new permissions (see docs/github-app.md).";
    case "not-found":
      return "GitHub could not find this with your account. You may have lost access to the repository, or it was renamed or deleted.";
    default:
      if (e.status === 410) return kind === "issue.create" ? "Issues are turned off for this repository on GitHub." : "That issue or pull request was deleted or moved on GitHub.";
      if (e.status === 422) return "GitHub did not accept the text (validation failed). Check the title and description and try again.";
      return "GitHub did not accept it. Nothing was written.";
  }
}

const releaseClaim = (db: Db, key: string) => db.rateLimitState.deleteMany({ where: { key } }).then(() => undefined);

export type WriteOpts<T> = {
  kind: WriteKind;
  repo: Repo;
  /** What the audit row is about. */
  target: { type: string; id: string };
  /** One-shot lock: a second identical request inside `gapMs` is refused as a duplicate (double submit). Released when the write fails. */
  dedupeKey?: string;
  call: (port: GithubPort) => Promise<T>;
  /** Item number for the audit row and the follow-up sync. */
  numberOf: (r: T) => number;
  now?: Date;
};

/**
 * Runs one write as the person. Order: refusal gate, duplicate lock, budgets, the person's own token, the GitHub call (one renewal and
 * one retry if GitHub says the token is dead), audit row (success or failure), and finally a `sync.item` job so the mirror updates.
 */
export async function githubWrite<T>(ctx: { db: Db; v: Viewer }, o: WriteOpts<T>): Promise<T> {
  const { db, v } = ctx;
  const now = o.now ?? new Date();
  const reason = await writeRefusal(db, v, o.repo, now);
  if (reason) throw new GithubWriteRefusedError(reason);

  if (o.dedupeKey && !(await claimGap(db, o.dedupeKey, 120_000, now))) throw new GithubWriteRefusedError("duplicate");
  const unclaim = async () => {
    if (o.dedupeKey) await releaseClaim(db, o.dedupeKey);
  };
  try {
    if (!(await take(db, userWriteKey(v.userId), USER_WRITES_PER_HOUR, HOUR_MS, now))) throw new GithubWriteRefusedError("rate-user");
    if (!(await take(db, workspaceWriteKey(v.workspaceId), WORKSPACE_WRITES_PER_HOUR, HOUR_MS, now))) throw new GithubWriteRefusedError("rate-workspace");

    const config = githubAppConfig();
    if (!config) throw new GithubWriteRefusedError("no-key");
    const deps = connectOverrides()?.deps ?? {};
    const portFor = async (force: boolean): Promise<{ port: GithubPort; version: Date }> => {
      let t;
      try {
        t = await getUserAccessToken(db, config, v.userId, deps, now, { force });
      } catch (e) {
        if (e instanceof GithubAppError) throw new GithubWriteRefusedError("unavailable");
        throw e;
      }
      if (t.kind === "none") throw new GithubWriteRefusedError("not-linked");
      if (t.kind === "relink") throw new GithubWriteRefusedError("relink");
      if (t.kind === "no-key") throw new GithubWriteRefusedError("no-key");
      // The person's own token, no cache: nothing a write fetches is stored under a shared key.
      return { port: new OctokitPort(createOctokit(t.token, githubAppFetch(), githubApiBase())), version: t.version };
    };

    let attempt = await portFor(false);
    let result: T;
    try {
      try {
        result = await o.call(attempt.port);
      } catch (e) {
        if (!(e instanceof GithubError && e.kind === "auth")) throw e;
        // GitHub says the token is dead: one renewal and one retry (a 401 means nothing was written), then the link needs a new sign-in.
        attempt = await portFor(true);
        try {
          result = await o.call(attempt.port);
        } catch (e2) {
          if (e2 instanceof GithubError && e2.kind === "auth") {
            await markRelinkIfCurrent(db, v.userId, attempt.version);
            throw new GithubWriteRefusedError("relink");
          }
          throw e2;
        }
      }
    } catch (e) {
      if (e instanceof GithubError) {
        await unclaim();
        await audit(db, v, `github.write.${o.kind}.failed`, o.target, { repository: o.repo.fullName, reason: e.kind, ...(e.status ? { status: e.status } : {}) });
        throw new GithubWriteError(explain(e, o.kind), e.kind, e.status);
      }
      throw e;
    }

    const number = o.numberOf(result);
    await audit(db, v, `github.write.${o.kind}`, o.target, { repository: o.repo.fullName, number });
    await enqueue(db, { type: "sync.item", payload: { repositoryId: o.repo.id, number }, dedupeKey: `item:${o.repo.id}:${number}`, workspaceId: v.workspaceId }).catch(() => undefined);
    return result;
  } catch (e) {
    if (e instanceof GithubWriteRefusedError || !(e instanceof GithubWriteError)) await unclaim();
    throw e;
  }
}
