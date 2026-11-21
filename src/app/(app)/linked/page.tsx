import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { Sheet } from "@/components/ui/dialog";
import { ActionForm } from "@/components/forms/ActionForm";
import { AutoRefresh } from "@/components/federation/AutoRefresh";
import { LinkInstanceForm } from "@/components/federation/FederationForms";
import { Banner, EmptyState, PageHeader, Panel, SimplePill } from "@/components/ui/primitives";
import { Globe, ShieldCheck } from "@/components/ui/icons";
import { revokeGrantAction, unlinkAction } from "@/app/federation-actions";
import { formatInstant } from "@/lib/format";
import { isHosted } from "@/lib/public-url";
import { liveCtx } from "@/lib/federation/context";
import { listLinks, remoteGet, type Remote } from "@/lib/federation/consumer";
import { canCreateLink, loadPolicy } from "@/lib/federation/policy";
import { myGrants } from "@/lib/federation/provider";
import type { ProjectDto } from "@/lib/federation/read-api";

export const metadata = { title: "Linked instances" };
export const dynamic = "force-dynamic";

const RESULT: Record<string, { tone: "info" | "warn" | "error"; title: string; text: string }> = {
  linked: { tone: "info", title: "Linked", text: "The instance is linked. You see its projects below, read-only." },
  denied: { tone: "warn", title: "Not linked", text: "The other instance did not approve the link." },
  invalid: { tone: "error", title: "Not linked", text: "That link request is not valid or has expired. Start again." },
  refused: { tone: "error", title: "Not linked", text: "Your workspace's policy does not allow this link." },
  peer: { tone: "error", title: "Not linked", text: "The other instance did not accept the link request. Try again." },
  signin: { tone: "warn", title: "Sign in first", text: "Sign in here, then start the link again." },
};

/**
 * "Linked instances": other Mergeport instances YOU linked, and their projects, read-only. The data stays on the other instance and
 * is never indexed into this one's search, digests, AI or backups; only you see it. Below: apps (other instances) you let read YOUR
 * data here, with Revoke.
 */
