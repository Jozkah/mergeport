import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireAdminViewer } from "@/lib/authz-page";
import { ActionForm } from "@/components/forms/ActionForm";
import { ConfirmSheet } from "@/components/forms/ConfirmSheet";
import { Host } from "@/components/ui/identity";
import { Select } from "@/components/ui/Select";
import { Banner, EmptyState, PageHeader, Panel, SimplePill } from "@/components/ui/primitives";
import { CircleAlert, Globe, ShieldCheck } from "@/components/ui/icons";
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
            <p className="wrap-any">
              Operator limit: <strong>{config.mode === "any" ? "any instance" : "only listed instances"}</strong>
              {config.mode === "allowlist" ? <> ({config.allowlist.length === 0 ? "none listed" : config.allowlist.join(", ")})</> : null}. It is set by whoever runs this server and cannot be changed here.
            </p>
            {state.kind === "misconfigured" && <Banner tone="error" title="Linking is not working on this server">{state.problems.join(" ")}</Banner>}
          </div>
        </Panel>
        <Panel title="Policy for this workspace" icon={Globe} id="policy">
          <div className="p-4">
            <ActionForm action={saveFederationPolicyAction} submitLabel="Save policy" pendingLabel="Saving…" resetOnSuccess={false} className="grid max-w-xl gap-3" requireDirty>
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
                <p className="mt-1 text-[12px] text-ink-3">{MODE_HELP} The same choices apply to both settings above.</p>
              </div>
              <div>
                <label className="label" htmlFor="fp-list">Allow list (one address per line)</label>
                <textarea id="fp-list" name="allowlist" rows={4} defaultValue={policy.allowlist.join("\n")} spellCheck={false} autoCapitalize="none" placeholder="https://mergeport.example.com" aria-describedby="fp-list-help" className="textarea font-mono text-[12.5px]" />
                <p id="fp-list-help" className="mt-1 text-[12px] text-ink-3">Only used by the two modes that say &quot;allow list&quot;.</p>
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
                  <input id="fp-links" name="maxLinksPerUser" type="number" inputMode="numeric" min={0} max={50} step={1} defaultValue={policy.maxLinksPerUser} className="input tnum w-28" />
                </div>
                <div>
                  <label className="label" htmlFor="fp-peers">Most instances this workspace can link</label>
                  <input id="fp-peers" name="maxPeers" type="number" inputMode="numeric" min={0} max={50} step={1} defaultValue={policy.maxPeers} className="input tnum w-28" aria-describedby="fp-peers-help" />
                  <p id="fp-peers-help" className="mt-1 text-[12px] text-ink-3">From 0 to 50. 1 means a single linked instance.</p>
                </div>
              </div>
            </ActionForm>
          </div>
        </Panel>
        <Panel title={<>Instances that can read this workspace (<span className="tnum">{grants.length}</span>)</>} icon={ShieldCheck} id="grants" summary={`${grants.length} access${grants.length === 1 ? "" : "es"}`}>
          {grants.length === 0 ? (
            <EmptyState icon={ShieldCheck} title="No access granted">No other instance can read this workspace.</EmptyState>
          ) : (
            <>
              <ul>
                {grants.map((g) => (
                  <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4 last:border-b-0">
                    <div className="min-w-0">
                      <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 font-medium"><Host origin={g.clientOrigin} className="min-w-0" /> <span className="min-w-0 wrap-any font-normal text-ink-3">as <bdi>{g.who}</bdi></span></p>
                      <p className="tnum text-[12.5px] text-ink-3">Approved {formatInstant(g.createdAt, viewer.timezone)}; {g.lastUsedAt ? `last used ${formatInstant(g.lastUsedAt, viewer.timezone)}` : "not used yet"}.</p>
                    </div>
                    <ConfirmSheet
                      title="Revoke this access?"
                      consequence={<><bdi>{g.who}</bdi> can no longer see this workspace from <bdi className="wrap-any">{g.clientOrigin}</bdi>. It stops working now.</>}
                      action={revokeGrantAction}
                      submitLabel="Revoke"
                      pendingLabel="Revoking…"
                      trigger={<button type="button" className="btn text-blocked" aria-label={`Revoke access of ${g.who} for ${g.clientOrigin}`}>Revoke</button>}
                    >
                      <input type="hidden" name="grantId" value={g.id} />
                    </ConfirmSheet>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-3 border-t border-line p-4">
                {origins.map((o) => {
                  const n = grants.filter((g) => g.clientOrigin === o).length;
                  return (
                    <ConfirmSheet
                      key={o}
                      title={`Revoke ${n} grant${n === 1 ? "" : "s"} from ${o.replace(/^https?:\/\//, "")}?`}
                      consequence={<>Everyone who linked this workspace from <bdi className="wrap-any">{o}</bdi> loses access now. They can link again if the policy allows it.</>}
                      action={revokeAllFromOriginAction}
                      submitLabel={`Revoke ${n} grant${n === 1 ? "" : "s"}`}
                      pendingLabel="Revoking…"
                      trigger={<button type="button" className="btn text-blocked" aria-label={`Revoke all ${n} grant${n === 1 ? "" : "s"} from ${o.replace(/^https?:\/\//, "")}`}>Revoke all from <span className="ml-1 max-w-48 truncate" title={o}>{o.replace(/^https?:\/\//, "")}</span></button>}
                    >
                      <input type="hidden" name="origin" value={o} />
                    </ConfirmSheet>
                  );
                })}
              </div>
            </>
          )}
        </Panel>
        <Panel title={<>Links from this workspace (<span className="tnum">{links.length}</span>)</>} icon={Globe} id="links" summary={`${links.length} link${links.length === 1 ? "" : "s"}`}>
          {links.length === 0 ? (
            <EmptyState icon={Globe} title="Nothing linked">Nobody here has linked another instance.</EmptyState>
          ) : (
            <ul>
              {links.map((l) => (
                <li key={l.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4 last:border-b-0">
                  <div className="min-w-0">
                    <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 font-medium"><Host origin={l.peerOrigin} className="min-w-0" /> <span className="min-w-0 wrap-any font-normal text-ink-3">linked by <bdi>{l.who}</bdi></span></p>
                    <p className="tnum text-[12.5px] text-ink-3">{l.lastUsedAt ? `Last used ${formatInstant(l.lastUsedAt, viewer.timezone)}.` : "Not used yet."}</p>
                    {l.lastError && <p className="wrap-any text-[12.5px] text-blocked">{l.lastError}</p>}
                  </div>
                  {l.lastError && <SimplePill tone="blocked" icon={CircleAlert}>Last request failed</SimplePill>}
                  <ConfirmSheet
                    title={`Unlink ${l.peerOrigin.replace(/^https?:\/\//, "")}?`}
                    consequence={<><bdi>{l.who}</bdi> stops seeing that instance&apos;s projects here. Nothing is deleted there.</>}
                    action={unlinkAction}
                    submitLabel="Unlink"
                    pendingLabel="Unlinking…"
                    trigger={<button type="button" className="btn text-blocked" aria-label={`Unlink ${l.peerOrigin} for ${l.who}`}>Unlink</button>}
                  >
                    <input type="hidden" name="linkId" value={l.id} />
                  </ConfirmSheet>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
