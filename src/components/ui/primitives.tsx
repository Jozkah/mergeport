import { SectionTile } from "@/components/ui/SectionTile";
import { TiltTile } from "@/components/ui/TiltTile";
import { CollapsiblePanel } from "@/components/ui/CollapsiblePanel";
import { DismissibleBanner } from "@/components/ui/DismissibleBanner";
import type { ComponentType, CSSProperties, ReactNode, SVGProps } from "react";
import { cn } from "@/lib/util";
import { Ban, Check, ChevronDown, CircleAlert, CircleHelp, Eye, Hourglass, Info, Users } from "./icons";
import type { PrimaryStatus } from "@/lib/domain/review";

type Icon = ComponentType<SVGProps<SVGSVGElement> & { size?: number | string }>;

/**
 * `summary` is a muted one-line digest shown in the head only while a collapsible panel is closed (ignored when the panel
 * cannot fold). A closed panel still renders its children on the server; they are only hidden and inert.
 */
export function Panel({ title, icon: I, actions, children, className, bodyClassName, id, collapsible = true, defaultOpen = true, summary }: { title?: ReactNode; icon?: Icon; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; id?: string; collapsible?: boolean; defaultOpen?: boolean; summary?: ReactNode }) {
  // A panel with a title and an id can be folded away; the choice is remembered per page.
  if (collapsible && id && title) {
    return (
      <CollapsiblePanel id={id} defaultOpen={defaultOpen} summary={summary} className={className} bodyClassName={bodyClassName} actions={actions} head={<>{I && <I size={16} aria-hidden className="shrink-0 text-ink-3" />}<span className="min-w-0 truncate">{title}</span></>}>
        {children}
      </CollapsiblePanel>
    );
  }
  return (
    <section className={cn("panel", className)} aria-labelledby={id ? `${id}-title` : undefined}>
      {(title || actions) && (
        <div className="panel-head">
          <h2 id={id ? `${id}-title` : undefined} className="flex min-w-0 items-center gap-2 text-[14px] font-medium text-ink-2">
            {I && <I size={16} aria-hidden className="shrink-0 text-ink-3" />}
            <span className="truncate">{title}</span>
          </h2>
          {actions && <div className="flex shrink-0 items-center gap-2 [&_form>div]:!mt-0">{actions}</div>}
        </div>
      )}
      <div className={cn("panel-body", bodyClassName)}>{children}</div>
    </section>
  );
}

/**
 * The subtitle clamps to two lines (a string subtitle keeps its full text in `title`). Longer explanation
 * goes in `help`: a closed "About this page" disclosure (native <details>, so it works without JavaScript).
 */
export function PageHeader({ title, subtitle, actions, help }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; help?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 max-w-full">
        <h1 className="wrap-any flex items-center gap-3 text-[24px] font-medium leading-8 tracking-[-0.01em] text-ink [text-wrap:balance]"><SectionTile /><span className="min-w-0">{title}</span></h1>
        {subtitle && <p className="mt-1 line-clamp-2 max-w-[70ch] text-[13px] text-ink-3" title={typeof subtitle === "string" ? subtitle : undefined}>{subtitle}</p>}
        {help && (
          <details className="group mt-0.5 max-w-[70ch]">
            <summary className="-ml-1 inline-flex h-10 cursor-pointer list-none items-center gap-1.5 rounded-[6px] px-1 text-[12.5px] text-ink-3 transition-colors duration-[var(--duration-feedback)] hover:text-ink [&::-webkit-details-marker]:hidden">
              <Info size={14} aria-hidden className="shrink-0" />
              About this page
              <ChevronDown size={14} aria-hidden className="shrink-0 transition-transform duration-[var(--duration-fast)] group-open:rotate-180" />
            </summary>
            <div className="mb-1 rounded-[10px] border border-line bg-subtle px-3 py-2.5 text-[12.5px] leading-5 text-ink-2">{help}</div>
          </details>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 [&_form>div]:!mt-0">{actions}</div>}
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

const TONE_ICON: Record<"needs" | "waiting" | "changes" | "blocked" | "ok" | "unknown", Icon> = { needs: Info, waiting: Hourglass, changes: CircleAlert, blocked: Ban, ok: Check, unknown: CircleHelp };

/** A state pill always carries an icon (colour never stands alone): pass `icon`, or the tone's default is used. */
export function SimplePill({ tone, icon, children }: { tone: "needs" | "waiting" | "changes" | "blocked" | "ok" | "unknown"; icon?: Icon; children: ReactNode }) {
  const I = icon ?? TONE_ICON[tone];
  return (
    <span className={cn("pill", `pill-${tone}`)}>
      <I size={12} aria-hidden />
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

/**
 * Honest partial states: stale, rate-limited, disconnected, demo. Never presented as "no data".
 * `dismissible` adds a close button; with a `storageKey` the dismissal is remembered on this device (see DismissibleBanner).
 */
export function Banner({ tone = "info", title, children, action, dismissible = false, storageKey }: { tone?: "info" | "warn" | "error"; title: string; children?: ReactNode; action?: ReactNode; dismissible?: boolean; storageKey?: string }) {
  const cls = tone === "error" ? "pill-blocked" : tone === "warn" ? "pill-waiting" : "banner-info"; // info is neutral: blue is reserved for "needs my review"
  const I = tone === "info" ? Info : CircleAlert;
  const role = tone === "error" ? "alert" : "status";
  // With an action the row wraps below sm: the icon and text stay on the first line, the action drops to its own row under the text
  // (indented to the text) and the dismiss X stays top-right. From sm up everything sits side by side.
  const className = cn("flex items-start gap-3 rounded-[10px] border px-3 py-2.5 text-[13px]", !!action && "flex-wrap sm:flex-nowrap", cls);
  const style = { height: "auto", borderRadius: 10 };
  const body = (
    <>
      <I size={16} aria-hidden className="mt-0.5 shrink-0" />
      <div className="min-w-0 max-w-[110ch] flex-1">
        <p className="font-medium">{title}</p>
        {children && <div className="mt-0.5 text-[12.5px] opacity-90">{children}</div>}
      </div>
      {action && <div data-banner-action className="order-last w-full pl-7 sm:order-none sm:w-auto sm:pl-0 max-sm:[&_.btn]:!h-10">{action}</div>}
    </>
  );
  if (dismissible) return <DismissibleBanner storageKey={storageKey} role={role} className={className} style={style} label={`Dismiss: ${title}`}>{body}</DismissibleBanner>;
  return (
    <div role={role} className={className} style={style}>
      {body}
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

/**
 * Do not put this on rows or cards: the demo banner in the top bar already says the whole app is synthetic, and a badge per
 * row only repeats it. Kept for the rare place that is shown outside the shell.
 */
export function DemoBadge() {
  return (
    <span className="pill pill-unknown" title="Synthetic demo data. Not from GitHub.">
      Synthetic demo
    </span>
  );
}
