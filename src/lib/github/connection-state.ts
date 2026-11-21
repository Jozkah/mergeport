import type { Db } from "@/lib/db";
import { workspaceGithubStatus, type ConnectionState } from "./status";

export type { ConnectionState };

/** The banner/Get started word for a workspace. Derived from `workspaceGithubStatus`, the single source of truth. */
export async function connectionState(db: Db, workspaceId: string): Promise<ConnectionState> {
  return (await workspaceGithubStatus(db, workspaceId)).state;
}
