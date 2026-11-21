"use client";

import { useRef } from "react";
import { useFormStatus } from "react-dom";
import { switchWorkspaceAction } from "@/app/account-actions";
import { LoaderCircle } from "@/components/ui/icons";
import { Select } from "@/components/ui/Select";

function Field({ workspaces, active }: { workspaces: { id: string; name: string }[]; active: string }) {
  const { pending } = useFormStatus();
  return (
    <>
      <Select aria-label="Workspace" aria-busy={pending} name="workspaceId" defaultValue={active} autoSubmit disabled={pending} className="select min-w-0 flex-1 text-[12.5px] sm:w-[11rem] sm:flex-none">
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </Select>
      {pending ? <LoaderCircle size={14} aria-hidden className="shrink-0 animate-spin text-ink-3 motion-reduce:animate-none" /> : null}
    </>
  );
}

/** Hosted accounts with several workspaces. Choosing one switches at once (the server checks the id against the person's ACTIVE memberships). A refused switch puts the picker back on the workspace that is actually active. */
export function AccountWorkspaceSwitcher({ workspaces, active, className = "" }: { workspaces: { id: string; name: string }[]; active: string; className?: string }) {
  const form = useRef<HTMLFormElement>(null);
  return (
    <form
      ref={form}
      action={async (fd) => {
        try {
          await switchWorkspaceAction(fd);
        } catch (e) {
          form.current?.reset();
          throw e;
        }
      }}
      className={`flex items-center gap-1.5 ${className}`}
    >
      <Field workspaces={workspaces} active={active} />
    </form>
  );
}
