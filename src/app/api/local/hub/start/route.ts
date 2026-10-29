import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { HubAuth, safeVerificationUri } from "@/lib/hub/connect";
import { failure, guardConnect, readBody } from "@/lib/hub/connect-route";

export async function POST(req: Request) {
  const refused = guardConnect(req);
  if (refused) return refused;
  const { url } = await readBody(req);
  if (typeof url !== "string") return NextResponse.json({ ok: false, error: "Type the server address." });
  try {
    const s = await new HubAuth().start(url);
    const verificationUri = safeVerificationUri(s.verificationUri, env().MERGEPORT_HOST);
    if (!verificationUri) return NextResponse.json({ ok: false, error: "The server sent a sign-in page that is not on GitHub, so it was not opened." });
    return NextResponse.json({ ok: true, userCode: s.userCode, verificationUri, interval: s.interval, deviceCode: s.deviceCode });
  } catch (err) {
    return failure(err);
  }
}
