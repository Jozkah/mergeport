import { ActionForm } from "@/components/forms/ActionForm";
import { Sheet } from "@/components/ui/dialog";
import { Select } from "@/components/ui/Select";
import { Plus } from "@/components/ui/icons";
import { TaskFields } from "@/components/tasks/TaskFields";
import { createTaskAction } from "@/app/task-actions";

type P = { id: string; name: string };

/** New-task dialog. The assignee list is everyone known in any of the projects; anyone else can be typed. */
export function NewTask({ projects, peopleByProject, me, defaultProjectId, defaultAssignee }: { projects: P[]; peopleByProject: Record<string, string[]>; me: string; defaultProjectId: string; defaultAssignee?: string }) {
  const first = defaultProjectId in peopleByProject ? defaultProjectId : projects[0]?.id;
  const people = [...new Map([me, ...Object.values(peopleByProject).flat()].map((l) => [l.toLowerCase(), l])).values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return (
    <Sheet title="New task" description="A task is a card on the board with an assignee, a status and a discussion. Everyone in the project's team sees it." trigger={<button className="btn btn-primary"><Plus size={14} aria-hidden /> New task</button>}>
      <ActionForm action={createTaskAction} submitLabel="Create task" pendingLabel="Creating…">
        <input type="hidden" name="goto" value="1" />
        <div className="flex flex-col gap-3">
          {projects.length > 1 && (
            <div><label className="label" htmlFor="nt-project">Project</label>
              <Select id="nt-project" name="projectId" className="select" defaultValue={first}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
          )}
          {projects.length === 1 && <input type="hidden" name="projectId" value={projects[0].id} />}
          <div><label className="label" htmlFor="nt-title">Title</label><input id="nt-title" name="title" className="input" required maxLength={200} autoFocus /></div>
          <div><label className="label" htmlFor="nt-desc">Description</label><textarea id="nt-desc" name="description" className="input min-h-24" rows={4} placeholder="What needs to happen, and how will we know it is done?" /></div>
          <TaskFields people={people}me={me} values={{ assignee: defaultAssignee }} />
        </div>
      </ActionForm>
    </Sheet>
  );
}
