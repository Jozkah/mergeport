"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Ban, Check, CircleAlert, Clock, CloudOff, Eye, Hourglass, RefreshCw } from "@/components/ui/icons";
import { Tip } from "@/components/ui/Tooltip";
import { millis } from "@/lib/motion";

export type SyncStateName = "synced" | "pending" | "syncing" | "reconnecting" | "offline" | "conflict" | "revoked" | "signin" | "rate-limited" | "schema" | "read-only";

const META: Record<SyncStateName, { label: string; cls: string; icon: typeof Check; help: string }> = {
  synced: { label: "Synced", cls: "pill-ok", icon: Check, help: "Everything on this computer matches the shared repository." },
  pending: { label: "Pending", cls: "pill-waiting", icon: Clock, help: "Saved on this computer. Waiting to be sent to GitHub." },
  syncing: { label: "Syncing", cls: "pill-needs", icon: RefreshCw, help: "Talking to GitHub now." },
  reconnecting: { label: "Reconnecting", cls: "pill-needs", icon: RefreshCw, help: "GitHub is reachable again. Sending what was saved while offline." },
  offline: { label: "Offline", cls: "pill-unknown", icon: CloudOff, help: "GitHub could not be reached. Edits are saved here and will be sent later." },
  conflict: { label: "Conflict", cls: "pill-changes", icon: CircleAlert, help: "You and a teammate changed the same thing. Choose which version to keep." },
  revoked: { label: "Access revoked", cls: "pill-blocked", icon: Ban, help: "GitHub no longer lets you read this space. Cached data was removed; unsent edits are kept aside." },
  signin: { label: "Sign-in or access", cls: "pill-blocked", icon: Ban, help: "GitHub refused access to some tracked repositories. Check your GitHub sign-in or your access to them, then refresh." },
  "rate-limited": { label: "Rate limited", cls: "pill-waiting", icon: Hourglass, help: "GitHub's request limit was reached. Edits stay queued until it resets." },
  schema: { label: "Update needed", cls: "pill-blocked", icon: Ban, help: "This space was written by a newer Mergeport. It is read-only until you update the app." },
  "read-only": { label: "Read only", cls: "pill-unknown", icon: Eye, help: "You can read this space but not change it." },
};

/** States that need a person. Entering one of them (not on first render) draws one ring; leaving it does not. */
const NEEDS_ATTENTION = new Set<SyncStateName>(["conflict", "revoked", "signin", "offline", "rate-limited", "schema"]);

/**
 * Sync state pill. The label cross-fades when the state changes (short, no movement) and the pill rings once when it turns
 * into something that needs a person. Coming back after being offline reads "Reconnecting" while the queue drains, so the
 * return is visible and not a silent flip to "Syncing". The state is ALWAYS also text + icon, so reduced-motion and
 * colour-blind users get the same information; the help text is a tooltip AND available to assistive technology.
 */
export function SyncBadge({ state: given, pending = 0, conflicts = 0, detail, href, scope }: { state: SyncStateName; pending?: number; conflicts?: number; detail?: string | null; href?: string; scope?: "source" }) {
  const [wasDown, setWasDown] = useState(given === "offline" || given === "rate-limited");
  if (!wasDown && (given === "offline" || given === "rate-limited")) setWasDown(true);
  else if (wasDown && (given === "synced" || given === "conflict" || given === "revoked")) setWasDown(false);
  const state: SyncStateName = given === "syncing" && wasDown ? "reconnecting" : given;

  const m = META[state];
  const [shown, setShown] = useState(state);
  const [swapping, setSwapping] = useState(false);
  const [attn, setAttn] = useState(false);
  const prev = useRef(state);
  useEffect(() => {
    if (prev.current === state) return;
    const from = prev.current;
    prev.current = state;
    setSwapping(true);
    if (NEEDS_ATTENTION.has(state) && !NEEDS_ATTENTION.has(from)) setAttn(true);
    const swap = setTimeout(() => {
      setShown(state);
      setSwapping(false);
    }, millis("--duration-quick", 150) - 30);
    return () => clearTimeout(swap);
  }, [state]);
  // The ring has its own timer: a second state change inside its window must not leave it switched on for good.
  useEffect(() => {
    if (!attn) return;
    const t = setTimeout(() => setAttn(false), millis("--duration-very-slow", 500) + millis("--duration-fast", 250) + 50);
    return () => clearTimeout(t);
  }, [attn]);
  const sm = META[shown];
  const SI = sm.icon;
  const count = shown === "pending" && pending ? ` (${pending})` : shown === "conflict" && conflicts ? ` (${conflicts})` : "";
  const common = { className: `pill sync-pill ${sm.cls}`, "data-state": state, "data-swapping": swapping ? "true" : undefined, "data-attn": attn ? "true" : undefined };
  // Changes are announced once, by SyncAnnouncer; the label itself is not a live region. The help text stays readable at all times.
  const body = (
    <>
      <SI size={12} aria-hidden className={shown === "syncing" || shown === "reconnecting" ? "animate-spin" : undefined} />
      <span className="sync-label">{sm.label}{count}</span>
      <span className="sr-only">{scope === "source" ? (detail ?? m.help) : `${m.help}${detail ? " " + detail : ""}`}</span>
    </>
  );
  return (
    <Tip label={scope === "source" ? (detail ?? m.help) : `${m.help}${detail ? " " + detail : ""}`}>
      {/* As a link it is the one tab stop for the destination; on its own it is a focusable status so the tooltip works from the keyboard. */}
      {href ? <Link href={href} {...common}>{body}</Link> : <span {...common} tabIndex={0}>{body}</span>}
    </Tip>
  );
}
