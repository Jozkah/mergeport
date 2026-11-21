import { clientIp } from "@/lib/auth/hosted-config";
import { liveCtx } from "@/lib/federation/context";
import { meRoute } from "@/lib/federation/provider-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return meRoute(liveCtx(clientIp(req)), req);
}
