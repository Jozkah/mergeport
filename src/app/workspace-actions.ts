"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer, requireWriter } from "@/lib/auth/current";
import { MailNotConfiguredError, getMailer, type Mailer } from "@/lib/auth/mailer";
import { db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { publicOrigin } from "@/lib/public-url";
import { createInvitation, resendInvitation, revokeInvitation } from "@/lib/services/invitations";
import { changeRole, leaveWorkspace, reinstateMember, removeMember, transferOwnership } from "@/lib/services/members";
import { createRestrictedSpace, deleteSpace, removeSpaceMember, setProjectAccessSpace, setSpaceMember } from "@/lib/services/access-spaces";

/**
 * Member administration and spaces as access lists (docs/roles.md). Every action starts with requireWriter, so a READER is stopped
 * here; the services behind it then check the real policy (can()) against a freshly read membership, so who may do what is decided in
 * one place, not in these forms.
 */
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const done = (message: string): ActionResult => {
  revalidatePath("/settings/members");
  return { ok: true, message };
};

/** The address links in mail point at: the public one when hosted, otherwise the host the browser used. */
async function origin(): Promise<string> {
  const p = publicOrigin();
  if (p) return p.origin;
  return `http://${(await headers()).get("host") ?? "127.0.0.1"}`;
}

function mailer(): Mailer {
  try {
    return getMailer();
  } catch (e) {
    if (e instanceof MailNotConfiguredError) throw new ValidationError("Outgoing email is not set up on this server, so invitations cannot be sent. Ask its administrator to configure it.");
    throw e;
  }
}

export async function inviteMemberAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    await createInvitation(db, viewer, { email: str(fd, "email"), role: str(fd, "role"), mailer: mailer(), origin: await origin() });
    return done("Invitation sent. It works for 7 days.");
  });
}

export async function resendInvitationAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    await resendInvitation(db, viewer, str(fd, "invitationId"), { mailer: mailer(), origin: await origin() });
    return done("Invitation sent again. The earlier link no longer works.");
  });
}

export async function revokeInvitationAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    await revokeInvitation(db, viewer, str(fd, "invitationId"));
    return done("Invitation withdrawn");
  });
}

export async function changeRoleAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    await changeRole(db, viewer, str(fd, "memberId"), str(fd, "role"));
    return done("Role saved");
  });
}

export async function removeMemberAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    await removeMember(db, viewer, str(fd, "memberId"));
    return done("Removed. Their access ended now.");
  });
}

export async function reinstateMemberAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    await reinstateMember(db, viewer, str(fd, "memberId"), str(fd, "role") || "MEMBER");
    return done("Reinstated");
  });
}

export async function transferOwnershipAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    if (fd.get("confirm") !== "on") throw new ValidationError("Tick the box to confirm the transfer.");
    await transferOwnership(db, viewer, str(fd, "memberId"));
    return done("Ownership transferred. You are now an admin.");
  });
}

/** A member leaves. A reader may leave too, so this one does not go through requireWriter: the service refuses the owner. */
export async function leaveWorkspaceAction(): Promise<ActionResult> {
  const r = await run(async () => {
    const { viewer } = await requireViewer();
    await leaveWorkspace(db, viewer);
  });
  if (!r.ok) return r;
  revalidatePath("/", "layout");
  redirect("/");
}

export async function createAccessSpaceAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    await createRestrictedSpace(db, viewer, str(fd, "name"));
    return done("Space created. Nobody is in it yet; add the people who should see it.");
  });
}

export async function deleteAccessSpaceAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    await deleteSpace(db, viewer, str(fd, "spaceId"));
    return done("Space deleted");
  });
}

export async function setSpaceMemberAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    await setSpaceMember(db, viewer, str(fd, "spaceId"), str(fd, "memberId"), fd.get("canWrite") === "on" || fd.get("canWrite") === "true");
    return done("Saved");
  });
}

export async function removeSpaceMemberAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    await removeSpaceMember(db, viewer, str(fd, "spaceId"), str(fd, "memberId"));
    return done("Removed from the space");
  });
}

export async function setProjectSpaceAclAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    await setProjectAccessSpace(db, viewer, str(fd, "projectId"), str(fd, "spaceId") || null);
    revalidatePath("/", "layout");
    return done("Project moved");
  });
}
