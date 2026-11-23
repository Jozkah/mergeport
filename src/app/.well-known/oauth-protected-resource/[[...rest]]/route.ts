import { issuerUrl, mcpResourceUrl } from "@/lib/oauth-urls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Protected resource metadata (RFC 9728): /.well-known/oauth-protected-resource and the path-inserted form for /api/mcp. Any other
 * path under it is 404. 404 unless hosted.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ rest?: string[] }> }) {
  const issuer = issuerUrl();
  const resource = mcpResourceUrl();
  const rest = (await ctx.params).rest ?? [];
  if (!issuer || !resource || (rest.length > 0 && rest.join("/") !== "api/mcp")) return new Response("Not found", { status: 404 });
  return Response.json(
    { resource, authorization_servers: [issuer], bearer_methods_supported: ["header"], scopes_supported: ["read", "write"], resource_name: "Mergeport" },
    { headers: { "cache-control": "public, max-age=300" } },
  );
}
