import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { redirectTo, sameOrigin } from "@/lib/http";
import { startLocalSession } from "@/lib/local/session-routes";

/** Development sign-in (no launcher). Disabled whenever a launch token is configured: then only the launcher URL works. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return new NextResponse("Bad origin", { status: 403 });
  if (env().MERGEPORT_LAUNCH_TOKEN) return new NextResponse("Use the link opened by the launcher", { status: 403 });
  const r = await startLocalSession();
  return redirectTo(req, r.ok ? "/" : `/sign-in?error=${r.error}`, 303);
}
