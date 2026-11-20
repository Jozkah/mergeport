import type { Prisma } from "@/generated/prisma/client";
import type { Db } from "@/lib/db";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { can, type Role } from "@/lib/authz/roles";
import type { Viewer } from "@/lib/authz/viewer";
import { normaliseOrigin, parseMode, type FederationConfig, type FederationMode } from "./config";
import { recordEvent } from "./events";

export type WhoCanLink = "ADMIN" | "MEMBER";

export type FederationPolicyView = {
  outboundMode: FederationMode;
  inboundMode: FederationMode;
  allowlist: string[];
  whoCanLink: WhoCanLink;
  maxLinksPerUser: number;
  maxPeers: number;
};

/** What a workspace without a policy row gets: nothing is allowed. */
export const DEFAULT_POLICY: FederationPolicyView = { outboundMode: "off", inboundMode: "off", allowlist: [], whoCanLink: "ADMIN", maxLinksPerUser: 5, maxPeers: 5 };

/** Read from the database on every use: a change (or turning it off) applies to the next request. */
export async function loadPolicy(db: Db, workspaceId: string): Promise<FederationPolicyView> {
  const r = await db.federationPolicy.findUnique({ where: { workspaceId } });
  if (!r) return { ...DEFAULT_POLICY };
  return {
    outboundMode: parseMode(r.outboundMode),
    inboundMode: parseMode(r.inboundMode),
    allowlist: r.allowlist,
    whoCanLink: r.whoCanLink === "MEMBER" ? "MEMBER" : "ADMIN",
    maxLinksPerUser: r.maxLinksPerUser,
    maxPeers: r.maxPeers,
  };
}

export type Decision = { ok: true } | { ok: false; reason: string };

/**
 * May this workspace talk to `origin` in this direction? The server ceiling and the workspace policy must BOTH say yes: the ceiling
 * `allowlist` limits even a workspace set to `any`, and a workspace can never be looser than the server.
 */
export function checkOrigin(direction: "outbound" | "inbound", origin: string, config: FederationConfig, policy: FederationPolicyView): Decision {
  if (config.mode === "off") return { ok: false, reason: "Linking is turned off on this server." };
  if (origin.startsWith("http:") && !config.allowInsecure) return { ok: false, reason: "Only https instances can be linked." };
  if (config.mode === "allowlist" && !config.allowlist.includes(origin)) return { ok: false, reason: "That instance is not on this server's allowed list." };
  const mode = direction === "outbound" ? policy.outboundMode : policy.inboundMode;
  if (mode === "off") return { ok: false, reason: direction === "outbound" ? "Linking to other instances is turned off for this workspace." : "Other instances may not link to this workspace." };
  if (mode === "allowlist" && !policy.allowlist.includes(origin)) return { ok: false, reason: "That instance is not on this workspace's allowed list." };
  return { ok: true };
}

/** Who may create a link from this workspace. READER never; MEMBER only when the workspace allows members. */
export function canCreateLink(role: Role | string, policy: FederationPolicyView): boolean {
  if (!can({ role }, "write")) return false; // READER (and unknown roles) never link
  return policy.whoCanLink === "MEMBER" || can({ role }, "manageSpaces");
}

export type PolicyInput = { outboundMode?: unknown; inboundMode?: unknown; allowlist?: unknown; whoCanLink?: unknown; maxLinksPerUser?: unknown; maxPeers?: unknown };

const MODES = ["off", "allowlist", "any"];
const intIn = (v: unknown, lo: number, hi: number, label: string) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  if (!Number.isInteger(n) || n < lo || n > hi) throw new ValidationError(`${label} must be a whole number from ${lo} to ${hi}.`);
  return n;
};

/** Administrators only. Validates, saves inside the ceiling's vocabulary, and writes one audit event with the before and after values. */
export async function savePolicy(db: Db, config: FederationConfig, viewer: Viewer, input: PolicyInput): Promise<FederationPolicyView> {
  if (!can(viewer, "manageSpaces")) throw new ForbiddenError("Administrator only");
  const before = await loadPolicy(db, viewer.workspaceId);
  const mode = (v: unknown, label: string): FederationMode => {
    if (typeof v !== "string" || !MODES.includes(v)) throw new ValidationError(`${label} must be off, allowlist or any.`);
    return v as FederationMode;
  };
  const lines = Array.isArray(input.allowlist) ? input.allowlist.map(String) : String(input.allowlist ?? "").split(/[\s,]+/);
  const allowlist: string[] = [];
  for (const raw of lines.map((s) => s.trim()).filter(Boolean)) {
    const o = normaliseOrigin(raw, config.allowInsecure);
    if (!o) throw new ValidationError(`"${raw.slice(0, 80)}" is not a valid https address.`);
    if (!allowlist.includes(o)) allowlist.push(o);
  }
  if (allowlist.length > 100) throw new ValidationError("The allowed list holds at most 100 instances.");
  if (input.whoCanLink !== "ADMIN" && input.whoCanLink !== "MEMBER") throw new ValidationError("Who can link must be administrators or members.");
  const next: FederationPolicyView = {
    outboundMode: mode(input.outboundMode, "Outgoing links"),
    inboundMode: mode(input.inboundMode, "Incoming links"),
    allowlist,
    whoCanLink: input.whoCanLink,
    maxLinksPerUser: intIn(input.maxLinksPerUser, 0, 50, "Links per person"),
    maxPeers: intIn(input.maxPeers, 0, 50, "Linked instances"),
  };
  await db.federationPolicy.upsert({
    where: { workspaceId: viewer.workspaceId },
    create: { workspaceId: viewer.workspaceId, ...next, updatedByUserId: viewer.userId },
    update: { ...next, updatedByUserId: viewer.userId },
  });
  await recordEvent(db, { workspaceId: viewer.workspaceId, userId: viewer.userId, kind: "policy.changed", meta: { before, after: next } as unknown as Prisma.InputJsonValue });
  return next;
}
