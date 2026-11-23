import type { Db } from "@/lib/db";
import { projectWhere, repoWhere, type Viewer } from "@/lib/authz/viewer";
import { isHosted } from "@/lib/public-url";
import { connectionState } from "@/lib/github/connection-state";
import { planningWhere } from "./queries";
import type { Step } from "@/components/onboarding/GettingStarted";

/** What the guide shows, computed from what the person already has: a step ticks itself once it is true. */
export async function gettingStarted(db: Db, v: Viewer): Promise<Step[]> {
  const hosted = isHosted();
  const [repos, projects, tasks, rules, people, github] = await Promise.all([
    db.repository.count({ where: repoWhere(v) }),
    db.project.count({ where: { workspaceId: v.workspaceId, ...projectWhere(v) } }),
    db.planningItem.count({ where: await planningWhere(db, v) }),
    db.reviewRule.count({ where: { workspaceId: v.workspaceId } }),
    db.member.count({ where: { workspaceId: v.workspaceId, status: "ACTIVE" } }),
    hosted ? connectionState(db, v.workspaceId) : Promise.resolve("ok" as const),
  ]);
  const ask = "Ask the owner or an administrator.";
  return [
    hosted
      ? { key: "repos", title: "Connect GitHub", why: github === "none" ? "Connect the GitHub account your repositories live on. Mergeport only reads from it, and you prove on GitHub that you control it." : "GitHub was suspended or removed for this workspace. Open GitHub settings to fix it.", href: "/settings/github", cta: github === "none" ? "Connect GitHub" : "Open GitHub settings", done: github === "ok", optional: true, locked: v.isAdmin ? undefined : "Ask the owner or an administrator to connect GitHub." }
      : { key: "repos", title: "Connect your repositories", why: "Pick the repositories you work in. Mergeport only reads them with your own GitHub sign-in.", href: "/repositories/connect", cta: "Choose repositories", done: repos > 0 },
    { key: "project", title: "Group them into a project", why: "A project is a set of repositories you plan together, like “Website” or “Mobile app”.", href: "/admin/projects", cta: "Create a project", done: projects > 0, locked: v.isAdmin ? undefined : "The owner or an administrator creates projects. Ask them to add you to one." },
    { key: "task", title: "Add your first task", why: "Write down something to do, give it to someone, and move it across the board as it progresses.", href: "/tasks", cta: "Create a task", done: tasks > 0, locked: projects === 0 ? "Create a project first." : undefined },
    { key: "team", title: "Invite your teammates", why: "Invite people by email and choose what each can do: owner, admin, member or reader.", href: "/settings/members", cta: "Invite people", done: people > 1, optional: true, locked: v.isAdmin ? undefined : ask },
    { key: "rules", title: "Say who reviews what", why: "Tell Mergeport who must review which pull requests, so “Needs my review” is accurate.", href: "/admin/rules", cta: "Add a rule", done: rules > 0, optional: true, locked: v.isAdmin ? undefined : "The owner or an administrator sets this up." },
  ];
}
