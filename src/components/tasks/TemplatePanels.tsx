import Link from "next/link";
import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { TASK_TEMPLATES } from "@/lib/domain/task-templates";
import { promoteAction, templateTaskAction } from "@/app/planning-actions";
import { promotionDestinations, previewPromotion } from "@/lib/services/task-promotion";
import { ActionForm } from "@/components/forms/ActionForm";
import { Panel } from "@/components/ui/primitives";
import { Select } from "@/components/ui/Select";
import { Sheet } from "@/components/ui/dialog";
import { ExternalLink } from "@/components/ui/icons";

/** Start a task from a template: its title prefix, description, labels, priority and checklist are filled in. */
export function TemplateButton({ projects }: { projects: { id: string; name: string }[] }) {
  return (
    <Sheet title="New task from a template" description="A starting point you can change afterwards." trigger={<button className="btn">From template</button>}>
      <ActionForm action={templateTaskAction} submitLabel="Create task">
        <div className="flex flex-col gap-3">
          <div><label className="label" htmlFor="tt-tpl">Template</label><Select id="tt-tpl" name="template" className="select" defaultValue="bug">{TASK_TEMPLATES.map((t) => <option key={t.key} value={t.key}>{t.name}</option>)}</Select></div>
          <div><label className="label" htmlFor="tt-proj">Project</label><Select id="tt-proj" name="projectId" className="select" defaultValue={projects[0]?.id}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
          <div><label className="label" htmlFor="tt-title">Title</label><input id="tt-title" name="title" className="input" required placeholder="What it is about" /></div>
          <div><label className="label" htmlFor="tt-as">Assign to (optional)</label><input id="tt-as" name="assignee" className="input" placeholder="GitHub username" /></div>
        </div>
      </ActionForm>
    </Sheet>
  );
}

/** Promote a local task to a GitHub issue: choose where, read exactly what will be sent, then confirm. The same task stays linked. */
export async function PromotePanel({ db, viewer, taskId, linked, promoteTo }: { db: Db; viewer: Viewer; taskId: string; linked: boolean; promoteTo?: string }) {
  if (linked) return null;
  const destinations = await promotionDestinations(db, viewer, taskId);
  if (destinations.length === 0) return null;
  const preview = promoteTo ? await previewPromotion(db, viewer, taskId, promoteTo).catch(() => null) : null;
  return (
    <Panel title="Turn into a GitHub issue" icon={ExternalLink} id="promote">
      <div className="flex flex-col gap-3 p-4 text-[13px]">
        {!preview ? (
          <form method="get" className="flex flex-wrap items-end gap-3">
            <div><label className="label" htmlFor="pr-dest">Create it in</label><Select id="pr-dest" name="promote" className="select" defaultValue={destinations[0].id}>{destinations.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}</Select></div>
            <button type="submit" className="btn">Preview</button>
          </form>
        ) : (
          <>
            <div className="rounded-[10px] border border-line p-3">
              <p className="text-ink-3">Will create in <span className="font-medium text-ink">{preview.destination.fullName}</span></p>
              <p className="mt-1 font-medium">{preview.title}</p>
              <pre className="mt-2 whitespace-pre-wrap text-[12.5px] text-ink-2">{preview.body}</pre>
              {preview.labels.length > 0 && <p className="mt-2 text-[12px] text-ink-3">Labels: {preview.labels.join(", ")}</p>}
            </div>
            <ul className="list-disc pl-5 text-[12.5px] text-ink-3">{preview.keeps.map((k) => <li key={k}>{k}</li>)}</ul>
            <p className="text-[12.5px] text-ink-2">{preview.note}</p>
            <div className="flex items-center gap-3">
              <ActionForm action={promoteAction} submitLabel="Create the issue" pendingLabel="Creating…">
                <input type="hidden" name="taskId" value={taskId} /><input type="hidden" name="repositoryId" value={preview.destination.id} />
              </ActionForm>
              <Link href={`/tasks/${taskId}`} className="btn btn-quiet">Cancel</Link>
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
