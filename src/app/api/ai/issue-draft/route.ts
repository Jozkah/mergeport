import { db } from "@/lib/db";
import { requireWrite } from "@/lib/authz/viewer";
import { withViewerStream } from "@/lib/api-post";
import { isDemo } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { vaultKeyFile, openVault } from "@/lib/hub/session-vault";
import { runIssueDraft } from "@/lib/services/ai-issue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Draft with AI" on the new issue page: returns a title and body for the form. Nothing is posted to GitHub. */
export async function POST(req: Request) {
  return withViewerStream(req, async (v, body, step) => {
    requireWrite(v); // spends the workspace AI key: writers only
    if (isDemo()) throw new ValidationError("The demo does not send anything to an AI endpoint.");
    const input = JSON.parse(body || "{}") as { repositoryId?: string; prompt?: string; research?: string; otherRepoIds?: unknown };
    const research = input.research === "none" || input.research === "others" ? input.research : "repo";
    const otherRepoIds = Array.isArray(input.otherRepoIds) ? input.otherRepoIds.slice(0, 50).map(String) : [];
    return runIssueDraft(db, v, openVault(vaultKeyFile()), { repositoryId: String(input.repositoryId ?? ""), prompt: String(input.prompt ?? ""), research, otherRepoIds }, step);
  });
}
