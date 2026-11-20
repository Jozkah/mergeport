import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { clientIp } from "@/lib/auth/login";
import { MailNotConfiguredError, getMailer } from "@/lib/auth/mailer";
import { requestMagicLink } from "@/lib/auth/magic-link";
import { redirectTo, sameOrigin } from "@/lib/http";
import { originFor } from "@/lib/public-url";

/** Asks for a sign-in link. Same-origin form POST (login CSRF); the answer is the same for known, unknown and rate-limited addresses. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return new NextResponse("Bad origin", { status: 403 });
  let mailer;
  try {
    mailer = getMailer();
  } catch (e) {
    if (e instanceof MailNotConfiguredError) return redirectTo(req, "/sign-in?error=mail-unconfigured", 303);
    throw e;
  }
  const form = await req.formData().catch(() => null);
  const result = await requestMagicLink(db, { email: form?.get("email"), next: typeof form?.get("next") === "string" ? (form!.get("next") as string) : null, ip: clientIp(req), origin: originFor(req), mailer });
  if (result === "invalid") return redirectTo(req, "/sign-in?error=email-invalid", 303);
  if (result === "send-failed") return redirectTo(req, "/sign-in?error=mail-failed", 303);
  return redirectTo(req, "/sign-in?sent=1", 303);
}
