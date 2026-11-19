"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sheet, useSheetClose } from "@/components/ui/dialog";
import { Select } from "@/components/ui/Select";
import { Wand2 } from "@/components/ui/icons";
import { createDraftsAction } from "@/app/ai-actions";
import { Progress, useAiJob } from "@/components/ai/progress";
import type { TaskDraft } from "@/lib/services/ai";

type P = { id: string; name: string };
const PRIORITY = ["No priority", "Low", "Medium", "High", "Urgent"];

/** Describe the work in plain words; the model proposes tasks; nothing exists until the person keeps some and presses Create. */
export function AiTasks({ projects, defaultProjectId, configured }: { projects: P[]; defaultProjectId: string; configured: boolean }) {
  return (
    <Sheet title="Draft tasks with AI" description="Write what needs doing, in any shape. You review the drafts before anything is created." trigger={<button className="btn !pl-2.5"><Wand2 size={14} aria-hidden /> Draft with AI</button>}>
      <DraftTasks projects={projects} defaultProjectId={defaultProjectId} configured={configured} />
    </Sheet>
  );
}

export function DraftTasks({ projects, defaultProjectId, configured }: { projects: P[]; defaultProjectId: string; configured: boolean }) {
  const router = useRouter();
  const close = useSheetClose();
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState(defaultProjectId);
  const [drafts, setDrafts] = useState<TaskDraft[] | null>(null);
  const [model, setModel] = useState("");
  const [keep, setKeep] = useState<boolean[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const job = useAiJob();
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? "";

  if (!configured) {
    return <p className="text-[13px] text-ink-2">Add the AI address and key in <Link className="link" href="/settings#ai">Settings</Link> first.</p>;
  }

  const draft = async () => {
    setError(null);
    setDone(null);
    const r = await job.run<{ drafts: TaskDraft[]; model: string }>("/api/ai/draft", { text, projectId });
    if (!r.ok) return setError(r.error);
    setDrafts(r.data.drafts);
    setModel(r.data.model);
    setKeep(r.data.drafts.map(() => true));
  };

  const create = () =>
    start(async () => {
      setError(null);
      const fd = new FormData();
      fd.set("drafts", JSON.stringify((drafts ?? []).filter((_, i) => keep[i])));
      const r = await createDraftsAction(fd);
      if (!r.ok) return setError(r.error);
      close?.();
      setDone(r.message ?? "Created");
      setDrafts(null);
      setText("");
      router.refresh();
    });

  if (drafts) {
    const n = keep.filter(Boolean).length;
    return (
      <div data-no-glow className="flex flex-col gap-3">
        <ul className="result-in flex flex-col divide-y divide-line overflow-hidden rounded-[8px] border border-line">
          {drafts.map((d, i) => (
            <li key={i}>
              <label className="flex cursor-pointer items-start gap-2.5 p-3 hover:bg-hover">
                <input type="checkbox" className="mt-1" checked={keep[i] ?? false} onChange={(e) => setKeep(keep.map((k, j) => (j === i ? e.target.checked : k)))} />
                <span className="min-w-0 text-[13px]">
                  <span className="block font-medium text-pretty [overflow-wrap:anywhere]">{d.title}</span>
                  <span className="block text-[12px] text-ink-3 text-pretty">
                    {[name(d.projectId), d.assignee ? `@${d.assignee}` : "Unassigned", PRIORITY[d.priority], d.due ? `due ${d.due}` : null, d.labels.length ? d.labels.join(", ") : null].filter(Boolean).join(" · ")}
                  </span>
                  {d.description && <span className="mt-1 block text-[12px] text-ink-2 text-pretty [overflow-wrap:anywhere]">{d.description}</span>}
                </span>
              </label>
            </li>
          ))}
        </ul>
        {model && <p className="text-[12px] text-ink-3">Written by {model}. Check the drafts before you create them.</p>}
        {error && <p role="alert" className="text-[12.5px] text-blocked">{error}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary" onClick={create} disabled={pending || n === 0}>{pending ? "Creating…" : <>Create <span className="tnum">{n}</span> task{n === 1 ? "" : "s"}</>}</button>
          <button type="button" className="btn btn-quiet" onClick={() => setDrafts(null)} disabled={pending}>Back</button>
        </div>
      </div>
    );
  }

  return (
    <div data-no-glow className="flex flex-col gap-3">
      {projects.length > 1 && (
        <div><label className="label" htmlFor="ai-project">Default project</label>
          <Select id="ai-project" className="select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
      )}
      <div><label className="label" htmlFor="ai-text">What needs doing?</label>
        <textarea id="ai-text" className="input min-h-32" rows={6} value={text} onChange={(e) => setText(e.target.value)} maxLength={8000} placeholder="e.g. Rotate the API keys by Friday, give it to alice. Also fix the login redirect bug, high priority." /></div>
      {done && <p role="status" className="result-in text-[12.5px] text-ok">{done}. <Link className="link" href="/tasks">Open Tasks</Link></p>}
      {error && <p role="alert" className="text-[12.5px] text-blocked">{error}</p>}
      <p className="text-[12px] text-ink-3">Your text and the names of your projects and people are sent to the AI address you set in Settings.</p>
      <div><button type="button" className="btn btn-primary" onClick={() => !job.running && draft()} aria-disabled={job.running} aria-busy={job.running} disabled={!text.trim()}>{job.running ? "Working…" : "Draft tasks"}</button></div>
      <Progress steps={job.steps} running={job.running} elapsed={job.elapsed} />
    </div>
  );
}
