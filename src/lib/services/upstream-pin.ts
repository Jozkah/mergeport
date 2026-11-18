import type { Db } from "@/lib/db";
import { notifyUpstream } from "./upstream-notify";

/**
 * The upstream auto-updater's pin: what the person approved when they saved the settings (both repositories' GitHub ids and full names,
 * and both branches). Mappings and repository names can change under the config through a teammate's shared edit; the updater (and the
 * release watch) only acts on the mapping the person saw. No git and no verify code here: the release watch imports it.
 */

type PinSource = { forkBranch: string; upstreamBranch: string; fork: { githubId: bigint; fullName: string }; upstream: { githubId: bigint; fullName: string } };
type Pin = { pinForkGithubId: bigint | null; pinUpstreamGithubId: bigint | null; pinForkFullName: string | null; pinUpstreamFullName: string | null; pinForkBranch: string | null; pinUpstreamBranch: string | null };

export const PIN_CHANGED = "The mapping changed since you enabled auto-update: review and save again";

/** The columns that pin a config to its mapping as it is right now (written by every save of the settings). */
export const pinOf = (m: PinSource): Pin => ({ pinForkGithubId: m.fork.githubId, pinUpstreamGithubId: m.upstream.githubId, pinForkFullName: m.fork.fullName, pinUpstreamFullName: m.upstream.fullName, pinForkBranch: m.forkBranch, pinUpstreamBranch: m.upstreamBranch });

/** What differs between the pin and the live mapping, or null. Full names compare without case (GitHub's own spelling may change case). */
export function pinMismatch(cfg: Pin, m: PinSource): string | null {
  const same = (a: string | null, b: string) => (a ?? "").toLowerCase() === b.toLowerCase();
  if (cfg.pinForkGithubId !== m.fork.githubId || !same(cfg.pinForkFullName, m.fork.fullName)) return `the fork is now ${m.fork.fullName}`;
  if (cfg.pinUpstreamGithubId !== m.upstream.githubId || !same(cfg.pinUpstreamFullName, m.upstream.fullName)) return `the upstream is now ${m.upstream.fullName}`;
  if (cfg.pinForkBranch !== m.forkBranch || cfg.pinUpstreamBranch !== m.upstreamBranch) return `the branches are now ${m.upstreamBranch} into ${m.forkBranch}`;
  return null;
}

/**
 * Before anything is read or run: is the mapping still what the person approved? A config never saved through the settings (no pin) is
 * pinned to the mapping as it stands. A mismatch records ONE failed run (and one notification) with the reason, not repeated while the
 * reason stays the same. Returns true when the caller must stop.
 */
export async function pinBlocks(db: Db, m: PinSource & { id: string; forkRepoId: string; fork: { workspaceId: string }; updateConfig: Pin }, at: Date, trigger: string): Promise<boolean> {
  const cfg = m.updateConfig;
  if (cfg.pinForkGithubId === null) {
    await db.upstreamUpdateConfig.update({ where: { mappingId: m.id }, data: pinOf(m) });
    return false;
  }
  const why = pinMismatch(cfg, m);
  if (!why) return false;
  const error = `${PIN_CHANGED} (${why}). Nothing was run.`;
  const prev = await db.upstreamUpdateRun.findFirst({ where: { mappingId: m.id, finishedAt: { not: null } }, orderBy: { startedAt: "desc" } });
  if (prev?.state === "failed" && prev.error === error) return true;
  await db.upstreamUpdateRun.create({ data: { mappingId: m.id, state: "failed", trigger, startedAt: at, finishedAt: at, triedShas: [], commits: [], error } });
  await notifyUpstream(db, { kind: "upstream-update", mappingId: m.id, forkRepoId: m.forkRepoId, workspaceId: m.fork.workspaceId, title: `Upstream update stopped: ${cfg.pinForkFullName ?? m.fork.fullName} (the mapping changed)` });
  return true;
}
