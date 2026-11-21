import { take } from "@/lib/auth/rate-limit";
import { sha256 } from "@/lib/crypto";
import { keyHash } from "./config";
import { nowOf, type FedCtx } from "./context";
import { authenticate, discoveryDocument, exchangeToken, revokeByToken, type Authed, type HttpAnswer } from "./provider";
import { NotFoundError } from "@/lib/errors";
import { boardDto, listProjectsDto, me, pageSize, tasksDto, workspaceName } from "./read-api";

/**
 * The provider's HTTP surface as plain functions of (FedCtx, Request), so the route files stay one line each and the tests can call
 * them from a simulated second instance. `ctx` is null when federation does not exist on this instance: every route answers 404.
 */
const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
const json = (status: number, body: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...extra } });
export const notFoundResponse = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
const unauthorized = () => json(401, { error: "unauthorized" }, { "WWW-Authenticate": 'Bearer realm="mergeport-federation"' });
const answer = (a: HttpAnswer) => json(a.status, a.body, a.headers);

const etagOf = (text: string) => `"${sha256(text).slice(0, 32)}"`;

export function wellKnownRoute(ctx: FedCtx | null): Response {
  if (!ctx) return notFoundResponse();
  return json(200, discoveryDocument(ctx), { "Cache-Control": "public, max-age=300" });
}

async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 4096) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function tokenRoute(ctx: FedCtx | null, req: Request): Promise<Response> {
  if (!ctx) return notFoundResponse();
  return answer(await exchangeToken(ctx, await readJson(req)));
}

const bearerOf = (req: Request): string | null => /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(req.headers.get("authorization") ?? "")?.[1] ?? null;

async function limitedIp(ctx: FedCtx, max: number): Promise<Response | null> {
  const ok = await take(ctx.db, `fed:ip:${ctx.ip ? keyHash(ctx.ip) : "noip"}`, max, 60_000, nowOf(ctx));
  return ok ? null : json(429, { error: "rate_limited" }, { "Retry-After": "60" });
}

export async function revokeRoute(ctx: FedCtx | null, req: Request): Promise<Response> {
  if (!ctx) return notFoundResponse();
  const limited = await limitedIp(ctx, 60);
  if (limited) return limited;
  const t = bearerOf(req);
  if (t) await revokeByToken(ctx, t);
  return json(200, { ok: true }); // the same answer for a live, a dead and an unknown token
}

/**
 * Authenticated read. Order: per-IP limit, token, per-grant limit, then the handler. A missing, wrong, revoked, expired or
 * policy-blocked token is one identical 401. An unseen or missing resource is one identical 404. Answers carry an ETag; a matching
 * If-None-Match gets an empty 304.
 */
export async function readRoute(ctx: FedCtx | null, req: Request, run: (a: Authed, ctx: FedCtx) => Promise<unknown>): Promise<Response> {
  if (!ctx) return notFoundResponse();
  const limited = await limitedIp(ctx, 600);
  if (limited) return limited;
  const token = bearerOf(req);
  const auth = token ? await authenticate(ctx, token) : null;
  if (!auth) return unauthorized();
  if (!(await take(ctx.db, `fed:grant:${auth.grantId}`, 120, 60_000, nowOf(ctx)))) return json(429, { error: "rate_limited" }, { "Retry-After": "60" });
  let body: unknown;
  try {
    body = await run(auth, ctx);
  } catch (e) {
    if (e instanceof NotFoundError) return json(404, { error: "not_found" });
    console.error("federation read failed", (e as Error).message);
    return json(500, { error: "server_error" });
  }
  const text = JSON.stringify(body);
  const etag = etagOf(text);
  const base = { ETag: etag, "Cache-Control": "private, no-cache" };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { ...base, "X-Content-Type-Options": "nosniff" } });
  return new Response(text, { status: 200, headers: { ...JSON_HEADERS, ...base } });
}

const query = (req: Request) => {
  const u = new URL(req.url);
  const cursor = u.searchParams.get("cursor");
  return { limit: pageSize(u.searchParams.get("limit")), cursor: cursor && /^[A-Za-z0-9_-]{1,60}$/.test(cursor) ? cursor : null };
};

export const meRoute = (ctx: FedCtx | null, req: Request) => readRoute(ctx, req, async (a, c) => me(a.viewer, await workspaceName(c.db, a.viewer.workspaceId)));
export const projectsRoute = (ctx: FedCtx | null, req: Request) => readRoute(ctx, req, (a, c) => listProjectsDto(c.db, a.viewer, query(req)));
export const projectRoute = (ctx: FedCtx | null, req: Request, projectId: string) => readRoute(ctx, req, (a, c) => boardDto(c.db, a.viewer, projectId));
export const tasksRoute = (ctx: FedCtx | null, req: Request, projectId: string) => readRoute(ctx, req, (a, c) => tasksDto(c.db, a.viewer, projectId, query(req)));
