import fs from "node:fs";
import path from "node:path";
import type { Db } from "@/lib/db";
import { loadViewer, type Viewer } from "@/lib/authz/viewer";
import { activeDbFile, profileDirOf } from "@/lib/local/contexts";
import { mergeportHome, profileDbPath } from "@/lib/local/profile";
import { readActive } from "@/lib/local/registry";
import { savedProfiles } from "@/lib/local/saved-profiles";

import { CliError } from "./errors";

export { CliError };

export type Located = { file: string; expectedGithubId: bigint | null };

/**
 * Finds the database of the profile the app opens, with no network and no gh: MERGEPORT_DB if set, else the profile named by
 * MERGEPORT_HOME/active.json (honoring the active team context), else the only saved profile for github.com. Never creates anything.
 */
export function locateProfile(env: Record<string, string | undefined> = process.env, host = env.MERGEPORT_HOST ?? "github.com"): Located {
  if (env.MERGEPORT_DB) {
    const file = path.resolve(env.MERGEPORT_DB.replace(/^file:/, ""));
    if (!fs.existsSync(file)) throw new CliError(`MERGEPORT_DB points to ${file}, which does not exist`);
    return { file, expectedGithubId: null };
  }
  const home = mergeportHome(env.MERGEPORT_HOME);
  const active = readActive(home);
  let base: string | null = null;
  let expected: bigint | null = null;
  if (active && /^\d+$/.test(active.accountId)) {
    expected = BigInt(active.accountId);
    base = profileDbPath(home, active.host, expected, active.backend);
  } else {
    const saved = savedProfiles(home, host);
    if (saved.length === 1) {
      base = saved[0].dbFile;
      expected = saved[0].id;
    } else if (saved.length > 1) throw new CliError("Several Mergeport profiles exist and none is marked active. Start Mergeport once (npm run local) or set MERGEPORT_DB.", saved.map((s) => `@${s.login} (${s.dbFile})`));
  }
  if (!base || !fs.existsSync(base)) throw new CliError(`No Mergeport profile found under ${home}. Start Mergeport once with npm run local, or set MERGEPORT_HOME / MERGEPORT_DB.`);
  const file = activeDbFile(profileDirOf(base), path.basename(base));
  if (!fs.existsSync(file)) throw new CliError(`The active context database ${file} does not exist yet. Open Mergeport once so it is created.`);
  return { file, expectedGithubId: expected };
}

/** The viewer the app would build for this profile's own user. Refuses a profile with no real user, or one that is not the expected account. */
export async function loadProfileViewer(db: Db, expectedGithubId: bigint | null): Promise<Viewer> {
  const user = await db.user.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
  if (!user) throw new CliError("This profile has no signed-in user yet. Open Mergeport and sign in first.");
  if (expectedGithubId !== null && user.githubId !== expectedGithubId) throw new CliError("The profile database belongs to a different GitHub account than the active profile. Refusing to run.");
  const viewer = await loadViewer(db, user.id);
  if (!viewer) throw new CliError("The profile's user is not an active member of its workspace. Refusing to run.");
  return viewer;
}
