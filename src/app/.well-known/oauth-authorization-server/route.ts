import { issuerUrl } from "@/lib/oauth-urls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Authorization server metadata (RFC 8414) for the hosted MCP endpoint's OAuth (docs/mcp.md). 404 unless hosted. */
export async function GET() {
  const issuer = issuerUrl();
  if (!issuer) return new Response("Not found", { status: 404 });
  return Response.json(
    {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/api/oauth/token`,
      registration_endpoint: `${issuer}/api/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["read", "write"],
    },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
