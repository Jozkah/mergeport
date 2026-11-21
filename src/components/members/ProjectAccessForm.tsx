"use client";

import { useState } from "react";
import { ActionForm } from "@/components/forms/ActionForm";
import { ConfirmSheet } from "@/components/forms/ConfirmSheet";
import { Select } from "@/components/ui/Select";
import type { ActionResult } from "@/lib/action-result";

/**
 * Who can see a project (hosted). Moving a project OUT of a restricted space shows it, its cards and its search results to
 * everyone in the workspace, so that one change goes through a confirmation sheet; any other change saves directly.
 */
export function ProjectAccessForm({ projectId, current, spaces, action }: { projectId: string; current: string; spaces: { id: string; name: string }[]; action: (fd: FormData) => Promise<ActionResult> }) {
  const [choice, setChoice] = useState(current);
  const toEveryone = choice === "" && current !== "";
  const id = `ac-${projectId}`;
  const select = (
    <>
      <label className="label" htmlFor={id}>Who can see this project</label>
      <Select id={id} value={choice} onChange={(e) => setChoice(e.target.value)} className="select">
        <option value="">Everyone in the workspace</option>
        {spaces.map((sp) => <option key={sp.id} value={sp.id}>{sp.name} (restricted)</option>)}
      </Select>
      <p className="mt-1 text-[12px] text-ink-3">A restricted space is seen only by the people listed in it, and you must be one of them to move a project into or out of it. Manage spaces in Members.</p>
    </>
  );
  return (
    <div className="max-w-md">
      {select}
      {toEveryone ? (
        <div className="mt-3">
          <ConfirmSheet
            title="Show this project to everyone?"
            consequence="Everyone in the workspace will see this project, its cards and its search results, including people outside the restricted space it comes from."
            action={action}
            submitLabel="Show to everyone"
            pendingLabel="Saving…"
            danger={false}
            trigger={<button type="button" className="btn btn-primary">Save access</button>}
          >
            <input type="hidden" name="projectId" value={projectId} />
            <input type="hidden" name="spaceId" value="" />
          </ConfirmSheet>
        </div>
      ) : (
        <ActionForm action={action} submitLabel="Save access" pendingLabel="Saving…" resetOnSuccess={false} submitDisabled={choice === current} submitDisabledReason="Choose a different space first.">
          <input type="hidden" name="projectId" value={projectId} />
          <input type="hidden" name="spaceId" value={choice} />
        </ActionForm>
      )}
    </div>
  );
}
