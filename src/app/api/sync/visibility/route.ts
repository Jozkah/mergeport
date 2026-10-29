import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { SESSION_COOKIE, findSession } from "@/lib/auth/session";
import { sameOrigin } from "@/lib/http";
import { setBrowserVisible } from "@/lib/local/activity";

/** The page tells us whether it is visible so background polling can slow down for a hidden or closed tab. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return new NextResponse("Bad origin", { status: 403 });
  const s = await findSession(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!s) return new NextResponse("Unauthorized", { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { visible?: boolean };
  setBrowserVisible(!!body.visible);
  return NextResponse.json({ ok: true });
}
