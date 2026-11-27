import Link from "next/link";
import type { CardView } from "@/lib/services/planning-view";
import { EmptyState, Panel } from "@/components/ui/primitives";
import { Ban, ListChecks } from "@/components/ui/icons";
import { OpenCardLink } from "@/components/planning/TaskDrawer";

/**
 * The project's work list: only actionable internal tasks, in the project's own order (card position), grouped so the top of the
 * list is always something that can be started now. GitHub issue / pull request cards and finished or reference cards stay on the
 * Board and List views and are only counted here.
 */
type Epic = { id: string; title: string; description: string | null; status: string };

const PRIORITY: Record<number, { label: string; cls: string }> = {
  4: { label: "Urgent", cls: "text-blocked font-medium" },
  3: { label: "High", cls: "text-ink" },
  2: { label: "Medium", cls: "text-ink-3" },
  1: { label: "Low", cls: "text-ink-3" },
};
const EFFORT: Record<string, string> = { "e-quick": "under 30 min", "e-small": "30 min – 2 h", "e-medium": "2 – 4 h", "e-focus": "4 – 8 h", "e-large": "several sessions" };

const isReference = (c: CardView) => c.taskLabels.includes("reference") || c.taskLabels.includes("archived");
const isOptional = (c: CardView) => c.taskLabels.includes("optional") || c.priority === 1;

export function TasksView({ cards, epics, boardHref, listHref, epicsHref }: { cards: CardView[]; epics: Epic[]; boardHref: string; listHref: string; epicsHref: string }) {
  const tasks = cards.filter((c) => c.isDraft && !isReference(c) && c.columnKey !== "done").sort((a, b) => a.position - b.position);
  const github = cards.filter((c) => !c.isDraft && c.columnKey !== "done").length;
  const finished = cards.filter((c) => c.columnKey === "done" && !isReference(c)).length;
  const history = cards.find((c) => c.isDraft && c.taskLabels.includes("reference"));
  const start = epics.find((e) => e.title.startsWith("Start here:"));
  const goal = epics.find((e) => e !== start && e.status === "OPEN" && !/optional/i.test(e.title));
  const inGoal = goal ? cards.filter((c) => c.epicId === goal.id) : [];

  // Optional work always comes last, even when it also waits on another task or on something external.
  const optional = tasks.filter((c) => isOptional(c));
  const essential = tasks.filter((c) => !isOptional(c));
  const external = essential.filter((c) => c.columnKey === "blocked");
  const waiting = essential.filter((c) => c.columnKey !== "blocked" && c.blockedBy > 0);
  // Nothing here waits on another task, so urgent work can always go first; otherwise the project's own order holds.
  const now = essential
    .filter((c) => c.columnKey !== "blocked" && c.blockedBy === 0 && c.columnKey !== "backlog")
    .sort((a, b) => Number(b.priority === 4) - Number(a.priority === 4) || a.position - b.position);
  const next = essential.filter((c) => c.columnKey === "backlog" && c.blockedBy === 0);
  const groups = [
    { key: "now", title: "Ready now", hint: "In order. Urgent work first.", cards: now },
    { key: "next", title: "Up next", hint: "Ready once you get to them.", cards: next },
    { key: "waiting", title: "Waiting on another task", hint: "Finish the task it depends on first.", cards: waiting },
    { key: "blocked", title: "Blocked by something outside the project", hint: "The task says what it is waiting for.", cards: external },
    { key: "optional", title: "Optional improvements", hint: "Nice to have, any time or never.", cards: optional },
  ].filter((g) => g.cards.length > 0);
  let n = 0;

  return (
    <div className="flex flex-col gap-5">
      {(start || goal || history) && (
        <Panel title="Where you left off" icon={ListChecks} id="resume">
          <div className="flex flex-col gap-3 p-4 text-[13px]">
            {start?.description && <p className="leading-relaxed text-ink-2 [overflow-wrap:anywhere]">{start.description}</p>}
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-ink-3">
              {goal && <span><span className="font-medium text-ink-2">Done when:</span> {goal.title} · <span className="tnum">{inGoal.filter((c) => c.columnKey === "done").length}/{inGoal.length}</span> done</span>}
              {history && <OpenCardLink id={history.id} href={history.taskHref} className="underline">Full history and decisions</OpenCardLink>}
              <Link href={epicsHref} className="underline">Epics</Link>
            </div>
          </div>
        </Panel>
      )}
      <Panel title="Tasks" icon={ListChecks} id="tasks" summary={<span className="tnum">{tasks.length} open</span>}>
        {tasks.length === 0 ? <EmptyState icon={ListChecks} title="Nothing to do here">No open tasks in this project.</EmptyState> : (
          <div className="flex flex-col">
            {groups.map((g) => (
              <section key={g.key} aria-label={g.title} className="border-b border-line last:border-b-0">
                <h3 className="flex items-baseline gap-2 px-4 pb-1 pt-4 text-[13px] font-medium text-ink-2">{g.title}<span className="tnum rounded-full bg-muted px-2 text-[11.5px] leading-5">{g.cards.length}</span><span className="font-normal text-ink-3">{g.hint}</span></h3>
                <ol className="flex flex-col">
                  {g.cards.map((c) => {
                    n += 1;
                    const p = PRIORITY[c.priority];
                    const eff = c.taskLabels.find((l) => Object.hasOwn(EFFORT, l));
                    return (
                      <li key={c.id} className="flex gap-3 px-4 py-2.5 hover:bg-muted/50">
                        <span className="tnum w-6 shrink-0 pt-px text-right text-[12px] text-ink-3">{n}</span>
                        <div className="min-w-0">
                          <OpenCardLink id={c.id} href={c.taskHref} className="font-medium leading-[1.35] hover:underline [overflow-wrap:anywhere]">{c.title}</OpenCardLink>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-ink-3">
                            {p && <span className={p.cls}>{p.label}</span>}
                            {eff && <span>{EFFORT[eff]}</span>}
                            {c.checklist.total > 0 && <span className="tnum inline-flex items-center gap-1"><ListChecks size={12} aria-hidden />{c.checklist.done}/{c.checklist.total} steps</span>}
                            {c.blockedBy > 0 && <span className="inline-flex items-center gap-1 text-blocked"><Ban size={12} aria-hidden />Blocked by {c.blockedBy} task{c.blockedBy === 1 ? "" : "s"}</span>}
                            {c.columnKey === "blocked" && <span className="text-blocked">Blocked</span>}
                            {c.columnKey === "in-progress" && <span>In progress</span>}
                            {c.epicTitle && !c.epicTitle.startsWith("Start here:") && <span className="truncate" title={`Epic: ${c.epicTitle}`}>◆ {c.epicTitle}</span>}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ))}
          </div>
        )}
        <p className="border-t border-line px-4 py-3 text-[12px] text-ink-3">
          {github} open GitHub issue and pull request card{github === 1 ? "" : "s"} and {finished} finished card{finished === 1 ? "" : "s"} are not listed here: see <Link href={boardHref} className="underline">Board</Link> or <Link href={listHref} className="underline">List</Link>.
        </p>
      </Panel>
    </div>
  );
}
