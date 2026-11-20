import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { landingPath, startHostedSession } from "@/lib/auth/login";
import { OIDC_COOKIE, completeOidc, findProvider } from "@/lib/auth/oidc";
import { redirectTo } from "@/lib/http";
import { originFor } from "@/lib/public-url";

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const provider = findProvider((await ctx.params).provider);
  if (!provider) return new NextResponse("Not found", { status: 404 });
  const jar = await cookies();
  const flowCookie = jar.get(OIDC_COOKIE)?.value;
  jar.delete({ name: OIDC_COOKIE, path: "/auth/oidc" }); // the flow is single use whatever happens next
  // req.url carries Next's own hostname; the browser's address is the public origin (or the loopback Host), so rebuild the URL on it.
  const origin = originFor(req);
  const u = new URL(req.url);
  const callbackUrl = new URL(`${origin}${u.pathname}${u.search}`);
  const r = await completeOidc(db, provider, { origin, callbackUrl, cookie: flowCookie });
  if (!r.ok) return redirectTo(req, `/sign-in?error=oidc-${r.reason}`, 303);
  await startHostedSession(r.userId);
  return redirectTo(req, await landingPath(r.userId, r.next), 303);
}
