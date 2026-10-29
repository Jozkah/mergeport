"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { deleteDraftAction, discardDraftsAction, submitDraftsAction } from "@/app/phase4-actions";
import { Select } from "@/components/ui/Select";
import type { DraftRow, OwnersView, ThreadRow } from "@/lib/services/review-extras";

export const DRAFTS_CHANGED = "mp:drafts-changed";

function useFetch<T>(url: string, deps: unknown[] = []) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  const key = JSON.stringify(deps);
  useEffect(() => {
    let live = true;
    fetch(url, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!live) return;
        setState(r.ok ? { data: body as T, error: null, loading: false } : { data: null, error: (body as { error?: string }).error ?? "Could not load this.", loading: false });
      })
      .catch(() => live && setState({ data: null, error: "Could not load this.", loading: false }));
    return () => {
      live = false;
    };
  }, [url, n, key]);
  return { ...state, reload: useCallback(() => setN((x) => x + 1), []) };
}

const STATUS_WORD: Record<string, string> = { approved: "Approved", "changes-requested": "Asked for changes", pending: "Review requested", "not-requested": "Not asked", unknown: "Not known" };

/** Who CODEOWNERS says should look at the changed files. It routes attention; it is not a GitHub requirement. */
export function OwnersPanel({ itemId }: { itemId: string }) {
  const { data, error, loading } = useFetch<OwnersView>(`/api/pr/${itemId}/owners`);
  if (loading) return <p className="p-4 text-[12.5px] text-ink-3">Reading CODEOWNERS…</p>;
  if (error || !data) return <p className="p-4 text-[12.5px] text-ink-3" role="status">{error ?? "Could not read CODEOWNERS."}</p>;
  return (
    <div className="flex flex-col gap-3 p-4 text-[12.5px]">
      {data.rows.length === 0 ? <p className="text-ink-3">{data.notes[0]}</p> : (
        <ul className="flex flex-col gap-2">
          {data.rows.map((r) => (
            <li key={r.owner} className="rounded-[10px] border border-line p-2.5">
              <p className="flex items-center justify-between gap-2"><span className="font-medium">{r.owner}</span><span className="text-ink-3">{STATUS_WORD[r.status]}</span></p>
              <p className="text-ink-3">{r.files.length} file{r.files.length === 1 ? "" : "s"} · {r.patterns.join(", ")}</p>
              <p className="text-ink-3">{r.note}</p>
            </li>
          ))}
        </ul>
      )}
      {data.routing && data.routing.unowned.length > 0 && <p className="text-ink-3">{data.routing.unowned.length} changed file{data.routing.unowned.length === 1 ? " has" : "s have"} no owner.</p>}
      {data.otherSources.length > 0 && (
        <div><p className="label">Other reasons someone is expected to review</p><ul className="text-ink-3">{data.otherSources.slice(0, 6).map((s) => <li key={s.who}><span className="text-ink-2">{s.who}</span>: {s.why}</li>)}</ul></div>
      )}
      {data.notes.slice(data.rows.length === 0 ? 1 : 0).map((n) => <p key={n} className="text-ink-3">{n}</p>)}
      <p className="text-[11.5px] text-ink-3">CODEOWNERS only suggests who to ask. Whether GitHub requires a code owner&rsquo;s approval depends on the branch protection rules, which Mergeport does not read.</p>
    </div>
  );
}

