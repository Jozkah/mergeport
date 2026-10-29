import { AutoRefresh } from "@/components/sync/AutoRefresh";
import { Time } from "@/components/ui/primitives";
import { formatInstant } from "@/lib/format";
import type { CachedView } from "@/lib/local/discovery";

const TEXT: Record<string, { cls: string; label: string }> = {
  FRESH: { cls: "text-ink-3", label: "Up to date" },
  RETRYING: { cls: "text-waiting", label: "Checking GitHub…" },
  OFFLINE: { cls: "text-waiting", label: "Offline: showing the saved list" },
  AUTH: { cls: "text-blocked", label: "GitHub sign-in needed: showing the saved list" },
  RATE_LIMITED: { cls: "text-waiting", label: "GitHub rate limit: showing the saved list" },
  ERROR: { cls: "text-blocked", label: "Could not refresh: showing the saved list" },
  EMPTY: { cls: "text-ink-3", label: "Not checked yet" },
};

/**
 * One line that says how old a cached GitHub list is and why it might not be current. It never presents a failed
 * refresh as an empty list or as success: the last good list stays, with the reason next to it.
 */
export function Freshness({ view, listKey, timezone, refreshing, auto = true }: { view: Pick<CachedView<unknown>, "state" | "fetchedAt" | "error" | "nextRetryAt" | "stale" | "attempts">; listKey: string; timezone: string; refreshing: boolean; auto?: boolean }) {
  const t = TEXT[refreshing ? "RETRYING" : view.state] ?? TEXT.EMPTY;
  const needsRefresh = auto && !refreshing && (view.state === "EMPTY" || (view.stale && view.state === "FRESH"));
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-[12px]" role="status" aria-live="polite">
      <p className={t.cls}>
        {t.label}
        {view.attempts > 1 && view.state !== "FRESH" ? ` (attempt ${view.attempts})` : ""}
        {view.fetchedAt ? <> · last updated <Time value={view.fetchedAt} formatted={formatInstant(view.fetchedAt, timezone)} /></> : view.state === "EMPTY" ? null : " · never updated"}
        {view.error && view.state !== "FRESH" && !refreshing ? <> · {view.error}</> : null}
        {view.nextRetryAt && (view.state === "OFFLINE" || view.state === "ERROR") && !refreshing ? <> · will retry <Time value={view.nextRetryAt} formatted={formatInstant(view.nextRetryAt, timezone)} /></> : null}
        {view.state === "RATE_LIMITED" && view.nextRetryAt && !refreshing ? <> · resets <Time value={view.nextRetryAt} formatted={formatInstant(view.nextRetryAt, timezone)} /></> : null}
      </p>
      <AutoRefresh listKey={listKey} auto={needsRefresh} busy={refreshing} />
    </div>
  );
}