export default async function LinkedPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const { viewer } = await requireViewer();
  const ctx = liveCtx();
  // Switched off (or no key): the page exists only for someone who still holds a link or a grant, and then only to END them.
  if (!ctx && !isHosted()) notFound();
  const result = RESULT[(await searchParams).result ?? ""];
  const policy = await loadPolicy(db, viewer.workspaceId);
  const links = await listLinks(db, viewer);
  const grants = await myGrants(db, viewer);
  if (!ctx && links.length === 0 && grants.length === 0) notFound();
  const canLink = ctx !== null && canCreateLink(viewer.role, policy) && policy.outboundMode !== "off" && policy.maxPeers > 0;
  const failed = (error: string): Remote<{ projects: ProjectDto[] }> => ({ state: "error", data: null, fetchedAt: null, stale: false, error });
  const remotes = await Promise.all(
    links.map((l) =>
      ctx
        ? remoteGet<{ projects: ProjectDto[] }>(ctx, viewer, l.id, "/projects?limit=100", { background: true }).catch(() => failed("Could not load."))
        : Promise.resolve<Remote<{ projects: ProjectDto[] }>>({ state: "blocked", data: null, fetchedAt: null, stale: false, error: "Linking is switched off on this server. You can still unlink." }),
    ),
  );
  return (
    <>
      <PageHeader title="Linked instances" subtitle="Projects from other Mergeport instances you linked, read-only." help={<>Linking lets you look at another instance&apos;s projects from here. The other instance keeps the data and decides what you may see; nothing is copied into this one&apos;s search, digests, AI or backups, and nobody else here sees it. Unlink at any time.</>} />
      <AutoRefresh seconds={45} />
      <div className="flex flex-col gap-5">
        {result && <Banner tone={result.tone} title={result.title}>{result.text}</Banner>}
        {links.map((l, i) => {
          const r = remotes[i];
          return (
            <Panel
              key={l.id}
              id={`link-${l.id}`}
              icon={Globe}
              title={<>From {l.peerOrigin.replace(/^https?:\/\//, "")} <span className="font-normal text-ink-3">(read-only)</span></>}
              actions={
                <Sheet title={`Unlink ${l.peerOrigin}?`} description="You stop seeing its projects here and the access you were given is revoked there." trigger={<button type="button" className="btn btn-danger !h-10">Unlink</button>}>
                  <ActionForm action={unlinkAction} submitLabel="Unlink" pendingLabel="Unlinking…" submitClassName="btn btn-danger !h-10" closeOnSuccess>
                    <input type="hidden" name="linkId" value={l.id} />
                  </ActionForm>
                </Sheet>
              }
            >
              <div className="border-b border-line px-4 py-2.5 text-[12.5px] text-ink-3">
                {l.peerWorkspaceName ? <>Workspace <strong className="text-ink-2">{l.peerWorkspaceName}</strong>{l.peerRole ? <> as {l.peerRole.toLowerCase()}</> : null}. </> : null}
                {r.fetchedAt ? <>Last updated {formatInstant(r.fetchedAt, viewer.timezone)}{r.stale ? " (refreshing)" : ""}.</> : <>Not loaded yet.</>}
              </div>
              {r.state !== "ok" && (
                <div className="p-4">
                  <Banner tone={r.state === "blocked" ? "warn" : "error"} title={r.state === "revoked" ? "Access was revoked" : r.state === "blocked" ? "Linking is switched off" : "Could not reach the other instance"}>
                    {r.error}
                    {r.state === "revoked" ? " Unlink it and link again if you still need it." : ""}
                  </Banner>
                </div>
              )}
              {r.state === "error" && r.data && <p className="px-4 pt-3 text-[12.5px] text-ink-3">Showing the last answer from {r.fetchedAt ? formatInstant(r.fetchedAt, viewer.timezone) : "earlier"}.</p>}
              {r.data && (r.data.projects ?? []).length === 0 && <EmptyState icon={Globe} title="No projects">You can see no projects over there, or none are shared with your account.</EmptyState>}
              {r.data && (r.data.projects ?? []).length > 0 && (
                <ul>
                  {(r.data.projects ?? []).map((p) => (
                    <li key={p.id} className="border-b border-line last:border-b-0">
                      <Link href={`/linked/${encodeURIComponent(l.id)}/projects/${encodeURIComponent(p.id)}`} className="block p-4 hover:bg-subtle">
                        <p className="truncate font-medium">{p.name}</p>
                        {p.description && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-ink-3">{p.description}</p>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          );
        })}
        {links.length === 0 && !result && <EmptyState icon={Globe} title="Nothing linked yet">Link another Mergeport instance to see its projects here, read-only.</EmptyState>}
        <Panel title="Link an instance" icon={Globe} id="link-new">
          <div className="p-4">
            {canLink ? <LinkInstanceForm /> : <p className="text-[13px] text-ink-3">{ctx === null ? "Linking is switched off on this server." : policy.outboundMode === "off" || policy.maxPeers === 0 ? "Linking to other instances is turned off for this workspace." : "Your role cannot link instances in this workspace."} An administrator can change this in Settings.</p>}
          </div>
        </Panel>
        <Panel title="Apps with access to your data" icon={ShieldCheck} id="linked-apps" summary={`${grants.length}`}>
          {grants.length === 0 ? (
            <p className="p-4 text-[13px] text-ink-3">No other instance can read your projects from this workspace.</p>
          ) : (
            <ul>
              {grants.map((g) => (
                <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4 last:border-b-0">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{g.clientOrigin.replace(/^https?:\/\//, "")}</p>
                    <p className="text-[12.5px] text-ink-3">Read-only. Approved {formatInstant(g.createdAt, viewer.timezone)}; {g.lastUsedAt ? `last used ${formatInstant(g.lastUsedAt, viewer.timezone)}` : "not used yet"}.</p>
                  </div>
                  <SimplePill tone="ok">Read only</SimplePill>
                  <ActionForm action={revokeGrantAction} submitLabel="Revoke" pendingLabel="Revoking…" submitClassName="btn btn-danger !h-10" submitAriaLabel={`Revoke access for ${g.clientOrigin}`} className="[&>div:last-child]:!mt-0">
                    <input type="hidden" name="grantId" value={g.id} />
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
