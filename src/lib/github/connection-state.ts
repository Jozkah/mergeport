import type { Db } from "@/lib/db";

export type ConnectionState = "none" | "ok" | "suspended" | "removed";

/**
 * One word for the app layout banner and the Get started card: is any GitHub account usable in this workspace?
 * `ok` when at least one connected installation is active; otherwise the state of the connections that exist
 * (`suspended` if any is suspended, `removed` if all are removed), or `none` when nothing is connected.
 */
export async function connectionState(db: Db, workspaceId: string): Promise<ConnectionState> {
  const rows = await db.workspaceInstallation.findMany({ where: { workspaceId }, select: { installation: { select: { suspendedAt: true, deletedAt: true } } }, take: 50 });
  if (rows.length === 0) return "none";
  if (rows.some((r) => !r.installation.suspendedAt && !r.installation.deletedAt)) return "ok";
  return rows.some((r) => !r.installation.deletedAt) ? "suspended" : "removed";
}
