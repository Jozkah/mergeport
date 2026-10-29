"use client";

import * as D from "@radix-ui/react-dialog";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { applyQuickAction, previewQuickAction } from "@/app/palette-actions";
import { setScopeAction } from "@/app/scope-actions";
import type { QuickPreview } from "@/lib/services/quick-actions";

/**
 * Ctrl/Cmd+K: jump to a page, switch scope, or type a quick action ("/assign @alice", "/priority high") on the item you are looking at.
 * Quick actions are previewed in words, with where each change is written, and only applied when you confirm.
 */
type Entry = { id: string; label: string; hint?: string; run: () => void };

const PAGES: [string, string, string?][] = [
  ["Overview", "/"], ["Inbox", "/inbox"], ["My attention", "/attention"], ["Tasks", "/tasks"], ["Pull requests", "/pull-requests"], ["Issues", "/issues"],
  ["Planning board", "/planning"], ["Epics", "/planning?view=epics"], ["Iterations", "/planning?view=iterations"], ["Release readiness", "/planning?view=release"], ["Dependency map", "/planning?view=map"], ["Delivery analytics", "/planning?view=insights"],
  ["Activity", "/activity"], ["Repositories", "/repositories"], ["Forks", "/forks"], ["Branches", "/branches"], ["Team", "/team"], ["Review capacity", "/capacity"], ["Sync status", "/sync"],
  ["Who reviews what", "/admin/rules"], ["Label taxonomy", "/admin/labels"], ["Settings", "/settings"], ["Help", "/help"],
];

/** The item the person is looking at: a task page, a drawer, or a pull request / issue page. */
function currentTarget(path: string, params: URLSearchParams): { type: "task" | "work"; id: string } | null {
  const card = params.get("card");
  if (card) return { type: "task", id: card };
  let m = /^\/tasks\/([^/]+)$/.exec(path);
  if (m) return { type: "task", id: m[1] };
  m = /^\/(?:pull-requests|issues)\/([^/]+)$/.exec(path);
  return m ? { type: "work", id: m[1] } : null;
}

export function CommandPalette({ projects, repos }: { projects: { id: string; name: string }[]; repos: { id: string; name: string }[] }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [preview, setPreview] = useState<QuickPreview | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const input = useRef<HTMLInputElement>(null);
  const target = currentTarget(path, new URLSearchParams(params.toString()));
  const quick = q.trimStart().startsWith("/");

  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const close = () => {
    setOpen(false);
    setQ("");
    setPreview(null);
    setMsg(null);
    setSel(0);
  };
  const go = (href: string) => {
    close();
    router.push(href);
  };

  const entries = useMemo<Entry[]>(() => {
    const all: Entry[] = [
      ...PAGES.map(([label, href]) => ({ id: `page:${href}`, label, hint: "Go to", run: () => go(href) })),
      { id: "scope:all", label: "Scope: everything", hint: "Scope", run: () => start(async () => { await setScopeAction("all"); close(); router.refresh(); }) },
      ...projects.map((p) => ({ id: `scope:p:${p.id}`, label: `Scope: project ${p.name}`, hint: "Scope", run: () => start(async () => { await setScopeAction(`p:${p.id}`); close(); router.refresh(); }) })),
      ...repos.map((r) => ({ id: `scope:r:${r.id}`, label: `Scope: ${r.name}`, hint: "Scope", run: () => start(async () => { await setScopeAction(`r:${r.id}`); close(); router.refresh(); }) })),
    ];
    const needle = q.trim().toLowerCase();
    return (needle ? all.filter((e) => e.label.toLowerCase().includes(needle)) : all.slice(0, 12)).slice(0, 12);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, projects, repos]);

  useEffect(() => {
    if (!open || !quick || !target) return;
    const t = setTimeout(() => {
      void previewQuickAction(target.type, target.id, q).then((r) => {
        setPreview(r.ok ? r.preview : null);
        setMsg(r.ok ? null : { ok: false, text: r.error });
      });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, open, quick, target?.id, target?.type]);

  const onKey = (e: React.KeyboardEvent) => {
    if (quick) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(entries.length - 1, s + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); entries[sel]?.run(); }
  };

  return (
    <D.Root open={open} onOpenChange={(o) => (o ? setOpen(true) : close())}>
      <D.Portal>
        <D.Overlay className="scrim fixed inset-0 z-[70] bg-scrim" />
        <D.Content className="sheet fixed left-1/2 top-[14vh] z-[71] w-[min(620px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-[14px] border border-line bg-surface shadow-pop" aria-describedby={undefined} onOpenAutoFocus={(e) => { e.preventDefault(); input.current?.focus(); }}>
          <D.Title className="sr-only">Command palette</D.Title>
          <input ref={input} value={q} onChange={(e) => { setQ(e.target.value); setSel(0); setPreview(null); setMsg(null); }} onKeyDown={onKey} role="combobox" aria-expanded aria-controls="palette-list" aria-label="Type a page, a scope, or a command like /assign @alice" placeholder={target ? "Go to… or type /assign, /priority, /due, /label, /move" : "Go to a page or switch scope"} className="h-12 w-full border-b border-line bg-transparent px-4 text-[14px] outline-none" />
          {quick ? (
            <div className="max-h-[50vh] overflow-y-auto p-3 text-[13px]" id="palette-list">
              {!target ? <p className="text-ink-3">Open a task, pull request or issue first, then type a command for it.</p> : (
                <>
                  {preview?.lines.map((l, i) => (
                    <p key={i} className={`flex items-start gap-2 py-0.5 ${l.ok ? "" : "text-blocked"}`}><span aria-hidden>{l.ok ? "•" : "×"}</span><span>{l.text}<span className="ml-2 text-[11.5px] text-ink-3">{l.writesTo === "github" ? "writes to GitHub" : "dashboard only"}</span>{l.problem && <span className="block text-[12px]">{l.problem}</span>}</span></p>
                  ))}
                  {preview?.errors.map((er) => <p key={er} className="py-0.5 text-blocked">{er}</p>)}
                  {preview && preview.comment && <p className="mt-1 text-[12px] text-ink-3">Text that is not a command is ignored here.</p>}
                  {!preview && !msg && <p className="text-ink-3">Reading…</p>}
                  {msg && <p role={msg.ok ? "status" : "alert"} className={msg.ok ? "text-ok" : "text-blocked"}>{msg.text}</p>}
                  <div className="mt-2 flex items-center gap-2">
                    <button type="button" className="btn btn-primary" disabled={pending || !preview?.canApply} onClick={() => start(async () => { const r = await applyQuickAction(target.type, target.id, q); setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Applied") : r.error }); if (r.ok) { setPreview(null); setQ(""); router.refresh(); } })}>{pending ? "Applying…" : "Apply"}</button>
                    <span className="text-[12px] text-ink-3">One command per line. Nothing changes until you press Apply.</span>
                  </div>
                </>
              )}
            </div>
          ) : (
            <ul id="palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
              {entries.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-ink-3">Nothing matches.</li>}
              {entries.map((e, i) => (
                <li key={e.id} role="option" aria-selected={i === sel}>
                  <button type="button" onMouseEnter={() => setSel(i)} onClick={e.run} className={`flex w-full items-center justify-between gap-3 rounded-[8px] px-3 py-2 text-left text-[13.5px] ${i === sel ? "bg-hover" : ""}`}>
                    <span>{e.label}</span>
                    <span className="text-[11.5px] text-ink-3">{e.hint}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="border-t border-line px-4 py-2 text-[11.5px] text-ink-3">Ctrl or ⌘ + K opens this anywhere. Esc closes it.</p>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
