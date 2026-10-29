"use server";

import path from "node:path";
import { revalidatePath } from "next/cache";
import { run, type ActionResult } from "@/lib/action-result";
import { requireViewer } from "@/lib/auth/current";
import { ValidationError } from "@/lib/errors";
import { createContext, profileDirOf, renameContext, setActive } from "@/lib/local/contexts";

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();

function where() {
  const db = process.env.MERGEPORT_DB;
  if (!db) throw new ValidationError("This Mergeport was not started with a database file, so contexts are unavailable");
  const base = process.env.MERGEPORT_BASE_DB ?? db;
  return { dir: profileDirOf(path.resolve(base)), baseName: path.basename(base) };
}

export async function createContextAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    const { dir, baseName } = where();
    try {
      const c = createContext(dir, baseName, str(fd, "name"));
      revalidatePath("/team");
      return { ok: true, message: `Context “${c.name}” created. Switch to it to start or join a team there; your current team is untouched.` };
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message : "Could not create the context");
    }
  });
}

export async function renameContextAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    const { dir, baseName } = where();
    try {
      renameContext(dir, baseName, str(fd, "id"), str(fd, "name"));
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message : "Could not rename");
    }
    revalidatePath("/team");
    return { ok: true };
  });
}

/**
 * Makes another context the active one. Nothing is deleted or left: the current context keeps its spaces, its unsent edits and its
 * personal state, and it stops syncing only while it is parked. Mergeport restarts to open the other database; under the launcher it
 * reopens by itself, otherwise it must be started again.
 */
export async function switchContextAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    await requireViewer();
    const { dir, baseName } = where();
    try {
      setActive(dir, baseName, str(fd, "id"));
    } catch (e) {
      throw new ValidationError(e instanceof Error ? e.message : "Could not switch");
    }
    const underLauncher = process.env.MERGEPORT_LAUNCHER === "1";
    if (underLauncher) setTimeout(() => process.exit(75), 700); // after this response is sent
    return { ok: true, message: underLauncher ? "Switching. Mergeport is restarting and will open in your browser again in a moment." : "Switched. Stop and start Mergeport (npm run local) to open it.", data: { restarting: underLauncher } };
  });
}
