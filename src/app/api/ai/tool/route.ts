import { db, resolveDbFile } from "@/lib/db";
import { requireWrite } from "@/lib/authz/viewer";
import { withViewerStream } from "@/lib/api-post";
import { isDemo } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { keyFileFor } from "@/lib/hub/ports-impl";
import { openVault } from "@/lib/hub/session-vault";
import { loadAiConfig, rememberModel } from "@/lib/services/ai";
import { runTool, type ToolName } from "@/lib/services/ai-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOOLS: ToolName[] = ["digest", "standup", "item", "focus"];

/** The small read-only AI jobs: briefing from the digest, stand-up, where one pull request or issue stands. */
export async function POST(req: Request) {
  return withViewerStream(req, async (v, body, step) => {
    requireWrite(v); // remembers the model in the workspace settings: writers only
    if (isDemo()) throw new ValidationError("The demo does not send anything to an AI endpoint.");
    const input = JSON.parse(body || "{}") as { tool?: string; id?: string; day?: string };
    const tool = TOOLS.find((t) => t === input.tool);
    if (!tool) throw new ValidationError("Unknown tool.");
    const cfg = await loadAiConfig(db, v.workspaceId, openVault(keyFileFor(resolveDbFile())));
    if (!cfg) throw new ValidationError("Set up the AI endpoint in Settings first.");
    const r = await runTool(db, v, cfg, tool, { id: input.id ? String(input.id) : undefined, day: input.day ? String(input.day) : undefined }, { step });
    if (r.model) await rememberModel(db, v.workspaceId, r.model);
    return r;
  });
}
