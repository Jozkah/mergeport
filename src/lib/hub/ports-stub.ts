import fs from "node:fs";
import path from "node:path";
import type { HubLinkStatus, HubSessionPort } from "@/lib/hub/ports";

/**
 * STAND-IN for plan 2. The real implementation keeps the session token encrypted in the profile db (HubSession table
 * plus a key file) and stores the backend on TeamConfig. Until those columns exist, this writes two small files beside
 * the db instead. `hub-session.json` holds the token in clear text, so it is only ever written inside the profile
 * directory (never hubs.json, active.json, logs or any response) and is replaced wholesale by plan 2.
 */

const writeJson = (file: string, value: unknown, mode?: number) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), mode === undefined ? undefined : { mode });
  fs.renameSync(tmp, file);
};

export const hubSessionPort: HubSessionPort = {
  async save(dbFile, s) {
    writeJson(path.join(path.dirname(dbFile), "hub-session.json"), { origin: s.origin, token: s.token, githubId: s.githubId }, 0o600);
  },
  async markProfile(dbFile, p) {
    writeJson(path.join(path.dirname(dbFile), "hub-profile.json"), { backend: p.backend, origin: p.origin, teamName: p.teamName });
  },
};

/** Plan 2 reports the live sync link; until then every hub profile reads as offline. */
export async function hubLinkStatus(_dbFile: string): Promise<HubLinkStatus> {
  return { state: "offline", pendingOps: 0, needsSignIn: false };
}
