import { Select } from "@/components/ui/Select";
import { cookies } from "next/headers";
import { requireViewer } from "@/lib/authz-page";
import { isDemo } from "@/lib/env";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";
import { ActionForm } from "@/components/forms/ActionForm";
import { ConfirmSheet } from "@/components/forms/ConfirmSheet";
import { ThemeSelect } from "@/components/shell/ThemeControls";
import { PageHeader, Panel } from "@/components/ui/primitives";
import { LogOut, Settings } from "@/components/ui/icons";
import { setTimezoneAction } from "@/app/actions";
import { signOutEverywhereFormAction } from "@/app/account-actions";
import { saveDigestSettingsAction } from "@/app/digest-actions";
import { db } from "@/lib/db";
import { Bell, Building2, Globe, Newspaper, Users, Wand2 } from "@/components/ui/icons";
import { listWorkspaceInstallations } from "@/lib/github/binding";
import { isHosted, publicOrigin } from "@/lib/public-url";
import { ConnectAiPanel, type ConnectAiView } from "@/components/settings/ConnectAiPanel";
import { listApiTokens } from "@/lib/services/api-tokens";
import { listGrants } from "@/lib/services/oauth";
import { can } from "@/lib/authz/roles";
import { subjectOf } from "@/lib/authz/viewer";
import { federationState } from "@/lib/federation/config";
import Link from "next/link";
import { RoleChip } from "@/components/ui/identity";
import { BackupPanel } from "@/components/settings/BackupPanel";
import { NotificationSettings } from "@/components/settings/NotificationSettings";
import { getPrefs } from "@/lib/services/notification-prefs";
import { AiSettingsPanel } from "@/components/settings/AiSettingsPanel";
import { getAiView } from "@/lib/services/ai";
import { GithubAccountPanel } from "@/components/settings/GithubAccountPanel";
import { githubAppConfigured } from "@/lib/github/app-config";
import { LINK_MESSAGES, isLinkResult } from "@/lib/github/link-messages";
import { userTokenKey } from "@/lib/github/user-token";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ githublink?: string | string[] }> }) {
  const { viewer, user } = await requireViewer();
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const hosted = isHosted(); // false only for the demo (a loopback run on synthetic data)
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
  const sp = await searchParams;
  const prefs = await getPrefs(db, user.id);
  const ai = isDemo() ? null : await getAiView(db, viewer.workspaceId);
  // Counts for the panel summaries (not in the demo).
  const memberCount = hosted ? await db.member.count({ where: { workspaceId: viewer.workspaceId, status: "ACTIVE" } }) : 0;
  const linkCount = hosted && viewer.isAdmin ? await db.federationLink.count({ where: { workspaceId: viewer.workspaceId, status: "ACTIVE" } }) : 0;
  const ghInstalls = hosted && !isDemo() ? await listWorkspaceInstallations(db, viewer.workspaceId) : [];
  const ghActive = ghInstalls.filter((i) => i.status === "active").length;
  // The person's own GitHub link (hosted). The result code from the callback is looked up in a fixed table, never shown as given.
  const tokenRow = hosted && !isDemo() ? await db.githubUserToken.findUnique({ where: { userId: user.id }, select: { status: true, accessCheckedAt: true, accessTruncated: true } }) : null;
  const linkCode = Array.isArray(sp.githublink) ? sp.githublink[0] : sp.githublink;
  // Connect AI (hosted): personal access tokens for the MCP endpoint, docs/mcp.md.
  const origin = publicOrigin();
  const connectAi: ConnectAiView | null = hosted && !isDemo() && origin ? { connectorUrl: `${origin.origin}/api/mcp`, canWrite: can(subjectOf(viewer), "write"), admin: viewer.isAdmin, tokens: await listApiTokens(db, viewer), apps: await listGrants(db, viewer) } : null;
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle={`Signed in as ${user.email ?? `@${user.login}`}${viewer.isAdmin ? " (administrator of this workspace)" : ""}.`}
        help={<>The daily digest uses your timezone ({user.timezone}) and shows in the bell and on Overview.</>}
      />
      <div className="fit-grid" style={{ "--fit-min": "520px" } as React.CSSProperties}>
        <Panel title="Display" icon={Settings} id="display">
          <div className="grid gap-5 p-4">
            <ThemeSelect initial={theme} />
            <ActionForm action={setTimezoneAction} submitLabel="Save timezone" resetOnSuccess={false} requireDirty>
              <label className="label" htmlFor="tz">Timezone</label>
              <Select id="tz" name="timezone" defaultValue={user.timezone} className="select max-w-sm">{[...new Set(["UTC", user.timezone, ...zones])].map((z) => <option key={z} value={z}>{z}</option>)}</Select>
              <p className="mt-1 text-[12px] text-ink-3">Due and milestone dates are calendar dates and are not shifted.</p>
            </ActionForm>
          </div>
        </Panel>
        {hosted && !isDemo() && (
          <Panel title={<>Workspace members (<span className="tnum">{memberCount}</span>)</>} icon={Users} id="members" summary={`${memberCount} member${memberCount === 1 ? "" : "s"}`}>
            <div className="p-4 text-[13px]">
              <p className="flex flex-wrap items-center gap-2">Your role: <RoleChip role={viewer.role} /></p>
              <p className="mt-2">{viewer.isAdmin ? "Invite people by email, change roles and control who sees which space." : "You can leave the workspace from the members page."}</p>
              <Link href="/settings/members" className="btn mt-3">Open members</Link>
            </div>
          </Panel>
        )}
        {hosted && !isDemo() && (
          <Panel title={<>GitHub (<span className="tnum">{ghActive}</span>)</>} icon={Building2} id="github" summary={ghInstalls.length === 0 ? "Not connected" : `${ghActive} of ${ghInstalls.length} active`}>
            <div className="p-4 text-[13px]">
              <p>{ghInstalls.length === 0 ? "GitHub is not connected, so repository sync and GitHub actions are off." : <><span className="tnum">{ghActive}</span> of <span className="tnum">{ghInstalls.length}</span> connected GitHub account{ghInstalls.length === 1 ? " is" : "s are"} active.</>}</p>
              <p className="mt-2 text-ink-3">{viewer.isAdmin ? "Connect a GitHub account, or disconnect one. You prove on GitHub that you control it." : "Only the owner and administrators can connect or disconnect GitHub."}</p>
              <Link href="/settings/github" className="btn mt-3">{viewer.isAdmin ? "Open GitHub settings" : "See status"}</Link>
            </div>
          </Panel>
        )}
        {connectAi && <ConnectAiPanel view={connectAi} now={new Date()} />}
        {hosted && viewer.isAdmin && federationState().kind !== "absent" && (
          <Panel title={<>Linked instances (<span className="tnum">{linkCount}</span>)</>} icon={Globe} id="linked-instances" summary={`${linkCount} link${linkCount === 1 ? "" : "s"}`}>
            <div className="p-4 text-[13px]">
              <p>Decide whether people here may link other Mergeport instances (read-only), which instances may link to this workspace, and revoke what is linked.</p>
              <Link href="/settings/linked" className="btn mt-3">Open linked instances</Link>
            </div>
          </Panel>
        )}
        {hosted && !isDemo() && (
          <GithubAccountPanel
            view={{ available: githubAppConfigured() && userTokenKey() !== null, link: tokenRow ? { login: user.githubLogin, state: tokenRow.status === "OK" ? "ok" : "relink", checkedAt: tokenRow.accessCheckedAt, truncated: tokenRow.accessTruncated } : null, timezone: user.timezone }}
            result={isLinkResult(linkCode) ? LINK_MESSAGES[linkCode] : null}
          />
        )}
        {hosted && (
          <Panel title="Account" icon={LogOut} id="account">
            <div className="p-4 text-[13px]">
              <p>Signed in as <bdi className="break-all font-medium">{user.email ?? `@${user.login}`}</bdi>. The sign-out button in the top bar ends this browser only.</p>
              <div className="mt-3">
                <ConfirmSheet
                  title="Sign out everywhere?"
                  consequence="Every browser and device signed in as you is signed out now, including this one. You will need a new sign-in link to come back."
                  action={signOutEverywhereFormAction}
                  submitLabel="Sign out everywhere"
                  pendingLabel="Signing out…"
                  trigger={<button type="button" className="btn text-blocked">Sign out everywhere</button>}
                />
              </div>
            </div>
          </Panel>
        )}
        <Panel title="Notifications" icon={Bell} id="notifications">
          <NotificationSettings initial={prefs} hosted={hosted} />
        </Panel>
        <Panel title="Daily digest" icon={Newspaper} id="digest">
          <div className="p-4">
            <ActionForm action={saveDigestSettingsAction} submitLabel="Save" resetOnSuccess={false} className="max-w-md">
              <label className="-my-2 flex min-h-10 w-fit cursor-pointer items-center gap-2 text-[13px]"><input type="checkbox" name="enabled" defaultChecked={prefs.digest.enabled} /> Make a digest of the previous day each day</label>
              <label className="label mt-3" htmlFor="digest-hour">Make it after (hour, 0 to 23)</label>
              <input id="digest-hour" name="hour" type="number" inputMode="numeric" min={0} max={23} step={1} defaultValue={prefs.digest.hour} aria-describedby="digest-hour-help" className="input tnum max-w-[8rem]" />
              <p id="digest-hour-help" className="mt-1 max-w-[60ch] text-[12px] text-ink-3 text-pretty">Local time. Made on next open if Mergeport was closed.</p>
            </ActionForm>
          </div>
        </Panel>
        {ai && (
          <Panel title="AI assistant" icon={Wand2} id="ai" defaultOpen={false} summary={!ai.saved ? "Not set up" : `${ai.autopilot === "off" ? "Autopilot off" : ai.autopilot === "suggest" ? "Autopilot suggests" : "Autopilot creates tasks"}${ai.model ? ` · prefers ${ai.model}` : ""}`}>
            <AiSettingsPanel baseUrl={ai.baseUrl} hasKey={ai.hasKey} model={ai.model} autopilot={ai.autopilot} hosted={hosted} />
          </Panel>
        )}
        {viewer.isAdmin && (
          <Panel title="Backup and restore" icon={Settings} id="backup" defaultOpen={false} summary="Export a copy or restore from one">
            <BackupPanel hosted={hosted} />
          </Panel>
        )}
      </div>
    </>
  );
}
