import { NextResponse } from "next/server";
import { safeEqual } from "@/lib/crypto";
import { env } from "@/lib/env";
import { redirectTo } from "@/lib/http";
import { startLocalSession } from "@/lib/local/session-routes";

/**
 * The launcher opens this URL once. The token binds the browser it opens to this process; it works one time only.
 * A token that appears anywhere else (another page, another process) is useless after the first use.
 */
const g = globalThis as typeof globalThis & { __mpLaunchUsed?: boolean };

export async function GET(req: Request) {
  const expected = env().MERGEPORT_LAUNCH_TOKEN;
  const given = new URL(req.url).searchParams.get("token") ?? "";
  if (!expected || g.__mpLaunchUsed || !safeEqual(given, expected)) return new NextResponse("Launch link expired. Start Mergeport again.", { status: 403 });
  g.__mpLaunchUsed = true;
  const r = await startLocalSession();
  if (!r.ok) g.__mpLaunchUsed = false; // a failed sign-in (offline, signed out) must not burn the one link the launcher printed
  return redirectTo(req, r.ok ? "/" : `/sign-in?error=${r.error}`);
}
