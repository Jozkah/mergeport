import { ActionForm } from "@/components/forms/ActionForm";
import { ConfirmSheet } from "@/components/forms/ConfirmSheet";
import { Disclosure } from "@/components/ui/Disclosure";
import { Banner, EmptyState, Panel, SimplePill } from "@/components/ui/primitives";
import { Building2, Layers, ListChecks, Unplug, User } from "@/components/ui/icons";
import { checkGithubInstallationAction, disconnectGithubInstallationAction } from "@/app/github-actions";
import { formatDateOnly } from "@/lib/format";
import type { InstallationStatus } from "@/lib/github/binding";
import type { ResultMessage } from "@/lib/github/connect-messages";
import { ConnectGithubForm, UseExistingForm } from "./GithubConnectForms";

export type InstallationRow = {
  installationId: string;
  accountLogin: string;
  accountType: "USER" | "ORGANIZATION";
  repositorySelection: "ALL" | "SELECTED";
  status: InstallationStatus;
  connectedAt: Date;
};

export type GithubView = {
  /** The server has a complete GitHub App configuration. */
  configured: boolean;
  /** The viewer is an owner or administrator (may connect and disconnect). */
  manage: boolean;
  installations: InstallationRow[];
};

/** What the person who runs the server has to set, in plain words. Names only: no value is ever shown. */
export const OPERATOR_SETTINGS: { name: string; what: string }[] = [
  { name: "MERGEPORT_GITHUB_APP_ID", what: "the App’s number" },
  { name: "MERGEPORT_GITHUB_APP_SLUG", what: "the App’s name in its GitHub address" },
  { name: "MERGEPORT_GITHUB_APP_CLIENT_ID", what: "the App’s client ID" },
  { name: "MERGEPORT_GITHUB_APP_CLIENT_SECRET", what: "the App’s client secret" },
  { name: "MERGEPORT_GITHUB_APP_PRIVATE_KEY", what: "the App’s private key (or MERGEPORT_GITHUB_APP_PRIVATE_KEY_FILE with the path to it)" },
  { name: "MERGEPORT_GITHUB_APP_WEBHOOK_SECRET", what: "the secret GitHub signs its messages with" },
];

/** An account name: wraps nowhere (one line, truncated), full text in the tooltip, and readable for keyboard and touch like Host. */
function AccountName({ login }: { login: string }) {
  return (
    <span className="inline-block max-w-full truncate align-bottom font-medium" title={login} translate="no" tabIndex={0} aria-label={login}>
      <bdi>{login}</bdi>
    </span>
  );
}

const STATUS: Record<InstallationStatus, { tone: "ok" | "waiting" | "blocked"; label: string; help: string | null }> = {
  active: { tone: "ok", label: "Active", help: null },
  suspended: { tone: "waiting", label: "Suspended on GitHub", help: "An owner of the GitHub account suspended the App. Nothing is read from it until it is unsuspended there." },
  removed: { tone: "blocked", label: "Removed on GitHub", help: "The App was uninstalled on GitHub. Disconnect it here, then connect again if you want it back." },
};

function InstallationItem({ row, manage }: { row: InstallationRow; manage: boolean }) {
  const st = STATUS[row.status];
  const TypeIcon = row.accountType === "ORGANIZATION" ? Building2 : User;
  const SelIcon = row.repositorySelection === "ALL" ? Layers : ListChecks;
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line p-4 last:border-b-0">
      <div className="min-w-0 max-w-full flex-1 basis-64">
        <p className="flex min-w-0 flex-wrap items-center gap-2 text-[13px]">
          <AccountName login={row.accountLogin} />
          <span className="pill pill-neutral"><TypeIcon size={12} aria-hidden />{row.accountType === "ORGANIZATION" ? "Organization" : "Personal account"}</span>
          <span className="pill pill-neutral"><SelIcon size={12} aria-hidden />{row.repositorySelection === "ALL" ? "All repositories" : "Selected repositories"}</span>
          <SimplePill tone={st.tone}>{st.label}</SimplePill>
        </p>
        <p className="mt-1 text-[12px] text-ink-3">Connected <span className="tnum">{formatDateOnly(row.connectedAt)}</span></p>
        {st.help && <p className="mt-1 max-w-[70ch] text-[12.5px] text-ink-2 text-pretty">{st.help}</p>}
      </div>
      {manage && (
        <div className="flex flex-wrap items-center gap-2">
          {row.status !== "active" && (
            <ActionForm action={checkGithubInstallationAction} submitLabel="Check again" pendingLabel="Checking…" resetOnSuccess={false} layout="inline" submitClassName="btn" submitAriaLabel={`Check ${row.accountLogin} again`}>
              <input type="hidden" name="installationId" value={row.installationId} />
            </ActionForm>
          )}
          <ConfirmSheet
            title={`Disconnect ${row.accountLogin}?`}
            consequence={<>This workspace stops using <bdi>{row.accountLogin}</bdi> on GitHub. Repositories that came from it stay here but show as not connected, and nothing is deleted: your tasks, projects and history are kept. You can connect it again later.</>}
            action={disconnectGithubInstallationAction}
            submitLabel="Disconnect"
            pendingLabel="Disconnecting…"
            trigger={<button type="button" className="btn text-blocked" aria-label={`Disconnect ${row.accountLogin}`}><Unplug size={14} aria-hidden />Disconnect</button>}
          >
            <input type="hidden" name="installationId" value={row.installationId} />
          </ConfirmSheet>
        </div>
      )}
    </li>
  );
}

