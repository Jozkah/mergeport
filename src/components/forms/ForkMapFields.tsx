"use client";

import { Select } from "@/components/ui/Select";
import { useState } from "react";

type Fork = { id: string; fullName: string; parentGithubId: string | null; parentFullName: string | null };
type Repo = { id: string; githubId: string; fullName: string };

/**
 * The fork and upstream pickers. The upstream list puts the fork's real parent (from GitHub's own metadata) first, leaves the
 * fork itself out, and says so when the parent is not tracked yet, instead of offering every repository in one long list.
 */
export function ForkMapFields({ forks, repos }: { forks: Fork[]; repos: Repo[] }) {
  const [forkId, setForkId] = useState(forks[0]?.id ?? "");
  const fork = forks.find((f) => f.id === forkId);
  const suggested = repos.filter((r) => fork?.parentGithubId && r.githubId === fork.parentGithubId);
  const others = repos.filter((r) => r.id !== forkId && !suggested.some((s) => s.id === r.id));
  const parentMissing = fork?.parentGithubId && suggested.length === 0;
  return (
    <>
      <div>
        <label className="label" htmlFor="mf-fork">Fork</label>
        <Select id="mf-fork" name="forkRepoId" className="select" value={forkId} onChange={(e) => setForkId(e.target.value)}>
          {forks.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}
        </Select>
      </div>
      <div key={forkId}>
        <label className="label" htmlFor="mf-up">Upstream</label>
        <Select id="mf-up" name="upstreamRepoId" className="select" defaultValue={suggested[0]?.id}>
          {suggested.length > 0 && <optgroup label="This fork's parent on GitHub">{suggested.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}</optgroup>}
          <optgroup label={suggested.length > 0 ? "Other tracked repositories" : "Tracked repositories"}>{others.map((r) => <option key={r.id} value={r.id}>{r.fullName}</option>)}</optgroup>
        </Select>
        {parentMissing && <p className="mt-1 text-[11.5px] text-ink-3">Its parent{fork?.parentFullName ? ` (${fork.parentFullName})` : ""} is not tracked yet. Track it on Repositories (a public one can be added by URL), then map it here.</p>}
      </div>
    </>
  );
}
