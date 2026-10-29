import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { env } from "@/lib/env";
import { SESSION_COOKIE, findSession } from "@/lib/auth/session";
import { sameOrigin } from "@/lib/http";
import { isHubBackend, type Backend } from "@/lib/local/backends";
import { mergeportHome } from "@/lib/local/profile";
import { readActive, writeActive, type Active } from "@/lib/local/registry";
import { bootId } from "@/lib/local/boot-id";
import { requestSwitch } from "@/lib/local/switch-client";

/** Switches the whole app to another workspace by asking the launcher to restart it on that profile. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return new NextResponse("Bad origin", { status: 403 });
  const s = await findSession(db, (await cookies()).get(SESSION_COOKIE)?.value);
  if (!s) return new NextResponse("Unauthorized", { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { backend?: unknown };
  const b = body.backend;
  if (typeof b !== "string" || !(b === "github" || isHubBackend(b))) return NextResponse.json({ error: "Unknown workspace" }, { status: 400 });
  const backend = b as Backend;

  const e = env();
  const home = mergeportHome(e.MERGEPORT_HOME);
  const next: Active = { host: e.MERGEPORT_HOST, accountId: String(s.user.githubId), backend };
  const previous: Active = readActive(home) ?? { ...next, backend: "github" };
  writeActive(home, next); // before the restart: the new child reads it to pick its database
  try {
    const { launchUrl } = await requestSwitch(backend);
    return NextResponse.json({ launchUrl, bootId: bootId() });
  } catch (err) {
    writeActive(home, previous);
    return NextResponse.json({ error: err instanceof Error ? err.message : "Switch failed" }, { status: 409 });
  }
}
