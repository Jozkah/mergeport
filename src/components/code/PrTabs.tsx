"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CommitView } from "@/lib/services/git-view";
import { DiffViewer, type FilesData } from "@/components/code/DiffViewer";
import { Avatar } from "@/components/ui/Avatar";
import { ArrowLeft, Check, Copy, GitCommitHorizontal } from "@/components/ui/icons";

type Tab = "conversation" | "files" | "commits";

/**
 * Conversation, Files and Commits of a pull request. The conversation stays mounted, the other two load from a local cache
 * the first time they are opened (and are fetched quietly in the background right after the page appears), so switching is a
 * state change, not a page load. The address bar follows the tab so a link opens the same tab.
 */

const memo = new Map<string, Promise<unknown>>();
function getJson<T>(url: string, fresh = false): Promise<T> {
  if (!fresh && memo.has(url)) return memo.get(url) as Promise<T>;
  const p = fetch(url).then(async (r) => {
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((body as { error?: string }).error ?? "Could not load this from GitHub.");
    return body as T;
  });
  memo.set(url, p);
  p.catch(() => memo.delete(url));
  return p;
}

function useJson<T>(url: string, on: boolean) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: false });
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    let live = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState((s) => ({ ...s, loading: s.data === null, error: null }));
    getJson<T>(url, n > 0)
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((e: Error) => live && setState({ data: null, error: e.message, loading: false }));
    return () => {
      live = false;
    };
  }, [url, on, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

export function PrTabs({ itemId, repoId, initial, fileCount, conversation, aside, githubUrl }: { itemId: string; repoId: string; initial: Tab; fileCount: number | null; conversation: ReactNode; aside: ReactNode; githubUrl: string }) {
  const [tab, setTab] = useState<Tab>(initial);
  const [visited, setVisited] = useState<Record<Tab, boolean>>({ conversation: true, files: initial === "files", commits: initial === "commits" });
  const [commitCount, setCommitCount] = useState<number | null>(null);

  const go = useCallback((t: Tab) => {
    setTab(t);
    setVisited((v) => (v[t] ? v : { ...v, [t]: true }));
    try {
      const u = new URL(window.location.href);
      if (t === "conversation") u.searchParams.delete("tab");
      else u.searchParams.set("tab", t);
      window.history.replaceState(null, "", u.toString());
    } catch {
      // the address just does not follow the tab
    }
  }, []);

  // Warm the cache once the page has settled, so the first click on Files or Commits is instant.
  useEffect(() => {
    const warm = () => {
      void getJson(`/api/pr/${itemId}/files`).catch(() => {});
      void getJson<{ commits: CommitView[] }>(`/api/pr/${itemId}/commits`).then((c) => setCommitCount(c.commits.length)).catch(() => {});
    };
    const t = setTimeout(warm, 600);
    return () => clearTimeout(t);
  }, [itemId]);

  const tabs: { key: Tab; label: string; count?: number | null }[] = [
    { key: "conversation", label: "Conversation" },
    { key: "files", label: "Files changed", count: fileCount },
    { key: "commits", label: "Commits", count: commitCount },
  ];
  const wide = tab !== "conversation";

  return (
    <div className={`grid gap-5 ${wide ? "" : "xl:grid-cols-[minmax(0,1fr)_360px]"}`}>
      <div className="flex min-w-0 flex-col gap-5">
        <div className="flex flex-wrap items-center gap-3">
          <div role="tablist" aria-label="Pull request sections" className="inline-flex gap-1 rounded-[10px] border border-line bg-surface p-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                role="tab"
                type="button"
                id={`tab-${t.key}`}
                aria-selected={tab === t.key}
                aria-controls={`pane-${t.key}`}
                onClick={() => go(t.key)}
                onMouseEnter={() => t.key !== "conversation" && void getJson(`/api/pr/${itemId}/${t.key === "files" ? "files" : "commits"}`).catch(() => {})}
                className={`h-8 rounded-[7px] px-3 text-[13px] font-medium ${tab === t.key ? "bg-ink text-ink-invert" : "text-ink-2 hover:bg-hover"}`}
              >
                {t.label}
                {t.count != null && <span className={`ml-1.5 tnum text-[12px] ${tab === t.key ? "opacity-80" : "text-ink-3"}`}>{t.count}</span>}
              </button>
            ))}
          </div>
          {wide && <a href="#review" className="btn ml-auto">Review changes</a>}
        </div>

        <div id="pane-conversation" role="tabpanel" aria-labelledby="tab-conversation" hidden={tab !== "conversation"} className="flex min-w-0 flex-col gap-5">{conversation}</div>
        {visited.files && <div id="pane-files" role="tabpanel" aria-labelledby="tab-files" hidden={tab !== "files"}><FilesPane itemId={itemId} repoId={repoId} githubFilesUrl={`${githubUrl}/files`} active={tab === "files"} /></div>}
        {visited.commits && <div id="pane-commits" role="tabpanel" aria-labelledby="tab-commits" hidden={tab !== "commits"}><CommitsPane itemId={itemId} repoId={repoId} githubUrl={githubUrl} onCount={setCommitCount} /></div>}
      </div>
      <div id="review" className={wide ? "grid gap-5 xl:grid-cols-3" : ""}>{wide ? aside : <div className="flex flex-col gap-5">{aside}</div>}</div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
      {[0, 1, 2].map((i) => (
        <div key={i} className="overflow-hidden rounded-[6px] border border-line">
          <div className="h-10 border-b border-line bg-muted/60" />
          <div className="flex flex-col gap-2 p-3">{Array.from({ length: 6 }, (_, k) => <div key={k} className="h-3 animate-pulse rounded bg-muted" style={{ width: `${40 + ((k * 37 + i * 19) % 55)}%` }} />)}</div>
        </div>
      ))}
    </div>
  );
}

