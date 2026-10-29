import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth/current";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { Viewer } from "@/lib/authz/viewer";

/**
 * For POST routes that change things (server actions get this protection built in; plain routes do not). The request must come from
 * this app's own pages: same origin, as the browser itself reports. The body is read as text and handed to `fn`.
 */
export async function withViewerPost(req: Request, fn: (v: Viewer, body: string) => Promise<unknown>): Promise<NextResponse> {
  const headers = { "Cache-Control": "no-store" };
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if ((site && site !== "same-origin") || (origin && host && new URL(origin).host !== host)) return NextResponse.json({ error: "Not allowed from another site." }, { status: 403, headers });
  const a = await getAuth();
  if (!a?.viewer) return NextResponse.json({ error: "Sign in again." }, { status: 401, headers });
  try {
    return NextResponse.json(await fn(a.viewer, await req.text()), { headers });
  } catch (e) {
    if (e instanceof ValidationError || e instanceof ForbiddenError) return NextResponse.json({ error: e.message }, { status: 400, headers });
    console.error("api post failed", e);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500, headers });
  }
}
