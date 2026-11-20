import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";

/**
 * Audit trail of federation decisions. `meta` is for non-secret context only (a reason, a policy before and after): callers must
 * never put a token, a code, a verifier or a state value in it. The writer drops keys that look like secrets as a last guard.
 */
export type FederationEventKind =
  | "link.started"
  | "link.created"
  | "link.denied"
  | "link.revoked"
  | "link.failed"
  | "grant.approved"
  | "grant.denied"
  | "grant.revoked"
  | "grant.token_issued"
  | "grant.first_use"
  | "policy.changed"
  | "policy.refused";

const SECRET_KEY = /token|secret|code|verifier|state|password|key/i;

function scrub(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) if (!SECRET_KEY.test(k)) out[k] = scrub(x, depth + 1);
  return out;
}

export async function recordEvent(
  db: Db,
  e: { workspaceId: string; userId?: string | null; kind: FederationEventKind; peerOrigin?: string | null; linkId?: string | null; grantId?: string | null; meta?: Prisma.InputJsonValue },
): Promise<void> {
  try {
    await db.federationEvent.create({
      data: { workspaceId: e.workspaceId, userId: e.userId ?? null, kind: e.kind, peerOrigin: e.peerOrigin ?? null, linkId: e.linkId ?? null, grantId: e.grantId ?? null, meta: e.meta === undefined ? undefined : (scrub(e.meta) as Prisma.InputJsonValue) },
    });
  } catch (err) {
    console.error("federation event not recorded", (err as Error).message); // the audit write must never break the request it describes
  }
}
