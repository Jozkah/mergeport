import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/ui/primitives";
import { FolderGit2 } from "@/components/ui/icons";

/** What a person who cannot track repositories is told instead of a button that leads to an admin-only page. */
export const ASK_ADMIN_TO_TRACK = "Ask the owner or an administrator to track a repository, and to give you access to it.";

/** Only owners and administrators choose which repositories enter the workspace. */
export const canConnectRepos = (viewer: { isAdmin: boolean }) => viewer.isAdmin;

/** The "Connect repositories" link, or nothing for someone who may not use the page. */
export function ConnectReposLink({ canConnect, className = "btn btn-primary", children = "Connect repositories" }: { canConnect: boolean; className?: string; children?: ReactNode }) {
  if (!canConnect) return null;
  return <Link href="/repositories/connect" className={className}>{children}</Link>;
}

/** An empty state that offers the connect link to administrators and the plain explanation to everyone else. */
export function ConnectReposEmpty({ canConnect, title, children }: { canConnect: boolean; title: string; children: ReactNode }) {
  return (
    <EmptyState icon={FolderGit2} title={title} action={canConnect ? <ConnectReposLink canConnect /> : undefined}>
      {canConnect ? children : ASK_ADMIN_TO_TRACK}
    </EmptyState>
  );
}
