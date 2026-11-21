import { ROLE_LABEL, type Role } from "@/lib/authz/roles";
import type { MailMessage } from "./mailer";

/** One line, no control characters: a workspace or person name goes into a mail header and must not be able to add one. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * The invitation email. Plain text, like the sign-in link mail. The link is the only secret in it: whoever opens it can ACCEPT only
 * after signing in with this very address (see services/invitations.ts), so a forwarded mail does not hand over the seat.
 */
export function invitationMail(input: { to: string; workspaceName: string; inviter: string; role: Role; link: string; expiresAt: Date }): MailMessage {
  const ws = oneLine(input.workspaceName).slice(0, 80) || "a workspace";
  const who = oneLine(input.inviter).slice(0, 80) || "A teammate";
  const role = ROLE_LABEL[input.role] ?? "Member";
  const days = Math.max(1, Math.round((input.expiresAt.getTime() - Date.now()) / (24 * 3600 * 1000)));
  return {
    to: input.to,
    subject: `${who} invited you to ${ws} on Mergeport`,
    text:
      `${who} invited you to join "${ws}" on Mergeport as ${role}.\n\n` +
      `Open this link to review the invitation and join:\n\n${input.link}\n\n` +
      `You will be asked to sign in with this email address (${input.to}). The link works for ${days} day${days === 1 ? "" : "s"} and can be used once. ` +
      `If you were not expecting it, you can ignore this email: nothing happens until you accept.`,
  };
}
