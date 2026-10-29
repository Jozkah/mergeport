"use client";

import { useState, useTransition } from "react";
import { inboxAction, inboxReadAllAction } from "@/app/inbox-actions";
import { ActionMenu } from "@/components/ui/ActionMenu";
import { Check } from "@/components/ui/icons";

/** Done / snooze / reopen for one inbox row. Personal and local: it never changes the pull request or any review. */
export function InboxRowActions({ itemId, status }: { itemId: string; status: "open" | "snoozed" | "done" }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const go = (op: Parameters<typeof inboxAction>[1]) =>
    start(async () => {
      const r = await inboxAction(itemId, op);
      setError(r.ok ? null : r.error);
    });
  return (
    <div className="flex items-center gap-1.5">
      {error && <span role="alert" className="text-[12px] text-blocked">{error}</span>}
      {status === "open" ? (
        <>
          <button type="button" className="btn" disabled={pending} onClick={() => go("done")} title="Mark done. It comes back if something new happens on it">
            <Check size={14} aria-hidden /> Done
          </button>
          <ActionMenu
            label="Snooze or mark read"
            items={[
              { label: "Mark as read", onSelect: () => go("read") },
              "sep",
              { label: "Snooze for 4 hours", onSelect: () => go("snooze-4h") },
              { label: "Snooze until tomorrow 9:00", onSelect: () => go("snooze-tomorrow") },
              { label: "Snooze for a week", onSelect: () => go("snooze-week") },
            ]}
          />
        </>
      ) : (
        <button type="button" className="btn" disabled={pending} onClick={() => go("reopen")}>Move back to inbox</button>
      )}
    </div>
  );
}

export function ReadAllButton({ disabled }: { disabled: boolean }) {
  const [pending, start] = useTransition();
  return (
    <button type="button" className="btn" disabled={disabled || pending} onClick={() => start(async () => void (await inboxReadAllAction()))}>
      Mark all read
    </button>
  );
}
