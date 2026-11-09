"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { resolveScope, scopeKey, SCOPE_COOKIE } from "@/lib/scope";

/** Remembers the working scope for this browser. Only a scope the person can see is stored. */
export async function setScopeAction(value: string): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const s = await resolveScope(db, viewer, value);
    (await cookies()).set(SCOPE_COOKIE, scopeKey(s), { path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax", httpOnly: true });
    revalidatePath("/", "layout");
    return { ok: true };
  });
}
