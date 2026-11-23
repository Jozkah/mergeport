import { db, resolveDbFile } from "@/lib/db";
import { requireWrite } from "@/lib/authz/viewer";
import { withViewerStream } from "@/lib/api-post";
import { isDemo } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { keyFileFor, openVault } from "@/lib/hub/session-vault";
import { runAsk } from "@/lib/services/ai-run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  return withViewerStream(req, async (v, body, step) => {
    requireWrite(v); // spends the workspace AI key: writers only
    if (isDemo()) throw new ValidationError("The demo does not send anything to an AI endpoint.");
    const input = JSON.parse(body || "{}") as { question?: string };
    return runAsk(db, v, openVault(keyFileFor(resolveDbFile())), { question: String(input.question ?? "") }, step);
  });
}
