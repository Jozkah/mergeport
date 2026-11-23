import { createHash } from "node:crypto";
import { clientIp } from "@/lib/auth/hosted-config";
import { readBodyCapped } from "@/lib/github/webhook-signature";
import { OAuthError } from "@/lib/services/oauth";

/** Shared by the OAuth machine endpoints (register, token): no cookie, no Origin, no CORS, answers never cached. */
export const OAUTH_BODY_MAX = 16 * 1024;

export const oauthJson = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...headers } });

export const oauthError = (e: OAuthError) => oauthJson(e.status, { error: e.code, error_description: e.description });

/** A counter key carrying a hash of the client address, never the address. A missing address (no trusted proxy header) shares one bucket. */
export const addressBucket = (kind: string, req: Request) => `oauth:${kind}:${createHash("sha256").update(clientIp(req) ?? "unknown").digest("hex").slice(0, 24)}`;

/** The body as a flat object of strings (form or JSON), size capped. Null when it is not one. */
export async function readFlatBody(req: Request, kinds: ("form" | "json")[]): Promise<Record<string, unknown> | null> {
  const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const form = type === "application/x-www-form-urlencoded";
  const json = type === "application/json";
  if (!((form && kinds.includes("form")) || (json && kinds.includes("json")))) return null;
  const read = await readBodyCapped(req, OAUTH_BODY_MAX);
  if (!read.ok) return null;
  const text = read.body.toString("utf8");
  if (form) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of new URLSearchParams(text)) if (!(k in out)) out[k] = v; // the first value wins; a repeated parameter is never merged
    return out;
  }
  try {
    const v = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
