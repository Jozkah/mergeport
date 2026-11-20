import { switchWorkspaceAction } from "@/app/account-actions";

/** Hosted accounts with several workspaces. A plain form: the server checks the chosen id against the person's ACTIVE memberships. */
export function AccountWorkspaceSwitcher({ workspaces, active, className = "" }: { workspaces: { id: string; name: string }[]; active: string; className?: string }) {
  return (
    <form action={switchWorkspaceAction} className={`flex items-center gap-1.5 ${className}`}>
      <select aria-label="Workspace" name="workspaceId" defaultValue={active} className="select !h-8 !py-0 min-w-0 flex-1 text-[12.5px] sm:w-[11rem] sm:flex-none">
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>{w.name}</option>
        ))}
      </select>
      <button className="btn !h-8 text-[12.5px]">Switch</button>
    </form>
  );
}
