"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getAuth } from "@/lib/auth/current";
import { selectWorkspace } from "@/lib/authz/active-workspace";
import { db } from "@/lib/db";
import { acceptInvitation } from "@/lib/services/invitations";

/**
 * Press Join on /invite/<token>. Joining is a POST on purpose: a mail scanner or link preview that only GETs the page cannot use up
 * the invitation. The signed-in user's own verified address must equal the invited one (checked in acceptInvitation); the token is
 * the second factor, not the identity. Same-origin is enforced by Next for server actions.
 */
export async function acceptInviteAction(formData: FormData): Promise<void> {
  const token = String(formData.get("token") ?? "");
  const a = await getAuth();
  if (!a) redirect(`/sign-in?next=${encodeURIComponent(`/invite/${token}`)}`);
  const r = await acceptInvitation(db, token, { id: a.user.id, email: a.user.email, emailVerifiedAt: a.user.emailVerifiedAt });
  if (!r.ok) redirect(`/invite/${encodeURIComponent(token)}`); // the page explains why, from the same checks
  await selectWorkspace(db, a.session, r.workspaceId);
  revalidatePath("/", "layout");
  redirect("/");
}
