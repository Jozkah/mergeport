import type { Backend } from "@/lib/local/backends";

/**
 * The seam between the hub profile UI (plan 3) and the hub storage/sync layer (plan 2).
 * Plan 2 replaces `ports-stub.ts` with real implementations; callers only depend on these types.
 */
export type HubSessionPort = {
  // stores the token encrypted in the profile db (plan 2: HubSession table + key file)
  save(dbFile: string, s: { origin: string; token: string; githubId: string }): Promise<void>;
  // marks TeamConfig.backend = hubId, hubOrigin = origin (plan 2 columns)
  markProfile(dbFile: string, p: { backend: Backend; origin: string; teamName: string }): Promise<void>;
};

export type HubLinkStatus = { state: "live" | "reconnecting" | "offline"; pendingOps: number; needsSignIn: boolean };

/** Admin calls against the hub; defined in Task 8. */
export type HubAdminApi = Record<string, never>;
