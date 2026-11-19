import { db, resolveDbFile } from "@/lib/db";
import { withViewerStream } from "@/lib/api-post";
import { isDemo } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { keyFileFor } from "@/lib/hub/ports-impl";
import { openVault } from "@/lib/hub/session-vault";
import { runDraft } from "@/lib/services/ai-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return withViewerStream(req, async (v, body, step) => {
    if (isDemo()) throw new ValidationError("The demo does not send anything to an AI endpoint.");
    const input = JSON.parse(body || "{}") as { text?: string; projectId?: string };
    return runDraft(db, v, openVault(keyFileFor(resolveDbFile())), { text: String(input.text ?? ""), projectId: input.projectId ? String(input.projectId) : undefined }, step);
  });
}
