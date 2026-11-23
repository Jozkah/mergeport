"use server";

import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { isHosted } from "@/lib/public-url";
import { createApiToken, revokeApiToken } from "@/lib/services/api-tokens";

/**
 * Personal access tokens for the hosted MCP endpoint (docs/mcp.md). Any member creates tokens for THEMSELVES (a READER only a read-only one,
 * enforced in createApiToken); revoking is your own token, or any in the workspace for an administrator (enforced in revokeApiToken).
 * Both use requireViewer and are listed with a reason in tests/mutation-guard.test.ts. The secret is returned once, in `data.secret`, and never stored or logged.
 */
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "");

export async function createApiTokenAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    if (!isHosted()) throw new ValidationError("Connecting an AI app is for hosted workspaces.");
    const expires = str(fd, "expires");
    const t = await createApiToken(db, viewer, { name: str(fd, "name"), scope: str(fd, "scope"), expiresInDays: expires === "none" || expires === "" ? null : Number(expires) });
    revalidatePath("/settings");
    return { ok: true, message: "Token created. Copy it now: it is shown only once.", data: { secret: t.secret, neutral: true } };
  });
}

export async function revokeApiTokenAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    await revokeApiToken(db, viewer, str(fd, "id"));
    revalidatePath("/settings");
    return { ok: true, message: "Token revoked. Apps using it stop working now." };
  });
}
