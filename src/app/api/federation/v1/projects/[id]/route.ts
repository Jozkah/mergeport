import { clientIp } from "@/lib/auth/hosted-config";
import { liveCtx } from "@/lib/federation/context";
import { projectRoute } from "@/lib/federation/provider-http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return projectRoute(liveCtx(clientIp(req)), req, id);
}
