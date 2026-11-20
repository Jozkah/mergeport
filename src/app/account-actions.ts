"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getAuth } from "@/lib/auth/current";
import { selectWorkspace } from "@/lib/authz/active-workspace";
import { createWorkspaceFor } from "@/lib/auth/workspaces";
import { db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";

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
    if (e instanceof ValidationError) redirect("/onboarding?error=name");
    throw e;
  }
  revalidatePath("/", "layout");
  redirect("/");
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
