"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Logo } from "@/components/ui/Logo";
import { Banner } from "@/components/ui/primitives";
import { LoaderCircle } from "@/components/ui/icons";
import { pollSwitch, validateSwitchTarget, type Ready } from "@/lib/local/switch-poll";
import { beginSwitch } from "@/lib/local/switching";

type Props = { launchUrl: string; previousBootId: string | null; expectedBackend: string };

const FAILURE: Record<"timeout" | "invalid", { title: string; text: string }> = {
  timeout: { title: "The other workspace did not start", text: "It did not answer in time. Nothing was lost. Go back and try again; if the page does not load, start Mergeport again." },
  invalid: { title: "The switch link is not valid", text: "It does not point at this computer, so Mergeport did not follow it. Nothing was changed." },
};

/** Full-screen state shown in place while the app restarts on another workspace. Rendered by the caller, not a route: the old app stops serving pages. */
export function SwitchingOverlay({ launchUrl, previousBootId, expectedBackend }: Props) {
  const [state, setState] = useState<"waiting" | "timeout" | "invalid">("waiting");
  const mounted = useSyncExternalStore(() => () => {}, () => true, () => false);
  const root = useRef<HTMLDivElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Every caller (workspace switcher, hub connect, hub sign-out) shows this overlay while the app restarts: no live refresh may reach the new process.
    beginSwitch();
    let cancelled = false;
    const fetchReady = async (): Promise<Ready> => {
      const res = await fetch("/api/local/ready", { cache: "no-store", signal: AbortSignal.timeout(2000) });
      if (!res.ok) throw new Error("not ready");
      return (await res.json()) as Ready;
    };
    void (async () => {
      if (!validateSwitchTarget(launchUrl, window.location.host)) {
        if (!cancelled) setState("invalid");
        return;
      }
      const outcome = await pollSwitch({ fetchReady, previousBootId, expectedBackend });
      if (cancelled) return;
      if (outcome === "go-launch") window.location.href = launchUrl;
      // Full document navigation on purpose: the app behind this page was restarted, so router.push() would talk to the old server and
      // fail. The rule suggests router.push for internal pages; this one must reload, so it is excepted here and only here.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      else if (outcome === "restored") window.location.href = `${window.location.origin}/`;
      else setState("timeout");
    })();
    return () => {
      cancelled = true;
    };
  }, [launchUrl, previousBootId, expectedBackend]);

  // Modal: everything behind the overlay is unreachable (pointer, keyboard, screen reader) until it goes away.
  useEffect(() => {
    if (!mounted) return;
    const held: { el: Element; was: boolean }[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === root.current || el.tagName === "SCRIPT") continue;
      held.push({ el, was: el.hasAttribute("inert") });
      el.setAttribute("inert", "");
    }
    return () => {
      for (const { el, was } of held) if (!was) el.removeAttribute("inert");
    };
  }, [mounted]);

  // Focus moves into the dialog when it appears, and to the way out when the switch fails.
  useEffect(() => {
    if (!mounted) return;
    const out = dialog.current?.querySelector<HTMLElement>("a[href]");
    (state === "waiting" ? dialog.current : out ?? dialog.current)?.focus();
  }, [mounted, state]);

  // A full page load on purpose: the app behind this page may have restarted.
  // eslint-disable-next-line @next/next/no-html-link-for-pages
  const back = <a href="/" className="btn">Back</a>;
  // Portaled to <body>: a caller inside the top bar (backdrop-blur) would otherwise confine position:fixed to the header.
  if (!mounted) return null;
  const failure = state === "waiting" ? null : FAILURE[state];
  return createPortal(
    <div ref={root} className="overlay-in fixed inset-0 z-50 grid place-items-center bg-canvas p-6">
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby="switching-title" tabIndex={-1} className="panel w-full max-w-[420px] outline-none">
        <div className="panel-body flex flex-col items-center gap-4 p-6 text-center">
          <Logo size={40} />
          {failure ? (
            <div className="w-full text-left">
              <h1 id="switching-title" className="sr-only">Switching workspace</h1>
              <Banner tone="error" title={failure.title} action={back}>{failure.text}</Banner>
            </div>
          ) : (
            <div role="status">
              <h1 id="switching-title" className="flex items-center justify-center gap-2 text-[20px] font-medium"><LoaderCircle size={18} aria-hidden className="animate-spin text-ink-3" />Switching workspace…</h1>
              <p className="mt-2 text-balance text-[13px] text-ink-3">Mergeport is restarting on the other workspace. This takes a few seconds, and this page opens it when it is ready.</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
