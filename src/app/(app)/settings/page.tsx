import { Select } from "@/components/ui/Select";
import path from "node:path";
import { cookies } from "next/headers";
import { requireViewer } from "@/lib/authz-page";
import { isDemo } from "@/lib/env";
import { currentGhStatus } from "@/lib/local/identity";
import { THEME_COOKIE, parseTheme } from "@/lib/theme";
import { ActionForm } from "@/components/forms/ActionForm";
import { ThemeSelect } from "@/components/shell/ThemeControls";
import { Mono, PageHeader, Panel, SimplePill } from "@/components/ui/primitives";
import { KeyRound, RefreshCw, Settings } from "@/components/ui/icons";
import { autoSetupAction, setRepoWatchAction, setTimezoneAction } from "@/app/actions";
import { watchView } from "@/lib/local/repo-watch";
import { WATCH_MAX_REPOS_LIMIT, WATCH_MAX_REPOS_MIN, WATCH_MAX_SECONDS, WATCH_MIN_SECONDS } from "@/lib/local/watch-format";
import { planAutoSetup } from "@/lib/services/auto-setup";
import { db } from "@/lib/db";
import { Bell, Wand2 } from "@/components/ui/icons";
import { BackupPanel } from "@/components/settings/BackupPanel";
import { NotificationSettings } from "@/components/settings/NotificationSettings";
import { getPrefs } from "@/lib/services/notification-prefs";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ clones?: string }> }) {
  const { viewer, user } = await requireViewer();
  const theme = parseTheme((await cookies()).get(THEME_COOKIE)?.value);
  const gh = isDemo() ? null : await currentGhStatus();
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["UTC"];
  const clones = (await searchParams).clones ?? path.dirname(process.cwd()); // by default the folder that holds this app, where clones usually sit
  const setup = viewer.isAdmin && !isDemo() ? await planAutoSetup(db, viewer, { clonesFolder: clones }) : null;
  const { summary: watch, config: wcfg } = await watchView(db);
  const hint = (stored: number | null, fb: number, fromEnv: boolean, envName: string) => (stored !== null ? "Saved here. Clear the field to go back to the default." : fromEnv ? `Using ${fb} from the environment (${envName}). Type a number to override it.` : `Using the default, ${fb}. Type a number to change it.`);
  return (
    <>
      <PageHeader title="Settings" subtitle={`Signed in as @${user.login}${viewer.isAdmin ? " (administrator of the team space)" : ""}. These settings belong to this computer.`} />
      <div className="fit-grid" style={{ "--fit-min": "520px" } as React.CSSProperties}>
        {viewer.isAdmin && (
          <Panel title="Backup and restore" icon={Settings} id="backup">
            <BackupPanel />
          </Panel>
        )}
        <Panel title="Notifications" icon={Bell} id="notifications">
          <NotificationSettings initial={await getPrefs(db, user.id)} />
        </Panel>
        <Panel title="Display" icon={Settings} id="display">
          <div className="grid gap-5 p-4">
            <ThemeSelect initial={theme} />
            <ActionForm action={setTimezoneAction} submitLabel="Save timezone" resetOnSuccess={false}>
              <label className="label" htmlFor="tz">Timezone</label>
              <Select id="tz" name="timezone" defaultValue={user.timezone} className="select max-w-sm">{[...new Set(["UTC", user.timezone, ...zones])].map((z) => <option key={z} value={z}>{z}</option>)}</Select>
              <p className="mt-1 text-[12px] text-ink-3">Times are stored in UTC and shown in this zone. Due dates and milestone dates are calendar dates and are not shifted.</p>
            </ActionForm>
          </div>
        </Panel>
        <Panel title="Auto-sync of repositories" icon={RefreshCw} id="auto-sync">
          <div className="p-4">
            <ActionForm action={setRepoWatchAction} submitLabel="Save" resetOnSuccess={false} className="max-w-md">
              <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" name="enabled" defaultChecked={watch.enabled} /> Check repositories I don&apos;t own while Mergeport is open</label>
              <label className="label mt-3" htmlFor="watch-seconds">Check every (seconds)</label>
              <input id="watch-seconds" name="seconds" type="number" min={WATCH_MIN_SECONDS} max={WATCH_MAX_SECONDS} defaultValue={wcfg.stored.seconds ?? ""} placeholder={String(wcfg.fallback.seconds)} className="input max-w-[8rem]" />
              <p className="mt-1 text-[12px] text-ink-3" data-testid="watch-seconds-hint">{hint(wcfg.stored.seconds, wcfg.fallback.seconds, wcfg.fallback.secondsFromEnv, "MERGEPORT_WATCH_SECONDS")}</p>
              <label className="label mt-3" htmlFor="watch-max">Watch at most (repositories)</label>
              <input id="watch-max" name="max" type="number" min={WATCH_MAX_REPOS_MIN} max={WATCH_MAX_REPOS_LIMIT} defaultValue={wcfg.stored.maxRepos ?? ""} placeholder={String(wcfg.fallback.maxRepos)} className="input max-w-[8rem]" />
              <p className="mt-1 text-[12px] text-ink-3" data-testid="watch-max-hint">{hint(wcfg.stored.maxRepos, wcfg.fallback.maxRepos, wcfg.fallback.maxReposFromEnv, "MERGEPORT_WATCH_MAX_REPOS")}</p>
              <p className="mt-1 text-[12px] text-ink-3">Repositories beyond this number keep the 15-minute refresh. The least recently synced are watched first.</p>
              <p className="mt-1 text-[12px] text-ink-3">On by default. Turn off to use only the 15-minute cycle.</p>
              <p className="mt-1 text-[12px] text-ink-3">Checks use conditional requests that do not use your GitHub rate limit when nothing changed. Webhook-covered repositories are never polled.</p>
            </ActionForm>
            <p className="mt-3 text-[12.5px] text-ink-2" data-testid="watch-effective">
              {!watch.enabled ? "Off. Repositories still refresh every 15 minutes." : watch.repos === 0 ? "No repositories to check right now." : <>Effective: every {watch.effective} s for {watch.repos} repositor{watch.repos === 1 ? "y" : "ies"}.</>}
            </p>
            {watch.enabled && watch.stretched && <p className="mt-1 text-[12px] text-ink-3">Stretched from {watch.configured} s because of the number of repositories: {watch.repos} repositories every {watch.effective} s is 300 requests a minute in total (two per repository and check). Lower the number of repositories to check faster.</p>}
          </div>
        </Panel>
        {setup && (
          <Panel title="Set up automatically" icon={Wand2} id="auto">
            <div className="flex flex-col gap-3 p-4 text-[13px]">
              <p className="text-ink-3">Looks at what you track and proposes configuration that follows from GitHub&apos;s own data: projects by owner, fork-to-upstream comparisons, waiting rules for other people&apos;s repositories, boards filled from open work, local clones mapped for Branches, and required reviewers where GitHub&apos;s review requests show a pattern. Everything stays on this computer, nothing is sent to GitHub, nothing existing is changed, and each change says what it is based on.</p>
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
        <Panel title="GitHub account" icon={KeyRound} id="gh">
          <div className="flex flex-col gap-3 p-4 text-[13px]">
            {gh === null ? (
              <p className="text-ink-3">Demo mode: nothing here talks to GitHub.</p>
            ) : gh.state === "ok" ? (
              <p>
                <SimplePill tone="ok">Signed in with the GitHub CLI</SimplePill> as <Mono>@{gh.identity.login}</Mono> on <Mono>{gh.identity.host}</Mono>. Mergeport recognises you by your numeric GitHub id, not your name.
              </p>
            ) : (
              <p><SimplePill tone="blocked">{gh.state === "missing-gh" ? "GitHub CLI not found" : gh.state === "not-logged-in" ? "Not signed in" : "GitHub CLI error"}</SimplePill> Cached data stays readable; nothing is sent to GitHub until <Mono>gh auth login</Mono> succeeds.</p>
            )}
            <ul className="list-disc space-y-1 pl-5 text-[12.5px] text-ink-3">
              <li>Mergeport never stores your token. It asks the GitHub CLI for each request, and the credential stays in the CLI&apos;s store (your operating system&apos;s keychain where available).</li>
              <li>The CLI&apos;s default sign-in grants broad scopes (classic <Mono>repo</Mono> can write to every repository you can reach). Mergeport only reads from source repositories unless you press an action; the scope itself is not read-only.</li>
              <li>To use a narrower credential, sign in with a fine-grained token limited to the repositories you track, then restart Mergeport.</li>
              <li>If you switch accounts in the CLI, Mergeport locks this profile instead of mixing data. Each account has its own database.</li>
            </ul>
          </div>
        </Panel>
      </div>
    </>
  );
}
