"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { SESSION_COOKIE, destroyAllSessions } from "@/lib/auth/session";
import type { ActionResult } from "@/lib/action-result";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth/current";
import { selectWorkspace } from "@/lib/authz/active-workspace";
import { createWorkspaceFor } from "@/lib/auth/workspaces";
import { db } from "@/lib/db";
import { ConflictError, ValidationError } from "@/lib/errors";

/**
 * Form actions for hosted accounts. Next checks that a Server Action's Origin matches the host that served the page, which is the
 * CSRF defence here; each action also needs the signed-in session itself, not just a viewer (a new person has no workspace yet).
 */

/** Onboarding: name -> a workspace the person administers. */
export async function createWorkspaceAction(formData: FormData): Promise<void> {
  const a = await getAuth();
  if (!a) redirect("/sign-in");
  try {
    await createWorkspaceFor(db, a.user.id, formData.get("name"), a.session.id);
  } catch (e) {
    // The typed name travels back so a refused name or a limit message does not lose it.
    const typed = `&name=${encodeURIComponent(String(formData.get("name") ?? "").slice(0, 80))}`;
    if (e instanceof ValidationError) redirect(`/onboarding?error=name${typed}`);
    if (e instanceof ConflictError) redirect(`/onboarding?error=limit${typed}`);
    throw e;
  }
  revalidatePath("/", "layout");
  redirect("/");
}

/** Ends every login of this person, on every device, including this one. */
export async function signOutEverywhereAction(): Promise<void> {
  const a = await getAuth();
  if (!a) redirect("/sign-in");
  await destroyAllSessions(db, a.user.id);
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/sign-in");
}

/** The same, as a form action with an ActionResult (the Settings > Account confirmation sheet). It always ends in a redirect. */
export async function signOutEverywhereFormAction(): Promise<ActionResult> {
  await signOutEverywhereAction();
  return { ok: true };
}

/** The workspace switcher. The id is untrusted: selectWorkspace accepts it only for a workspace the person is an ACTIVE member of. */
export async function switchWorkspaceAction(formData: FormData): Promise<void> {
  const a = await getAuth();
  if (!a) redirect("/sign-in");
  const id = formData.get("workspaceId");
  if (typeof id === "string" && id) await selectWorkspace(db, a.session, id);
  revalidatePath("/", "layout");
  redirect("/");
}
