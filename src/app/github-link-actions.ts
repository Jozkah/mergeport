"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { claimGap } from "@/lib/auth/rate-limit";
import { requireViewer } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { requestAccessRefresh } from "@/lib/github/access-cache";
import { githubAppConfig } from "@/lib/github/app-config";
import { LINK_COOKIE, LINK_COOKIE_PATH, linkRedirectUri, startLink, unlinkGithubAccount } from "@/lib/github/user-link";
import { cookiesSecure, isHosted, publicOrigin } from "@/lib/public-url";

/**
 * Per-person GitHub link actions (docs/github-app.md, "Linking your GitHub account"). They act on the CALLER's own link only, whatever
 * their role (a reader links too), so they use requireViewer and are listed with a reason in tests/mutation-guard.test.ts. Server
 * actions get Next's same-origin check and proxy.ts's Origin rules (a cross-site POST never reaches them).
 */
const NOT_CONFIGURED = "GitHub is not set up on this server yet. Ask the person who runs this server to finish setting up the Mergeport GitHub App.";

/**
 * Answers with the GitHub address to send the browser to (`data.redirect`); the client navigates. The nonce cookie is HttpOnly and
 * SameSite=Lax (the callback arrives from github.com as a top-level navigation) and is only sent to the link callback path.
 */
export async function startGithubLinkAction(_fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    const origin = publicOrigin();
    if (!isHosted() || !origin) throw new ValidationError("Linking GitHub is for hosted workspaces.");
    const config = githubAppConfig();
    if (!config) throw new ValidationError(NOT_CONFIGURED);
    const started = await startLink(db, { viewer, config, redirectUri: linkRedirectUri(origin.origin) });
    (await cookies()).set(LINK_COOKIE, started.nonce, { httpOnly: true, sameSite: "lax", secure: cookiesSecure(), path: LINK_COOKIE_PATH, maxAge: started.maxAgeSeconds });
    return { ok: true, data: { redirect: started.url } };
  });
}

/** Unlink: removes the caller's own link, token, cached access and stored digests. Safe to repeat. */
export async function unlinkGithubAction(_fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    if (!isHosted()) throw new ValidationError("Linking GitHub is for hosted workspaces.");
    await unlinkGithubAccount(db, viewer, githubAppConfig());
    revalidatePath("/", "layout");
    return { ok: true, message: "GitHub account unlinked. Repositories you could only open through it are hidden from you again, unless an administrator granted them." };
  });
}

/** "Check again": asks for a fresh listing of what GitHub says the caller can open. The job does the work; this never waits on GitHub. */
export async function checkGithubAccessAction(_fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireViewer();
    if (!isHosted()) throw new ValidationError("Linking GitHub is for hosted workspaces.");
    const row = await db.githubUserToken.findUnique({ where: { userId: viewer.userId }, select: { status: true } });
    if (!row) throw new ValidationError("Link your GitHub account first.");
    if (row.status !== "OK") throw new ValidationError("Your GitHub link needs to be renewed. Link GitHub again.");
    if (!(await claimGap(db, `ghaccess:check:${viewer.userId}`, 15_000))) throw new ValidationError("Checked a moment ago. Wait a few seconds and try again.");
    await requestAccessRefresh(db, viewer.userId);
    revalidatePath("/settings");
    return { ok: true, message: "Asked GitHub again. The time of the last check updates when it answers." };
  });
}
