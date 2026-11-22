import { createHash } from "node:crypto";
import { clientIp } from "@/lib/auth/hosted-config";
import { take } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { readBodyCapped } from "@/lib/github/webhook-signature";
import { hostedCtx } from "@/lib/mcp/hosted";
import { handle, type Reply } from "@/lib/mcp/server";
import { isHosted } from "@/lib/public-url";
import { authenticateApiToken, bearerSecret } from "@/lib/services/api-tokens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mergeport's remote MCP server (docs/mcp.md): MCP "streamable HTTP", stateless. One JSON-RPC message (or a short batch) per POST, answered
 * as application/json. No sessions and no server-sent events, so GET and DELETE are 405.
 *
 * The credential is a personal access token in `Authorization: Bearer` (never the query string). It names one workspace and one person;
 * the person's viewer is loaded fresh on every request. A cookie is never read here. `src/proxy.ts` lets this exact path past its browser
 * Origin rule only for a Bearer POST with no Origin, no Sec-Fetch-Site and no Cookie (a browser always sends one of those), and CORS is not enabled.
 *
 * Bad, revoked, expired and unknown tokens (and a removed member's) all get the same 401 with the same body.
 */
const MAX_BODY = 256 * 1024;
const MAX_BATCH = 5;
const REQUESTS_PER_MINUTE = 120;
const BAD_TOKENS_PER_MINUTE = 20;

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
const rpcError = (status: number, code: number, message: string, headers?: Record<string, string>) => json(status, { jsonrpc: "2.0", id: null, error: { code, message } } satisfies Reply, headers);
const unauthorized = () => json(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="Mergeport"' });
const bucket = (req: Request) => `mcp:bad:${createHash("sha256").update(clientIp(req) ?? "unknown").digest("hex").slice(0, 24)}`;

export async function POST(req: Request) {
  if (!isHosted()) return new Response("Not found", { status: 404 });
  const secret = bearerSecret(req.headers.get("authorization"));
  if (!secret) return unauthorized();

  const auth = await authenticateApiToken(db, secret);
  if (!auth) {
    // Only guessing is counted: a valid token never spends this bucket.
    const within = await take(db, bucket(req), BAD_TOKENS_PER_MINUTE, 60_000).catch(() => true);
    return within ? unauthorized() : json(429, { error: "slow down" }, { "retry-after": "60" });
  }
  if (!(await take(db, `mcp:req:${auth.tokenId}`, REQUESTS_PER_MINUTE, 60_000))) return json(429, { error: "slow down" }, { "retry-after": "60" });

  const read = await readBodyCapped(req, MAX_BODY);
  if (!read.ok) return rpcError(413, -32600, "Request too large");
  let msg: unknown;
  try {
    msg = JSON.parse(read.body.toString("utf8"));
  } catch {
    return rpcError(400, -32700, "Parse error");
  }
  const batch = Array.isArray(msg);
  const items: unknown[] = Array.isArray(msg) ? msg : [msg];
  if (items.length === 0 || items.length > MAX_BATCH) return rpcError(400, -32600, "Invalid request");

  // The request already cost one; every further message of a batch costs one more, so a batch cannot multiply the limit.
  for (let i = 1; i < items.length; i++) {
    if (!(await take(db, `mcp:req:${auth.tokenId}`, REQUESTS_PER_MINUTE, 60_000))) return json(429, { error: "slow down" }, { "retry-after": "60" });
  }
  const ctx = hostedCtx(db, auth.viewer, { id: auth.tokenId, scope: auth.scope });
  const replies: Reply[] = [];
  for (const m of items) {
    if (typeof m !== "object" || m === null || Array.isArray(m)) {
      replies.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
      continue;
    }
    const r = await handle(m as Parameters<typeof handle>[0], ctx);
    if (r) replies.push(r);
  }
  if (replies.length === 0) return new Response(null, { status: 202, headers: { "cache-control": "no-store" } });
  return json(200, batch ? replies : replies[0]);
}

const notAllowed = () => new Response("Method not allowed", { status: 405, headers: { allow: "POST", "cache-control": "no-store" } });
export const GET = notAllowed;
export const DELETE = notAllowed;
