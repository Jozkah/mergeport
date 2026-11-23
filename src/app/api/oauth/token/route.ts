import { take } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { addressBucket, addressHash, noAddress, oauthError, oauthJson, readFlatBody } from "@/lib/oauth-http";
import { isHosted } from "@/lib/public-url";
import { OAuthError, exchangeCode, exchangeRefresh } from "@/lib/services/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The OAuth token endpoint (docs/mcp.md): authorization_code (PKCE S256) and refresh_token grants for public clients. The credential is
 * the code plus its PKCE verifier, or the refresh token; there is no cookie and no client secret. `src/proxy.ts` exempts exactly this
 * path and POST for a request with no Origin, Sec-Fetch-Site or Cookie. Every answer is `no-store`. 404 unless hosted.
 *
 * Limits: 60 requests a minute per address, and 120 per client AND address (so a stranger who knows a public client_id cannot drain the
 * budget of that app's real users, and junk client ids create no counter rows: the client is loaded first and an unknown one is
 * `invalid_client`). A request with no client address is refused (503) rather than put in a bucket everyone shares. Codes are single-use and 60 seconds; a refresh token is single-use too,
 * and one used twice revokes its whole grant (services/oauth.ts).
 */
const PER_ADDRESS = 60;
const PER_CLIENT = 120;

const s = (v: unknown, max = 2000): string | undefined => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

export async function POST(req: Request) {
  if (!isHosted()) return new Response("Not found", { status: 404 });
  const mine = addressBucket("tok", req);
  if (!mine) return noAddress();
  if (!(await take(db, mine, PER_ADDRESS, 60_000).catch(() => true))) return oauthJson(429, { error: "temporarily_unavailable", error_description: "Slow down." }, { "retry-after": "60" });
  const body = await readFlatBody(req, ["form", "json"]);
  if (!body) return oauthError(new OAuthError("invalid_request", "Send application/x-www-form-urlencoded parameters, up to 16 KiB."));
  const clientId = s(body.client_id, 64);
  if (!clientId) return oauthError(new OAuthError("invalid_client", "client_id is required.", 401));
  if (!(await db.oAuthClient.findUnique({ where: { id: clientId }, select: { id: true } }))) return oauthError(new OAuthError("invalid_client", "Unknown client.", 401));
  if (!(await take(db, `oauth:tok:c:${clientId}:${addressHash(req)}`, PER_CLIENT, 60_000).catch(() => true))) return oauthJson(429, { error: "temporarily_unavailable", error_description: "Slow down." }, { "retry-after": "60" });
  const resource = body.resource === undefined ? undefined : s(body.resource);
  try {
    if (body.grant_type === "authorization_code") {
      const code = s(body.code, 200);
      const redirectUri = s(body.redirect_uri);
      const verifier = s(body.code_verifier, 200);
      if (!code || !redirectUri || !verifier) throw new OAuthError("invalid_request", "code, redirect_uri and code_verifier are required.");
      return oauthJson(200, await exchangeCode(db, { code, clientId, redirectUri, verifier, resource }));
    }
    if (body.grant_type === "refresh_token") {
      const refreshToken = s(body.refresh_token, 200);
      if (!refreshToken) throw new OAuthError("invalid_request", "refresh_token is required.");
      return oauthJson(200, await exchangeRefresh(db, { refreshToken, clientId, resource }));
    }
    throw new OAuthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(e);
    throw e;
  }
}