/** The person's pending review: comments gathered here are sent to GitHub together, once, only when they submit. */
export function PendingReview({ itemId, canReview }: { itemId: string; canReview: boolean }) {
  const { data, reload } = useFetch<{ drafts: DraftRow[] }>(`/api/pr/${itemId}/drafts`);
  const [event, setEvent] = useState<"COMMENT" | "APPROVE" | "REQUEST_CHANGES">("COMMENT");
  const [body, setBody] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  useEffect(() => {
    window.addEventListener(DRAFTS_CHANGED, reload);
    return () => window.removeEventListener(DRAFTS_CHANGED, reload);
  }, [reload]);
  const drafts = data?.drafts ?? [];
  if (!canReview || drafts.length === 0) return null;
  const stale = drafts.filter((d) => d.stale).length;
  return (
    <section aria-label="Your pending review" className="mb-4 rounded-[12px] border border-line bg-surface p-3.5 text-[13px]">
      <p className="font-medium">Your pending review <span className="font-normal text-ink-3">· {drafts.length} comment{drafts.length === 1 ? "" : "s"}, not sent yet</span></p>
      {stale > 0 && <p role="alert" className="mt-1 text-blocked">{stale} comment{stale === 1 ? " was" : "s were"} written on an older version of this pull request. Delete what no longer applies before submitting.</p>}
      <ul className="mt-2 flex flex-col gap-1.5">
        {drafts.map((d) => (
          <li key={d.id} className="flex items-start justify-between gap-3 rounded-[8px] border border-line p-2">
            <div className="min-w-0"><p className="font-mono text-[12px] text-ink-3">{d.path}:{d.line}{d.stale ? " (older version)" : ""}</p><p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{d.body}</p></div>
            <button type="button" className="btn btn-quiet" disabled={pending} onClick={() => start(async () => { await deleteDraftAction(d.id); reload(); })}>Delete</button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-col gap-2">
        <label className="label" htmlFor="pr-body">Review summary</label>
        <textarea id="pr-body" className="textarea min-h-16" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Optional for a comment or approval; needed when asking for changes without comments" />
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor="pr-event">Review type</label>
          <Select id="pr-event" className="select !h-8 w-48" value={event} onChange={(e) => setEvent(e.target.value as typeof event)}><option value="COMMENT">Comment</option><option value="APPROVE">Approve</option><option value="REQUEST_CHANGES">Request changes</option></Select>
          <button type="button" className="btn btn-primary" disabled={pending || stale > 0} onClick={() => start(async () => { const r = await submitDraftsAction({ id: itemId, event, body }); setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Submitted") : r.error }); if (r.ok) { setBody(""); reload(); } })}>{pending ? "Submitting…" : "Submit review"}</button>
          <button type="button" className="btn btn-quiet" disabled={pending} onClick={() => start(async () => { await discardDraftsAction(itemId); reload(); })}>Discard all</button>
          {msg && <span role={msg.ok ? "status" : "alert"} className={`text-[12.5px] ${msg.ok ? "text-ok" : "text-blocked"}`}>{msg.text}</span>}
        </div>
      </div>
    </section>
  );
}

/** Unresolved review threads, with a way to step through them. Resolving happens on GitHub; this links there. */
export function ThreadNav({ itemId, version }: { itemId: string; version: string }) {
  const { data } = useFetch<{ threads: ThreadRow[]; unresolved: number; unknown: number; githubUrl: string }>(`/api/pr/${itemId}/threads`, [version]);
  const [at, setAt] = useState(-1);
  if (!data || data.threads.length === 0) return null;
  const open = data.threads.filter((t) => t.resolved === false);
  const go = (dir: 1 | -1) => {
    if (open.length === 0) return;
    const next = (at + dir + open.length) % open.length;
    setAt(next);
    const el = document.getElementById(`cmt-${open[next].firstCommentId}`);
    el?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el?.focus({ preventScroll: true });
  };
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-[10px] border border-line bg-surface px-3 py-2 text-[12.5px]" role="group" aria-label="Review threads">
      <span><strong className="font-medium">{data.unresolved}</strong> unresolved{data.unknown > 0 ? `, ${data.unknown} not known` : ""} of {data.threads.length} thread{data.threads.length === 1 ? "" : "s"}</span>
      {open.length > 0 && <><button type="button" className="btn" onClick={() => go(-1)}>Previous</button><button type="button" className="btn" onClick={() => go(1)}>Next unresolved</button>{at >= 0 && <span className="tnum text-ink-3">{at + 1}/{open.length} · {open[at].path}:{open[at].line ?? "?"}</span>}</>}
      <a className="link ml-auto" href={data.githubUrl} target="_blank" rel="noopener noreferrer">Resolve threads on GitHub</a>
    </div>
  );
}
