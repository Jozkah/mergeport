import { cache } from "react";
import { db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { resolveScope, scopeRepositoryIds } from "@/lib/scope";
import { attention } from "./queries";

/**
 * Per-request memo (React cache): layout and page share one attention computation for the same Viewer object and scope key
 * ("all", "p:<project>" or "r:<repository>"). A project scope also gives the rules their project context.
 */
export const attentionFor = cache(async (v: Viewer, key: string = "all") => {
  const scope = await resolveScope(db, v, key);
  return attention(db, v, { projectId: scope.kind === "project" ? scope.id : null, repositoryIds: await scopeRepositoryIds(db, scope) });
});
