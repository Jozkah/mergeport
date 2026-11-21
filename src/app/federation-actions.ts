"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { clientIpFromHeaders } from "@/lib/auth/hosted-config";
import { requireAdminViewer, requireViewer, requireWriter } from "@/lib/auth/current";
import { safeEqual } from "@/lib/crypto";
import { db } from "@/lib/db";
import { ForbiddenError, ValidationError } from "@/lib/errors";
import { liveCtx, revokeCtx, type FedCtx } from "@/lib/federation/context";
import { startLink, unlink } from "@/lib/federation/consumer";
import { savePolicy } from "@/lib/federation/policy";
import { approveAuthorization, denyAuthorization, parseAuthorizeRequest, revokeAllFromOrigin, revokeGrant } from "@/lib/federation/provider";
import { headers } from "next/headers";

/**
 * Federation actions (docs/federation.md). Server actions get Next's same-origin check and proxy.ts's Origin rules; the approval
 * forms also carry the session's CSRF token. Each one re-validates everything it was given: the page is never trusted.
 * When federation does not exist on this server every action refuses the same way.
 */
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

async function ctxOrThrow(): Promise<FedCtx> {
  const ctx = liveCtx(clientIpFromHeaders(await headers()));
  if (!ctx) throw new ValidationError("Linking instances is not available on this server.");
  return ctx;
}

/** Link button on /linked. Answers with the address to send the browser to; the client navigates (a form-action CSP would block a cross-origin redirect after a form post). */
export async function startLinkAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter(); // READER never links
    const ctx = await ctxOrThrow();
    const { authorizeUrl } = await startLink(ctx, viewer, str(fd, "address"));
    return { ok: true, data: { redirect: authorizeUrl } };
  });
}

/** Unlink: your own link (anyone, whatever their role now is) or, for an administrator, any link of the workspace. The service decides. */
export async function unlinkAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await unlink(revokeCtx(clientIpFromHeaders(await headers())), viewer, str(fd, "linkId")); // works even when linking is switched off
    revalidatePath("/linked");
    revalidatePath("/settings/linked");
    return { ok: true, message: "Unlinked." };
  });
}

function authorizeFields(ctx: FedCtx, fd: FormData) {
  const parsed = parseAuthorizeRequest(ctx, { client_origin: str(fd, "client_origin"), redirect_uri: str(fd, "redirect_uri"), state: str(fd, "state"), code_challenge: str(fd, "code_challenge"), code_challenge_method: "S256", scope: str(fd, "scope") || "read" });
  if (!parsed.ok) throw new ValidationError(parsed.error);
  return parsed.req;
}

/** Approve on /federation/authorize (the consent page of THIS instance). The person's own consent: any role may share what they themselves can see, read-only. */
export async function approveFederationAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer, user, csrf } = await requireViewer();
    if (!safeEqual(str(fd, "csrf"), csrf)) throw new ForbiddenError("This page is out of date. Reload it and try again.");
    const ctx = await ctxOrThrow();
    const { redirectTo } = await approveAuthorization(ctx, user.id, authorizeFields(ctx, fd), str(fd, "workspaceId") || viewer.workspaceId);
    return { ok: true, data: { redirect: redirectTo } };
  });
}

export async function denyFederationAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer, user, csrf } = await requireViewer();
    if (!safeEqual(str(fd, "csrf"), csrf)) throw new ForbiddenError("This page is out of date. Reload it and try again.");
    const ctx = await ctxOrThrow();
    const { redirectTo } = await denyAuthorization(ctx, user.id, authorizeFields(ctx, fd), str(fd, "workspaceId") || viewer.workspaceId);
    return { ok: true, data: { redirect: redirectTo } };
  });
}

/** "Linked apps": revoke one of your own grants; an administrator may revoke any grant of the workspace. The service decides. */
export async function revokeGrantAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await revokeGrant(db, viewer, str(fd, "grantId")); // works even when linking is switched off
    revalidatePath("/linked");
    revalidatePath("/settings/linked");
    return { ok: true, message: "Access revoked. It stops working now." };
  });
}

export async function revokeAllFromOriginAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireAdminViewer();
    await ctxOrThrow();
    const n = await revokeAllFromOrigin(db, viewer, str(fd, "origin"));
    revalidatePath("/settings/linked");
    return { ok: true, message: `Revoked ${n} grant${n === 1 ? "" : "s"}.` };
  });
}

export async function saveFederationPolicyAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireAdminViewer();
    const ctx = await ctxOrThrow();
    await savePolicy(db, ctx.config, viewer, {
      outboundMode: str(fd, "outboundMode"),
      inboundMode: str(fd, "inboundMode"),
      allowlist: String(fd.get("allowlist") ?? ""),
      whoCanLink: str(fd, "whoCanLink"),
      maxLinksPerUser: str(fd, "maxLinksPerUser"),
      maxPeers: str(fd, "maxPeers"),
    });
    revalidatePath("/settings/linked");
    return { ok: true, message: "Saved. It applies to the next request, including existing links." };
  });
}
