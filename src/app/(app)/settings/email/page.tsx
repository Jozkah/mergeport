import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { isDemo } from "@/lib/env";
import { isHosted } from "@/lib/public-url";
import { getSmtpView } from "@/lib/services/smtp-settings";
import { saveSmtpSettingsAction, sendTestEmailAction } from "@/app/server-email-actions";
import { ActionForm } from "@/components/forms/ActionForm";
import { Select } from "@/components/ui/Select";
import { Banner, PageHeader, Panel } from "@/components/ui/primitives";
import { Mail } from "@/components/ui/icons";

export const metadata = { title: "Email settings" };
export const dynamic = "force-dynamic";

/**
 * Settings > Email (hosted). Outgoing email for the whole server: sign-in links and invitations. Server administrators only
 * (User.isServerAdmin); everyone else, workspace owners included, gets the same 404 as a missing page. The saved password is never
 * sent to the browser: the field is empty and a blank field keeps it.
 */
export default async function EmailSettings() {
  const { user } = await requireViewer();
  if (isDemo() || !isHosted() || !user.isServerAdmin) notFound();
  const v = await getSmtpView(db);
  const configured = !!v.host && !!v.mailFrom;
  return (
    <>
      <PageHeader
        title="Email"
        subtitle="Outgoing email for this whole server: sign-in links and invitations."
        help={<>These settings belong to the server, not to a workspace, and only a server administrator sees them. Until they are saved, nobody can sign in by email.</>}
      />
      <div className="grid max-w-2xl gap-5">
        {!v.keyConfigured && (
          <Banner tone="error" title="MERGEPORT_ENCRYPTION_KEY is not set">
            The SMTP password is only stored encrypted, with MERGEPORT_ENCRYPTION_KEY. Set it on the server (64 hex characters, for example from <code>openssl rand -hex 32</code>) and restart before saving a password. A server that needs no password works without it.
          </Banner>
        )}
        <Panel title="SMTP server" icon={Mail} id="smtp" collapsible={false}>
          <div className="p-4">
            <ActionForm action={saveSmtpSettingsAction} submitLabel="Save" resetOnSuccess={false} className="max-w-md">
              <div className="flex flex-col gap-4">
                <div>
                  <label className="label" htmlFor="smtp-host">Host</label>
                  <input id="smtp-host" name="host" className="input" defaultValue={v.host} required maxLength={253} autoComplete="off" spellCheck={false} placeholder="smtp.example.com" />
                </div>
                <div className="flex flex-wrap gap-4">
                  <div>
                    <label className="label" htmlFor="smtp-port">Port</label>
                    <input id="smtp-port" name="port" type="number" inputMode="numeric" min={1} max={65535} step={1} defaultValue={v.port} className="input tnum max-w-[8rem]" aria-describedby="smtp-port-help" />
                  </div>
                  <div>
                    <label className="label" htmlFor="smtp-security">Security</label>
                    <Select id="smtp-security" name="security" defaultValue={v.security} className="select">
                      <option value="starttls">STARTTLS (port 587)</option>
                      <option value="tls">TLS from the start (port 465)</option>
                      <option value="none">None (not encrypted)</option>
                    </Select>
                  </div>
                </div>
                <p id="smtp-port-help" className="-mt-2 text-[12px] text-ink-3 text-pretty">Use 587 with STARTTLS: the production host only allows outgoing connections on port 587.</p>
                <div>
                  <label className="label" htmlFor="smtp-user">User name</label>
                  <input id="smtp-user" name="username" className="input" defaultValue={v.username} maxLength={254} autoComplete="off" spellCheck={false} />
                  <p className="mt-1 text-[12px] text-ink-3">Leave empty when the server needs no sign-in.</p>
                </div>
                <div>
                  <label className="label" htmlFor="smtp-password">Password</label>
                  <input id="smtp-password" name="password" type="password" className="input" maxLength={1024} autoComplete="new-password" disabled={!v.keyConfigured} placeholder={v.hasPassword ? "Saved. Type to replace it." : v.keyConfigured ? "" : "Needs MERGEPORT_ENCRYPTION_KEY"} />
                  <p className="mt-1 text-[12px] text-ink-3 text-pretty">Stored encrypted and never shown again. Leave empty to keep the saved one.</p>
                  {v.hasPassword && <label className="mt-1 flex min-h-10 w-fit cursor-pointer items-center gap-2 text-[12.5px]"><input type="checkbox" name="clearPassword" /> Remove the saved password</label>}
                </div>
                <div>
                  <label className="label" htmlFor="smtp-from">Sender</label>
                  <input id="smtp-from" name="mailFrom" className="input" defaultValue={v.mailFrom} required maxLength={320} autoComplete="off" spellCheck={false} placeholder="Mergeport <no-reply@example.com>" />
                </div>
              </div>
            </ActionForm>
          </div>
        </Panel>
        <Panel title="Test" icon={Mail} id="smtp-test" collapsible={false}>
          <div className="p-4 text-[13px]">
            <p className="mb-3 text-ink-3">{configured ? <>Sends one message with the saved settings to <bdi className="break-all text-ink-2">{user.email ?? "your address"}</bdi>. A failure shows the mail server&apos;s answer.</> : "Save the settings above first."}</p>
            <ActionForm action={sendTestEmailAction} submitLabel="Send test email" pendingLabel="Sending…" resetOnSuccess={false} submitClassName="btn" submitDisabled={!configured || !user.email} submitDisabledReason={!user.email ? "Your account has no email address." : "Save the settings first."}>
              {null}
            </ActionForm>
          </div>
        </Panel>
      </div>
    </>
  );
}
