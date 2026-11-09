"use client";

import { useState, useTransition } from "react";
import { openWorktreeAction } from "@/app/phase4-actions";

/** Copy the path, or open the folder or editor on this computer. Opening only works for this computer's own recorded worktrees. */
export function WorktreeActions({ repositoryId, path }: { repositoryId: string; path: string }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const open = (how: "folder" | "editor") =>
    start(async () => {
      const r = await openWorktreeAction({ repositoryId, path, how });
      setMsg(r.ok ? null : r.error);
    });
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button type="button" className="btn" onClick={() => { void navigator.clipboard?.writeText(path).then(() => setMsg("Path copied")).catch(() => setMsg("Could not copy")); }}>Copy path</button>
      <button type="button" className="btn" disabled={pending} onClick={() => open("folder")}>Open folder</button>
      <button type="button" className="btn" disabled={pending} onClick={() => open("editor")}>Open in editor</button>
      {msg && <span role="status" className="text-[12px] text-ink-3">{msg}</span>}
    </div>
  );
}
