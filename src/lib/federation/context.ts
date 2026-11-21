import { db } from "@/lib/db";
import type { Db } from "@/lib/db";
import { publicOrigin } from "@/lib/public-url";
import { activeConfig, readConfig, type FederationConfig } from "./config";
import { realFedFetch, type FedFetch } from "./safe-fetch";

/**
 * Everything the federation services need from the outside, passed explicitly. One instance is one `FedCtx`: its database, its own
 * public origin, its operator config and the function that talks to other instances. The route handlers build the real one;
 * the tests build two (an instance A and an instance B) whose `fetch` routes by origin straight into the other one's handlers.
 */
export type FedCtx = {
  db: Db;
  /** This instance's own origin (MERGEPORT_PUBLIC_URL). */
  selfOrigin: string;
  config: FederationConfig;
  fetch: FedFetch;
  now?: () => Date;
  /** Client address for per-IP limits (null when not behind a trusted proxy). */
  ip?: string | null;
};

export const nowOf = (ctx: Pick<FedCtx, "now">) => (ctx.now ? ctx.now() : new Date());

/** The live context, or null when federation does not exist on this instance (the callers answer 404). */
export function liveCtx(ip?: string | null): FedCtx | null {
  const config = activeConfig();
  const origin = publicOrigin();
  if (!config || !origin) return null;
  return { db, selfOrigin: origin.origin, config, fetch: realFedFetch, ip };
}

/**
 * A context for ENDING things only (unlink, revoke): it exists even when the operator turned federation off or the key is missing,
 * because revocation must never be blocked by being disabled. Without a key the token cannot be decrypted, so the peer is simply not told.
 */
export function revokeCtx(ip?: string | null): FedCtx {
  return liveCtx(ip) ?? { db, selfOrigin: publicOrigin()?.origin ?? "", config: readConfig(), fetch: realFedFetch, ip };
}