/** The whole Settings > GitHub page body for one viewer. Pure data in, so it renders the same in tests. */
export function GithubSettingsBody({ view, result }: { view: GithubView; result: ResultMessage | null }) {
  const { configured, manage, installations } = view;
  return (
    <div className="flex flex-col gap-5">
      {result && <Banner tone={result.tone} title={result.title}>{result.body}</Banner>}

      {!configured && (
        <Panel title="GitHub is not set up on this server" icon={Unplug} id="gh-setup">
          <div className="p-4 text-[13px]">
            <p className="max-w-[70ch] text-pretty">The Mergeport GitHub App has not been added to this server yet, so no workspace can connect GitHub.{" "}
              {manage ? "Ask whoever runs this server to set it up; the list below tells them what is needed." : "Contact your administrator."}</p>
            {manage && (
              <div className="mt-2">
                <Disclosure summary="For the person who runs the server">
                  <p className="max-w-[70ch] text-[12.5px] text-ink-3 text-pretty">Register one GitHub App for this deployment, then set these in the server&apos;s environment and restart it. All of them are needed together. The steps are in docs/github-app.md.</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-[12.5px]">
                    {OPERATOR_SETTINGS.map((s) => <li key={s.name}><code className="wrap-any font-mono text-[12px]">{s.name}</code>: {s.what}</li>)}
                  </ul>
                </Disclosure>
              </div>
            )}
          </div>
        </Panel>
      )}

      {installations.length > 0 && (
        <Panel title={<>Connected GitHub accounts (<span className="tnum">{installations.length}</span>)</>} icon={Building2} id="gh-connected">
          <ul style={{ "--row-gap": "0px" } as React.CSSProperties} aria-label="Connected GitHub accounts">
            {installations.map((r) => <InstallationItem key={r.installationId} row={r} manage={manage} />)}
          </ul>
          {!manage && <p className="border-t border-line p-4 text-[12.5px] text-ink-3">Only the owner and administrators can connect or disconnect GitHub.</p>}
        </Panel>
      )}

      {installations.length === 0 && !manage && (
        <Panel title="GitHub" icon={Building2} id="gh-status">
          <EmptyState icon={Unplug} title="GitHub is not connected">{configured ? "Ask the owner or an administrator to connect it. Repository sync and GitHub actions are off until then." : "Repository sync and GitHub actions are off."}</EmptyState>
        </Panel>
      )}

      {configured && manage && (
        <Panel title={installations.length === 0 ? "Connect GitHub" : "Connect another account"} icon={Building2} id="gh-connect">
          <div className="grid gap-5 p-4">
            {installations.length === 0 && <p className="max-w-[70ch] text-[13px] text-ink-3 text-pretty">GitHub is not connected yet, so repository sync and GitHub actions are off. Your workspace data is still here.</p>}
            <ConnectGithubForm />
            <div className="border-t border-line pt-4"><UseExistingForm /></div>
            <p className="max-w-[70ch] text-[12.5px] text-ink-3 text-pretty">For an organization, an owner of that organization has to do this. You will be asked to prove it on GitHub.</p>
          </div>
        </Panel>
      )}
    </div>
  );
}
