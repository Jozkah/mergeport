import { clientIp } from "@/lib/auth/hosted-config";
import { liveCtx } from "@/lib/federation/context";
import { wellKnownRoute } from "@/lib/federation/provider-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Discovery document. 404 unless federation is switched on for this server (see docs/federation.md). */
export function GET(req: Request) {
  return wellKnownRoute(liveCtx(clientIp(req)));
}
