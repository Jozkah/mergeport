import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { isDemo } from "@/lib/env";
import { SESSION_COOKIE, createSession } from "@/lib/auth/session";
import { redirectTo, sameOrigin } from "@/lib/http";

const LOGINS: Record<string, string> = { admin: "owner-demo", alice: "alice-demo", bram: "bram-demo" };

/** Demo sign-in: only with DEMO_MODE=true and only for the seeded synthetic people. Never talks to GitHub. */
export async function POST(req: Request) {
  if (!isDemo()) return new NextResponse("Not found", { status: 404 });
  if (!sameOrigin(req)) return new NextResponse("Bad origin", { status: 403 });
  const form = await req.formData();
  const login = LOGINS[String(form.get("as"))];
  const user = login ? await db.user.findFirst({ where: { login, isDemo: true } }) : null;
  if (!user) return redirectTo(req, "/sign-in?error=demo-unseeded", 303);
  const s = await createSession(db, user.id);
  (await cookies()).set(SESSION_COOKIE, s.token, { httpOnly: true, sameSite: "strict", secure: false, path: "/", expires: s.expiresAt });
  return redirectTo(req, "/", 303);
}
