"use client";

import { useState, useTransition } from "react";
import { GitMerge, CircleAlert, Check, LoaderCircle } from "@/components/ui/icons";
import { Sheet } from "@/components/ui/dialog";
import { mergeAction, mergeCheckAction } from "@/app/actions";

type Eligibility = { headSha: string | null; baseRef: string | null; hardBlockers: string[]; warnings: string[]; methods: string[] };

/**
 * Two-step merge: (1) re-fetch eligibility from GitHub, (2) confirm target, method and the exact head SHA.
 * The SHA is sent back and verified; if the head moved the merge is refused and the person must re-confirm.
 */
export function MergeSheet({ id, disabledReason }: { id: string; disabledReason?: string }) {
  const [e, setE] = useState<Eligibility | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [method, setMethod] = useState("squash");
  const [ack, setAck] = useState(false);
  const [pending, start] = useTransition();

  function check() {
    setErr(null);
    start(async () => {
      const fd = new FormData();
      fd.set("id", id);
      const r = await mergeCheckAction(fd).catch(() => ({ ok: false as const, error: "Could not reach the server. Try again." }));
      if (!r.ok) setErr(r.error);
      else setE(r.data as unknown as Eligibility);
    });
  }
  function merge() {
    if (!e?.headSha) return;
    setErr(null);
    start(async () => {
      const fd = new FormData();
      fd.set("id", id);
      fd.set("method", method);
      fd.set("sha", e.headSha!);
      if (ack) fd.set("ack", "on");
      const r = await mergeAction(fd).catch(() => ({ ok: false as const, error: "Could not reach the server. Nothing was merged; check the pull request and try again." }));
      if (r.ok) setDone(true);
      else {
        setErr(r.error);
        setE(null); // stale confirmation must be redone
      }
    });
  }

  return (
    <Sheet
      title="Merge pull request"
      description="Eligibility is re-checked on GitHub right now. Nothing is merged until you confirm."
      trigger={
        <button className="btn" disabled={Boolean(disabledReason)} title={disabledReason}>
          <GitMerge size={14} aria-hidden /> Merge…
        </button>
      }
    >
      {done ? (
        <p role="status" className="flex items-center gap-2 text-[13px] text-ok"><Check size={14} aria-hidden /> Merged. The list will refresh.</p>
      ) : !e ? (
        <div className="flex flex-col gap-3">
          {err && <p role="alert" className="flex items-start gap-2 text-[12.5px] text-blocked"><CircleAlert size={14} aria-hidden className="mt-0.5 shrink-0" />{err}</p>}
          <button className="btn btn-primary w-fit" onClick={check} disabled={pending} data-loading={pending}>
            {pending && <LoaderCircle size={14} aria-hidden className="animate-spin" />} Check merge eligibility
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-[110px_1fr] gap-y-2 text-[13px]">
            <dt className="text-ink-3">Into</dt><dd className="mono">{e.baseRef}</dd>
            <dt className="text-ink-3">Head commit</dt><dd className="mono">{e.headSha?.slice(0, 12)}</dd>
          </dl>
          {e.hardBlockers.length > 0 && (
            <ul role="alert" className="flex flex-col gap-1 rounded-[10px] border border-blocked-line bg-blocked-bg p-3 text-[12.5px] text-blocked">
              {e.hardBlockers.map((b) => <li key={b}>{b}</li>)}
            </ul>
          )}
          {e.warnings.length > 0 && (
            <div className="rounded-[10px] border border-waiting-line bg-waiting-bg p-3 text-[12.5px] text-waiting">
              <ul className="flex flex-col gap-1">{e.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
              <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={ack} onChange={(ev) => setAck(ev.target.checked)} /> I have read these warnings and want to continue</label>
            </div>
          )}
          <fieldset>
            <legend className="label">Merge method</legend>
            <div className="flex gap-2">
              {e.methods.map((m) => (
                <label key={m} className="btn cursor-pointer capitalize has-[:checked]:bg-ink has-[:checked]:text-ink-invert">
                  <input type="radio" name="method" value={m} checked={method === m} onChange={() => setMethod(m)} className="sr-only" />
                  {m}
                </label>
              ))}
            </div>
          </fieldset>
          {err && <p role="alert" className="text-[12.5px] text-blocked">{err}</p>}
          <button className="btn btn-primary w-fit" onClick={merge} disabled={pending || e.hardBlockers.length > 0 || (e.warnings.length > 0 && !ack)} data-loading={pending}>
            {pending && <LoaderCircle size={14} aria-hidden className="animate-spin" />} Merge into {e.baseRef}
          </button>
        </div>
      )}
    </Sheet>
  );
}
