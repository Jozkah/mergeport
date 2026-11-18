import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { redirectTo } from "@/lib/http";
import { launchTokenUsable, processStartedAt } from "@/lib/local/launch-token";
import { startLocalSession } from "@/lib/local/session-routes";

/**
 * The launcher opens this URL once. The token binds the browser it opens to this process; it works one time only, and only within
 * LAUNCH_TOKEN_TTL_MS of the process starting. A token that appears anywhere else (another page, a log) is useless after either.
 */
const g = globalThis as typeof globalThis & { __mpLaunchUsed?: boolean; __mpLaunchIssuedAt?: number };

export async function GET(req: Request) {
  const given = new URL(req.url).searchParams.get("token") ?? "";
  g.__mpLaunchIssuedAt ??= processStartedAt();
  if (!launchTokenUsable({ given, expected: env().MERGEPORT_LAUNCH_TOKEN, used: !!g.__mpLaunchUsed, issuedAt: g.__mpLaunchIssuedAt, now: Date.now() }))
    return new NextResponse("Launch link expired. Start Mergeport again.", { status: 403 });
  g.__mpLaunchUsed = true;
  const r = await startLocalSession();
  if (!r.ok) g.__mpLaunchUsed = false; // a failed sign-in (offline, signed out) must not burn the one link the launcher printed
  return redirectTo(req, r.ok ? "/" : `/sign-in?error=${r.error}`);
}
