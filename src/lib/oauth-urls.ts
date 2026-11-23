import { publicOrigin } from "@/lib/public-url";

/** The addresses OAuth is built from. All null unless the server is hosted (MERGEPORT_PUBLIC_URL). */
export const issuerUrl = (): string | null => publicOrigin()?.origin ?? null;
/** The protected resource, and the audience every OAuth access token is bound to. */
export const mcpResourceUrl = (): string | null => {
  const i = issuerUrl();
  return i ? `${i}/api/mcp` : null;
};
/** Where a client learns how to authorize against the MCP endpoint (RFC 9728, path-inserted form for /api/mcp). */
export const resourceMetadataUrl = (): string | null => {
  const i = issuerUrl();
  return i ? `${i}/.well-known/oauth-protected-resource/api/mcp` : null;
};
