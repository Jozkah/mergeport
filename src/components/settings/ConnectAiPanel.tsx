import { ActionForm } from "@/components/forms/ActionForm";
import { ConfirmSheet } from "@/components/forms/ConfirmSheet";
import { CopyField } from "@/components/forms/CopyField";
import { Disclosure } from "@/components/ui/Disclosure";
import { Select } from "@/components/ui/Select";
import { EmptyState, Panel, SimplePill } from "@/components/ui/primitives";
import { Ban, KeyRound, Wand2 } from "@/components/ui/icons";
import { createApiTokenAction, revokeApiTokenAction } from "@/app/api-token-actions";
import { formatDateOnly, relativeTime } from "@/lib/format";
import { TOKEN_NAME_MAX, type TokenRow } from "@/lib/services/api-tokens";

export type ConnectAiView = {
  /** The address of the endpoint (MERGEPORT_PUBLIC_URL plus /api/mcp). */
  connectorUrl: string;
  /** The person's role may change things; a reader can only make read-only tokens. */
  canWrite: boolean;
  /** An administrator sees and revokes every token of the workspace. */
  admin: boolean;
  tokens: TokenRow[];
};

const stateLabel = { active: "Active", expired: "Expired", revoked: "Revoked" } as const;

function TokenItem({ t, now }: { t: TokenRow; now: Date }) {
  const live = t.state === "active";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0" data-token={t.id}>
      <div className="min-w-0 flex-1 basis-56">
        <p className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 max-w-full truncate font-medium" translate="no" title={t.name}><bdi>{t.name}</bdi></span>
          <SimplePill tone={live ? "ok" : t.state === "expired" ? "waiting" : "blocked"} icon={live ? undefined : Ban}>{stateLabel[t.state]}</SimplePill>
          <SimplePill tone="unknown" icon={t.scope === "WRITE" ? Wand2 : KeyRound}>{t.scope === "WRITE" ? "Read and write" : "Read only"}</SimplePill>
        </p>
        <p className="mt-1 text-[12px] text-ink-3">
          <span className="mono" translate="no">{t.prefix}…</span>
          {" · "}
          {t.lastUsedAt ? <>used <span className="tnum">{relativeTime(t.lastUsedAt, now)}</span></> : "never used"}
          {" · "}
          {t.revokedAt ? <>revoked <span className="tnum">{formatDateOnly(t.revokedAt)}</span></> : t.expiresAt ? <>{t.state === "expired" ? "expired" : "expires"} <span className="tnum">{formatDateOnly(t.expiresAt)}</span></> : "no expiry"}
          {t.mine ? null : <> · <bdi className="break-all">{t.owner}</bdi></>}
        </p>
      </div>
      {live && (
        <ConfirmSheet
          title="Revoke this token?"
          consequence={<>Any app using <bdi>{t.name}</bdi> stops working at once. This cannot be undone; make a new token to connect again.</>}
          action={revokeApiTokenAction}
          submitLabel="Revoke token"
          pendingLabel="Revoking…"
          trigger={<button type="button" className="btn text-blocked" aria-label={`Revoke token ${t.name}`}>Revoke</button>}
        >
          <input type="hidden" name="id" value={t.id} />
        </ConfirmSheet>
      )}
    </li>
  );
}

/** Settings > Connect AI (MCP), hosted. Pure data in, so it renders the same in tests. */
export function ConnectAiBody({ view, now }: { view: ConnectAiView; now: Date }) {
  const { connectorUrl, canWrite, admin, tokens } = view;
  return (
    <div className="flex max-w-2xl flex-col gap-5 p-4 text-[13px]">
      <p className="max-w-[70ch] text-pretty text-ink-2">
        Let an AI app such as Claude look at your tasks, open new ones and add comments, as you. It sees only what you can see here. It cannot edit, move or delete anything, and it never changes GitHub.
      </p>
      <CopyField label="Connector address" value={connectorUrl} />
      <ActionForm action={createApiTokenAction} submitLabel="Create token" pendingLabel="Creating…" className="flex flex-col gap-3" success={{ copy: { field: "secret", label: "Your new token", hint: "Shown once. Paste it into the app now; Mergeport keeps only a fingerprint." } }}>
        <div>
          <label className="label" htmlFor="mcp-name">Name</label>
          <input id="mcp-name" name="name" required maxLength={TOKEN_NAME_MAX} autoComplete="off" spellCheck={false} placeholder="Claude on my laptop" className="input max-w-sm" />
        </div>
        <div className="flex flex-wrap gap-3">
          <div className="min-w-[min(220px,100%)] flex-1">
            <label className="label" htmlFor="mcp-scope">Access</label>
            <Select id="mcp-scope" name="scope" defaultValue="READ" className="select">
              <option value="READ">Read only</option>
              {canWrite && <option value="WRITE">Read, open tasks and comment</option>}
            </Select>
          </div>
          <div className="min-w-[min(160px,100%)] flex-1">
            <label className="label" htmlFor="mcp-expires">Expires</label>
            <Select id="mcp-expires" name="expires" defaultValue="90" className="select">
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
              <option value="none">Never</option>
            </Select>
          </div>
        </div>
        {!canWrite && <p className="text-[12px] text-ink-3">Your role is read-only here, so tokens can only read.</p>}
      </ActionForm>
      <Disclosure summary="Connect Claude or another app">
        <div className="flex flex-col gap-2 pb-2 pl-1 text-ink-2">
          <p className="max-w-[70ch] text-pretty">Add Mergeport as a remote MCP server in the app, using the connector address and a header named <span className="mono">Authorization</span> with the value <span className="mono">Bearer</span>, a space, then your token.</p>
          <p className="text-ink-3">In Claude Code:</p>
          <pre className="mono overflow-x-auto whitespace-pre-wrap break-all rounded-[8px] bg-code p-3 text-[12px]" translate="no">{`claude mcp add --transport http mergeport ${connectorUrl} --header "Authorization: Bearer <your token>"`}</pre>
          <p className="max-w-[70ch] text-pretty text-ink-3">Then ask, for example, &ldquo;open a task on Mergeport to review the payments PR, high priority&rdquo;. Apps that cannot send a custom header cannot connect yet.</p>
        </div>
      </Disclosure>
      <section aria-labelledby="mcp-tokens">
        <h3 id="mcp-tokens" className="mb-2 text-[12px] font-medium text-ink-2">{admin ? "Tokens in this workspace" : "Your tokens"}</h3>
        {tokens.length === 0 ? (
          <EmptyState icon={KeyRound} title="No tokens yet">Create one above to connect an app.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {tokens.map((t) => <TokenItem key={t.id} t={t} now={now} />)}
          </ul>
        )}
      </section>
    </div>
  );
}

export function ConnectAiPanel({ view, now }: { view: ConnectAiView; now: Date }) {
  const active = view.tokens.filter((t) => t.state === "active").length;
  return (
    <Panel title="Connect AI (MCP)" icon={Wand2} id="connect-ai" defaultOpen={false} summary={active === 0 ? "No tokens" : `${active} active token${active === 1 ? "" : "s"}`}>
      <ConnectAiBody view={view} now={now} />
    </Panel>
  );
}
