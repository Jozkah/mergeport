"use client";

import * as D from "@radix-ui/react-dialog";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState, useTransition, type ReactNode } from "react";
import { drawerCommentAction, drawerTickAction } from "@/app/drawer-actions";
import { X } from "@/components/ui/icons";

/**
 * A task or card opened beside the list or board it came from. The card id lives in the address (?card=...), so the page behind
 * keeps its filters, scroll position and selection, the link can be shared, Back closes the drawer, and a middle-click still opens
 * the full page. The drawer shows the same record as the full page and uses the same authorization.
 */
type Detail = {
  id: string; title: string; description: string | null; column: string; assignee: string | null; priority: string; due: string | null; labels: string[]; milestone: string | null;
  github: { repo: string; number: number; href: string } | null;
  dependencies: ({ opaque: true; direction: string; kind: string } | { opaque: false; direction: string; kind: string; id: string; title: string; done: boolean })[];
  checklist: { id: string; text: string; done: boolean }[];
  comments: { id: string; author: string; kind: string; body: string; at: string }[];
};

export function OpenCardLink({ id, href, className, children }: { id: string; href: string; className?: string; children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  return (
    <Link
      href={href}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // keep "open in new tab" working
        e.preventDefault();
        const next = new URLSearchParams(params.toString());
        next.set("card", id);
        router.push(`${path}?${next.toString()}`, { scroll: false });
      }}
    >
      {children}
    </Link>
  );
}

export function TaskDrawer() {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const id = params.get("card");
  const [loaded, setLoaded] = useState<{ id: string; detail: Detail | null; error: string | null } | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!id) return;
    let live = true;
    fetch(`/api/task/${encodeURIComponent(id)}`, { cache: "no-store" })
      .then(async (r) => {
        const body = await r.json().catch(() => ({}));
        if (!live) return;
        setLoaded(r.ok ? { id, detail: body as Detail, error: null } : { id, detail: null, error: (body as { error?: string }).error ?? "Could not load this task." });
      })
      .catch(() => live && setLoaded({ id, detail: null, error: "Could not load this task." }));
    return () => {
      live = false;
    };
  }, [id, nonce]);

  const close = useCallback(() => {
    const next = new URLSearchParams(params.toString());
    next.delete("card");
    router.replace(next.toString() ? `${path}?${next.toString()}` : path, { scroll: false });
  }, [params, path, router]);

  if (!id) return null;
  const cur = loaded?.id === id ? loaded : null;
  const d = cur?.detail ?? null;
  return (
    <D.Root open onOpenChange={(o) => !o && close()}>
      <D.Portal>
        <D.Overlay className="scrim fixed inset-0 z-40 bg-scrim" />
        <D.Content className="drawer fixed inset-y-0 right-0 z-50 flex w-[min(460px,100vw)] flex-col overflow-y-auto border-l border-line bg-surface p-5 shadow-pop" aria-describedby={undefined}>
          <div className="mb-3 flex items-start justify-between gap-3">
            <D.Title className="text-[16px] font-medium leading-snug [overflow-wrap:anywhere]">{d?.title ?? (cur?.error ? "Task unavailable" : "Loading…")}</D.Title>
            <D.Close className="btn btn-quiet btn-icon -mr-1.5" aria-label="Close"><X size={16} aria-hidden /></D.Close>
          </div>
          {cur?.error && <p role="alert" className="text-[13px] text-blocked">{cur.error}</p>}
          {d && (
            <div className="flex flex-col gap-4 text-[13px]">
              <dl className="grid grid-cols-[88px_1fr] gap-y-1.5">
                <dt className="text-ink-3">Status</dt><dd>{d.column}</dd>
                <dt className="text-ink-3">Assignee</dt><dd>{d.assignee ? `@${d.assignee}` : "Nobody"}</dd>
                <dt className="text-ink-3">Priority</dt><dd>{d.priority}</dd>
                <dt className="text-ink-3">Due</dt><dd>{d.due ?? "None"}</dd>
                {d.milestone && (<><dt className="text-ink-3">Milestone</dt><dd>{d.milestone}</dd></>)}
                {d.labels.length > 0 && (<><dt className="text-ink-3">Labels</dt><dd>{d.labels.join(", ")}</dd></>)}
                {d.github && (<><dt className="text-ink-3">GitHub</dt><dd><Link href={d.github.href} className="link">{d.github.repo}#{d.github.number}</Link></dd></>)}
              </dl>
              {d.description && <p className="whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{d.description}</p>}
              {d.dependencies.length > 0 && (
                <div>
                  <p className="label">Links</p>
                  <ul className="flex flex-col gap-1 text-[12.5px]">
                    {d.dependencies.map((x, i) => (
                      <li key={i} className="text-ink-2">
                        {x.kind === "blocks" ? (x.direction === "blocked-by" ? "Blocked by " : "Blocks ") : x.kind === "duplicates" ? "Duplicate of " : "Related to "}
                        {x.opaque ? <span className="italic">an item you cannot see</span> : <span className={x.done ? "line-through" : ""}>{x.title}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {d.checklist.length > 0 && (
                <div>
                  <p className="label">Checklist {d.checklist.filter((c) => c.done).length}/{d.checklist.length}</p>
                  <ul className="flex flex-col gap-1">
                    {d.checklist.map((c) => (
                      <li key={c.id}>
                        <label className="flex items-start gap-2"><input type="checkbox" className="mt-0.5" checked={c.done} disabled={pending} onChange={(e) => start(async () => { const r = await drawerTickAction(d.id, c.id, e.target.checked); if (r.ok) setNonce((n) => n + 1); else setError(r.error); })} /><span className={c.done ? "text-ink-3 line-through" : ""}>{c.text}</span></label>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <p className="label">Discussion</p>
                <ul className="flex flex-col gap-2">
                  {d.comments.slice(-30).map((c) => (
                    <li key={c.id} className={c.kind === "EVENT" ? "text-[12px] text-ink-3" : "rounded-[8px] border border-line p-2"}>
                      <span className="font-medium">@{c.author}</span> {c.kind === "EVENT" ? c.body : <span className="whitespace-pre-wrap text-ink-2 [overflow-wrap:anywhere]">{c.body}</span>}
                    </li>
                  ))}
                </ul>
                <form className="mt-2 flex flex-col gap-2" onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; start(async () => { const r = await drawerCommentAction(d.id, text); if (r.ok) { setText(""); setError(null); setNonce((n) => n + 1); } else setError(r.error); }); }}>
                  <label className="sr-only" htmlFor="drawer-comment">Add a comment</label>
                  <textarea id="drawer-comment" className="textarea min-h-16" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a comment" />
                  <div className="flex items-center gap-2"><button type="submit" className="btn" disabled={pending || !text.trim()}>Comment</button>{error && <span role="alert" className="text-[12px] text-blocked">{error}</span>}</div>
                </form>
              </div>
              <Link href={`/tasks/${d.id}`} className="btn self-start">Open the full page</Link>
            </div>
          )}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
