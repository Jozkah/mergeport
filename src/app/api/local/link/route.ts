import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { CONTROL_HEADER, controlSecretOk, mintFreshLink } from "@/lib/local/fresh-link";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A fresh single-use sign-in link for the desktop shortcut, so it can open the running app without restarting it. Needs the control
 * secret the launcher left in a file only this Windows user can read. A GET on purpose: the proxy refuses POSTs without a browser origin,
 * and a header with a secret cannot be sent by a web page. Requests that carry an Origin (a browser) are refused outright.
 */
export async function GET(req: Request) {
  if (req.headers.get("origin")) return new NextResponse("Not for browsers", { status: 403 });
  if (!controlSecretOk(req.headers.get(CONTROL_HEADER), process.env.MERGEPORT_CONTROL_SECRET)) return new NextResponse("Forbidden", { status: 403 });
  const token = mintFreshLink();
  return NextResponse.json({ url: `http://127.0.0.1:${env().MERGEPORT_PORT}/api/local/launch?token=${token}` }, { headers: { "Cache-Control": "no-store" } });
}
