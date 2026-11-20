import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { OIDC_COOKIE, beginOidc, findProvider, oidcCookieOptions } from "@/lib/auth/oidc";
import { redirectTo } from "@/lib/http";
import { originFor } from "@/lib/public-url";

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const provider = findProvider((await ctx.params).provider);
  if (!provider) return new NextResponse("Not found", { status: 404 });
  try {
    const { url, cookie } = await beginOidc(provider, { origin: originFor(req), next: new URL(req.url).searchParams.get("next") });
    (await cookies()).set(OIDC_COOKIE, cookie, oidcCookieOptions());
    return new Response(null, { status: 302, headers: { location: url.toString() } });
  } catch {
    // Discovery failed or the auth secret is missing. No detail goes to the page.
    console.error(`[auth] could not start sign-in with ${provider.name}`);
    return redirectTo(req, "/sign-in?error=oidc-unavailable", 303);
  }
}
