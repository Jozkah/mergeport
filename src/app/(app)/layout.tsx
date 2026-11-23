import { processStartedAt } from "@/lib/local/boot";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth/current";
import { activeWorkspaces } from "@/lib/auth/workspaces";
import { GithubConnectionBanner } from "@/components/shell/GithubConnectionBanner";
import { HideOnPath } from "@/components/shell/HideOnPath";
import { connectionState } from "@/lib/github/connection-state";
import { can } from "@/lib/authz/roles";
import { isHosted } from "@/lib/public-url";
import { projectWhere, repoWhere } from "@/lib/authz/viewer";
import { readScope, scopeKey } from "@/lib/scope";
import { Suspense } from "react";
import { CommandPalette } from "@/components/shell/CommandPalette";
import { TaskDrawer } from "@/components/planning/TaskDrawer";
import { Shortcuts } from "@/components/shell/Shortcuts";
import { DesktopNotifier } from "@/components/shell/DesktopNotifier";
import { ScopePicker } from "@/components/shell/ScopePicker";
import { inbox } from "@/lib/services/inbox";
import { unreadDigestCount } from "@/lib/services/digest";
import { attentionFor } from "@/lib/services/request-cache";
import { planningWhere, unreadNotificationCount } from "@/lib/services/queries";
import { formatInstant } from "@/lib/format";
import { MobileNav, Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";
import { AiQuick } from "@/components/ai/AiQuick";
import { GlowManager } from "@/components/ai/GlowManager";
import { getAiView } from "@/lib/services/ai";
import { pendingCount } from "@/lib/services/ai-approvals";
import { LiveRefresh } from "@/components/sync/LiveRefresh";
import { SectionMain } from "@/components/shell/SectionMain";
import { ContextMenuProvider } from "@/components/ui/ContextMenu";
import { SpotlightProvider } from "@/components/ui/SpotlightProvider";
import { SyncAnnouncer } from "@/components/sync/SyncAnnouncer";
import { ToastProvider } from "@/components/ui/ToastProvider";
import { TooltipProvider } from "@/components/ui/Tooltip";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";
import { deriveSourceStatus } from "@/lib/sync/source-status";
import { isDemo } from "@/lib/env";
import { federationState } from "@/lib/federation/config";
import { cookies } from "next/headers";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { viewer, user } = await requireViewer();
  const scope = await readScope(db, viewer);
  const [q, unread, ws, lastSync, demoRepos, scopeProjects, scopeRepos] = await Promise.all([
    attentionFor(viewer, scopeKey(scope)),
    unreadNotificationCount(db, viewer),
    db.workspace.findUniqueOrThrow({ where: { id: viewer.workspaceId } }),
    db.repository.aggregate({ where: repoWhere(viewer), _max: { lastSyncedAt: true } }),
    db.repository.count({ where: { ...repoWhere(viewer), isDemo: true } }),
    db.project.findMany({ where: projectWhere(viewer), select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200 }),
    db.repository.findMany({ where: repoWhere(viewer), select: { id: true, fullName: true }, orderBy: { fullName: "asc" }, take: 300 }),
  ]);
  // What the AI has waiting for you: suggested tasks, and requests from AI apps to approve. Shown on the sidebar row and the top-bar button.
  const [aiSuggestions, aiRequests] = isDemo() ? [0, 0] : await Promise.all([db.aiSuggestion.count({ where: { workspaceId: viewer.workspaceId, state: "NEW" } }), pendingCount(db, viewer)]);
  const counts = {
    needsMyReview: q.needsMyReview.length,
    needsTeam: q.needsTeamReview.length,
    waiting: q.waitingExternal.length,
    changes: q.changesRequested.length,
    blocked: q.blocked.length,
    inbox: (await inbox(db, viewer, { queues: q })).unread,
    digest: await unreadDigestCount(db, viewer),
    ai: aiSuggestions + aiRequests,
    linked: federationState().kind === "enabled",
    hosted: isHosted(),
    tasks: await db.planningItem.count({ where: { AND: [await planningWhere(db, viewer), { assigneeLogin: viewer.login.toLowerCase(), column: { key: { not: "done" } } }] } }),
  };
  const last = lastSync._max.lastSyncedAt;
  const githubState = isHosted() ? await connectionState(db, viewer.workspaceId) : "ok";
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  // Refreshing tracked source repositories.
  // A job still marked RUNNING by a process that died is not work in progress; it is reclaimed on a timer.
  const bootAt = processStartedAt();
  const own = { isDemo: false, trackingStatus: { not: "REMOVED" as const } };
  const [tracked, running, queued, refused, rateLimited, failed, neverSynced] = await Promise.all([
    db.repository.count({ where: { AND: [repoWhere(viewer), own] } }),
    db.job.count({ where: { workspaceId: viewer.workspaceId, type: "sync.repository", status: "RUNNING", lockedAt: { gte: bootAt } } }),
    db.job.count({ where: { workspaceId: viewer.workspaceId, type: "sync.repository", status: "QUEUED" } }),
    db.repository.count({ where: { AND: [repoWhere(viewer), own], trackingStatus: "DISCONNECTED" } }),
    db.repository.count({ where: { AND: [repoWhere(viewer), own], rateLimited: true } }),
    db.repository.count({ where: { AND: [repoWhere(viewer), own], trackingStatus: "ACTIVE", rateLimited: false, syncError: { not: null } } }),
    db.repository.count({ where: { AND: [repoWhere(viewer), own], lastSyncedAt: null } }),
  ]);
  const source = deriveSourceStatus({ tracked, running, queued, refused, rateLimited, failed, neverSynced });
  const sync = source ? { state: source.state, pending: 0, conflicts: 0, detail: source.detail, scope: "source" as const } : null;
  const hosted = isHosted();
  const mine = hosted ? await activeWorkspaces(db, user.id) : [];
  const accountSwitcher = mine.length > 1 ? { workspaces: mine, active: viewer.workspaceId } : null;
  const aiQuick = isDemo() || !(await getAiView(db, viewer.workspaceId)).saved ? null : <AiQuick suggestions={aiSuggestions} requests={aiRequests} />;
  const navProps = { counts, isAdmin: viewer.isAdmin, user: { login: user.login, name: user.name, avatarUrl: user.avatarUrl }, workspace: ws.name };
  return (
    <TooltipProvider>
    <ToastProvider>
    {/* First stop for the keyboard: past the sidebar and top bar, straight to the page. */}
    <a href="#main" className="btn btn-primary sr-only focus-visible:not-sr-only focus-visible:fixed focus-visible:left-3 focus-visible:top-3 focus-visible:z-[80]">Skip to content</a>
    <div className="mx-auto flex min-h-dvh max-w-[3200px]">
      <LiveRefresh />
      <GlowManager />
      <ContextMenuProvider />
      <SpotlightProvider />
      <SyncAnnouncer state={sync?.state ?? null} hosted={hosted} />
      <Suspense fallback={<aside className="hidden w-[250px] shrink-0 lg:block" />}>
        <Sidebar {...navProps} />
      </Suspense>
      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<div className="h-14" />}>
          <DesktopNotifier />
          <Shortcuts />
          <Suspense fallback={null}><TaskDrawer /><CommandPalette projects={scopeProjects} repos={scopeRepos.map((r) => ({ id: r.id, name: r.fullName }))} /></Suspense>
          <Topbar aiQuick={aiQuick} accountSwitcher={hosted ? accountSwitcher : undefined} scopePicker={<ScopePicker value={scopeKey(scope)} projects={scopeProjects} repos={scopeRepos.map((r) => ({ id: r.id, name: r.fullName }))} />} unread={unread} theme={theme} sync={sync} hosted={hosted} menu={<MobileNav {...navProps} />} syncNote={last ? `Last refresh ${formatInstant(last, viewer.timezone)}` : "Not refreshed yet"} />
        </Suspense>
        {isHosted() && githubState !== "ok" && (
          // The Settings > GitHub page explains the state itself and has the actions, so the banner would only repeat it there.
          <HideOnPath path="/settings/github">
            <div className="px-4 pt-3 lg:px-6">
              <GithubConnectionBanner state={githubState} manage={can(viewer, "manageGithub")} />
            </div>
          </HideOnPath>
        )}
        {demoRepos > 0 && (
          <div className="border-b border-line bg-subtle px-4 py-1.5 text-[12px] text-ink-2 lg:px-6" role="note">
            Demo mode: {demoRepos} repositor{demoRepos === 1 ? "y" : "ies"} hold synthetic data. Actions change the demo database only; nothing is sent to GitHub.
          </div>
        )}
        <SectionMain>{children}</SectionMain>
      </div>
    </div>
    </ToastProvider>
    </TooltipProvider>
  );
}
