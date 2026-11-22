import { Select } from "@/components/ui/Select";
import path from "node:path";
import { cookies } from "next/headers";
import { requireViewer } from "@/lib/authz-page";
import { isDemo } from "@/lib/env";
import { currentGhStatus } from "@/lib/local/identity";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";
import { ActionForm } from "@/components/forms/ActionForm";
import { ConfirmSheet } from "@/components/forms/ConfirmSheet";
import { ThemeSelect } from "@/components/shell/ThemeControls";
import { Mono, PageHeader, Panel, SimplePill } from "@/components/ui/primitives";
import { KeyRound, LogOut, RefreshCw, Settings } from "@/components/ui/icons";
import { autoSetupAction, setRepoWatchAction, setTimezoneAction } from "@/app/actions";
import { signOutEverywhereFormAction } from "@/app/account-actions";
import { saveDigestSettingsAction } from "@/app/digest-actions";
import { setPollSecondsAction } from "@/app/team-actions";
import { watchView } from "@/lib/local/repo-watch";
import { WATCH_MAX_REPOS_LIMIT, WATCH_MAX_REPOS_MIN, WATCH_MAX_SECONDS, WATCH_MIN_SECONDS } from "@/lib/local/watch-format";
import { planAutoSetup } from "@/lib/services/auto-setup";
import { db } from "@/lib/db";
import { Bell, Building2, Globe, Newspaper, Users, Wand2 } from "@/components/ui/icons";
import { listWorkspaceInstallations } from "@/lib/github/binding";
import { isHosted, publicOrigin } from "@/lib/public-url";
import { ConnectAiPanel, type ConnectAiView } from "@/components/settings/ConnectAiPanel";
import { listApiTokens } from "@/lib/services/api-tokens";
import { can } from "@/lib/authz/roles";
import { subjectOf } from "@/lib/authz/viewer";
import { federationState } from "@/lib/federation/config";
import Link from "next/link";
import { RoleChip } from "@/components/ui/identity";
import { BackupPanel } from "@/components/settings/BackupPanel";
import { NotificationSettings } from "@/components/settings/NotificationSettings";
import { getPrefs } from "@/lib/services/notification-prefs";
import { McpPanel } from "@/components/settings/McpPanel";
import { AiSettingsPanel } from "@/components/settings/AiSettingsPanel";
import { getAiView } from "@/lib/services/ai";
import { GithubAccountPanel } from "@/components/settings/GithubAccountPanel";
import { githubAppConfigured } from "@/lib/github/app-config";
import { LINK_MESSAGES, isLinkResult } from "@/lib/github/link-messages";
import { userTokenKey } from "@/lib/github/user-token";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ clones?: string; githublink?: string | string[] }> }) {
  const { viewer, user } = await requireViewer();
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const hosted = isHosted(); // hosted: no "this computer", no local clones, no gh on the server
  const gh = isDemo() || hosted ? null : await currentGhStatus();
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
  const sp = await searchParams;
  const clones = sp.clones ?? path.dirname(process.cwd()); // by default the folder that holds this app, where clones usually sit
  const setup = viewer.isAdmin && !isDemo() && !hosted ? await planAutoSetup(db, viewer, { clonesFolder: clones }) : null;
  const prefs = await getPrefs(db, user.id);
  const { summary: watch, config: wcfg } = await watchView(db);
  const ai = isDemo() ? null : await getAiView(db, viewer.workspaceId);
  // Counts for the panel summaries (hosted only: these panels do not exist locally).
  const memberCount = hosted ? await db.member.count({ where: { workspaceId: viewer.workspaceId, status: "ACTIVE" } }) : 0;
  const linkCount = hosted && viewer.isAdmin ? await db.federationLink.count({ where: { workspaceId: viewer.workspaceId, status: "ACTIVE" } }) : 0;
  const ghInstalls = hosted && !isDemo() ? await listWorkspaceInstallations(db, viewer.workspaceId) : [];
  const ghActive = ghInstalls.filter((i) => i.status === "active").length;
  const poll = (await db.teamConfig.findUnique({ where: { workspaceId: viewer.workspaceId } }))?.pollSeconds ?? 30;
  // The person's own GitHub link (hosted). The result code from the callback is looked up in a fixed table, never shown as given.
  const tokenRow = hosted && !isDemo() ? await db.githubUserToken.findUnique({ where: { userId: user.id }, select: { status: true, accessCheckedAt: true, accessTruncated: true } }) : null;
  const linkCode = Array.isArray(sp.githublink) ? sp.githublink[0] : sp.githublink;
  // Connect AI (hosted): personal access tokens for the MCP endpoint, docs/mcp.md.
  const origin = publicOrigin();
  const connectAi: ConnectAiView | null = hosted && !isDemo() && origin ? { connectorUrl: `${origin.origin}/api/mcp`, canWrite: can(subjectOf(viewer), "write"), admin: viewer.isAdmin, tokens: await listApiTokens(db, viewer) } : null;
  const hint = (stored: number | null, fb: number, fromEnv: boolean, envName: string) => (stored !== null ? "Saved here. Clear the field to go back to the default." : fromEnv ? `Using ${fb} from the environment (${envName}). Type a number to override it.` : `Using the default, ${fb}. Type a number to change it.`);
  return (
    <>
      <PageHeader
        title="Settings"
        subtitle={`Signed in as ${hosted ? (user.email ?? `@${user.login}`) : `@${user.login}`}${viewer.isAdmin ? ` (administrator of ${hosted ? "this workspace" : "the team space"})` : ""}.`}
        help={hosted ? <>The daily digest uses your timezone ({user.timezone}) and shows in the bell and on Overview.</> : <>These settings belong to this computer. The daily digest uses your timezone ({user.timezone}); it is built only from the data on this computer, with no network call, and shows in the bell and on Overview.</>}
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
        {!isDemo() && !hosted && (
          <Panel title="Use from other AI apps" icon={Wand2} id="mcp" defaultOpen={false} summary="Claude, opencode, Cursor and others (MCP)">
            <McpPanel launcher={path.join(process.cwd(), "scripts", "mcp.mjs")} />
          </Panel>
        )}
        {!hosted && <Panel title="Sync" icon={RefreshCw} id="polling">
          <div className="p-4">
            <ActionForm action={setPollSecondsAction} submitLabel="Save" resetOnSuccess={false} className="max-w-xs">
              <label className="label" htmlFor="poll">Active polling interval (seconds, 15 to 600)</label>
              <input id="poll" name="seconds" type="number" min={15} max={600} defaultValue={poll} className="input" />
              <p className="mt-1 text-[12px] text-ink-3">Shorter means fresher data and more GitHub requests.</p>
            </ActionForm>
          </div>
        </Panel>}
        {viewer.isAdmin && (
          <Panel title="Backup and restore" icon={Settings} id="backup" defaultOpen={false} summary="Export a copy or restore from one">
            <BackupPanel hosted={hosted} />
          </Panel>
        )}
        {!hosted && <Panel title="Auto-sync of repositories" icon={RefreshCw} id="auto-sync" defaultOpen={false} summary={!watch.enabled ? "Off" : `On, every ${watch.effective} s`}>
          <div className="p-4">
            <ActionForm action={setRepoWatchAction} submitLabel="Save" resetOnSuccess={false} className="max-w-md">
              <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="enabled" defaultChecked={watch.enabled} /> Check repositories I don&apos;t own while Mergeport is open</label>
              <label className="label mt-3" htmlFor="watch-seconds">Check every (seconds)</label>
              <input id="watch-seconds" name="seconds" type="number" min={WATCH_MIN_SECONDS} max={WATCH_MAX_SECONDS} defaultValue={wcfg.stored.seconds ?? ""} placeholder={String(wcfg.fallback.seconds)} className="input max-w-[8rem]" />
              <p className="mt-1 text-[12px] text-ink-3" data-testid="watch-seconds-hint">{hint(wcfg.stored.seconds, wcfg.fallback.seconds, wcfg.fallback.secondsFromEnv, "MERGEPORT_WATCH_SECONDS")}</p>
              <label className="label mt-3" htmlFor="watch-max">Watch at most (repositories)</label>
              <input id="watch-max" name="max" type="number" min={WATCH_MAX_REPOS_MIN} max={WATCH_MAX_REPOS_LIMIT} defaultValue={wcfg.stored.maxRepos ?? ""} placeholder={String(wcfg.fallback.maxRepos)} className="input max-w-[8rem]" />
              <p className="mt-1 text-[12px] text-ink-3" data-testid="watch-max-hint">{hint(wcfg.stored.maxRepos, wcfg.fallback.maxRepos, wcfg.fallback.maxReposFromEnv, "MERGEPORT_WATCH_MAX_REPOS")}</p>
              <p className="mt-1 text-[12px] text-ink-3">Repositories beyond this number keep the 15-minute refresh.</p>
              <p className="mt-1 text-[12px] text-ink-3">Unchanged checks cost no rate limit. Webhook-covered repositories are never polled.</p>
            </ActionForm>
            <p className="mt-3 text-[12.5px] text-ink-2" data-testid="watch-effective">
              {!watch.enabled ? "Off. Repositories still refresh every 15 minutes." : watch.repos === 0 ? "No repositories to check right now." : <>Effective: every {watch.effective} s for {watch.repos} repositor{watch.repos === 1 ? "y" : "ies"}.</>}
            </p>
            {watch.enabled && watch.stretched && <p className="mt-1 text-[12px] text-ink-3">Stretched from {watch.configured} s: {watch.repos} repositories every {watch.effective} s is 300 requests a minute. Watch fewer repositories to check faster.</p>}
          </div>
        </Panel>}
        {setup && (
          <Panel title="Set up automatically" icon={Wand2} id="auto">
            <div className="flex flex-col gap-3 p-4 text-[13px]">
              <p className="text-ink-3">Proposes configuration from the GitHub data you track. Nothing is sent to GitHub or changed until you apply.</p>
              <form method="get" className="flex flex-wrap items-end gap-2"><div className="min-w-[min(240px,100%)] flex-1"><label className="label" htmlFor="clones">Folder that holds your local clones</label><input id="clones" name="clones" defaultValue={clones} className="input" /></div><button className="btn" type="submit">Look again</button></form>
              {setup.steps.length === 0 ? <p><SimplePill tone="ok">Nothing to add</SimplePill> Your projects, forks and waiting rules already cover what is tracked.</p> : (
                <ActionForm action={autoSetupAction} submitLabel="Apply selected" pendingLabel="Applying…" resetOnSuccess={false}>
                  <input type="hidden" name="folder" value={clones} />
                  <ul className="flex flex-col gap-2">
                    {setup.steps.map((st) => (
                      <li key={st.id}><label className="flex items-start gap-2"><input type="checkbox" name="step" value={st.id} defaultChecked className="mt-1" /><span><span className="font-medium">{st.title}</span><span className="block text-[12px] text-ink-3">{st.basis}</span></span></label></li>
                    ))}
                  </ul>
                </ActionForm>
              )}
              {setup.skipped.length > 0 && <div><p className="text-[12px] font-medium text-ink-2">Not proposed</p><ul className="mt-1 list-disc space-y-1 pl-5 text-[12px] text-ink-3">{setup.skipped.map((x) => <li key={x}>{x}</li>)}</ul></div>}
              <div><p className="text-[12px] font-medium text-ink-2">Nothing to configure</p><ul className="mt-1 list-disc space-y-1 pl-5 text-[12px] text-ink-3">{setup.nothingToConfigure.map((x) => <li key={x}>{x}</li>)}</ul></div>
            </div>
          </Panel>
        )}
        {!hosted && <Panel title="GitHub account" icon={KeyRound} id="gh" defaultOpen={false} summary={gh === null ? "Demo mode" : gh.state === "ok" ? `@${gh.identity.login} via the GitHub CLI` : "Not connected"}>
          <div className="flex flex-col gap-3 p-4 text-[13px]">
            {gh === null ? (
              <p className="text-ink-3">Demo mode: nothing here talks to GitHub.</p>
            ) : gh.state === "ok" ? (
              <p>
                <SimplePill tone="ok">Signed in with the GitHub CLI</SimplePill> as <Mono>@{gh.identity.login}</Mono> on <Mono>{gh.identity.host}</Mono>.              </p>
            ) : (
              <p><SimplePill tone="blocked">{gh.state === "missing-gh" ? "GitHub CLI not found" : gh.state === "not-logged-in" ? "Not signed in" : "GitHub CLI error"}</SimplePill> Cached data stays readable; nothing is sent to GitHub until <Mono>gh auth login</Mono> succeeds.</p>
            )}
            <p className="text-[12.5px] text-ink-3">Mergeport never stores your token; the GitHub CLI keeps it.</p>
            <details className="text-[12.5px] text-ink-3">
              <summary className="inline-flex min-h-10 cursor-pointer items-center rounded-[6px] text-ink-2 hover:text-ink">More about credentials</summary>
              <ul className="list-disc space-y-1 pl-5">
              <li>The CLI&apos;s default sign-in grants broad scopes (classic <Mono>repo</Mono> can write to every repository you can reach). Mergeport only reads from source repositories unless you press an action; the scope itself is not read-only.</li>
              <li>To use a narrower credential, sign in with a fine-grained token limited to the repositories you track, then restart Mergeport.</li>
              <li>If you switch accounts in the CLI, Mergeport locks this profile instead of mixing data. Each account has its own database.</li>
              </ul>
            </details>
          </div>
        </Panel>}
      </div>
    </>
  );
}