function Failed({ message, onRetry, href }: { message: string; onRetry: () => void; href: string }) {
  return (
    <div className="rounded-[10px] border border-blocked-line bg-blocked-bg p-4 text-[13px]" role="alert">
      <p className="font-medium text-blocked">Could not load this from GitHub</p>
      <p className="mt-1 text-ink-2">{message}</p>
      <p className="mt-3 flex gap-2"><button type="button" className="btn" onClick={onRetry}>Try again</button><a className="btn" href={href} target="_blank" rel="noopener noreferrer">Open on GitHub</a></p>
    </div>
  );
}

function FilesPane({ itemId, repoId, githubFilesUrl, active }: { itemId: string; repoId: string; githubFilesUrl: string; active: boolean }) {
  const { data, error, loading, reload } = useJson<FilesData>(`/api/pr/${itemId}/files`, true);
  if (error) return <Failed message={error} onRetry={reload} href={githubFilesUrl} />;
  if (loading || !data) return active ? <Skeleton /> : null;
  return <DiffViewer itemId={itemId} data={data} storeKey={`pr-${itemId}-${data.headSha ?? "x"}`} repoId={repoId} githubFilesUrl={githubFilesUrl} onPosted={() => { memo.delete(`/api/pr/${itemId}/files`); reload(); }} />;
}

