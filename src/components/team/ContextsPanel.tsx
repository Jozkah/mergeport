import path from "node:path";
import { createContextAction, renameContextAction, switchContextAction } from "@/app/context-actions";
import { contextIdOf, peekContext, profileDirOf, readIndex } from "@/lib/local/contexts";
import { formatInstant } from "@/lib/format";
import { ActionForm } from "@/components/forms/ActionForm";
import { Panel } from "@/components/ui/primitives";
import { Users } from "@/components/ui/icons";

/**
 * Separate teams on one account, each in its own database. Switching keeps everything in the one you leave, exactly as it was.
 * Only the active context is open and syncing; the others are parked, with their unsent edits waiting for you.
 */
export function ContextsPanel({ tz }: { tz: string }) {
  const dbFile = process.env.MERGEPORT_DB;
  if (!dbFile) return null;
  const base = path.resolve(process.env.MERGEPORT_BASE_DB ?? dbFile);
  const dir = profileDirOf(base);
  const baseName = path.basename(base);
  const idx = readIndex(dir, baseName);
  const current = contextIdOf(dir, baseName, dbFile);
  return (
    <Panel title="Team contexts" icon={Users} id="contexts">
      <div className="flex flex-col gap-3 p-4 text-[13px]">
        <p className="text-ink-3">Use more than one team without leaving any. Each context is its own database, so one team&rsquo;s records are never stored or searched alongside another&rsquo;s. Switching restarts Mergeport; the context you leave is kept exactly as it was and syncs again when you return. Only the open context syncs.</p>
        <ul className="flex flex-col gap-2">
          {idx.contexts.map((c) => {
            const active = c.id === current;
            const s = peekContext(path.resolve(dir, c.file));
            return (
              <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 rounded-[10px] border border-line p-3">
                <div className="min-w-0">
                  <p className="font-medium">{c.name} {active && <span className="ml-1 rounded-full border border-line px-2 py-0.5 text-[11.5px] font-normal text-ink-2">open now</span>}</p>
                  <p className="text-[12.5px] text-ink-3">{!s.exists ? "Not started yet" : s.team ? `Team: ${s.team}` : "Personal mode"} · {s.spaces} space{s.spaces === 1 ? "" : "s"}{s.lastSyncedAt ? ` · last synced ${formatInstant(new Date(/^\d+$/.test(s.lastSyncedAt) ? Number(s.lastSyncedAt) : s.lastSyncedAt), tz)}` : ""}</p>
                  {!active && (s.unsent > 0 || s.conflicts > 0) && <p className="text-[12.5px] text-waiting">Parked with {s.unsent} unsent change{s.unsent === 1 ? "" : "s"}{s.conflicts ? ` and ${s.conflicts} open conflict${s.conflicts === 1 ? "" : "s"}` : ""}. They are kept and send when you switch back.</p>}
                  {!active && <p className="text-[12px] text-ink-3">Not syncing while parked, so teammates&rsquo; changes arrive when you return.</p>}
                </div>
                <div className="flex flex-col items-end gap-2">
                  {!active && (
                    <ActionForm action={switchContextAction} submitLabel="Switch to this" submitClassName="btn btn-primary" pendingLabel="Switching…" resetOnSuccess={false}>
                      <input type="hidden" name="id" value={c.id} />
                    </ActionForm>
                  )}
                  <ActionForm action={renameContextAction} submitLabel="Rename" submitClassName="btn btn-quiet" className="flex items-center gap-2" resetOnSuccess={false}>
                    <input type="hidden" name="id" value={c.id} /><label className="sr-only" htmlFor={`rn-${c.id}`}>New name</label><input id={`rn-${c.id}`} name="name" className="input !h-8 w-36" defaultValue={c.name} maxLength={40} />
                  </ActionForm>
                </div>
              </li>
            );
          })}
        </ul>
        <ActionForm action={createContextAction} submitLabel="Add a context" submitClassName="btn" className="flex flex-wrap items-end gap-3">
          <div><label className="label" htmlFor="ctx-name">New context name</label><input id="ctx-name" name="name" className="input" placeholder="Client team" maxLength={40} required /></div>
        </ActionForm>
      </div>
    </Panel>
  );
}
