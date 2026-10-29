import { SectionTile } from "@/components/ui/SectionTile";
import { TiltTile } from "@/components/ui/TiltTile";
import type { ComponentType, CSSProperties, ReactNode, SVGProps } from "react";
import { cn } from "@/lib/util";
import { Ban, Check, CircleAlert, CircleHelp, Eye, Hourglass, Info, Users } from "./icons";
import type { PrimaryStatus } from "@/lib/domain/review";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

export function Panel({ title, icon: I, actions, children, className, bodyClassName, id }: { title?: ReactNode; icon?: Icon; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; id?: string }) {
  return (
    <section className={cn("panel", className)} aria-labelledby={id ? `${id}-title` : undefined}>
      {(title || actions) && (
        <div className="panel-head">
          <h2 id={id ? `${id}-title` : undefined} className="flex min-w-0 items-center gap-2 text-[14px] font-medium text-ink-2">
            {I && <I size={16} aria-hidden className="shrink-0 text-ink-3" />}
            <span className="truncate">{title}</span>
          </h2>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn("panel-body", bodyClassName)}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="flex items-center gap-3 text-[24px] font-medium leading-8 tracking-[-0.01em] text-ink"><SectionTile /><span className="min-w-0">{title}</span></h1>
        {subtitle && <p className="mt-1 max-w-[70ch] text-[13px] text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const STATUS: Record<Exclude<PrimaryStatus, "NOT_APPLICABLE">, { cls: string; label: string; icon: Icon }> = {
  NEEDS_MY_REVIEW: { cls: "pill-needs", label: "Needs my review", icon: Eye },
  WAITING_TEAM: { cls: "pill-waiting", label: "Waiting on team", icon: Users },
  WAITING_EXTERNAL: { cls: "pill-waiting", label: "Waiting on external review", icon: Hourglass },
  CHANGES_REQUESTED: { cls: "pill-changes", label: "Changes requested", icon: CircleAlert },
  BLOCKED: { cls: "pill-blocked", label: "Blocked", icon: Ban },
  APPROVED: { cls: "pill-ok", label: "Approved", icon: Check },
  UNKNOWN: { cls: "pill-unknown", label: "Unknown", icon: CircleHelp },
};

/** Status is always icon + text; colour only reinforces it. */
export function StatusPill({ status, label }: { status: PrimaryStatus; label?: string }) {
  if (status === "NOT_APPLICABLE") return null;
  const s = STATUS[status];
  const I = s.icon;
  return (
    <span className={cn("pill", s.cls)}>
      <I size={12} aria-hidden />
      {label ?? s.label}
    </span>
  );
}

export function SimplePill({ tone, icon: I, children }: { tone: "needs" | "waiting" | "changes" | "blocked" | "ok" | "unknown"; icon?: Icon; children: ReactNode }) {
  return (
    <span className={cn("pill", `pill-${tone}`)}>
      {I && <I size={12} aria-hidden />}
      {children}
    </span>
  );
}

/** Keeps GitHub's label identity (the colour) while forcing readable text and border from it. */
export function LabelChip({ name, color }: { name: string; color: string }) {
  const hex = /^[0-9a-f]{6}$/i.test(color) ? color : "ededed";
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  // Only the label's raw channels go inline; .chip derives readable text/border/tint per theme in globals.css.
  return (
    <span className="chip" title={name} style={{ "--r": r, "--g": g, "--b": b } as CSSProperties}>
      <span className="truncate">{name}</span>
    </span>
  );
}

export { Avatar } from "./Avatar";

export function EmptyState({ icon: I, title, children, action }: { icon?: Icon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-in flex flex-col items-center px-6 py-8 text-center">
      {I && (
        <TiltTile>
          <I size={18} aria-hidden />
        </TiltTile>
      )}
      <p className="text-[14px] font-medium text-ink">{title}</p>
      {children && <p className="mt-1 max-w-[52ch] text-[13px] text-ink-3">{children}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Honest partial states: stale, rate-limited, disconnected, demo. Never presented as "no data". */
export function Banner({ tone = "info", title, children, action }: { tone?: "info" | "warn" | "error"; title: string; children?: ReactNode; action?: ReactNode }) {
  const cls = tone === "error" ? "pill-blocked" : tone === "warn" ? "pill-waiting" : "pill-needs";
  const I = tone === "info" ? Info : CircleAlert;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cn("flex items-start gap-3 rounded-[10px] border px-3 py-2.5 text-[13px]", cls)} style={{ height: "auto", borderRadius: 10 }}>
      <I size={16} aria-hidden className="mt-0.5 shrink-0" />
      <div className="min-w-0 max-w-[110ch] flex-1">
        <p className="font-medium">{title}</p>
        {children && <div className="mt-0.5 text-[12.5px] opacity-90">{children}</div>}
      </div>
      {action}
    </div>
  );
}

export { Segmented } from "./Segmented";

export function Field({ label, htmlFor, hint, children }: { label: string; htmlFor: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[12px] text-ink-3">{hint}</p>}
    </div>
  );
}

/** Instants render as <time> with the full UTC value discoverable on hover. */
export function Time({ value, formatted }: { value: Date; formatted: string }) {
  return (
    <time dateTime={value.toISOString()} title={value.toISOString()} className="tnum">
      {formatted}
    </time>
  );
}

export function Mono({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="mono" title={title}>
      {children}
    </span>
  );
}

/** Truncates with a discoverable full value. */
export function Trunc({ children, max = 260 }: { children: string; max?: number }) {
  return (
    <span className="block truncate" style={{ maxWidth: max }} title={children}>
      {children}
    </span>
  );
}

export function DemoBadge() {
  return (
    <span className="pill pill-unknown" title="Synthetic demo data. Not from GitHub.">
      Synthetic demo
    </span>
  );
}
