"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { Check, ChevronRight, X } from "@/components/ui/icons";

export type Step = { key: string; title: string; why: string; href: string; cta: string; done: boolean; optional?: boolean; locked?: string };

const KEY = "mp.getting-started.dismissed";
const subscribe = (fn: () => void) => {
  window.addEventListener("storage", fn);
  return () => window.removeEventListener("storage", fn);
};
const read = () => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
};

/**
 * The first things to do, in order, each saying why. It ticks itself as the app notices each step is done, and goes away when
 * the required ones are done or when it is dismissed (the Help page keeps the same list).
 */
export function GettingStarted({ steps }: { steps: Step[] }) {
  const hidden = useSyncExternalStore(subscribe, read, () => true);
  const [gone, setGone] = useState(false);
  const required = steps.filter((s) => !s.optional);
  const left = required.filter((s) => !s.done).length;
  if (hidden || gone || left === 0) return null;
  const next = steps.find((s) => !s.done && !s.locked);
  return (
    <section aria-labelledby="gs-title" className="mb-5 rounded-[14px] border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="gs-title" className="text-[16px] font-medium">Get started in a few minutes</h2>
          <p className="mt-0.5 text-[13px] text-ink-3">{required.length - left} of {required.length} done. Nothing here changes anything on GitHub.</p>
        </div>
        <button
          type="button"
          className="btn btn-quiet btn-icon !h-8 !w-8"
          aria-label="Hide this guide"
          title="Hide this guide (it stays on the Help page)"
          onClick={() => {
            try {
              localStorage.setItem(KEY, "1");
            } catch {
              // not remembered
            }
            setGone(true);
          }}
        >
          <X size={15} aria-hidden />
        </button>
      </div>
      <ol className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {steps.map((s, i) => (
          <li key={s.key} className={`spot-card flex flex-col gap-2 rounded-[10px] border p-3 ${s.done ? "border-ok-line bg-ok-bg" : s === next ? "border-line-strong bg-canvas" : "border-line bg-canvas"}`}>
            <div className="flex items-center gap-2 text-[13.5px] font-medium">
              <span aria-hidden className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] ${s.done ? "bg-ok text-ink-invert" : "border border-line-strong text-ink-3"}`}>{s.done ? <Check size={12} /> : i + 1}</span>
              <span className={s.done ? "text-ink-2" : ""}>{s.title}{s.optional && <span className="ml-1.5 text-[11.5px] font-normal text-ink-3">optional</span>}</span>
            </div>
            <p className="text-[12.5px] text-ink-3">{s.locked ?? s.why}</p>
            {!s.done && !s.locked && (
              <Link href={s.href} className={`btn mt-auto self-start ${s === next ? "btn-primary" : ""}`}>{s.cta} <ChevronRight size={14} aria-hidden /></Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
