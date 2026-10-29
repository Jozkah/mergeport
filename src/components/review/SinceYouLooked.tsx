"use client";

import { useState, useTransition } from "react";
import { markSeenAction } from "@/app/inbox-actions";
import type { Change } from "@/lib/domain/changes";

/** What changed since this person last acknowledged the item. Stays until they say they have seen it; it is not a review decision. */
export function SinceYouLooked({ itemId, changes, seenLabel }: { itemId: string; changes: Change[]; seenLabel: string | null }) {
  const [pending, start] = useTransition();
  const [gone, setGone] = useState(false);
  if (changes.length === 0 || gone) return null;
  return (
    <section aria-label="Changes since you last looked" className="rounded-[12px] border border-line bg-surface p-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[13px] font-medium">Since you last looked{seenLabel ? ` (${seenLabel})` : ""}</p>
          <ul className="mt-1 list-disc pl-5 text-[12.5px] text-ink-2">{changes.map((c, i) => <li key={i}>{c.text}</li>)}</ul>
        </div>
        <button
          type="button"
          className="btn"
          disabled={pending}
          onClick={() => start(async () => { const r = await markSeenAction(itemId); if (r.ok) setGone(true); })}
        >
          Mark as seen
        </button>
      </div>
    </section>
  );
}
