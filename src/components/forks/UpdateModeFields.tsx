"use client";

import { useEffect, useState, type ReactNode } from "react";
import { markReleasesSeenAction } from "@/app/upstream-update-actions";
import { Mono } from "@/components/ui/primitives";

/**
 * The top of the auto-update form: which mode, and the on/off switch worded for it. The settings that only one mode uses arrive as
 * server-rendered slots and are hidden (not removed) in the other, so their stored values are posted back unchanged and survive a
 * switch of mode. The mode radios are real radios, so the choice is announced and works from the keyboard.
 */
const CARD = "flex min-h-10 cursor-pointer flex-col gap-0.5 rounded-[10px] border border-line p-2.5 transition-colors duration-[var(--duration-feedback)] hover:bg-subtle has-[:checked]:border-ink has-[:checked]:bg-subtle has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink";

export function UpdateModeFields({ defaultMode, enabled, forkName, upstreamName, mergeFields, releaseFields }: { defaultMode: "merge" | "releases"; enabled: boolean; forkName: string; upstreamName: string; mergeFields: ReactNode; releaseFields: ReactNode }) {
  const [mode, setMode] = useState(defaultMode);
  return (
    <>
      <fieldset className="min-w-0">
        <legend className="label">What should Mergeport do?</legend>
        <div className="grid gap-2 md:grid-cols-2">
          <label className={CARD}>
            <span className="flex items-center gap-2 text-[13px] font-medium"><input type="radio" name="mode" value="merge" checked={mode === "merge"} onChange={() => setMode("merge")} /> Merge upstream changes</span>
            <span className="pl-6 text-[12px] text-ink-3 text-pretty">Merge new upstream commits in a private copy, check them, and open a pull request.</span>
          </label>
          <label className={CARD}>
            <span className="flex items-center gap-2 text-[13px] font-medium"><input type="radio" name="mode" value="releases" checked={mode === "releases"} onChange={() => setMode("releases")} /> Only warn about new upstream releases</span>
            <span className="pl-6 text-[12px] text-ink-3 text-pretty">Read the upstream&rsquo;s releases from GitHub and tell you. Nothing is changed.</span>
          </label>
        </div>
      </fieldset>
      <label className="flex min-h-10 items-center gap-2 text-[13px]">
        <input type="checkbox" name="enabled" defaultChecked={enabled} />
        {mode === "releases" ? <span>Tell me when <Mono>{upstreamName}</Mono> publishes a new release</span> : <span>Keep <Mono>{forkName}</Mono> up to date automatically</span>}
      </label>
      <div hidden={mode !== "merge"} className="flex flex-col gap-4">{mergeFields}</div>
      <div hidden={mode !== "releases"} className="flex flex-col gap-4">{releaseFields}</div>
    </>
  );
}

/**
 * Opening the Forks page counts as looking at the release warnings under it: they leave the daily digest. Nothing is drawn.
 * (Idempotent, so a repeated effect run is harmless.)
 */
export function ReleasesSeen({ mappingId }: { mappingId: string }) {
  useEffect(() => {
    void markReleasesSeenAction(mappingId);
  }, [mappingId]);
  return null;
}
