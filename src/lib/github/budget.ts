import type { Db } from "@/lib/db";
import { canSpend } from "@/lib/domain/sync";
import { isHosted } from "@/lib/public-url";
import { installationBudgetKey } from "./factory";
import { GithubError, type RateInfo } from "./port";

/** The local app's single credential and budget. */
export const SOURCE_BUDGET_KEY = "source";

/**
 * The rate-limit budget a repository's GitHub reads spend from. The local app has one credential and one budget ("source"). A hosted
 * repository spends from its INSTALLATION's budget (`installation:<id>`): GitHub's quota belongs to the installation token, which
 * every workspace using that installation shares, and one installation running dry must not stall the others.
 */
export async function sourceBudgetKeyFor(db: Db, repositoryId: string): Promise<string> {
  if (!isHosted()) return SOURCE_BUDGET_KEY;
  const repo = await db.repository.findUnique({ where: { id: repositoryId }, select: { installationId: true } });
  return repo?.installationId != null ? installationBudgetKey(repo.installationId) : SOURCE_BUDGET_KEY;
}

/** Throws a rate-limited GithubError (so a job backs off, a page says so) when the budget is nearly spent. */
export async function guardSourceBudget(db: Db, key: string = SOURCE_BUDGET_KEY) {
  const rl = await db.rateLimitState.findUnique({ where: { key } });
  const state = rl ? { remaining: rl.remaining, limit: rl.limit, resetAt: rl.resetAt } : null;
  if (!canSpend(state, 10, 25)) {
    const secs = Math.max(30, Math.ceil((state!.resetAt.getTime() - Date.now()) / 1000));
    throw new GithubError("rate-limited", "Waiting for the GitHub API budget to reset", secs, state!.resetAt);
  }
}

export async function recordRate(db: Db, rate: RateInfo | null, key: string = SOURCE_BUDGET_KEY) {
  if (!rate) return;
  await db.rateLimitState.upsert({ where: { key }, create: { key, ...rate }, update: { ...rate } });
}
