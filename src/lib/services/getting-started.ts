import type { Db } from "@/lib/db";
import { projectWhere, repoWhere, type Viewer } from "@/lib/authz/viewer";
import type { Step } from "@/components/onboarding/GettingStarted";

/** What the guide shows, computed from what the person already has: a step ticks itself once it is true. */
export async function gettingStarted(db: Db, v: Viewer): Promise<Step[]> {
  const [repos, projects, tasks, rules, team] = await Promise.all([
    db.repository.count({ where: repoWhere(v) }),
    db.project.count({ where: { workspaceId: v.workspaceId, ...projectWhere(v) } }),
    db.planningItem.count({ where: { project: { workspaceId: v.workspaceId } } }),
    db.reviewRule.count(),
    db.teamConfig.findUnique({ where: { id: "team" } }),
  ]);
  return [
    { key: "repos", title: "Connect your repositories", why: "Pick the repositories you work in. Mergeport only reads them with your own GitHub sign-in.", href: "/repositories/connect", cta: "Choose repositories", done: repos > 0 },
    { key: "project", title: "Group them into a project", why: "A project is a set of repositories you plan together, like “Website” or “Mobile app”.", href: "/admin/projects", cta: "Create a project", done: projects > 0, locked: v.isAdmin ? undefined : "An administrator creates projects. Ask them to add you to one." },
    { key: "task", title: "Add your first task", why: "Write down something to do, give it to someone, and move it across the board as it progresses.", href: "/tasks", cta: "Create a task", done: tasks > 0, locked: projects === 0 ? "Create a project first." : undefined },
    { key: "team", title: "Invite your teammates", why: "Share your projects and tasks with people through a private GitHub repository. Nobody runs a server.", href: "/team", cta: "Set up a team", done: !!team && team.mode === "TEAM", optional: true },
    { key: "rules", title: "Say who reviews what", why: "Tell Mergeport who must review which pull requests, so “Needs my review” is accurate.", href: "/admin/rules", cta: "Add a rule", done: rules > 0, optional: true, locked: v.isAdmin ? undefined : "An administrator sets this up." },
  ];
}
