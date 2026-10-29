"use client";

import * as D from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Keyboard operation for the whole app, without a mouse:
 *   ?  this list        g then i/a/t/p/b/f/s  go to Inbox / Attention / Tasks / Planning / Branches / Forks / Sync
 *   j / k  next or previous row in a list     Enter  open the focused row     Ctrl or ⌘ + K  command palette
 * Shortcuts never fire while you type in a field, and never with a modifier held.
 */
const GO: Record<string, [string, string]> = { i: ["Inbox", "/inbox"], a: ["My attention", "/attention"], t: ["Tasks", "/tasks"], p: ["Planning", "/planning"], b: ["Branches", "/branches"], f: ["Forks", "/forks"], s: ["Sync status", "/sync"], o: ["Overview", "/"] };

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest('[role="dialog"]'));

export function Shortcuts() {
  const router = useRouter();
  const [help, setHelp] = useState(false);
  const pending = useRef<number | null>(null);

  useEffect(() => {
    const move = (dir: 1 | -1) => {
      const rows = [...document.querySelectorAll<HTMLElement>("[data-row]")].filter((r) => r.offsetParent !== null);
      if (rows.length === 0) return;
      const at = rows.indexOf(document.activeElement as HTMLElement);
      const next = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? (dir === 1 ? 0 : rows.length - 1) : at + dir))];
      next.focus();
      next.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    };
    const key = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if (pending.current !== null) {
        window.clearTimeout(pending.current);
        pending.current = null;
        const dest = GO[e.key.toLowerCase()];
        if (dest) {
          e.preventDefault();
          router.push(dest[1]);
        }
        return;
      }
      if (e.key === "?") { e.preventDefault(); setHelp(true); }
      else if (e.key === "g") pending.current = window.setTimeout(() => (pending.current = null), 900);
      else if (e.key === "j") { e.preventDefault(); move(1); }
      else if (e.key === "k") { e.preventDefault(); move(-1); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [router]);

  return (
    <D.Root open={help} onOpenChange={setHelp}>
      <D.Portal>
        <D.Overlay className="scrim fixed inset-0 z-[70] bg-scrim" />
        <D.Content className="sheet fixed left-1/2 top-1/2 z-[71] w-[min(460px,calc(100vw-24px))] -translate-x-1/2 -translate-y-1/2 rounded-[14px] border border-line bg-surface p-5 shadow-pop" aria-describedby={undefined}>
          <D.Title className="mb-3 text-[16px] font-medium">Keyboard shortcuts</D.Title>
          <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-1.5 text-[13px]">
            <dt><kbd className="kbd">Ctrl/⌘ K</kbd></dt><dd>Command palette: pages, scope, quick actions</dd>
            <dt><kbd className="kbd">?</kbd></dt><dd>This list</dd>
            <dt><kbd className="kbd">j</kbd> <kbd className="kbd">k</kbd></dt><dd>Next / previous row in a list</dd>
            <dt><kbd className="kbd">Enter</kbd></dt><dd>Open the focused row</dd>
            {Object.entries(GO).map(([k, [label]]) => (<><dt key={`k${k}`}><kbd className="kbd">g</kbd> <kbd className="kbd">{k}</kbd></dt><dd key={`d${k}`}>Go to {label}</dd></>))}
            <dt><kbd className="kbd">Esc</kbd></dt><dd>Close a dialog or drawer</dd>
          </dl>
          <D.Close className="btn mt-4">Close</D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
