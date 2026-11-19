"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sheet, useSheetClose } from "@/components/ui/dialog";
import { Select } from "@/components/ui/Select";
import { Wand2 } from "@/components/ui/icons";
import { createDraftsAction, draftTasksAction } from "@/app/ai-actions";
import type { TaskDraft } from "@/lib/services/ai";

type P = { id: string; name: string };
const PRIORITY = ["No priority", "Low", "Medium", "High", "Urgent"];

/** Describe the work in plain words; the model proposes tasks; nothing exists until the person keeps some and presses Create. */
export function AiTasks({ projects, defaultProjectId, configured }: { projects: P[]; defaultProjectId: string; configured: boolean }) {
  return (
    <Sheet title="Draft tasks with AI" description="Write what needs doing, in any shape. You review the drafts before anything is created." trigger={<button className="btn"><Wand2 size={14} aria-hidden /> Draft with AI</button>}>
      <Body projects={projects} defaultProjectId={defaultProjectId} configured={configured} />
    </Sheet>
  );
}

function Body({ projects, defaultProjectId, configured }: { projects: P[]; defaultProjectId: string; configured: boolean }) {
  const router = useRouter();
  const close = useSheetClose();
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [drafts, setDrafts] = useState<TaskDraft[] | null>(null);
  const [keep, setKeep] = useState<boolean[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? "";

  if (!configured) {
    return <p className="text-[13px] text-ink-2">Add the AI address, key and a model in <a className="underline" href="/settings#ai">Settings</a> first.</p>;
  }

  const draft = () =>
    start(async () => {
      setError(null);
      const fd = new FormData();
      fd.set("text", text);
      fd.set("projectId", projectId);
      const r = await draftTasksAction(fd);
      if (!r.ok) return setError(r.error);
      const list = (r.data?.drafts as TaskDraft[]) ?? [];
      setDrafts(list);
      setKeep(list.map(() => true));
    });

  const create = () =>
    start(async () => {
      setError(null);
      const fd = new FormData();
      fd.set("drafts", JSON.stringify((drafts ?? []).filter((_, i) => keep[i])));
      const r = await createDraftsAction(fd);
      if (!r.ok) return setError(r.error);
      close?.();
      router.refresh();
    });

  if (drafts) {
    const n = keep.filter(Boolean).length;
    return (
      <div className="flex flex-col gap-3">
        <ul className="flex flex-col gap-2">
          {drafts.map((d, i) => (
            <li key={i}>
              <label className="flex cursor-pointer items-start gap-2 rounded-[10px] border border-line p-2.5">
                <input type="checkbox" className="mt-1" checked={keep[i] ?? false} onChange={(e) => setKeep(keep.map((k, j) => (j === i ? e.target.checked : k)))} />
                <span className="min-w-0 text-[13px]">
                  <span className="block font-medium [overflow-wrap:anywhere]">{d.title}</span>
                  <span className="block text-[12px] text-ink-3">
                    {[name(d.projectId), d.assignee ? `@${d.assignee}` : "Unassigned", PRIORITY[d.priority], d.due ? `due ${d.due}` : null, d.labels.length ? d.labels.join(", ") : null].filter(Boolean).join(" · ")}
                  </span>
                  {d.description && <span className="mt-1 block text-[12px] text-ink-2 [overflow-wrap:anywhere]">{d.description}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
        {error && <p role="alert" className="text-[12.5px] text-blocked">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary" onClick={create} disabled={pending || n === 0}>{pending ? "Creating…" : `Create ${n} task${n === 1 ? "" : "s"}`}</button>
          <button type="button" className="btn btn-quiet" onClick={() => setDrafts(null)} disabled={pending}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {projects.length > 1 && (
        <div><label className="label" htmlFor="ai-project">Default project</label>
          <Select id="ai-project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
      )}
      <div><label className="label" htmlFor="ai-text">What needs doing?</label>
        <textarea id="ai-text" className="input min-h-32" rows={6} value={text} onChange={(e) => setText(e.target.value)} maxLength={8000} autoFocus placeholder="e.g. Rotate the API keys by Friday, give it to alice. Also fix the login redirect bug, high priority." /></div>
      {error && <p role="alert" className="text-[12.5px] text-blocked">{error}</p>}
      <p className="text-[12px] text-ink-3">Your text and the names of your projects and people are sent to the AI address you set in Settings.</p>
      <div><button type="button" className="btn btn-primary" onClick={draft} disabled={pending || !text.trim()}>{pending ? "Drafting…" : "Draft tasks"}</button></div>
    </div>
  );
}
