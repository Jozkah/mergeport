"use server";

import { revalidatePath } from "next/cache";
import { db, resolveDbFile } from "@/lib/db";
import { run, type ActionResult } from "@/lib/action-result";
import { requireWriter } from "@/lib/auth/current";
import { requireAdmin } from "@/lib/authz/viewer";
import { isDemo } from "@/lib/env";
import { ValidationError } from "@/lib/errors";
import { keyFileFor, openVault } from "@/lib/hub/session-vault";
import { createTask } from "@/lib/services/tasks";
import { acceptSuggestions, dismissSuggestions } from "@/lib/services/ai-review";
import { approve, reject } from "@/lib/services/ai-approvals";
import { listModelInfo, loadAiConfig, saveAiSettings, normalizeBaseUrl, DEFAULT_AI_BASE_URL, type TaskDraft } from "@/lib/services/ai";

// Drafting tasks and answering questions are streamed from /api/ai/draft and /api/ai/ask so the page can show progress.

const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const vault = () => openVault(keyFileFor(resolveDbFile()));
const noDemo = () => {
  if (isDemo()) throw new ValidationError("The demo does not send anything to an AI endpoint.");
};

export async function saveAiSettingsAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    requireAdmin(viewer); // the endpoint and its key belong to the workspace: administrators only
    noDemo();
    await saveAiSettings(db, viewer.workspaceId, vault(), { baseUrl: str(fd, "baseUrl"), apiKey: str(fd, "apiKey"), clearKey: fd.get("clearKey") === "on", model: str(fd, "model"), autopilot: str(fd, "autopilot") });
    revalidatePath("/settings");
    revalidatePath("/tasks");
    return { ok: true, message: "Saved" };
  });
}

/**
 * Asks the endpoint what it offers now, using the address and key in the form. The saved key is used ONLY when the address in the
 * form is the saved address: otherwise any member could point this at their own host and receive the workspace's key.
 */
export async function listAiModelsAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    noDemo();
    const saved = await loadAiConfig(db, viewer.workspaceId, vault());
    const baseUrl = normalizeBaseUrl(str(fd, "baseUrl") || saved?.baseUrl || DEFAULT_AI_BASE_URL);
    const sameEndpoint = !!saved && normalizeBaseUrl(saved.baseUrl) === baseUrl;
    const apiKey = str(fd, "apiKey") || (sameEndpoint ? saved.apiKey : null) || null;
    const info = await listModelInfo({ baseUrl, apiKey, model: null });
    if (info.length === 0) throw new ValidationError("The endpoint listed no models.");
    const models = info.map((m) => m.id);
    const loaded = info.filter((m) => m.loaded === true).map((m) => m.id);
    return { ok: true, message: `${models.length} model${models.length === 1 ? "" : "s"} available`, data: { models, loaded } };
  });
}

const idList = (fd: FormData): string[] => {
  try {
    const v = JSON.parse(str(fd, "ids"));
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  } catch {
    // falls through
  }
  throw new ValidationError("Nothing selected.");
};

/** Turns the chosen AI suggestions into tasks. */
export async function acceptSuggestionsAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    const n = await acceptSuggestions(db, viewer, idList(fd));
    for (const p of ["/tasks", "/planning", "/attention", "/ai"]) revalidatePath(p);
    return { ok: true, message: `Created ${n} task${n === 1 ? "" : "s"}` };
  });
}

export async function dismissSuggestionsAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    const n = await dismissSuggestions(db, viewer, idList(fd));
    revalidatePath("/ai");
    return { ok: true, message: `Dismissed ${n}` };
  });
}

/** Creates the drafts the person kept. Each goes through the same checks as a task typed by hand. */
export async function createDraftsAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    let drafts: TaskDraft[];
    try {
      drafts = JSON.parse(str(fd, "drafts"));
      if (!Array.isArray(drafts)) throw new Error();
    } catch {
      throw new ValidationError("Nothing to create.");
    }
    if (drafts.length === 0 || drafts.length > 20) throw new ValidationError("Pick between 1 and 20 tasks.");
    let made = 0;
    for (const d of drafts) {
      await createTask(db, viewer, {
        projectId: String(d.projectId),
        title: String(d.title ?? ""),
        description: String(d.description ?? ""),
        assigneeLogin: d.assignee ? String(d.assignee) : null,
        priority: Math.max(0, Math.min(4, Number(d.priority) || 0)),
        dueDate: d.due && /^\d{4}-\d{2}-\d{2}$/.test(String(d.due)) ? new Date(d.due + "T00:00:00Z") : null,
        labels: Array.isArray(d.labels) ? d.labels.map(String) : [],
      });
      made++;
    }
    for (const p of ["/tasks", "/planning", "/attention"]) revalidatePath(p);
    return { ok: true, message: `Created ${made} task${made === 1 ? "" : "s"}` };
  });
}

/** The person approves a request an AI app made: it is sent to GitHub now, as them. */
export async function approveActionAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    const r = await approve(db, viewer, str(fd, "id"));
    for (const p of ["/ai", "/pull-requests", "/issues"]) revalidatePath(p);
    return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.message.replace(/^Not sent: /, "") };
  });
}

export async function rejectActionAction(fd: FormData): Promise<ActionResult> {
  return run(async () => {
    const { viewer } = await requireWriter();
    const done = await reject(db, viewer, str(fd, "id"));
    revalidatePath("/ai");
    return done ? { ok: true, message: "Rejected. Nothing was sent." } : { ok: false, error: "That request is no longer waiting." };
  });
}
