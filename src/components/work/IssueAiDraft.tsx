"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { Progress, useAiJob } from "@/components/ai/progress";
import { ChevronDown } from "@/components/ui/icons";

export type IssueDraft = { title: string; body: string; sources: string[] };
type Scope = "repo" | "others";

/**
 * "Draft with AI" above the new issue form: a prompt, optional research (this repository, or also other repositories the person
 * can see), and Generate. The answer only fills the form; it is never sent anywhere. When the form already has text, the person
 * chooses Replace or Append first.
 */
export function IssueAiDraft({ enabled, repoId, repos, hasText, onFill }: { enabled: boolean; repoId: string; repos: { id: string; fullName: string }[]; hasText: boolean; onFill: (d: IssueDraft, mode: "replace" | "append") => void }) {
  const uid = useId();
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [research, setResearch] = useState(true);
  const [scope, setScope] = useState<Scope>("repo");
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<IssueDraft | null>(null); // waiting for Replace / Append
  const job = useAiJob();
  const others = repos.filter((r) => r.id !== repoId);
  const textNow = useRef(hasText);
  useEffect(() => {
    textNow.current = hasText;
  }, [hasText]);

  const generate = async () => {
    setError(null);
    setPending(null);
    const r = await job.run<IssueDraft>("/api/ai/issue-draft", { repositoryId: repoId, prompt, research: research ? scope : "none", otherRepoIds: research && scope === "others" ? picked.filter((id) => id !== repoId) : [] });
    if (!r.ok) return setError(r.error);
    if (textNow.current) setPending(r.data); // what the form holds now: typing while the model worked counts
    else onFill(r.data, "replace");
  };
  const apply = (mode: "replace" | "append") => {
    if (pending) onFill(pending, mode);
    setPending(null);
  };
  const why = !repoId ? "Choose a repository first" : !prompt.trim() ? "Describe the issue first" : undefined;

  return (
    <section className="mb-4 rounded-[10px] border border-line" aria-labelledby={`${uid}-head`}>
      <button type="button" id={`${uid}-head`} className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left text-[13px] font-medium pointer-coarse:min-h-11" aria-expanded={open} aria-controls={`${uid}-panel`} onClick={() => setOpen((o) => !o)}>
        Draft with AI
        <ChevronDown size={14} aria-hidden className={`shrink-0 text-ink-3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div id={`${uid}-panel`} className="flex flex-col gap-3 border-t border-line p-3">
          {!enabled ? (
            <p className="text-[13px] text-ink-2 text-pretty">The AI is not set up for this workspace. Add the address and key in <Link className="link" href="/settings#ai">Settings</Link>.</p>
          ) : (
            <>
              <div>
                <label className="label" htmlFor={`${uid}-prompt`}>What should the issue be about?</label>
                <textarea id={`${uid}-prompt`} className="textarea min-h-24" maxLength={4000} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="Say what is wrong or what is wanted. The AI writes a title and description you can edit before creating the issue." />
              </div>
              <fieldset className="flex flex-col gap-2 text-[13px]">
                <legend className="sr-only">Research</legend>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={research} onChange={(e) => setResearch(e.target.checked)} />
                  Research first (README, labels and similar open issues)
                </label>
                {research && (
                  <div className="flex flex-col gap-1.5 pl-6" role="radiogroup" aria-label="Research scope">
                    <label className="flex items-center gap-2"><input type="radio" name={`${uid}-scope`} checked={scope === "repo"} onChange={() => setScope("repo")} />This repository</label>
                    <label className="flex items-center gap-2"><input type="radio" name={`${uid}-scope`} checked={scope === "others"} onChange={() => setScope("others")} disabled={others.length === 0} />This repository and other projects</label>
                    {scope === "others" && others.length > 0 && (
                      <div className="mt-1 max-h-40 overflow-y-auto rounded-[8px] border border-line p-2" role="group" aria-label="Other repositories">
                        <p className="mb-1 text-[12px] text-ink-3">Optional: pick repositories. With none picked, up to five you can see are used.</p>
                        {others.map((r) => (
                          <label key={r.id} className="flex min-h-7 items-center gap-2 pointer-coarse:min-h-10">
                            <input type="checkbox" checked={picked.includes(r.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, r.id] : p.filter((x) => x !== r.id)))} />
                            <span className="min-w-0 truncate">{r.fullName}</span>
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </fieldset>
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="btn btn-primary" onClick={generate} disabled={!!why || job.running} title={why} aria-describedby={why ? `${uid}-why` : undefined}>
                  {job.running ? "Generating…" : "Generate"}
                </button>
                {why && <span id={`${uid}-why`} className="text-[12px] text-ink-3">{why}</span>}
              </div>
              <Progress steps={job.steps} running={job.running} elapsed={job.elapsed} />
              {error && <p role="alert" className="text-[13px] text-blocked">{error}</p>}
              {pending && (
                <div role="group" aria-label="Use the draft" className="flex flex-col gap-2 rounded-[8px] border border-line bg-faint p-3 text-[13px]">
                  <p>The form already has text. Replace it with the draft, or append the draft to the description?</p>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" className="btn" onClick={() => apply("replace")}>Replace</button>
                    <button type="button" className="btn" onClick={() => apply("append")}>Append</button>
                    <button type="button" className="btn" onClick={() => setPending(null)}>Discard</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
