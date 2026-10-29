import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, ValidationError } from "@/lib/errors";
import { GithubError } from "@/lib/github/port";

export type ActionResult = { ok: true; message?: string; data?: Record<string, unknown> } | { ok: false; error: string; retryable?: boolean };

/** Maps domain errors to messages a person can act on. Unknown errors are logged and reported generically. */
export async function run(fn: () => Promise<ActionResult | void>): Promise<ActionResult> {
  try {
    const r = await fn();
    // A successful action may have changed shared data: send it to the team now instead of at the next poll.
    if (!r || r.ok) void import("@/lib/local/runtime").then((m) => m.syncSoon()).catch(() => {});
    return r ?? { ok: true };
  } catch (e) {
    if (e instanceof NotFoundError) return { ok: false, error: "That item was not found, or you do not have access to it." };
    if (e instanceof ForbiddenError || e instanceof ValidationError || e instanceof ConflictError) return { ok: false, error: e.message, retryable: e instanceof ConflictError };
    if (e instanceof UnauthenticatedError) return { ok: false, error: "Your session has ended. Sign in again." };
    if (e instanceof GithubError) {
      if (e.kind === "rate-limited") return { ok: false, error: `GitHub rate limit reached. Try again ${e.resetAt ? "after " + e.resetAt.toUTCString() : "in a minute"}.`, retryable: true };
      if (e.kind === "auth") return { ok: false, error: e.message };
      if (e.kind === "sso") return { ok: false, error: e.message };
      if (e.kind === "forbidden") return { ok: false, error: "GitHub says your authorization does not allow this. " + e.message };
      if (e.kind === "not-found") return { ok: false, error: "GitHub could not find it with your authorization." };
      return { ok: false, error: `GitHub error: ${e.message}`, retryable: e.kind === "network" };
    }
    console.error("action failed", e);
    return { ok: false, error: "Something went wrong. Nothing was changed. Try again." };
  }
}
