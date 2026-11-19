import { NextResponse } from "next/server";
import { getAuth } from "@/lib/auth/current";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import type { Viewer } from "@/lib/authz/viewer";

/**
 * For POST routes that change things (server actions get this protection built in; plain routes do not). The request must come from
 * this app's own pages: same origin, as the browser itself reports. The body is read as text and handed to `fn`.
 */
/**
 * Like withViewerPost, but answers as a stream of lines so the page can show progress: `{"type":"step","text"}` while the work
 * runs, then one `{"type":"result","data"}` or `{"type":"error","error"}`. Same origin and sign-in checks.
 */
export async function withViewerStream(req: Request, fn: (v: Viewer, body: string, step: (text: string) => void) => Promise<unknown>): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const site = req.headers.get("sec-fetch-site");
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if ((site && site !== "same-origin") || (origin && host && new URL(origin).host !== host)) return NextResponse.json({ error: "Not allowed from another site." }, { status: 403, headers });
  const a = await getAuth();
  if (!a?.viewer) return NextResponse.json({ error: "Sign in again." }, { status: 401, headers });
  const viewer = a.viewer;
  const body = await req.text();
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      const send = (o: unknown) => {
        try {
          c.enqueue(enc.encode(JSON.stringify(o) + "\n"));
        } catch {
          // the page went away; the work still finishes
        }
      };
      try {
        send({ type: "result", data: await fn(viewer, body, (text) => send({ type: "step", text })) });
      } catch (e) {
        if (e instanceof ValidationError || e instanceof ForbiddenError) send({ type: "error", error: e.message });
        else {
          console.error("api stream failed", e);
          send({ type: "error", error: "Something went wrong. Nothing was changed." });
        }
      }
      try {
        c.close();
      } catch {
        // already closed
      }
    },
  });
  return new Response(stream, { headers: { ...headers, "Content-Type": "application/x-ndjson; charset=utf-8" } });
}

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
