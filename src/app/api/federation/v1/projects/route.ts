import { clientIp } from "@/lib/auth/hosted-config";
import { liveCtx } from "@/lib/federation/context";
import { projectsRoute } from "@/lib/federation/provider-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return projectsRoute(liveCtx(clientIp(req)), req);
}
