import type { Db } from "@/lib/db";
import type { Viewer } from "@/lib/authz/viewer";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { ENTITY_TYPES } from "@/lib/sync/entities";

/**
 * What sharing a coordination space would let a person read, stated before anyone is invited.
 *
 * A coordination repository is an audience boundary: everyone who can read it can read every file AND its whole commit history,
 * whatever the interface shows. So the preview lists what is stored (repository identities, projects, tasks, comments), how much
 * history exists, and reminds that access to the SOURCE repositories is a separate GitHub permission checked separately.
 */
export type SpaceContents = {
  space: { id: string; name: string; fullName: string; kind: string };
  repositories: { fullName: string; visibility: string }[];
  projects: { name: string; cards: number }[];
  tasks: { total: number; titles: string[] };
  counts: Record<string, number>;
  /** Earlier versions of these records that stay readable in the repository's history. */
  history: { versionsKept: number; note: string };
};

const LABEL: Record<string, string> = { repo: "repositories", project: "projects", milestone: "milestones", epic: "epics", iteration: "iterations", card: "cards and tasks", board: "boards", taskcomment: "task comments", checkitem: "checklist items", rule: "review rules", waitrule: "waiting rules", forkmap: "fork mappings", triage: "upstream triage decisions", waiting: "manual waiting records", view: "shared views", availability: "availability records", labelmap: "label mappings", upstreamsub: "upstream subscriptions", backport: "backport records", planevent: "planning history events" };

export async function spaceContents(db: Db, v: Viewer, spaceId: string): Promise<SpaceContents> {
  if (!v.isAdmin) throw new ValidationError("Only an administrator can preview what a space shares");
  const space = await db.space.findUnique({ where: { id: spaceId } });
  if (!space) throw new NotFoundError();
  const team = await db.teamConfig.findUnique({ where: { id: "team" } });
  const counts: Record<string, number> = {};
  const repos: { fullName: string; visibility: string }[] = [];
  const projectNames = new Map<string, string>();
  const cardsBy = new Map<string, number>();
  const titles: string[] = [];
  let tasks = 0;
  for (const def of ENTITY_TYPES) {
    const rows = (await def.list(db, { commonSpaceId: team?.commonSpaceId ?? null })).filter((r) => r.spaceId === spaceId);
    if (rows.length === 0) continue;
    counts[LABEL[def.type] ?? def.type] = rows.length;
    for (const r of rows) {
      const d = r.data as Record<string, unknown>;
      if (def.type === "repo") repos.push({ fullName: String(d.fullName), visibility: String(d.visibility) });
      else if (def.type === "project") projectNames.set(r.id, String(d.name));
      else if (def.type === "card") {
        cardsBy.set(String(d.projectId), (cardsBy.get(String(d.projectId)) ?? 0) + 1);
        if (d.workRepoGithubId === null || d.workRepoGithubId === undefined) {
          tasks++;
          if (titles.length < 40) titles.push(String(d.title));
        }
      }
    }
  }
  const known = await db.syncEntity.findMany({ where: { spaceId }, select: { baseVersion: true } });
  const versions = known.reduce((n, k) => n + Math.max(0, k.baseVersion - 1), 0);
  return {
    space: { id: space.id, name: space.name, fullName: `${space.repoOwner}/${space.repoName}`, kind: space.kind },
    repositories: repos.sort((a, b) => a.fullName.localeCompare(b.fullName)),
    projects: [...projectNames].map(([id, name]) => ({ name, cards: cardsBy.get(id) ?? 0 })).sort((a, b) => a.name.localeCompare(b.name)),
    tasks: { total: tasks, titles },
    counts,
    history: { versionsKept: versions, note: "Every earlier version of every record, and every commit message (including who made it), stays readable to anyone who can read this repository." },
  };
}

export type SourcePermission = "admin" | "write" | "read" | "none" | "unknown";
export type PersonPreview = {
  login: string;
  coordination: { level: "read" | "write"; will: string };
  /** Whether this person's own GitHub account can open each source repository the space names. Separate from the invitation. */
  source: { repo: string; permission: SourcePermission }[];
  missing: string[];
};

export type AccessPreview = { contents: SpaceContents; people: PersonPreview[]; notes: string[] };

/** `check` asks GitHub (as the acting person) what a login may do on a repository. Anything it cannot answer is "unknown", never "none". */
export async function accessPreview(db: Db, v: Viewer, input: { spaceId: string; logins: string[]; permission: "pull" | "push" }, check: (repoFullName: string, login: string) => Promise<SourcePermission>): Promise<AccessPreview> {
  const contents = await spaceContents(db, v, input.spaceId);
  const logins = [...new Set(input.logins.map((l) => l.trim().replace(/^@/, "")).filter(Boolean))].slice(0, 10);
  if (logins.length === 0) throw new ValidationError("Name at least one GitHub username");
  const repos = contents.repositories.slice(0, 25);
  const people: PersonPreview[] = [];
  for (const login of logins) {
    const source: PersonPreview["source"] = [];
    for (const r of repos) source.push({ repo: r.fullName, permission: await check(r.fullName, login).catch(() => "unknown" as const) });
    people.push({
      login,
      coordination: { level: input.permission === "push" ? "write" : "read", will: input.permission === "push" ? "can read everything listed here and its history, and change shared records" : "can read everything listed here and its history" },
      source,
      missing: source.filter((s) => s.permission === "none").map((s) => s.repo),
    });
  }
  return {
    contents,
    people,
    notes: [
      "Hiding something in the screens would not hide it from a person who can open the coordination repository on GitHub. Share only what this audience should see.",
      "Access to the source repositories is a separate permission. People shown as having none will see the shared records but not be able to open the code or issues.",
      ...(contents.repositories.length > repos.length ? [`Source access was checked for the first ${repos.length} of ${contents.repositories.length} repositories.`] : []),
    ],
  };
}
