"use client";

import { useEffect, useRef } from "react";
import { useToast } from "@/components/ui/ToastProvider";
import type { SyncStateName } from "@/components/sync/SyncBadge";

/**
 * Says, once, when a SHARED state changes into something a person should know about while they are looking at another
 * page: a conflict, revoked access, going offline, and coming back. It never fires for the first state it sees, never for
 * polling that changes nothing, and never moves focus; the Sync page and the top-bar pill carry the detail.
 */
export function SyncAnnouncer({ state }: { state: SyncStateName | null }) {
  const { show } = useToast();
  const prev = useRef<SyncStateName | null>(state);
  const wasDown = useRef(false);
  useEffect(() => {
    const was = prev.current;
    prev.current = state;
    if (!state || was === state) return;
    if (state === "offline" || state === "rate-limited") wasDown.current = true;
    if (state === "conflict") show("error", "A teammate changed something you also changed. Open Sync to choose which version to keep.");
    else if (state === "revoked") show("error", "Your access to a shared space was removed. Unsent edits are kept aside on the Sync page.");
    else if (state === "signin") show("error", "GitHub refused access to some tracked repositories. Open Repositories to see which, and check your GitHub sign-in.");
    else if (state === "schema") show("error", "A shared space was written by a newer Mergeport. It is read-only until you update.");
    else if (state === "offline") show("info", "GitHub can’t be reached. Edits are saved on this computer and sent when it is back.");
    else if (state === "rate-limited") show("info", "GitHub’s request limit was reached. Edits stay queued until it resets.");
    else if (state === "synced" && wasDown.current) {
      wasDown.current = false;
      show("ok", "Back online. Everything was sent and is up to date.");
    }
  }, [state, show]);
  return null;
}
