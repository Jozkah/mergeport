import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { SESSION_COOKIE, findSession } from "@/lib/auth/session";
import { bus, dataVersion } from "@/lib/local/runtime";
import { markBrowserSeen } from "@/lib/local/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-sent events: tells the open page that local data changed (a teammate's edit arrived, a push finished). */
export async function GET(req: Request) {
  const s = await findSession(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!s) return new Response("Unauthorized", { status: 401 });
  const enc = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (obj: unknown) => controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      send({ version: dataVersion(), hello: true });
      const onChange = (e: unknown) => send(e);
      bus.on("change", onChange);
      const ka = setInterval(() => {
        markBrowserSeen();
        controller.enqueue(enc.encode(`: keepalive\n\n`));
      }, 25_000);
      markBrowserSeen();
      cleanup = () => {
        bus.off("change", onChange);
        clearInterval(ka);
      };
      req.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store, no-transform", connection: "keep-alive" } });
}
