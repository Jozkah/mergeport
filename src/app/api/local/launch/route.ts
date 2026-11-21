import { refuseWhenHosted } from "@/lib/public-url";
import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { redirectTo } from "@/lib/http";
import { launchTokenUsable, processStartedAt } from "@/lib/local/launch-token";
import { takeFreshLink } from "@/lib/local/fresh-link";
import { startLocalSession } from "@/lib/local/session-routes";

/**
 * The launcher opens this URL once. The token binds the browser it opens to this process; it works one time only, and only within
 * LAUNCH_TOKEN_TTL_MS of the process starting. A token that appears anywhere else (another page, a log) is useless after either.
 */
const g = globalThis as typeof globalThis & { __mpLaunchUsed?: boolean; __mpLaunchIssuedAt?: number };

export async function GET(req: Request) {
  const hostedRefusal = refuseWhenHosted();
  if (hostedRefusal) return hostedRefusal;
  const given = new URL(req.url).searchParams.get("token") ?? "";
  g.__mpLaunchIssuedAt ??= processStartedAt();
  // Either the link the launcher printed at startup, or a fresh one the desktop shortcut asked the running app for (/api/local/link).
  const startup = launchTokenUsable({ given, expected: env().MERGEPORT_LAUNCH_TOKEN, used: !!g.__mpLaunchUsed, issuedAt: g.__mpLaunchIssuedAt, now: Date.now() });
  if (!startup && !takeFreshLink(given)) return new NextResponse("Launch link expired. Start Mergeport again, or use the desktop shortcut.", { status: 403 });
  if (startup) g.__mpLaunchUsed = true;
  const r = await startLocalSession();
  if (!r.ok && startup) g.__mpLaunchUsed = false; // a failed sign-in (offline, signed out) must not burn the one link the launcher printed
  return redirectTo(req, r.ok ? "/" : `/sign-in?error=${r.error}`);
}
