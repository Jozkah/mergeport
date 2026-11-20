import { clientIp } from "@/lib/auth/hosted-config";
import { liveCtx } from "@/lib/federation/context";
import { revokeRoute } from "@/lib/federation/provider-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The linked instance's Unlink calls this with its own token. Always answers 200 so it reveals nothing about the token. */
export function POST(req: Request) {
  return revokeRoute(liveCtx(clientIp(req)), req);
}
