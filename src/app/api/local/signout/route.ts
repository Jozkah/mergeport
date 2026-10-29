import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { SESSION_COOKIE, destroySession } from "@/lib/auth/session";
import { redirectTo, sameOrigin } from "@/lib/http";

export async function POST(req: Request) {
  if (!sameOrigin(req)) return new NextResponse("Bad origin", { status: 403 });
  const jar = await cookies();
  await destroySession(db, jar.get(SESSION_COOKIE)?.value);
  jar.delete(SESSION_COOKIE);
  return redirectTo(req, "/sign-in", 303);
}
