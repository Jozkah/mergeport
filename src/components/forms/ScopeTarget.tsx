"use client";

import { useState, type ReactNode } from "react";
import { Select } from "@/components/ui/Select";

type Scope = "REPOSITORY" | "PROJECT" | "OWNER" | "WORKSPACE";

/**
 * "Applies to" plus only the one target field that scope needs. The field names (scope, repositoryId, projectId, ownerLogin)
 * are the ones the server actions already read, so they receive the same FormData; the other targets are simply not sent.
 */
export function ScopeTarget({ prefix, scopes, defaultScope, repos, projects, ownerPlaceholder }: {
  prefix: string;
  scopes: { value: Scope; label: string }[];
  defaultScope: Scope;
  repos: { id: string; fullName: string }[];
  projects: { id: string; name: string }[];
  ownerPlaceholder?: string;
}): ReactNode {
  const [scope, setScope] = useState<Scope>(defaultScope);
  return (
    <>
      <div>
        <label className="label" htmlFor={`${prefix}-scope`}>Applies to</label>
        <Select id={`${prefix}-scope`} name="scope" className="select" value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
          {scopes.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
      </div>
      {scope === "REPOSITORY" && (
        <div><label className="label" htmlFor={`${prefix}-repo`}>Repository</label><Select id={`${prefix}-repo`} name="repositoryId" className="select"><option value="">-</option>{repos.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}</Select></div>
      )}
      {scope === "PROJECT" && (
        <div><label className="label" htmlFor={`${prefix}-proj`}>Project</label><Select id={`${prefix}-proj`} name="projectId" className="select"><option value="">-</option>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</Select></div>
      )}
      {scope === "OWNER" && (
        <div><label className="label" htmlFor={`${prefix}-owner`}>GitHub owner</label><input id={`${prefix}-owner`} name="ownerLogin" className="input" placeholder={ownerPlaceholder} /></div>
      )}
    </>
  );
}
