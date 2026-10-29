"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import type { CtxItem } from "@/lib/ctx";
import { applyTheme, readTheme } from "@/components/shell/ThemeControls";
import { Glide } from "@/components/ui/Glide";

/**
 * The app's own right-click menu, in place of the browser's. It offers what the thing under the pointer can do: the entries an
 * element declares in `data-ctx`, link actions, copy for selected text, cut/copy/paste in text fields, and page actions.
 * Hold Shift while right-clicking to get the browser's menu (Inspect, spelling, and so on).
 */

type Entry = { label: string; run?: () => void; href?: string; disabled?: boolean; hint?: string } | "sep";
type Open = { x: number; y: number; entries: Entry[] };

const EDITABLE = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range]):not([type=color]):not([type=file]), textarea, [contenteditable=""], [contenteditable="true"]';

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement("textarea");
    t.value = text;
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
}

function declared(el: Element): CtxItem[] {
  const out: CtxItem[] = [];
  for (let n: Element | null = el.closest("[data-ctx]"); n; n = n.parentElement?.closest("[data-ctx]") ?? null) {
    try {
      const list = JSON.parse(n.getAttribute("data-ctx") ?? "[]") as CtxItem[];
      if (out.length && list.length) out.push("sep");
      out.push(...list);
    } catch {
      // a malformed attribute offers nothing
    }
  }
  return out;
}

export function ContextMenuProvider() {
  const router = useRouter();
  const [open, setOpen] = useState<Open | null>(null);
  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false);
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);

  const close = useCallback(() => setOpen(null), []);

  const build = useCallback(
    (target: Element): Entry[] => {
      const entries: Entry[] = [];
      const sep = () => entries.length > 0 && entries[entries.length - 1] !== "sep" && entries.push("sep");
      const editable = target.closest(EDITABLE) as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;

      if (editable) {
        const el = editable as HTMLInputElement;
        const hasSel = "selectionStart" in el && el.selectionStart !== null ? el.selectionStart !== el.selectionEnd : !!window.getSelection()?.toString();
        const ro = "readOnly" in el && el.readOnly;
        entries.push({ label: "Cut", hint: "Ctrl+X", disabled: !hasSel || ro, run: () => { el.focus(); document.execCommand("cut"); } });
        entries.push({ label: "Copy", hint: "Ctrl+C", disabled: !hasSel, run: () => { el.focus(); document.execCommand("copy"); } });
        entries.push({
          label: "Paste",
          hint: "Ctrl+V",
          disabled: ro,
          run: async () => {
            el.focus();
            try {
              const text = await navigator.clipboard.readText();
              document.execCommand("insertText", false, text);
            } catch {
              // clipboard reading was refused: Ctrl+V still works
            }
          },
        });
        entries.push({ label: "Select all", hint: "Ctrl+A", run: () => { el.focus(); if ("select" in el) el.select(); else document.execCommand("selectAll"); } });
        return entries;
      }

      for (const it of declared(target)) {
        if (it === "sep") sep();
        else if (it.href) entries.push({ label: it.label, href: it.href, run: () => (it.external ? window.open(it.href, "_blank", "noopener,noreferrer") : router.push(it.href!)) });
        else if (it.copy !== undefined) entries.push({ label: it.label, run: () => void copyText(it.copy!) });
      }

      const a = target.closest("a[href]") as HTMLAnchorElement | null;
      if (a && !a.getAttribute("href")!.startsWith("javascript:")) {
        sep();
        const url = new URL(a.href, window.location.href);
        const internal = url.origin === window.location.origin;
        if (internal) entries.push({ label: "Open", run: () => router.push(url.pathname + url.search + url.hash) });
        entries.push({ label: "Open in new tab", run: () => window.open(url.href, "_blank", "noopener,noreferrer") });
        entries.push({ label: "Copy link address", run: () => void copyText(url.href) });
      }

      const selected = window.getSelection()?.toString().trim();
      if (selected) {
        sep();
        entries.push({ label: "Copy", hint: "Ctrl+C", run: () => void copyText(selected) });
      }

      sep();
      entries.push({ label: "Back", run: () => window.history.back() });
      entries.push({ label: "Forward", run: () => window.history.forward() });
      entries.push({ label: "Reload", hint: "Ctrl+R", run: () => window.location.reload() });
      sep();
      entries.push({ label: "Copy page link", run: () => void copyText(window.location.href) });
      const dark = readTheme() === "dark" || (readTheme() === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      entries.push({ label: dark ? "Switch to light theme" : "Switch to dark theme", run: () => applyTheme(dark ? "light" : "dark") });
      return entries;
    },
    [router],
  );

  useEffect(() => {
    const onMenu = (e: MouseEvent) => {
      if (e.shiftKey || e.defaultPrevented) return; // Shift + right-click keeps the browser's menu
      const t = e.target;
      if (!(t instanceof Element)) return;
      if (t.closest("[data-native-menu]")) return;
      e.preventDefault();
      setAt(null);
      setOpen({ x: e.clientX, y: e.clientY, entries: build(t) });
    };
    document.addEventListener("contextmenu", onMenu);
    return () => document.removeEventListener("contextmenu", onMenu);
  }, [build]);

  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => {
      if (e.target instanceof Node && menu.current?.contains(e.target)) return;
      close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open, close]);

  // Keep the menu inside the window, then focus its first enabled item so the keyboard works at once.
  useLayoutEffect(() => {
    if (!open || !menu.current) return;
    const r = menu.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(open.x, window.innerWidth - r.width - 8));
    const y = Math.max(8, Math.min(open.y, window.innerHeight - r.height - 8));
    setAt({ x, y });
    menu.current.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "ArrowDown") (items[(i + 1) % items.length] ?? items[0]).focus();
    else if (e.key === "ArrowUp") (items[(i - 1 + items.length) % items.length] ?? items[0]).focus();
    else if (e.key === "Home") items[0].focus();
    else if (e.key === "End") items[items.length - 1].focus();
    else if (e.key === "Tab") close();
    else return;
    e.preventDefault();
  };

  if (!mounted || !open) return null;
  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label="Context menu"
      onKeyDown={onKey}
      onContextMenu={(e) => e.preventDefault()}
      className="select-pop fixed z-[90] min-w-[220px] max-w-[320px] overflow-hidden rounded-[10px] border border-line bg-surface p-1 text-[13px] text-ink shadow-pop"
      style={{ left: at?.x ?? open.x, top: at?.y ?? open.y, visibility: at ? "visible" : "hidden" }}
    >
      <Glide for={menu} />
      {open.entries.map((e, i) =>
        e === "sep" ? (
          <div key={i} role="separator" className="my-1 h-px bg-line" />
        ) : (
          <button
            key={i}
            type="button"
            role="menuitem"
            disabled={e.disabled}
            onClick={() => {
              close();
              e.run?.();
            }}
            className="relative z-[1] flex min-h-8 w-full items-center justify-between gap-6 rounded-[6px] px-2 py-1.5 text-left outline-none disabled:opacity-40"
          >
            <span className="truncate">{e.label}</span>
            {e.hint && <span className="text-[11.5px] text-ink-3">{e.hint}</span>}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
