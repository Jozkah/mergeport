import { stageLabel, type StageEntry } from "@/lib/domain/stages";
import { formatDuration } from "@/lib/format";

/** The hand-off stages of a pull request, in order, each with who acts and for how long it has waited. */
export function StageList({ stages, compact = false }: { stages: StageEntry[]; compact?: boolean }) {
  if (stages.length === 0) return null;
  return (
    <ol aria-label="Hand-off stages" className={compact ? "flex flex-wrap gap-1.5" : "flex flex-col gap-2"}>
      {stages.map((s, i) =>
        compact ? (
          <li key={i} className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-[11.5px] text-ink-2" title={s.nextAction}>
            {stageLabel(s.stage)}
            <span className="text-ink-3">· {s.owners.join(", ")}{s.elapsedMs !== null ? ` · ${formatDuration(s.elapsedMs)}` : ""}</span>
          </li>
        ) : (
          <li key={i} className="rounded-[10px] border border-line p-2.5 text-[12.5px]">
            <p className="font-medium">{stageLabel(s.stage)}{s.elapsedMs !== null && <span className="font-normal text-ink-3"> · waiting {formatDuration(s.elapsedMs)}</span>}</p>
            <p className="text-ink-2">Next: {s.nextAction}</p>
            <p className="text-ink-3">{s.reason}{s.source === "rule" ? " (waiting rule)" : s.source === "manual" ? " (recorded by hand)" : ""}</p>
          </li>
        ),
      )}
    </ol>
  );
}
