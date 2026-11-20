import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireAdminViewer } from "@/lib/authz-page";
import { ActionForm } from "@/components/forms/ActionForm";
import { Select } from "@/components/ui/Select";
import { Banner, PageHeader, Panel, SimplePill } from "@/components/ui/primitives";
import { Globe, ShieldCheck } from "@/components/ui/icons";
import { revokeAllFromOriginAction, revokeGrantAction, saveFederationPolicyAction, unlinkAction } from "@/app/federation-actions";
import { formatInstant } from "@/lib/format";
import { federationState } from "@/lib/federation/config";
import { workspaceLinks } from "@/lib/federation/consumer";
import { loadPolicy } from "@/lib/federation/policy";
import { workspaceGrants } from "@/lib/federation/provider";

export const metadata = { title: "Linked instances settings" };
export const dynamic = "force-dynamic";

const MODE_HELP = "Off: none. Allow list: only the instances listed below. Any: every instance the server allows.";

/** Owner and administrators: the policy for linking this workspace to other instances, and every link and grant with Revoke. Writes are audited. */
export default async function LinkedSettings() {
  const { viewer } = await requireAdminViewer();
  const state = federationState();
  if (state.kind === "absent") notFound();
  const { config } = state;
  const policy = await loadPolicy(db, viewer.workspaceId);
  const [grants, links] = state.kind === "enabled" ? await Promise.all([workspaceGrants(db, viewer), workspaceLinks(db, viewer)]) : [[], []];
  const origins = [...new Set(grants.map((g) => g.clientOrigin))];
  return (
    <>
      <PageHeader title="Linked instances" subtitle="Who may link this workspace to other Mergeport instances, and what is linked now." help={<>Linking lets a person see another instance&apos;s projects, read-only, from their own. The instance that owns the data stores it and authorizes every request, so turning something off here stops it at once. The server operator sets the outer limit; here you can only be stricter.</>} />
      <div className="flex flex-col gap-5">
        <Panel title="This server" icon={ShieldCheck} id="ceiling">
          <div className="grid gap-2 p-4 text-[13px]">
            <p>
              Operator limit: <strong>{config.mode === "any" ? "any instance" : "only listed instances"}</strong>
              {config.mode === "allowlist" ? <> ({config.allowlist.length === 0 ? "none listed" : config.allowlist.join(", ")})</> : null}. It is set by the server&apos;s environment and cannot be changed here.
            </p>
            {state.kind === "misconfigured" && <Banner tone="error" title="Linking is not working on this server">{state.problems.join(" ")}</Banner>}
          </div>
        </Panel>
        <Panel title="Policy for this workspace" icon={Globe} id="policy">
          <div className="p-4">
            <ActionForm action={saveFederationPolicyAction} submitLabel="Save policy" pendingLabel="Saving…" resetOnSuccess={false} className="grid max-w-xl gap-3">
              <div>
                <label className="label" htmlFor="fp-out">Links from this workspace to other instances</label>
                <Select id="fp-out" name="outboundMode" defaultValue={policy.outboundMode} className="select max-w-xs">
                  <option value="off">Off</option>
                  <option value="allowlist">Only the allow list</option>
                  <option value="any">Any allowed instance</option>
                </Select>
              </div>
              <div>
                <label className="label" htmlFor="fp-in">Links from other instances to this workspace</label>
                <Select id="fp-in" name="inboundMode" defaultValue={policy.inboundMode} className="select max-w-xs">
                  <option value="off">Off</option>
                  <option value="allowlist">Only the allow list</option>
                  <option value="any">Any allowed instance</option>
                </Select>
                <p className="mt-1 text-[12px] text-ink-3">{MODE_HELP}</p>
              </div>
              <div>
                <label className="label" htmlFor="fp-list">Allow list (one address per line)</label>
                <textarea id="fp-list" name="allowlist" rows={4} defaultValue={policy.allowlist.join("\n")} spellCheck={false} placeholder="https://mergeport.example.com" className="input !h-auto font-mono text-[12.5px]" />
              </div>
              <div>
                <label className="label" htmlFor="fp-who">Who can create a link</label>
                <Select id="fp-who" name="whoCanLink" defaultValue={policy.whoCanLink} className="select max-w-xs">
                  <option value="ADMIN">Owner and administrators</option>
                  <option value="MEMBER">Members too (never readers)</option>
                </Select>
              </div>
              <div className="flex flex-wrap gap-4">
                <div>
                  <label className="label" htmlFor="fp-links">Links per person</label>
                  <input id="fp-links" name="maxLinksPerUser" type="number" inputMode="numeric" min={0} max={50} step={1} defaultValue={policy.maxLinksPerUser} className="input tnum !w-28" />
                </div>
                <div>
                  <label className="label" htmlFor="fp-peers">Linked instances (0 to 50)</label>
                  <input id="fp-peers" name="maxPeers" type="number" inputMode="numeric" min={0} max={50} step={1} defaultValue={policy.maxPeers} className="input tnum !w-28" aria-describedby="fp-peers-help" />
                  <p id="fp-peers-help" className="mt-1 text-[12px] text-ink-3">1 means a single linked instance.</p>
                </div>
              </div>
            </ActionForm>
          </div>
        </Panel>
        <Panel title={<>Instances that can read this workspace (<span className="tnum">{grants.length}</span>)</>} icon={ShieldCheck} id="grants">
          {grants.length === 0 ? (
            <p className="p-4 text-[13px] text-ink-3">No other instance holds access.</p>
          ) : (
            <>
              <ul>
                {grants.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4 last:border-b-0">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{g.clientOrigin.replace(/^https?:\/\//, "")} <span className="font-normal text-ink-3">as {g.who}</span></p>
                      <p className="text-[12.5px] text-ink-3">Approved {formatInstant(g.createdAt, viewer.timezone)}; {g.lastUsedAt ? `last used ${formatInstant(g.lastUsedAt, viewer.timezone)}` : "not used yet"}.</p>
                    </div>
                    <ActionForm action={revokeGrantAction} submitLabel="Revoke" pendingLabel="Revoking…" submitClassName="btn btn-danger !h-10" submitAriaLabel={`Revoke access of ${g.who} for ${g.clientOrigin}`} className="[&>div:last-child]:!mt-0">
                      <input type="hidden" name="grantId" value={g.id} />
                    </ActionForm>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-3 border-t border-line p-4">
                {origins.map((o) => (
                  <ActionForm key={o} action={revokeAllFromOriginAction} submitLabel={`Revoke all from ${o.replace(/^https?:\/\//, "")}`} pendingLabel="Revoking…" submitClassName="btn btn-danger !h-10" className="[&>div:last-child]:!mt-0">
                    <input type="hidden" name="origin" value={o} />
                  </ActionForm>
                ))}
              </div>
            </>
          )}
        </Panel>
        <Panel title={<>Links from this workspace (<span className="tnum">{links.length}</span>)</>} icon={Globe} id="links">
          {links.length === 0 ? (
            <p className="p-4 text-[13px] text-ink-3">Nobody here has linked another instance.</p>
          ) : (
            <ul>
              {links.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4 last:border-b-0">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{l.peerOrigin.replace(/^https?:\/\//, "")} <span className="font-normal text-ink-3">linked by {l.who}</span></p>
                    <p className="text-[12.5px] text-ink-3">{l.lastUsedAt ? `Last used ${formatInstant(l.lastUsedAt, viewer.timezone)}.` : "Not used yet."}</p>
                  </div>
                  {l.lastError && <SimplePill tone="changes">Error</SimplePill>}
                  <ActionForm action={unlinkAction} submitLabel="Unlink" pendingLabel="Unlinking…" submitClassName="btn btn-danger !h-10" submitAriaLabel={`Unlink ${l.peerOrigin} for ${l.who}`} className="[&>div:last-child]:!mt-0">
                    <input type="hidden" name="linkId" value={l.id} />
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
