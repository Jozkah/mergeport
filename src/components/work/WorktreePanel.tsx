import type { WorkLinks } from "@/lib/services/work-links";
import { describeWorktree } from "@/lib/domain/worktree-links";
import { formatInstant } from "@/lib/format";
import { Panel } from "@/components/ui/primitives";
import { GitBranch } from "@/components/ui/icons";
import { WorktreeActions } from "@/components/work/WorktreeActions";

/**
 * The local checkout of this work, from the branch/worktree snapshot on THIS computer: which folder, and whether it is clean, ahead or
 * behind. Facts only. Folder paths are never sent to teammates; they are shown here because it is your own computer.
 */
export function WorktreePanel({ links, tz, repositoryId, note }: { links: WorkLinks; tz: string; repositoryId: string; note?: string }) {
  return (
    <Panel title="On this computer" icon={GitBranch} id="local">
      <div className="flex flex-col gap-2 p-4 text-[12.5px]">
        {!links.branch ? (
          <p className="text-ink-3">{note ?? "No branch is known for this work, so it cannot be matched to a folder."}</p>
        ) : !links.mapped ? (
          <p className="text-ink-3">The repository is not mapped to a folder on this computer. Map it on the Branches page to see its worktrees here.</p>
        ) : links.matches.length === 0 ? (
          <p className="text-ink-3">No worktree on this computer has <span className="font-mono">{links.branch}</span> checked out.{links.stale ? " The snapshot is old; rescan on the Branches page." : ""}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {links.matches.map((m) => (
              <li key={m.worktree.path} className="rounded-[10px] border border-line p-2.5">
                <p className="font-medium">{m.repository} · <span className="font-mono">{m.worktree.branch}</span></p>
                <p className="text-ink-3">{describeWorktree(m.worktree)}</p>
                <p className="mt-1 break-all font-mono text-[11.5px] text-ink-2">{m.worktree.path}</p>
                <WorktreeActions repositoryId={repositoryId} path={m.worktree.path} />
              </li>
            ))}
          </ul>
        )}
        {links.capturedAt && links.capturedAt.getTime() > 0 && <p className="text-[11.5px] text-ink-3">Snapshot of {links.machine} from {formatInstant(links.capturedAt, tz)}.</p>}
      </div>
    </Panel>
  );
}
