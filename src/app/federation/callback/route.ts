import { getAuth } from "@/lib/auth/current";
import { clientIp } from "@/lib/auth/hosted-config";
import { liveCtx } from "@/lib/federation/context";
import { completeCallback } from "@/lib/federation/consumer";
import { notFoundResponse } from "@/lib/federation/provider-http";
import { redirectTo } from "@/lib/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where the other instance sends the browser back with `?code&state` (or `?error&state`). Step 3 of the handshake: the state must
 * belong to a pending link of the person signed in HERE, and the code is exchanged server to server. The answer is always a redirect
 * to /linked with a short result code (never text taken from the request), so the code and the state leave the address bar at once.
 * Without a session nothing is exchanged and the code is dropped.
 */
export async function GET(req: Request) {
  const ctx = liveCtx(clientIp(req));
  if (!ctx) return notFoundResponse();
  const a = await getAuth();
  if (!a?.viewer) return redirectTo(req, "/linked?result=signin", 303);
  const u = new URL(req.url);
  const r = await completeCallback(ctx, a.user.id, { code: u.searchParams.get("code"), state: u.searchParams.get("state"), error: u.searchParams.get("error") });
  return redirectTo(req, r.ok ? "/linked?result=linked" : `/linked?result=${r.code}`, 303);
}
