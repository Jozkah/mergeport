"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveActionAction, rejectActionAction } from "@/app/ai-actions";

export type PendingRow = { id: string; summary: string; detail: string; href: string; createdAt: string };

/** What AI apps asked to do on GitHub. Each shows its exact text; nothing is sent until you press Approve. */
export function ApprovalsTab({ initial }: { initial: PendingRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();

  const decide = (id: string, kind: "approve" | "reject") =>
    start(async () => {
      setBusy(id);
      const fd = new FormData();
      fd.set("id", id);
      const r = await (kind === "approve" ? approveActionAction(fd) : rejectActionAction(fd));
      setBusy(null);
      setMsg({ ok: r.ok, text: r.ok ? (r.message ?? "Done") : r.error });
      setRows((l) => l.filter((x) => x.id !== id));
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[13px] text-ink-2">An AI app (through the MCP server) can ask to comment, request a review or submit a review. It cannot do any of it itself: each request waits here with its exact text. Approving sends it to GitHub now, as you.</p>
      {msg && <p role="status" className={`text-[12.5px] ${msg.ok ? "text-ok" : "text-blocked"}`}>{msg.text}</p>}
      {rows.length === 0 ? (
        <div className="rounded-[12px] border border-line p-4 text-[13px] text-ink-3">Nothing is waiting for your approval. Requests older than a day expire.</div>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => (
            <li key={r.id} className="rounded-[12px] border border-line p-4">
              <p className="text-[13px] font-medium [overflow-wrap:anywhere]">{r.summary}</p>
              <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-[8px] bg-faint p-3 font-sans text-[12.5px] [overflow-wrap:anywhere]">{r.detail}</pre>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => decide(r.id, "approve")}>{busy === r.id ? "Sending…" : "Approve and send to GitHub"}</button>
                <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={() => decide(r.id, "reject")}>Reject</button>
                <Link href={r.href} className="text-[12px] underline">Open it</Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