function CommitsPane({ itemId, repoId, githubUrl, onCount }: { itemId: string; repoId: string; githubUrl: string; onCount: (n: number) => void }) {
  const { data, error, loading, reload } = useJson<{ commits: CommitView[]; truncated: boolean }>(`/api/pr/${itemId}/commits`, true);
  const [open, setOpen] = useState<CommitView | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const counted = useRef(false);
  useEffect(() => {
    if (data && !counted.current) {
      counted.current = true;
      onCount(data.commits.length);
    }
  }, [data, onCount]);

  if (open) return <OneCommit itemId={itemId} repoId={repoId} commit={open} githubUrl={githubUrl} onBack={() => setOpen(null)} />;
  if (error) return <Failed message={error} onRetry={reload} href={`${githubUrl}/commits`} />;
  if (loading || !data) return <Skeleton />;
  if (data.commits.length === 0) return <p className="p-6 text-[13px] text-ink-3">No commits are available for this pull request.</p>;

  const groups = new Map<string, CommitView[]>();
  for (const c of data.commits) {
    const day = c.date ? new Date(c.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "Unknown date";
    groups.set(day, [...(groups.get(day) ?? []), c]);
  }
  return (
    <div className="flex flex-col gap-5">
      {data.truncated && <p className="rounded-[8px] border border-line bg-surface p-3 text-[12.5px] text-ink-2">Showing the first 100 commits. <a className="link" href={`${githubUrl}/commits`} target="_blank" rel="noopener noreferrer">Open the rest on GitHub</a>.</p>}
      {[...groups.entries()].map(([day, list]) => (
        <section key={day}>
          <h3 className="mb-2 flex items-center gap-2 text-[13px] font-medium text-ink-2"><GitCommitHorizontal size={15} aria-hidden /> Commits on {day}</h3>
          <ul className="overflow-hidden rounded-[8px] border border-line bg-surface">
            {list.map((c) => (
              <li key={c.sha} className="flex items-start gap-3 border-b border-line px-4 py-3 last:border-b-0">
                <div className="min-w-0 flex-1">
                  <button type="button" onClick={() => setOpen(c)} className="text-left text-[14px] font-semibold text-ink hover:underline">{c.message}</button>
                  {c.body && <details className="mt-1"><summary className="cursor-pointer text-[12px] text-ink-3">Show description</summary><pre className="mt-1 whitespace-pre-wrap font-sans text-[12.5px] text-ink-2">{c.body}</pre></details>}
                  <p className="mt-1 flex items-center gap-1.5 text-[12.5px] text-ink-3">{c.author && <Avatar login={c.author} url={c.authorAvatar} size={16} />}<strong className="font-medium text-ink-2">{c.author ?? "unknown"}</strong> committed{c.date ? ` ${new Date(c.date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}</p>
                </div>
                <span className="flex shrink-0 items-center gap-1 font-mono text-[12px]">
                  <button type="button" onClick={() => setOpen(c)} className="rounded-[6px] border border-line bg-surface px-2 py-1 hover:bg-hover" title="Review this commit's changes">{c.sha.slice(0, 7)}</button>
                  <button type="button" className="btn btn-quiet btn-icon !h-7 !w-7" aria-label="Copy full commit id" onClick={() => navigator.clipboard?.writeText(c.sha).then(() => { setCopied(c.sha); setTimeout(() => setCopied(null), 1500); })}>{copied === c.sha ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function OneCommit({ itemId, repoId, commit, githubUrl, onBack }: { itemId: string; repoId: string; commit: CommitView; githubUrl: string; onBack: () => void }) {
  const { data, error, loading, reload } = useJson<FilesData>(`/api/pr/${itemId}/commit/${commit.sha}`, true);
  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-[8px] border border-line bg-surface p-4">
        <button type="button" onClick={onBack} className="mb-2 inline-flex items-center gap-1.5 text-[13px] text-ink-3 hover:text-ink"><ArrowLeft size={14} aria-hidden /> All commits</button>
        <h3 className="text-[16px] font-semibold">{commit.message}</h3>
        {commit.body && <pre className="mt-2 whitespace-pre-wrap font-sans text-[13px] text-ink-2">{commit.body}</pre>}
        <p className="mt-2 text-[12.5px] text-ink-3">{commit.author ?? "unknown"} · <span className="font-mono">{commit.sha.slice(0, 12)}</span></p>
      </div>
      {error ? <Failed message={error} onRetry={reload} href={`${githubUrl}/commits/${commit.sha}`} /> : loading || !data ? <Skeleton /> : <DiffViewer itemId={itemId} data={{ ...data, canComment: false }} storeKey={`commit-${commit.sha}`} repoId={repoId} githubFilesUrl={`${githubUrl}/commits/${commit.sha}`} />}
    </div>
  );
}
