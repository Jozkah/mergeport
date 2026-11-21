import Link from "next/link";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/authz-page";
import { ConfirmSheet } from "@/components/forms/ConfirmSheet";
import { AutoRefresh } from "@/components/federation/AutoRefresh";
import { LinkInstanceForm } from "@/components/federation/FederationForms";
import { PeerSkeleton, StripResult } from "@/components/federation/LinkedBits";
import { Host, RoleChip, ScopeChip } from "@/components/ui/identity";
import { Banner, EmptyState, PageHeader, Panel } from "@/components/ui/primitives";
import { ChevronRight, Globe, ShieldCheck } from "@/components/ui/icons";
import { revokeGrantAction, unlinkAction } from "@/app/federation-actions";
import { formatInstant } from "@/lib/format";
import { isHosted } from "@/lib/public-url";
import { liveCtx } from "@/lib/federation/context";
import { listLinks, remoteGet, type Remote } from "@/lib/federation/consumer";
import { canCreateLink, loadPolicy } from "@/lib/federation/policy";
import { myGrants } from "@/lib/federation/provider";
import type { ProjectDto } from "@/lib/federation/read-api";
import type { Viewer } from "@/lib/authz/viewer";
import type { Role } from "@/lib/authz/roles";
import type { FedCtx } from "@/lib/federation/context";

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

type Projects = Remote<{ projects: ProjectDto[] }>;

