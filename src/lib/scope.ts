import { cookies } from "next/headers";
import type { Db } from "@/lib/db";
import { projectWhere, repoWhere, type Viewer } from "@/lib/authz/viewer";

/**
 * The working scope: Global, one Project, or one Repository. It is remembered in a cookie (a personal preference, never synced) and
 * every list that supports it narrows to it. A scope the viewer can no longer see falls back to Global instead of failing.
 */
export const SCOPE_COOKIE = "mp-scope";
export type Scope = { kind: "all" } | { kind: "project"; id: string; name: string } | { kind: "repo"; id: string; name: string };
export const GLOBAL: Scope = { kind: "all" };

export const scopeKey = (s: Scope) => (s.kind === "all" ? "all" : `${s.kind === "project" ? "p" : "r"}:${s.id}`);
export const scopeLabel = (s: Scope) => (s.kind === "all" ? "Everything" : s.kind === "project" ? `Project ${s.name}` : s.name);

/** Parses "all", "p:<id>" or "r:<id>" and checks the viewer may see it. */
export async function resolveScope(db: Db, v: Viewer, raw: string | undefined | null): Promise<Scope> {
  const m = /^([pr]):([A-Za-z0-9_-]{1,64})$/.exec(raw ?? "");
  if (!m) return GLOBAL;
  if (m[1] === "p") {
    const p = await db.project.findFirst({ where: { AND: [projectWhere(v), { id: m[2] }] }, select: { id: true, name: true } });
    return p ? { kind: "project", id: p.id, name: p.name } : GLOBAL;
  }
  const r = await db.repository.findFirst({ where: { AND: [repoWhere(v), { id: m[2] }] }, select: { id: true, fullName: true } });
  return r ? { kind: "repo", id: r.id, name: r.fullName } : GLOBAL;
}

export async function readScope(db: Db, v: Viewer): Promise<Scope> {
  return resolveScope(db, v, (await cookies()).get(SCOPE_COOKIE)?.value);
}

/** Repository ids a scope narrows to, or undefined for Global. */
export async function scopeRepositoryIds(db: Db, s: Scope): Promise<string[] | undefined> {
  if (s.kind === "all") return undefined;
  if (s.kind === "repo") return [s.id];
  return (await db.projectRepository.findMany({ where: { projectId: s.id }, select: { repositoryId: true } })).map((r) => r.repositoryId);
}
