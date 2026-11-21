"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { approveActionAction, rejectActionAction } from "@/app/ai-actions";
import { EmptyState } from "@/components/ui/primitives";
import { FOLD_MS } from "@/lib/motion";
import { ShieldCheck } from "@/components/ui/icons";

export type PendingRow = { id: string; summary: string; detail: string; href: string; createdAt: string; error?: string | null };

/**
 * What AI apps asked to do on GitHub. Each shows its exact text; nothing is sent until you press Approve. A request that could not be
 * sent stays in the list with the reason, so it is never lost by a failed attempt.
 */
export function ApprovalsTab({ initial }: { initial: PendingRow[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();
  const status = useRef<HTMLParagraphElement>(null);
  const live = rows.filter((r) => !leaving.has(r.id));

  const decide = (id: string, kind: "approve" | "reject") =>
    start(async () => {
      setBusy(id);
      const fd = new FormData();
      fd.set("id", id);
      const r = await (kind === "approve" ? approveActionAction(fd) : rejectActionAction(fd));
      setBusy(null);
      if (!r.ok) {
        setFailed((f) => ({ ...f, [id]: r.error }));
        return;
      }
      setFailed((f) => {
        const { [id]: _gone, ...rest } = f;
        return rest;
      });
      setLeaving((l) => new Set([...l, id]));
      setTimeout(() => setRows((l) => l.filter((x) => x.id !== id)), FOLD_MS); // after the row has folded away
      setMsg(r.message ?? "Done");
      status.current?.focus(); // the row the focus was on is folding away
      router.refresh();
    });

  return (
    <div data-no-glow>
      <p className="px-4 pt-4 text-[13px] text-ink-2 text-pretty">An AI app connected through MCP can ask to comment, request a review or submit a review. It cannot do any of it itself: each request waits here with its exact text. Approving sends it to GitHub now, as you.</p>
      <p ref={status} tabIndex={-1} role="status" className={`px-4 text-[12.5px] text-ok outline-none ${msg ? "pt-2" : "sr-only"}`}>{msg}</p>
      {rows.length === 0 ? (
        <EmptyState icon={ShieldCheck} title="Nothing waiting for your approval">Requests from AI apps appear here and expire after a day.</EmptyState>
      ) : (
        <ul className="mt-3 flex flex-col border-t border-line" style={{ "--row-gap": "0px" } as React.CSSProperties}>
          {rows.map((r) => (
            <li key={r.id} className={leaving.has(r.id) ? "row-leave" : undefined}>
              <div className="border-b border-line px-4 py-4 last:border-b-0">
                <p className="text-[13px] font-medium text-pretty [overflow-wrap:anywhere]">{r.summary}</p>
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded-[8px] bg-faint p-3 font-sans text-[12.5px] [overflow-wrap:anywhere]">{r.detail}</pre>
                {(failed[r.id] || r.error) && <p role="alert" className="mt-2 text-[12.5px] text-blocked text-pretty">{failed[r.id] ? `Not sent: ${failed[r.id]}` : r.error}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2">
                  <button type="button" className="btn btn-primary" disabled={busy !== null} onClick={() => decide(r.id, "approve")}>{busy === r.id ? "Sending…" : "Approve and send to GitHub"}</button>
                  <span className="flex items-center gap-3">
                    <button type="button" className="btn btn-quiet" disabled={busy !== null} onClick={() => decide(r.id, "reject")}>Reject</button>
                    <Link href={r.href} className="link inline-flex min-h-8 items-center text-[12.5px]">Open it</Link>
                  </span>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {live.length === 0 && rows.length > 0 && <span className="sr-only">All decided.</span>}
    </div>
  );
}
