"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireWriter } from "@/lib/auth/current";
import { db } from "@/lib/db";
import { ValidationError } from "@/lib/errors";
import { githubAppConfig } from "@/lib/github/app-config";
import { CONNECT_COOKIE, CONNECT_COOKIE_PATH, CALLBACK_PATH, checkInstallation, disconnectInstallation, startConnect, type StartMode } from "@/lib/github/connect";
import { cookiesSecure, isHosted, publicOrigin } from "@/lib/public-url";
import { setWorkspaceGithubOrgJoin, setWorkspaceGithubWrites } from "@/lib/services/github-writes-setting";

/**
 * GitHub connection actions (docs/github-app.md). Server actions get Next's same-origin check and proxy.ts's Origin rules. Each one
 * re-checks the role on the server (`manageGithub`: owner and administrators), so a hidden button is never the protection.
 */
const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const ID = /^[1-9]\d{0,15}$/;

const NOT_CONFIGURED = "GitHub is not set up on this server yet. Ask the person who runs this server to finish setting up the Mergeport GitHub App.";

function installationIdOf(fd: FormData): bigint {
  const raw = str(fd, "installationId");
  if (!ID.test(raw)) throw new ValidationError("That GitHub connection was not found.");
  return BigInt(raw);
}

/**
 * Answers with the GitHub address to send the browser to (`data.redirect`); the client navigates (a form-action policy would block a
 * cross-origin redirect after a form post). The nonce cookie is set here, HttpOnly and SameSite=Lax (the callback arrives from
 * github.com as a top-level navigation), and only sent to the callback path.
 */
export async function startGithubConnectAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    const origin = publicOrigin();
    if (!isHosted() || !origin) throw new ValidationError("Connecting GitHub is for hosted workspaces.");
    const config = githubAppConfig();
    if (!config) throw new ValidationError(NOT_CONFIGURED);
    const mode: StartMode = str(fd, "mode") === "existing" ? "existing" : "install";
    const started = await startConnect(db, { viewer, mode, account: str(fd, "account"), config, redirectUri: `${origin.origin}${CALLBACK_PATH}` });
    (await cookies()).set(CONNECT_COOKIE, started.nonce, { httpOnly: true, sameSite: "lax", secure: cookiesSecure(), path: CONNECT_COOKIE_PATH, maxAge: started.maxAgeSeconds });
    return { ok: true, data: { redirect: started.url } };
  });
}

/** Disconnect: removes this workspace's connection. Repositories stay but are no longer connected; no planning data is deleted. */
export async function disconnectGithubInstallationAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    await disconnectInstallation(db, viewer, installationIdOf(fd));
    revalidatePath("/settings/github");
    revalidatePath("/settings");
    revalidatePath("/", "layout"); // the "GitHub is not connected" banner lives in the app layout
    return { ok: true, message: "Disconnected. Your repositories and planning data are still here; repositories now show as not connected." };
  });
}

/** Owners and administrators: let people write to GitHub as themselves in this workspace (create an issue, from a task or the new issue page; comment). Re-checked on the server; off by default. */
export async function setGithubWritesAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    const enabled = str(fd, "enabled") === "on";
    await setWorkspaceGithubWrites(db, viewer, enabled);
    revalidatePath("/settings/github");
    revalidatePath("/", "layout");
    return { ok: true, message: enabled ? "People in this workspace can now write to GitHub as themselves, once they have linked their account." : "Writing to GitHub is off for this workspace." };
  });
}

/** Owners and administrators: let members of the connected GitHub organizations join this workspace when they sign in with GitHub. On by default. */
export async function setGithubOrgJoinAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    const enabled = str(fd, "enabled") === "on";
    await setWorkspaceGithubOrgJoin(db, viewer, enabled);
    revalidatePath("/settings/github");
    return { ok: true, message: enabled ? "Members of the connected GitHub organizations now join this workspace when they sign in with GitHub." : "People now need an invitation to join this workspace." };
  });
}

/** "Check again": asks GitHub whether the installation is still there and not suspended. */
export async function checkGithubInstallationAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    const config = githubAppConfig();
    if (!config) throw new ValidationError(NOT_CONFIGURED);
    const status = await checkInstallation(db, viewer, installationIdOf(fd), config);
    revalidatePath("/settings/github");
    revalidatePath("/", "layout");
    return { ok: true, message: status === "active" ? "GitHub says this connection is active." : status === "suspended" ? "GitHub says this connection is still suspended." : "GitHub says the App is no longer installed there." };
  });
}
