"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { safeEqual } from "@/lib/crypto";
import { ValidationError } from "@/lib/errors";
import { isHosted } from "@/lib/public-url";
import { issueCode, parseAuthorize, revokeGrant } from "@/lib/services/oauth";

/**
 * The consent page's answer, and disconnecting a connected app (docs/mcp.md, "OAuth"). Both are for the CALLER (any role; a READER can only
 * grant read access, enforced in issueCode), so they use requireViewer and are listed with a reason in tests/mutation-guard.test.ts.
 * The decision re-reads and re-validates every parameter of the request (never trusts what the form carried), checks the session's
 * CSRF token, and only ever returns an address the client registered. Server actions also get Next's same-origin check and proxy.ts's Origin rule.
 */
const str = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : undefined;
};

function back(redirectUri: string, params: Record<string, string | undefined>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

export async function decideOAuthAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer, csrf } = await requireViewer();
    if (!isHosted()) throw new ValidationError("Connecting an AI app is for hosted workspaces.");
    if (!safeEqual(str(fd, "csrf") ?? "", csrf)) throw new ValidationError("This page expired. Reload it and try again.");
    const parsed = await parseAuthorize(db, {
      client_id: str(fd, "client_id"),
      redirect_uri: str(fd, "redirect_uri"),
      state: str(fd, "state"),
      response_type: "code",
      code_challenge: str(fd, "code_challenge"),
      code_challenge_method: "S256",
      resource: str(fd, "resource"),
    });
    if (!parsed.ok) throw new ValidationError(parsed.fatal ? parsed.message : parsed.description);
    const r = parsed.request;
    if (str(fd, "decision") === "deny") return { ok: true, message: "Cancelled.", data: { redirect: back(r.redirectUri, { error: "access_denied", state: r.state }), neutral: true } };
    const code = await issueCode(db, viewer.userId, { workspaceId: str(fd, "workspace") ?? "", scope: str(fd, "scope") ?? "", request: r });
    return { ok: true, message: "Connected.", data: { redirect: back(r.redirectUri, { code, state: r.state }) } };
  });
}

export async function revokeOAuthGrantAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await revokeGrant(db, viewer, str(fd, "id") ?? "");
    revalidatePath("/settings");
    return { ok: true, message: "App disconnected. It stops working now." };
  });
}
