import { refuseWhenHosted } from "@/lib/public-url";
import { NextResponse } from "next/server";
import { localRequest, redirectTo } from "@/lib/http";
import { startLocalSession } from "@/lib/local/session-routes";

/** Development sign-in for a non-hosted run: signs the browser in as the GitHub CLI's account. */
export async function POST(req: Request) {
  const hostedRefusal = refuseWhenHosted();
  if (hostedRefusal) return hostedRefusal;
  if (!localRequest(req)) return new NextResponse("Bad origin", { status: 403 });
  const r = await startLocalSession();
  return redirectTo(req, r.ok ? "/" : `/sign-in?error=${r.error}`, 303);
}
