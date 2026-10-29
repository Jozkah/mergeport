"use server";

import { spawn } from "node:child_process";
import { env } from "@/lib/env";
import { ghExecutable, killTree, resetGhResolution } from "@/lib/github/exec";
import { REQUIRED_SCOPES } from "@/lib/github/gh";
import { currentGhStatus } from "@/lib/local/identity";

export type LoginStart = { ok: true; output: string } | { ok: false; error: string };

/**
 * Starts the GitHub CLI's own browser login. The login happens entirely inside gh; Mergeport only relays the one-time
 * code gh prints. The token goes to gh's credential store, never through this app.
 */
export async function startGhLoginAction(): Promise<LoginStart> {
  const host = env().MERGEPORT_HOST;
  resetGhResolution(); // the person may just have installed gh
  const exe = ghExecutable();
  if (!exe) return { ok: false, error: "The GitHub CLI (gh) is not installed or could not be found. Install it from https://cli.github.com/, then try again." };
  const file = exe.file;
  const args = [...exe.prefix, "auth", "login", "--hostname", host, "--web", "--git-protocol", "https", "--scopes", REQUIRED_SCOPES.join(",")];
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (r: LoginStart) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    try {
      const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      // gh waits for the person to finish in the browser. Never let it linger for ever.
      const reaper = setTimeout(() => killTree(child), 10 * 60_000);
      reaper.unref?.();
      child.on("close", () => clearTimeout(reaper));
      const take = (b: Buffer) => {
        out += b.toString();
        if (/one-time code|[A-Z0-9]{4}-[A-Z0-9]{4}/.test(out)) finish({ ok: true, output: out.trim().slice(0, 600) });
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("error", () => finish({ ok: false, error: "The GitHub CLI (gh) is not installed or could not be started." }));
      child.on("exit", async () => {
        await currentGhStatus(true);
        finish({ ok: true, output: out.trim().slice(0, 600) || "gh finished." });
      });
      setTimeout(() => finish({ ok: !!out, ...(out ? { output: out.trim().slice(0, 600) } : { error: "gh did not print a login code. Run the command shown below in a terminal." }) } as LoginStart), 12_000);
    } catch {
      finish({ ok: false, error: "Could not start gh." });
    }
  });
}