/** One peer's answer: the fetch happens here, inside its own Suspense boundary, so a slow instance never holds the rest of the page. */
async function PeerBody({ ctx, viewer, linkId, peerWorkspaceName, peerRole }: { ctx: FedCtx | null; viewer: Viewer; linkId: string; peerWorkspaceName: string | null; peerRole: string | null }) {
  const r: Projects = ctx
    ? await remoteGet<{ projects: ProjectDto[] }>(ctx, viewer, linkId, "/projects?limit=100", { background: true }).catch((): Projects => ({ state: "error", data: null, fetchedAt: null, stale: false, error: "Could not load." }))
    : { state: "blocked", data: null, fetchedAt: null, stale: false, error: "Linking is switched off on this server. You can still unlink." };
  const projects = r.data?.projects ?? [];
  return (
    <>
      <div className="border-b border-line px-4 py-2.5 text-[12.5px] text-ink-3">
        {peerWorkspaceName ? <>Workspace <strong className="wrap-any text-ink-2"><bdi>{peerWorkspaceName}</bdi></strong>{peerRole ? <> as <RoleChip role={peerRole as Role} /></> : null}. </> : null}
        {r.fetchedAt ? <>Last updated <span className="tnum">{formatInstant(r.fetchedAt, viewer.timezone)}</span>{r.stale ? " (refreshing)" : ""}.</> : <>Not loaded yet.</>}
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
      {r.data && projects.length === 0 && <EmptyState icon={Globe} title="No projects">You can see no projects over there, or none are shared with your account.</EmptyState>}
      {r.data && projects.length > 0 && (
        <ul>
          {projects.map((p) => (
            <li key={p.id} className="border-b border-line last:border-b-0">
              <Link href={`/linked/${encodeURIComponent(linkId)}/projects/${encodeURIComponent(p.id)}`} className="flex items-center gap-3 p-4 outline-none hover:bg-subtle focus-visible:bg-subtle focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-focus-ring)]">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{p.name}</span>
                  {p.description && <span className="mt-0.5 line-clamp-2 block text-[12.5px] text-ink-3">{p.description}</span>}
                </span>
                <ChevronRight size={16} aria-hidden className="shrink-0 text-ink-3" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

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
  const key = (await searchParams).result ?? "";
  const result = RESULT[key];
  const policy = await loadPolicy(db, viewer.workspaceId);
  const links = await listLinks(db, viewer);
  const grants = await myGrants(db, viewer);
  if (!ctx && links.length === 0 && grants.length === 0) notFound();
  const canLink = ctx !== null && canCreateLink(viewer.role, policy) && policy.outboundMode !== "off" && policy.maxPeers > 0;
  const linkPanel = (
    <Panel title="Link an instance" icon={Globe} id="link-new">
      <div className="p-4">
        {canLink ? (
          <LinkInstanceForm />
        ) : ctx === null ? (
          <p className="text-[13px] text-ink-3">Linking is switched off on this server.</p>
        ) : (
          <p className="text-[13px] text-ink-3">
            {policy.outboundMode === "off" || policy.maxPeers === 0 ? "Linking to other instances is turned off for this workspace." : "Your role cannot link instances in this workspace."} An administrator can change this in Settings.
          </p>
        )}
      </div>
    </Panel>
  );
  return (
    <>
      <PageHeader title="Linked instances" subtitle="Projects from other Mergeport instances you linked, read-only." help={<>Linking lets you look at another instance&apos;s projects from here. The other instance keeps the data and decides what you may see; nothing is copied into this one&apos;s search, digests, AI or backups, and nobody else here sees it. Unlink at any time.</>} />
      <AutoRefresh seconds={90} />
      {result && <StripResult to="/linked" />}
      <div className="flex flex-col gap-5">
        {result && <Banner tone={result.tone} title={result.title}>{result.text}</Banner>}
        {links.map((l) => (
          <Panel
            key={l.id}
            id={`link-${l.id}`}
            icon={Globe}
            title={<span className="flex min-w-0 items-center gap-1.5">From <Host origin={l.peerOrigin} className="min-w-0" /> <span className="shrink-0 font-normal text-ink-3">(read-only)</span></span>}
            actions={
              <ConfirmSheet
                title={`Unlink ${l.peerOrigin.replace(/^https?:\/\//, "")}?`}
                consequence="You stop seeing its projects here and the access you were given is revoked there."
                action={unlinkAction}
                submitLabel="Unlink"
                pendingLabel="Unlinking…"
                trigger={<button type="button" className="btn text-blocked" aria-label={`Unlink ${l.peerOrigin.replace(/^https?:\/\//, "")}`}>Unlink</button>}
              >
                <input type="hidden" name="linkId" value={l.id} />
              </ConfirmSheet>
            }
          >
            <Suspense fallback={<PeerSkeleton />}>
              <PeerBody ctx={ctx} viewer={viewer} linkId={l.id} peerWorkspaceName={l.peerWorkspaceName} peerRole={l.peerRole} />
            </Suspense>
          </Panel>
        ))}
        {links.length === 0 && linkPanel}
        {links.length === 0 && !result && <EmptyState icon={Globe} title="Nothing linked yet">Link another Mergeport instance to see its projects here, read-only.</EmptyState>}
        {links.length > 0 && linkPanel}
        <Panel title="Apps with access to your data" icon={ShieldCheck} id="linked-apps" summary={`${grants.length} app${grants.length === 1 ? "" : "s"}`}>
          {grants.length === 0 ? (
            <p className="p-4 text-[13px] text-ink-3">No other instance can read your projects from this workspace.</p>
          ) : (
            <ul>
              {grants.map((g) => (
                <li key={g.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-line p-4 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium"><Host origin={g.clientOrigin} /></p>
                    <p className="text-[12.5px] text-ink-3">Approved <span className="tnum">{formatInstant(g.createdAt, viewer.timezone)}</span>; {g.lastUsedAt ? <>last used <span className="tnum">{formatInstant(g.lastUsedAt, viewer.timezone)}</span></> : "not used yet"}.</p>
                  </div>
                  <ScopeChip scope="readonly" />
                  <ConfirmSheet
                    title="Revoke this access?"
                    consequence={<><bdi className="wrap-any">{g.clientOrigin.replace(/^https?:\/\//, "")}</bdi> can no longer read your projects from this workspace. It stops working now.</>}
                    action={revokeGrantAction}
                    submitLabel="Revoke"
                    pendingLabel="Revoking…"
                    trigger={<button type="button" className="btn text-blocked" aria-label={`Revoke access for ${g.clientOrigin}`}>Revoke</button>}
                  >
                    <input type="hidden" name="grantId" value={g.id} />
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
