import type { Db } from "@/lib/db";
import { InstallationGoneError, InstallationSuspendedError, type InstallationTokenProvider } from "./app-auth";
import { markInstallationLoss } from "./binding";

/**
 * Detecting loss without webhooks: when minting an installation token fails because the installation was uninstalled (404) or
 * suspended (403), the installation row is marked (`deletedAt` / `suspendedAt`) so Settings shows "Removed on GitHub" or "Suspended
 * on GitHub" and `loadBoundInstallation` stops handing it out. Webhooks will do the same job later.
 */

/** Records what a token failure says. Returns true when the error was a loss and the row was marked. Any other error is ignored. */
export async function noteInstallationError(db: Db, installationId: bigint, error: unknown): Promise<boolean> {
  if (error instanceof InstallationGoneError) {
    await markInstallationLoss(db, installationId, "gone");
    return true;
  }
  if (error instanceof InstallationSuspendedError) {
    await markInstallationLoss(db, installationId, "suspended");
    return true;
  }
  return false;
}

/** Wraps a token provider so every typed loss it raises is recorded. The error is rethrown unchanged. */
export function withInstallationHealth(db: Db, inner: InstallationTokenProvider): InstallationTokenProvider {
  return {
    async getToken(installation) {
      try {
        return await inner.getToken(installation);
      } catch (e) {
        await noteInstallationError(db, installation.installationId, e).catch(() => {});
        throw e;
      }
    },
  };
}
