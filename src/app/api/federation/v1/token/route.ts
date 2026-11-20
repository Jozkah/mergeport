import { clientIp } from "@/lib/auth/hosted-config";
import { liveCtx } from "@/lib/federation/context";
import { tokenRoute } from "@/lib/federation/provider-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-to-server: exchanges a one-time code (with its PKCE verifier) for an access token. No cookies; proxy.ts exempts this path from the Origin rule. */
export function POST(req: Request) {
  return tokenRoute(liveCtx(clientIp(req)), req);
}
