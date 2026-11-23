import { db, resolveDbFile } from "@/lib/db";
import { requireWrite } from "@/lib/authz/viewer";
import { withViewerStream } from "@/lib/api-post";
import { isDemo } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { keyFileFor, openVault } from "@/lib/hub/session-vault";
import { loadAiConfig, rememberModel } from "@/lib/services/ai";
import { analyzeWorkspace, listSuggestions, saveSuggestions } from "@/lib/services/ai-review";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Analyze my workspace": always leaves suggestions to accept or dismiss, whatever the autopilot level. */
export async function POST(req: Request) {
  return withViewerStream(req, async (v, _body, step) => {
    requireWrite(v); // saves suggestions and settings: a reader only looks
    if (isDemo()) throw new ValidationError("The demo does not send anything to an AI endpoint.");
    const cfg = await loadAiConfig(db, v.workspaceId, openVault(keyFileFor(resolveDbFile())));
    if (!cfg) throw new ValidationError("Set up the AI endpoint in Settings first.");
    const r = await analyzeWorkspace(db, v, cfg, { step });
    step("Saving the suggestions");
    const counts = await saveSuggestions(db, v, r.drafts, "suggest");
    if (r.model) await rememberModel(db, v.workspaceId, r.model);
    await db.aiSettings.updateMany({ where: { workspaceId: v.workspaceId }, data: { lastSummary: r.summary || null, lastRunAt: new Date() } });
    return { summary: r.summary, model: r.model, counts, suggestions: await listSuggestions(db, v) };
  });
}
