import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth/current";
import { ForbiddenError, NotFoundError, ValidationError } from "@/lib/errors";
import { GithubError } from "@/lib/github/port";
import type { Viewer } from "@/lib/authz/viewer";

/** For read-only JSON routes: the signed-in viewer, and the same error words the pages use. Never caches across people. */
export async function withViewer(fn: (v: Viewer) => Promise<unknown>): Promise<NextResponse> {
  const a = await getAuth();
  if (!a?.viewer) return NextResponse.json({ error: "Sign in again." }, { status: 401, headers: { "Cache-Control": "no-store" } });
  try {
    const body = await fn(a.viewer);
    return NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    const headers = { "Cache-Control": "no-store" };
    if (e instanceof NotFoundError) return NextResponse.json({ error: "That was not found, or you do not have access to it." }, { status: 404, headers });
    if (e instanceof ForbiddenError || e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 400, headers });
    if (e instanceof GithubError) {
      const status = e.kind === "not-found" ? 404 : e.kind === "rate-limited" ? 429 : e.kind === "forbidden" || e.kind === "sso" ? 403 : e.kind === "auth" ? 401 : 502;
      return NextResponse.json({ error: e.kind === "not-found" ? "GitHub could not find it with your authorization." : e.message }, { status, headers });
    }
    console.error("api failed", e);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers });
  }
}
