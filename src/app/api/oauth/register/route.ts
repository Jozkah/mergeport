import { take } from "@/lib/auth/rate-limit";
import { db } from "@/lib/db";
import { addressBucket, noAddress, oauthError, oauthJson, readFlatBody } from "@/lib/oauth-http";
import { isHosted } from "@/lib/public-url";
import { OAuthError, registerClient } from "@/lib/services/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Dynamic client registration (RFC 7591) for the hosted MCP endpoint's OAuth (docs/mcp.md). Public clients only: no secret is issued, so
 * `token_endpoint_auth_method` must be "none". Redirect addresses are https or loopback http, exact, no wildcard. No credential is
 * needed (that is what registration is); abuse is bounded by an address limit and a cap on the table, and a registered app can do
 * nothing until a signed-in person consents to it. `src/proxy.ts` exempts exactly this path and POST for a request with no Origin,
 * Sec-Fetch-Site or Cookie. 404 unless hosted.
 */
const REGISTRATIONS_PER_HOUR = 10;
/** Across ALL callers: far under the table cap and its hourly purge (services/oauth.ts), so no one can hold the table full. */
export const GLOBAL_REGISTRATIONS_PER_HOUR = 60;
const GRANTS = ["authorization_code", "refresh_token"];

const subset = (v: unknown, allowed: string[]) => v === undefined || (Array.isArray(v) && v.every((x) => typeof x === "string" && allowed.includes(x)));

export async function POST(req: Request) {
  if (!isHosted()) return new Response("Not found", { status: 404 });
  const mine = addressBucket("reg", req);
  if (!mine) return noAddress();
  const tooMany = () => oauthJson(429, { error: "temporarily_unavailable", error_description: "Too many registrations. Try again later." }, { "retry-after": "3600" });
  if (!(await take(db, mine, REGISTRATIONS_PER_HOUR, 3_600_000).catch(() => true))) return tooMany();
  if (!(await take(db, "oauth:reg:all", GLOBAL_REGISTRATIONS_PER_HOUR, 3_600_000).catch(() => true))) return tooMany();
  const body = await readFlatBody(req, ["json"]);
  if (!body) return oauthJson(400, { error: "invalid_client_metadata", error_description: "Send a JSON object (Content-Type: application/json), up to 16 KiB." });
  if ((body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") || !subset(body.grant_types, GRANTS) || !subset(body.response_types, ["code"])) {
    return oauthJson(400, { error: "invalid_client_metadata", error_description: "Only public clients are supported: token_endpoint_auth_method none, grant types authorization_code and refresh_token, response type code." });
  }
  try {
    const c = await registerClient(db, { name: body.client_name, redirectUris: body.redirect_uris });
    return oauthJson(201, {
      client_id: c.clientId,
      client_id_issued_at: Math.floor(c.issuedAt.getTime() / 1000),
      client_name: c.name,
      redirect_uris: c.redirectUris,
      grant_types: GRANTS,
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  } catch (e) {
    if (e instanceof OAuthError) return oauthError(e);
    throw e;
  }
}
