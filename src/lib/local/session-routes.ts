import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { ensureLocalProfile, AccountMismatchError } from "@/lib/local/profile";
import { currentGhStatus } from "@/lib/local/identity";
import { looksOffline } from "@/lib/local/saved-profiles";

/** Mints the browser session for the local profile after confirming WHO gh is signed in as. */
export async function startLocalSession(): Promise<{ ok: true } | { ok: false; error: string }> {
  const gh = await currentGhStatus(true);
  if (gh.state === "missing-gh") return { ok: false, error: "gh-missing" };
  if (gh.state === "not-logged-in") return { ok: false, error: "gh-login" };
  if (gh.state === "error") {
    // GitHub unreachable is not "signed out". The profile already on this computer opens from its own data; every GitHub
    // call is still verified against the profile's numeric account id before anything is sent.
    if (looksOffline(gh.message)) {
      const local = await db.user.findFirst({ where: { isDemo: false }, orderBy: { createdAt: "asc" } });
      if (local) {
        const s = await createSession(db, local.id);
        (await cookies()).set(SESSION_COOKIE, s.token, { httpOnly: true, sameSite: "strict", secure: false, path: "/", expires: s.expiresAt });
        return { ok: true };
      }
    }
    return { ok: false, error: "gh-error" };
  }
  try {
    const p = await ensureLocalProfile(db, gh.identity);
    const s = await createSession(db, p.user.id);
    (await cookies()).set(SESSION_COOKIE, s.token, { httpOnly: true, sameSite: "strict", secure: false, path: "/", expires: s.expiresAt });
    return { ok: true };
  } catch (e) {
    if (e instanceof AccountMismatchError) return { ok: false, error: "mismatch" };
    throw e;
  }
}
